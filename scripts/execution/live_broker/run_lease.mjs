/**
 * RunLease — local single-writer lease for the paper execution runtime (Phase 1, Unit 7).
 *
 * A minimal, robust, file-based lease so that at most ONE paper runner mutates the
 * OrderStore at a time. The atomic primitive is an exclusive create
 * (writeFileSync(..., { flag: 'wx' })) — if the lease file already exists the create
 * fails, which IS the single-writer guard. No distributed locking, no daemon.
 *
 * Policy (fail-closed, deliberately conservative):
 *   - acquire success ......... atomic exclusive create won → lease held
 *   - existing fresh lease ..... NOT acquired (reason: held) — never run concurrently
 *   - corrupt lease file ....... NOT acquired (reason: corrupt_lease) — never steal the unknown
 *   - stale lease (age > TTL) .. by DEFAULT only reported (reason: stale_lease_not_taken);
 *                                taken over ONLY with opts.takeoverStale === true, and then
 *                                conservatively (unlink + re-create atomically; lose the race
 *                                → fail-closed held). An unparseable timestamp counts as
 *                                NOT stale (treated as held) so it is never auto-taken.
 *   - release .................. deletes ONLY our own lease (lease_id match); a foreign or
 *                                corrupt lease is never removed.
 *
 * Test-only path override mirrors order_store._setOrderStorePaths.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', '..', '..', 'trading');

const DEFAULT_LEASE_PATH = join(TRADING_DIR, 'execution', 'live_orders', '.paper_runner.lease');
export const LEASE_TTL_MS = 300_000;   // 5 min: older than this (by heartbeat/started_at) = stale

let _leasePath = null;
export function _setLeasePath(p)  { _leasePath = p; }
export function _clearLeasePath() { _leasePath = null; }
function leasePath() { return _leasePath ?? DEFAULT_LEASE_PATH; }

function nowIso()    { return new Date().toISOString(); }
function newLeaseId() { return `lease_${Date.now()}_${process.pid}_${Math.random().toString(16).slice(2, 8)}`; }

/** readLease — inspect the current lease file (never throws on bad content). */
export function readLease() {
  const p = leasePath();
  if (!existsSync(p)) return { present: false };
  let raw;
  try { raw = readFileSync(p, 'utf8'); }
  catch (e) { return { present: true, corrupt: true, error: e.message }; }
  try { return { present: true, corrupt: false, lease: JSON.parse(raw) }; }
  catch (e) { return { present: true, corrupt: true, error: e.message }; }
}

// Age in ms by heartbeat_at (fallback started_at); null when no parseable timestamp.
function leaseAgeMs(lease) {
  const ts = Date.parse(lease?.heartbeat_at ?? lease?.started_at ?? '');
  return Number.isFinite(ts) ? (Date.now() - ts) : null;
}

/**
 * acquireLease — try to become the single writer.
 * @param {object} opts — { ttlMs?, takeoverStale?, host? }
 * @returns {{acquired:boolean, reason:string, lease?:object, holder?:object}}
 * @throws  {Error} only on an unexpected filesystem error (fail-closed)
 */
export function acquireLease(opts = {}) {
  const ttlMs         = Number.isFinite(opts.ttlMs) ? opts.ttlMs : LEASE_TTL_MS;
  const takeoverStale = opts.takeoverStale === true;
  const p             = leasePath();
  mkdirSync(dirname(p), { recursive: true });

  const lease = {
    lease_id: newLeaseId(), pid: process.pid, host: opts.host ?? 'local',
    started_at: nowIso(), heartbeat_at: nowIso(), ttl_ms: ttlMs,
  };

  try {
    writeFileSync(p, JSON.stringify(lease, null, 2) + '\n', { flag: 'wx', encoding: 'utf8' });   // atomic exclusive create
    return { acquired: true, reason: 'acquired', lease };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;   // unexpected IO error → propagate (fail-closed)
  }

  // Lease file already exists → inspect, never blindly overwrite.
  const cur = readLease();
  if (cur.corrupt || !cur.present || !cur.lease) {
    return { acquired: false, reason: 'corrupt_lease' };
  }
  const age   = leaseAgeMs(cur.lease);
  const stale = age != null && age > ttlMs;   // unparseable age → not stale → held
  if (!stale) {
    return { acquired: false, reason: 'held', holder: { pid: cur.lease.pid ?? null, started_at: cur.lease.started_at ?? null } };
  }
  if (!takeoverStale) {
    return { acquired: false, reason: 'stale_lease_not_taken', holder: { pid: cur.lease.pid ?? null, started_at: cur.lease.started_at ?? null } };
  }

  // Conservative opt-in takeover: remove the stale file, then re-create atomically.
  try { unlinkSync(p); }
  catch (e) { if (e.code !== 'ENOENT') return { acquired: false, reason: 'stale_takeover_failed' }; }
  try {
    const taken = { ...lease, took_over_from: cur.lease.lease_id ?? null };
    writeFileSync(p, JSON.stringify(taken, null, 2) + '\n', { flag: 'wx', encoding: 'utf8' });
    return { acquired: true, reason: 'stale_taken_over', lease: taken };
  } catch (e) {
    if (e.code === 'EEXIST') return { acquired: false, reason: 'held' };   // lost the race → fail-closed
    throw e;
  }
}

/**
 * releaseLease — release ONLY our own lease (lease_id match). Never deletes a
 * foreign or corrupt lease.
 * @param {object} lease — the lease object returned by acquireLease()
 */
export function releaseLease(lease) {
  const p   = leasePath();
  const cur = readLease();
  if (!cur.present)  return { released: false, reason: 'absent' };
  if (cur.corrupt)   return { released: false, reason: 'corrupt' };
  if (lease?.lease_id && cur.lease?.lease_id !== lease.lease_id) {
    return { released: false, reason: 'not_owner' };
  }
  try { unlinkSync(p); return { released: true, reason: 'released' }; }
  catch (e) { if (e.code === 'ENOENT') return { released: false, reason: 'absent' }; throw e; }
}
