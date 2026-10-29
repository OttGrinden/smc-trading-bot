/**
 * OrderStore — isolated persistence for BrokerOrderRecords (Phase 1, Step 2).
 *
 * Pure local persistence ONLY. No broker IO, no submit/poll/reconcile logic, no
 * flow orchestration, no portfolio mutation, no status mapping. Later steps
 * (gateway/poller/reconciler) read/write records through this store.
 *
 * Layout:
 *   trading/execution/live_orders/{client_order_id}.json  — one atomic snapshot per order
 *   trading/execution/live_orders/live_order_events.jsonl  — central append-only event log
 *
 * Safety (fail-closed):
 *   - atomic writes (temp + renameSync), mirroring scripts/macd_calc.atomicWriteJson
 *   - get(missing) → null ; get(corrupt) → THROW (corrupt ≠ not found)
 *   - listAll()/listNonTerminal() THROW on any corrupt record (never silently skip)
 *   - orphaned ".tmp-*" files (crash mid-write) are ignored when listing
 *   - upsert = create-or-replace by client_order_id (idempotent); never blind append
 *   - upsert validates client_order_id charset, schema_version, and known state
 *   - append-only event log; events are never rewritten
 *
 * Naming is inherited from makeBrokerOrderRecord (Step 1) — no renames/synonyms.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { ORDER_STATES }  from '../schemas.mjs';
import { fileURLToPath } from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', '..', '..', 'trading');

const DEFAULT_DIR     = join(TRADING_DIR, 'execution', 'live_orders');
const EVENTS_LOG_NAME = 'live_order_events.jsonl';

const VALID_STATES = new Set(Object.values(ORDER_STATES));
const CID_RE       = /^[A-Za-z0-9_-]+$/;   // filesystem-safe + injection-safe

// Settled = no longer needs broker execution attention (used by listNonTerminal).
// This is deliberately broader than order_state.isTerminal(): `filled` is settled
// here even though the contract keeps a `filled → failed_reconciliation` AUDIT edge
// (that edge is an exceptional reconciler-only transition, not routine lifecycle).
// Later recovery/poller steps must NOT re-poll settled orders.
export const SETTLED_STATES = new Set([
  ORDER_STATES.FILLED,
  ORDER_STATES.REJECTED,
  ORDER_STATES.CANCELLED,
  ORDER_STATES.REPLACED,
  ORDER_STATES.EXPIRED,
  ORDER_STATES.BLOCKED,
  ORDER_STATES.FAILED_RECONCILIATION,
]);

// ─── Test-only path override (mirrors portfolio_state._setTestPaths) ───────────
let _paths = null;
export function _setOrderStorePaths(p) { _paths = p; }
export function _clearOrderStorePaths() { _paths = null; }

function dir()           { return _paths?.dir ?? DEFAULT_DIR; }
function eventsLogPath() { return _paths?.eventsLog ?? join(dir(), EVENTS_LOG_NAME); }
function recordPath(cid) { return join(dir(), `${cid}.json`); }

function assertCid(cid) {
  if (typeof cid !== 'string' || !CID_RE.test(cid)) {
    throw new Error(`OrderStore: invalid client_order_id (must match ${CID_RE}): ${JSON.stringify(cid)}`);
  }
  return cid;
}

function atomicWriteJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = join(
    dirname(filePath),
    `.tmp-liveorder-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tempPath, filePath);   // atomic: a crash before this leaves only the .tmp (ignored on list)
}

function readRecordFile(p, label) {
  let raw;
  try { raw = readFileSync(p, 'utf8'); }
  catch (e) { throw new Error(`OrderStore: cannot read ${label}: ${e.message}`); }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`OrderStore: corrupt record ${label} (fail-closed): ${e.message}`); }
}

/**
 * upsert — create-or-replace a record by client_order_id (atomic, idempotent).
 * @throws on invalid client_order_id / missing schema_version / unknown state.
 */
export function upsert(record) {
  if (record == null || typeof record !== 'object') {
    throw new Error('OrderStore.upsert: record must be an object');
  }
  const cid = assertCid(record.client_order_id);
  if (!Number.isFinite(record.schema_version)) {
    throw new Error(`OrderStore.upsert: record.schema_version missing/invalid for ${cid}`);
  }
  if (!VALID_STATES.has(record.state)) {
    throw new Error(`OrderStore.upsert: unknown state "${record.state}" for ${cid}`);
  }
  atomicWriteJson(recordPath(cid), record);
  return record;
}

/** get — persisted record, or null if not found. THROWS on corrupt file. */
export function get(clientOrderId) {
  const cid = assertCid(clientOrderId);
  const p   = recordPath(cid);
  if (!existsSync(p)) return null;
  return readRecordFile(p, cid);
}

/** exists — true if a record file exists for the cid. */
export function exists(clientOrderId) {
  return existsSync(recordPath(assertCid(clientOrderId)));
}

/**
 * remove — delete a record file by client_order_id. Additive helper for dev/smoke
 * cleanup (Unit 10.4); uses the store's own path resolution so test overrides apply.
 * @returns {boolean} true if a file was removed, false if none existed.
 * @throws on invalid client_order_id.
 */
export function remove(clientOrderId) {
  const p = recordPath(assertCid(clientOrderId));
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

/** listAll — all persisted records. THROWS (fail-closed) on any corrupt record. */
export function listAll() {
  const d = dir();
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter(f => f.endsWith('.json') && !f.startsWith('.tmp'))
    .map(f => readRecordFile(join(d, f), f));
}

/** listNonTerminal — persisted records that are NOT settled (still need broker attention). */
export function listNonTerminal() {
  return listAll().filter(r => !SETTLED_STATES.has(r.state));
}

/** getEventsLogPath — returns the active events log path (honours test overrides). */
export function getEventsLogPath() {
  return eventsLogPath();
}

/**
 * appendEvent — append-only event to the central log.
 * client_order_id + ts are store-controlled (authoritative); event.type is required.
 */
export function appendEvent(clientOrderId, event) {
  const cid = assertCid(clientOrderId);
  if (event == null || typeof event !== 'object' || typeof event.type !== 'string' || !event.type) {
    throw new Error(`OrderStore.appendEvent: event.type (string) is required for ${cid}`);
  }
  const p = eventsLogPath();
  mkdirSync(dirname(p), { recursive: true });
  const line = JSON.stringify({ ...event, client_order_id: cid, ts: new Date().toISOString() });
  appendFileSync(p, line + '\n', 'utf8');
}
