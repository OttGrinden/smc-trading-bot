#!/usr/bin/env node
/**
 * StartupRecovery — Phase 1 / Unit 9c tests (SR-01 … SR-08).
 *
 * Isolated: temp OrderStore (_setOrderStorePaths) + temp lease (_setLeasePath) +
 * injected fake broker. Offline. Asserts the read-only gate exit-code contract
 * (0 safe / 2 fail-closed / 1 error) on the returned summary (no real process.exit).
 *
 * node scripts/execution/tests/startup_recovery_step9_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import { upsert, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { acquireLease, releaseLease, _setLeasePath, _clearLeasePath } from '../live_broker/run_lease.mjs';
import { runStartupRecoveryOnce } from '../live_broker/startup_recovery.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwAsync(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `startup9_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

async function withEnv(tag, fn) {
  const d = join(ROOT, tag);
  mkdirSync(d, { recursive: true });
  const leaseP = join(d, '.paper_runner.lease');
  _setOrderStorePaths({ dir: d, eventsLog: join(d, 'live_order_events.jsonl') });
  _setLeasePath(leaseP);
  try { return await fn(d, leaseP); } finally { _clearOrderStorePaths(); _clearLeasePath(); }
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

// ─── SR-01: clean store → safe, exit 0, lease released ────────────────────────
await withEnv('sr01', async (d, leaseP) => {
  seed('cid_done', { state: 'filled', terminal_at: new Date().toISOString() });  // settled → not scanned
  const s = await runStartupRecoveryOnce({ broker: fakeBroker(view('filled')), execConfig: PAPER_CFG });
  check('SR-01',
    s.ran === true && s.gate.safe === true && s.gate.blocking_count === 0 && s.exit_code === 0
    && s.lease.released === true && !existsSync(leaseP),
    'no blocking records → safe (exit 0), lease released');
});

// ─── SR-02: reconcile_hold the broker does not know → stays blocking → exit 2 ─
await withEnv('sr02', async () => {
  seed('cid_hold', { state: 'reconcile_hold', broker_order_id: 'B_h' });
  const s = await runStartupRecoveryOnce({ broker: fakeBroker(undefined /* not found */), execConfig: PAPER_CFG });
  check('SR-02',
    s.ran === true && s.gate.safe === false && s.gate.blocking_count >= 1 && s.exit_code === 2
    && s.gate.blocking.some(b => b.cid === 'cid_hold'),
    'unresolved reconcile_hold → fail-closed not safe (exit 2)');
});

// ─── SR-03: submit_unknown resolved by recovery → safe → exit 0 ───────────────
await withEnv('sr03', async () => {
  seed('cid_su', { state: 'submit_unknown', broker_order_id: null });
  // broker knows it as live ('new') → reconciler adopts submit_unknown → submitted (not blocking)
  const s = await runStartupRecoveryOnce({ broker: fakeBroker(view('new', { broker_order_id: 'B_ok' })), execConfig: PAPER_CFG });
  check('SR-03',
    s.ran === true && s.gate.safe === true && s.exit_code === 0,
    'recovery adopts submit_unknown → submitted → gate clears (exit 0)');
});

// ─── SR-04: lease held → fail-closed, no run, exit 2 ──────────────────────────
await withEnv('sr04', async () => {
  const held = acquireLease({});
  const b = fakeBroker(view('new'));
  const s = await runStartupRecoveryOnce({ broker: b, execConfig: PAPER_CFG });
  check('SR-04',
    s.ran === false && s.reason === 'lease_held' && s.exit_code === 2
    && s.gate.safe === false && b.calls.getOrderByClientId === 0,
    'fresh lease present → fail-closed (exit 2), no recovery run');
  releaseLease(held.lease);
});

// ─── SR-05: corrupt store record → reconcile throws → worker_error → exit 1 ───
await withEnv('sr05', async (d, leaseP) => {
  writeFileSync(join(d, 'cid_bad.json'), '{ broken', 'utf8');
  const s = await runStartupRecoveryOnce({ broker: fakeBroker(view('new')), execConfig: PAPER_CFG });
  check('SR-05',
    s.ran === false && s.reason === 'worker_error' && s.exit_code === 1
    && s.lease.released === true && !existsSync(leaseP),
    'corrupt record → unexpected error (exit 1), lease still released');
});

// ─── SR-06: pending_submit broker does not know → stays blocking → exit 2 ─────
await withEnv('sr06', async () => {
  seed('cid_ps', { state: 'pending_submit', broker_order_id: null });
  const s = await runStartupRecoveryOnce({ broker: fakeBroker(undefined), execConfig: PAPER_CFG });
  check('SR-06',
    s.ran === true && s.gate.safe === false && s.exit_code === 2
    && s.gate.blocking.some(b => b.cid === 'cid_ps'),
    'pending_submit unknown to broker → fail-closed not safe (exit 2)');
});

// ─── SR-07: a clean record carrying a reconcile_flag still blocks → exit 2 ────
await withEnv('sr07', async () => {
  // acknowledged (live, pollable) but flagged; broker still 'new' → flag not cleanly clearable here
  seed('cid_flag', { state: 'acknowledged', broker_order_id: 'B_f', reconcile_flag: 'broker_not_found' });
  const s = await runStartupRecoveryOnce({ broker: fakeBroker(undefined), execConfig: PAPER_CFG });
  check('SR-07',
    s.ran === true && s.gate.safe === false && s.exit_code === 2
    && s.gate.blocking.some(b => b.cid === 'cid_flag' && b.reconcile_flag != null),
    'unresolved reconcile_flag → fail-closed not safe (exit 2)');
});

// ─── SR-08: bad config / missing broker → throws before lease (fail-closed) ───
await withEnv('sr08', async (d, leaseP) => {
  const threwCfg    = await threwAsync(() => runStartupRecoveryOnce({ broker: fakeBroker(view('new')), execConfig: { enabled: false, mode: 'off' } }));
  const threwLive   = await threwAsync(() => runStartupRecoveryOnce({ broker: fakeBroker(view('new')), execConfig: { ...PAPER_CFG, paper: false } }));
  const threwBroker = await threwAsync(() => runStartupRecoveryOnce({ execConfig: PAPER_CFG }));
  check('SR-08',
    threwCfg && threwLive && threwBroker && !existsSync(leaseP),
    'disabled/non-paper config + missing broker → throw before lease, no lease file');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nstartup_recovery_step9_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
