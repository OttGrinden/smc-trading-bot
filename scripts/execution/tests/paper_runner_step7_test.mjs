#!/usr/bin/env node
/**
 * PaperRunner + RunLease — Phase 1 / Unit 7 tests (PR-01 … PR-14).
 *
 * Isolated: temp lease path (_setLeasePath) + temp OrderStore (_setOrderStorePaths)
 * + injected fake broker. Fully offline, no network.
 *
 * node scripts/execution/tests/paper_runner_step7_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import { upsert, get, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { acquireLease, releaseLease, readLease, _setLeasePath, _clearLeasePath } from '../live_broker/run_lease.mjs';
import { runPaperCycleOnce } from '../live_broker/paper_runner.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwAsync(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `paperrunner_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

async function withEnv(tag, fn) {
  const d = join(ROOT, tag);
  mkdirSync(d, { recursive: true });
  const leaseP = join(d, '.paper_runner.lease');
  _setOrderStorePaths({ dir: d, eventsLog: join(d, 'live_order_events.jsonl') });
  _setLeasePath(leaseP);
  try { return await fn(d, leaseP); }
  finally { _clearOrderStorePaths(); _clearLeasePath(); }
}

const PAPER_CFG = Object.freeze({ enabled: true, mode: 'alpaca_paper', paper: true, base_url: 'https://paper-api.alpaca.markets', key_id: 'k', secret_key: 's' });

function seed(cid, over = {}) {
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol: 'AMAT', side: 'long', asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_x', action: 'open', order_action: 'buy', qty: 10 },
  );
  upsert({ ...r, ...over });
}

function fakeBroker(viewOrFn) {
  const calls = { getOrderByClientId: 0 };
  return {
    calls,
    async getOrderByClientId(cid) {
      calls.getOrderByClientId += 1;
      const v = typeof viewOrFn === 'function' ? viewOrFn(cid) : viewOrFn;
      return v === undefined ? null : v;
    },
  };
}
const view = (status, over = {}) => ({ provider: 'alpaca', broker_order_id: 'B', broker_status: status, filled_qty: 0, avg_fill_price: null, ...over });

// ─── PR-01: successful run: acquire → reconcile → poll → release ─────────────────
await withEnv('pr01', async (d, leaseP) => {
  seed('cid_su', { state: 'submit_unknown' });
  const b = fakeBroker(view('new', { broker_order_id: 'B_ok' }));
  const s = await runPaperCycleOnce({ broker: b, execConfig: PAPER_CFG });
  check('PR-01',
    s.ran === true && s.reason === 'completed' && s.reconcile != null && s.poll != null
    && s.lease.acquired === true && s.lease.released === true && !existsSync(leaseP)
    && b.calls.getOrderByClientId >= 1,
    'one cycle: lease acquired, reconcile+poll ran, lease released (file gone)');
});

// ─── PR-02: existing fresh lease blocks a second run, no worker call ─────────────
await withEnv('pr02', async () => {
  const held = acquireLease({});                 // hold a fresh lease (not released)
  const b = fakeBroker(view('new'));
  const s = await runPaperCycleOnce({ broker: b, execConfig: PAPER_CFG });
  check('PR-02',
    held.acquired === true && s.ran === false && s.reason === 'lease_held'
    && b.calls.getOrderByClientId === 0,
    'fresh lease present → second run blocked (lease_held), no worker called');
  releaseLease(held.lease);
});

// ─── PR-03: corrupt lease file → fail-closed, no run ─────────────────────────────
await withEnv('pr03', async (d, leaseP) => {
  writeFileSync(leaseP, '{ not json', 'utf8');
  const b = fakeBroker(view('new'));
  const s = await runPaperCycleOnce({ broker: b, execConfig: PAPER_CFG });
  check('PR-03',
    s.ran === false && s.reason === 'lease_corrupt_lease' && b.calls.getOrderByClientId === 0,
    'corrupt lease file → fail-closed (lease_corrupt_lease), never stolen, no worker call');
});

// ─── PR-04: worker error → clean abort, lease still released ─────────────────────
await withEnv('pr04', async (d, leaseP) => {
  // Corrupt store record → listNonTerminal() throws → reconcileOnce throws.
  writeFileSync(join(d, 'cid_bad.json'), '{ broken', 'utf8');
  const b = fakeBroker(view('new'));
  const s = await runPaperCycleOnce({ broker: b, execConfig: PAPER_CFG });
  check('PR-04',
    s.ran === false && s.reason === 'worker_error' && s.error && typeof s.error.message === 'string'
    && s.lease.released === true && !existsSync(leaseP),
    'worker throw → fail-closed worker_error, no half-run, lease released even on exception');
});

// ─── PR-05: non-paper / invalid config refused (throws), no lease created ────────
await withEnv('pr05', async (d, leaseP) => {
  const b = fakeBroker(view('new'));
  const threwOff   = await threwAsync(() => runPaperCycleOnce({ broker: b, execConfig: { enabled: false, mode: 'off' } }));
  const threwLive  = await threwAsync(() => runPaperCycleOnce({ broker: b, execConfig: { ...PAPER_CFG, paper: false } }));
  check('PR-05',
    threwOff && threwLive && !existsSync(leaseP) && b.calls.getOrderByClientId === 0,
    'disabled config + non-paper config → throw before lease; no lease file, no worker call');
});

// ─── PR-06: summary aggregates worker results ────────────────────────────────────
await withEnv('pr06', async () => {
  seed('cid_a', { state: 'submit_unknown' });                                    // reconciler candidate
  seed('cid_b', { state: 'acknowledged' });                                      // poller candidate
  const s = await runPaperCycleOnce({ broker: fakeBroker(view('new')), execConfig: PAPER_CFG });
  check('PR-06',
    Number.isInteger(s.reconcile.scanned) && s.reconcile.scanned >= 1
    && Number.isInteger(s.poll.scanned) && s.poll.scanned >= 1,
    'summary carries both worker results (reconcile.scanned + poll.scanned populated)');
});

// ─── PR-07: missing ctx.broker → throws before lease ─────────────────────────────
await withEnv('pr07', async (d, leaseP) => {
  const threw = await threwAsync(() => runPaperCycleOnce({ execConfig: PAPER_CFG }));
  check('PR-07', threw && !existsSync(leaseP), 'missing broker → throws, no lease created');
});

// ─── PR-08: lease acquire is single-writer (second acquire blocked) ──────────────
await withEnv('pr08', async () => {
  const a = acquireLease({});
  const b = acquireLease({});
  check('PR-08', a.acquired === true && b.acquired === false && b.reason === 'held',
    'two acquires → only the first wins (atomic single-writer)');
  releaseLease(a.lease);
});

// ─── PR-09: release deletes only our own lease (foreign lease untouched) ─────────
await withEnv('pr09', async (d, leaseP) => {
  const a = acquireLease({});
  const rel = releaseLease({ lease_id: 'someone_else' });   // not the owner
  check('PR-09',
    rel.released === false && rel.reason === 'not_owner' && existsSync(leaseP)
    && releaseLease(a.lease).released === true,
    'foreign release is refused (not_owner); owner release succeeds');
});

// ─── PR-10: stale lease — DEFAULT only reported, not taken ────────────────────────
await withEnv('pr10', async (d, leaseP) => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString();   // 10 min old (TTL 5 min)
  writeFileSync(leaseP, JSON.stringify({ lease_id: 'stale1', pid: 999, started_at: old, heartbeat_at: old, ttl_ms: 300000 }) + '\n', 'utf8');
  const s = await runPaperCycleOnce({ broker: fakeBroker(view('new')), execConfig: PAPER_CFG });
  check('PR-10',
    s.ran === false && s.reason === 'lease_stale_lease_not_taken',
    'stale lease default → reported only (stale_lease_not_taken), no run');
});

// ─── PR-11: stale lease — taken over ONLY with explicit opt-in ───────────────────
await withEnv('pr11', async (d, leaseP) => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(leaseP, JSON.stringify({ lease_id: 'stale2', pid: 999, started_at: old, heartbeat_at: old, ttl_ms: 300000 }) + '\n', 'utf8');
  const s = await runPaperCycleOnce({ broker: fakeBroker(view('new')), execConfig: PAPER_CFG, leaseOpts: { takeoverStale: true } });
  check('PR-11',
    s.ran === true && s.lease.reason === 'stale_taken_over' && s.lease.released === true && !existsSync(leaseP),
    'stale lease + takeoverStale → taken over, cycle runs, lease released');
});

// ─── PR-12: fresh lease is NOT taken over even with opt-in ───────────────────────
await withEnv('pr12', async () => {
  const held = acquireLease({});
  const s = await runPaperCycleOnce({ broker: fakeBroker(view('new')), execConfig: PAPER_CFG, leaseOpts: { takeoverStale: true } });
  check('PR-12', s.ran === false && s.reason === 'lease_held',
    'a FRESH lease is never taken over, even with takeoverStale=true');
  releaseLease(held.lease);
});

// ─── PR-13: store contract intact — reconcile→poll chain runs end-to-end ─────────
await withEnv('pr13', async () => {
  seed('cid_adopt', { state: 'submit_unknown', broker_order_id: null });
  await runPaperCycleOnce({ broker: fakeBroker(view('new', { broker_order_id: 'B_z' })), execConfig: PAPER_CFG });
  const r = get('cid_adopt');
  // reconcile adopts submit_unknown→submitted, THEN poll advances submitted→acknowledged (broker 'new') in the same cycle.
  check('PR-13', r.state === 'acknowledged' && r.broker_order_id === 'B_z',
    'cycle drove both workers: submit_unknown → (reconcile) submitted → (poll) acknowledged; store contract intact');
});

// ─── PR-14: readLease reflects acquire/release lifecycle ─────────────────────────
await withEnv('pr14', async () => {
  check('PR-14a', readLease().present === false, 'no lease before acquire');
  const a = acquireLease({});
  check('PR-14b', readLease().present === true && readLease().lease.lease_id === a.lease.lease_id, 'lease readable after acquire');
  releaseLease(a.lease);
  check('PR-14c', readLease().present === false, 'lease gone after release');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_runner_step7_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
