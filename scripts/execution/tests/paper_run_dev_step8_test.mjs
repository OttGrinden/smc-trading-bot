#!/usr/bin/env node
/**
 * paper_run_dev — Phase 1 / Unit 8 dev/test entrypoint tests (U8-01 … U8-10).
 *
 * Fully offline: injected fake broker + injected runner spy; the end-to-end case uses
 * the real runner against a temp OrderStore + temp lease + fake broker. No network.
 *
 * node scripts/execution/tests/paper_run_dev_step8_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { join }   from 'path';
import { tmpdir } from 'os';
import { mkdirSync } from 'fs';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import { upsert, get, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { _setLeasePath, _clearLeasePath } from '../live_broker/run_lease.mjs';
import { runDevPaperCycle, devExitCode } from '../live_broker/paper_run_dev.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwAsync(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `paperrundev_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

// Valid paper config via env (parseBrokerExecConfig defaults to the paper endpoint).
const PAPER_ENV = { BROKER_EXEC: 'alpaca_paper', ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' };

function fakeBroker(viewOrFn) {
  const calls = { getOrderByClientId: 0, submitOrder: 0 };
  return {
    calls,
    async getOrderByClientId(cid) {
      calls.getOrderByClientId += 1;
      const v = typeof viewOrFn === 'function' ? viewOrFn(cid) : viewOrFn;
      return v === undefined ? null : v;
    },
    async submitOrder() { calls.submitOrder += 1; throw new Error('submitOrder must not be called by Unit 8'); },
  };
}
const view = (status, over = {}) => ({ provider: 'alpaca', broker_order_id: 'B', broker_status: status, filled_qty: 0, avg_fill_price: null, ...over });

// Runner spy: records calls + the ctx it received; returns a canned summary.
function runnerSpy(summary = { ran: true, reason: 'completed', reconcile: {}, poll: {}, lease: {} }) {
  const calls = [];
  const fn = async (ctx) => { calls.push(ctx); return summary; };
  fn.calls = calls;
  return fn;
}

// ─── U8-01: valid paper config → EXACTLY one runner call with {broker, execConfig} ─
await (async () => {
  const spy = runnerSpy();
  const b = fakeBroker(view('new'));
  const s = await runDevPaperCycle({ argv: [], env: PAPER_ENV, broker: b, runner: spy });
  check('U8-01',
    spy.calls.length === 1 && spy.calls[0].broker === b
    && spy.calls[0].execConfig.mode === 'alpaca_paper' && spy.calls[0].execConfig.paper === true
    && s.ran === true,
    'valid paper config → exactly ONE runner call with injected broker + paper execConfig');
})();

// ─── U8-02: end-to-end with the REAL runner + fake broker (temp store/lease) ─────
await (async () => {
  const d = join(ROOT, 'u802'); mkdirSync(d, { recursive: true });
  _setOrderStorePaths({ dir: d, eventsLog: join(d, 'live_order_events.jsonl') });
  _setLeasePath(join(d, '.paper_runner.lease'));
  try {
    const r = makeBrokerOrderRecord(
      { intent_id: 'i', symbol: 'AMAT', side: 'long', asset_type: 'stock' }, { decision_id: 'd' },
      { client_order_id: 'cid_e2e', run_id: 'run_x', action: 'open', order_action: 'buy', qty: 10 },
    );
    upsert({ ...r, state: 'submit_unknown' });
    const s = await runDevPaperCycle({ env: PAPER_ENV, broker: fakeBroker(view('new', { broker_order_id: 'B_e2e' })) });
    check('U8-02',
      s.ran === true && s.reason === 'completed' && s.reconcile != null && s.poll != null
      && get('cid_e2e').broker_order_id === 'B_e2e',
      'end-to-end: real runner runs ONE cycle, reconcile+poll summaries present, record advanced');
  } finally { _clearOrderStorePaths(); _clearLeasePath(); }
})();

// ─── U8-03: OFF config (no flag) → fail-closed, runner NOT called ────────────────
await (async () => {
  const spy = runnerSpy();
  const threw = await threwAsync(() => runDevPaperCycle({ argv: [], env: {}, broker: fakeBroker(), runner: spy }));
  check('U8-03', threw && spy.calls.length === 0, 'disabled (off) config → throws fail-closed, runner not called');
})();

// ─── U8-04: ALPACA_PAPER=false → rejected by config guard, runner NOT called ─────
await (async () => {
  const spy = runnerSpy();
  const threw = await threwAsync(() => runDevPaperCycle({ env: { ...PAPER_ENV, ALPACA_PAPER: 'false' }, broker: fakeBroker(), runner: spy }));
  check('U8-04', threw && spy.calls.length === 0, 'ALPACA_PAPER=false → fail-closed, runner not called');
})();

// ─── U8-05: missing credentials → rejected, runner NOT called ────────────────────
await (async () => {
  const spy = runnerSpy();
  const threw = await threwAsync(() => runDevPaperCycle({ env: { BROKER_EXEC: 'alpaca_paper' }, broker: fakeBroker(), runner: spy }));
  check('U8-05', threw && spy.calls.length === 0, 'missing ALPACA_KEY_ID/SECRET → fail-closed, runner not called');
})();

// ─── U8-06: default makeBroker constructs a real AlpacaPaperBroker (no network) ───
await (async () => {
  const spy = runnerSpy();
  await runDevPaperCycle({ env: PAPER_ENV, runner: spy });   // no injected broker → makeBroker builds one
  const built = spy.calls[0].broker;
  check('U8-06',
    built && built.provider === 'alpaca' && built.mode === 'write_paper' && built.paper === true,
    'default makeBroker constructs a real AlpacaPaperBroker (paper, write_paper) without network');
})();

// ─── U8-07: runner error propagates as a controlled rejection ────────────────────
await (async () => {
  const boom = async () => { throw new Error('runner blew up'); };
  const threw = await threwAsync(() => runDevPaperCycle({ env: PAPER_ENV, broker: fakeBroker(), runner: boom }));
  check('U8-07', threw, 'a throwing runner propagates as a controlled rejection');
})();

// ─── U8-08: devExitCode mapping (ran → 0, otherwise → 1) ─────────────────────────
{
  check('U8-08',
    devExitCode({ ran: true }) === 0 && devExitCode({ ran: false }) === 1
    && devExitCode(null) === 1 && devExitCode({ ran: false, reason: 'lease_held' }) === 1,
    'devExitCode: ran→0; not-ran/lease-blocked/undefined→1');
}

// ─── U8-09: no loop — runner invoked exactly once per call ───────────────────────
await (async () => {
  const spy = runnerSpy();
  await runDevPaperCycle({ env: PAPER_ENV, broker: fakeBroker(), runner: spy });
  check('U8-09', spy.calls.length === 1, 'entrypoint invokes the cycle exactly once (no loop)');
})();

// ─── U8-10: guard failure means broker side-effects never happen ─────────────────
await (async () => {
  const spy = runnerSpy();
  const b = fakeBroker(view('new'));
  await threwAsync(() => runDevPaperCycle({ env: { BROKER_EXEC: 'alpaca_paper' /* no creds */ }, broker: b, runner: spy }));
  check('U8-10', spy.calls.length === 0 && b.calls.getOrderByClientId === 0 && b.calls.submitOrder === 0,
    'on guard failure: runner not called and broker never touched');
})();

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_run_dev_step8_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
