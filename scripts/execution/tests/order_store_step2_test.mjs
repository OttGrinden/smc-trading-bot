#!/usr/bin/env node
/**
 * OrderStore — Phase 1 / Step 2 persistence tests (OS-01 … OS-10).
 *
 * Isolated: every case uses a temp directory via _setOrderStorePaths.
 * No live order store touched. No broker IO.
 *
 * node scripts/execution/tests/order_store_step2_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join }                                               from 'path';
import { tmpdir }                                             from 'os';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import {
  upsert, get, exists, listAll, listNonTerminal, appendEvent,
  _setOrderStorePaths, _clearOrderStorePaths,
} from '../live_broker/order_store.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
function threws(fn) { try { fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `orderstore_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

// Each test gets an isolated store dir so listAll/listNonTerminal don't cross-contaminate.
function withStore(tag, fn) {
  const d = join(ROOT, tag);
  mkdirSync(d, { recursive: true });
  _setOrderStorePaths({ dir: d, eventsLog: join(d, 'live_order_events.jsonl') });
  try { return fn(d); } finally { _clearOrderStorePaths(); }
}

const rec = (cid, over = {}) => {
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol: 'AMAT', side: 'long', asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_x', action: 'open', order_action: 'buy', qty: 3.6 },
  );
  return { ...r, ...over };
};

// ─── OS-01: upsert + get reload exakt ────────────────────────────────────────
withStore('os01', () => {
  const r = rec('cid_os01');
  upsert(r);
  const back = get('cid_os01');
  check('OS-01', JSON.stringify(back) === JSON.stringify(r), 'upsert→get liefert exakt denselben Record');
});

// ─── OS-02: get(missing)=null, exists korrekt ────────────────────────────────
withStore('os02', () => {
  check('OS-02',
    get('cid_missing') === null && exists('cid_missing') === false
    && (upsert(rec('cid_there')), exists('cid_there') === true && get('cid_there') !== null),
    'get(missing)=null, exists=false; nach upsert exists=true');
});

// ─── OS-03: listNonTerminal nur nicht-terminale States ───────────────────────
withStore('os03', () => {
  upsert(rec('cid_sub', { state: 'submitted' }));        // non-terminal
  upsert(rec('cid_ack', { state: 'acknowledged' }));     // non-terminal
  upsert(rec('cid_fill', { state: 'filled' }));          // terminal
  upsert(rec('cid_canc', { state: 'cancelled' }));       // terminal
  upsert(rec('cid_exp', { state: 'expired' }));          // terminal (Phase 1 additive)
  const nt = listNonTerminal().map(r => r.client_order_id).sort();
  check('OS-03',
    listAll().length === 5 && nt.length === 2 && nt[0] === 'cid_ack' && nt[1] === 'cid_sub',
    'listNonTerminal nur submitted+acknowledged; filled/cancelled/expired ausgeschlossen');
});

// ─── OS-04: appendEvent append-only, Reihenfolge + cid erzwungen ─────────────
withStore('os04', (d) => {
  appendEvent('cid_ev', { type: 'broker_order_submitted', broker_order_id: 'b1' });
  appendEvent('cid_ev', { type: 'broker_order_filled', client_order_id: 'SHOULD_BE_OVERRIDDEN' });
  const lines = readFileSync(join(d, 'live_order_events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  check('OS-04',
    lines.length === 2 && lines[0].type === 'broker_order_submitted' && lines[1].type === 'broker_order_filled'
    && lines.every(l => l.client_order_id === 'cid_ev' && typeof l.ts === 'string')
    && lines[0].broker_order_id === 'b1',
    'zwei Events in Reihenfolge; client_order_id store-erzwungen; ts gesetzt');
});

// ─── OS-05: atomarer Write — kein .tmp-Müll, kein korrupter Endzustand ───────
withStore('os05', (d) => {
  upsert(rec('cid_atomic'));
  const filesAll = readdirSync(d);
  const tmpLeft  = filesAll.some(f => f.startsWith('.tmp'));
  check('OS-05',
    !tmpLeft && existsSync(join(d, 'cid_atomic.json'))
    && listAll().length === 1 && get('cid_atomic') !== null,
    'kein .tmp-Rest, Record vollständig lesbar, listAll ignoriert temp');
});

// ─── OS-06: Reload nach „Neustart" (Store ist zustandslos/file-basiert) ──────
withStore('os06', () => {
  upsert(rec('cid_reload', { state: 'submitted', broker_order_id: 'B9' }));
  _clearOrderStorePaths();   // simulate process restart (drop in-memory)
  _setOrderStorePaths({ dir: join(ROOT, 'os06'), eventsLog: join(ROOT, 'os06', 'live_order_events.jsonl') });
  const back = get('cid_reload');
  check('OS-06', back && back.state === 'submitted' && back.broker_order_id === 'B9',
    'nach Neustart aus Datei reproduziert (state + broker_order_id)');
});

// ─── OS-07: alle makeBrokerOrderRecord-Felder bleiben erhalten ───────────────
withStore('os07', () => {
  const r = rec('cid_fields');
  upsert(r);
  const b = get('cid_fields');
  const keys = ['schema_version','client_order_id','broker_order_id','intent_id','decision_id','run_id',
    'symbol','side','action','order_action','asset_type','order_type','time_in_force','limit_price',
    'qty','filled_qty','remaining_qty','avg_fill_price','fills','last_applied_filled_qty','state',
    'broker_status','broker','attempt_count','idempotency_status','replaces_cid','replaced_by_cid',
    'error','reconcile_flag','events','created_at','anchor_persisted_at','submitted_at','last_poll_at','terminal_at'];
  check('OS-07', keys.every(k => k in b) && b.qty === 3.6 && b.last_applied_filled_qty === 0 && Array.isArray(b.fills),
    'alle Contract-Felder durch upsert→get erhalten');
});

// ─── OS-08: korrupte Datei → fail-closed (Throw), nicht „not found" ──────────
withStore('os08', (d) => {
  writeFileSync(join(d, 'cid_bad.json'), '{ this is not json', 'utf8');
  check('OS-08',
    threws(() => get('cid_bad')) && threws(() => listAll()) && threws(() => listNonTerminal()),
    'korrupte Record-Datei → get/listAll/listNonTerminal werfen (fail-closed)');
});

// ─── OS-09: upsert-Validierung fail-closed ───────────────────────────────────
withStore('os09', () => {
  const ok =
    threws(() => upsert({}))                                                  && // keine cid
    threws(() => upsert({ client_order_id: 'bad/cid', schema_version: 1, state: 'created' })) && // bad charset
    threws(() => upsert({ client_order_id: 'okcid', state: 'created' }))      && // schema_version fehlt
    threws(() => upsert({ client_order_id: 'okcid', schema_version: 1, state: 'nonsense' })); // unbekannter state
  check('OS-09', ok, 'upsert wirft bei fehlender/bad cid, fehlender schema_version, unbekanntem state');
});

// ─── OS-10: idempotentes Upsert + Order-Isolation + Event-Order stabil ───────
withStore('os10', (d) => {
  const r = rec('cid_x');
  upsert(r); upsert(r);                                  // zweimal identisch
  upsert(rec('cid_y', { state: 'submitted' }));          // unabhängige Order
  for (const t of ['a','b','c']) appendEvent('cid_x', { type: t });
  const recFiles = readdirSync(d).filter(f => f.endsWith('.json') && !f.startsWith('.tmp'));
  const evs = readFileSync(join(d, 'live_order_events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  check('OS-10',
    recFiles.length === 2                                 // genau eine Datei je cid (idempotent)
    && JSON.stringify(get('cid_x')) === JSON.stringify(r)
    && get('cid_y').state === 'submitted'                // getrennte Orders unbeeinflusst
    && evs.map(e => e.type).join('') === 'abc',          // Reihenfolge stabil
    'idempotentes Upsert (1 Datei/cid), Order-Isolation, stabile Event-Reihenfolge');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\norder_store_step2_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
