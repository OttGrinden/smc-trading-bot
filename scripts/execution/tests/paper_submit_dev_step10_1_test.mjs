#!/usr/bin/env node
/**
 * paper_submit_dev — Phase 1 / Unit 10.1 tests (PSD-01 … PSD-07).
 *
 * Offline: temp OrderStore (_setOrderStorePaths) + temp lease (_setLeasePath) +
 * injected fake broker. No network. Verifies the dev/smoke submit entrypoint:
 *   gate off → submit; gate on + unsafe → fail-closed block (no submit, no anchor);
 *   gate on + clean → submit; invalid args / config not enabled → exit 2; dry-run → no submit.
 *
 * node scripts/execution/tests/paper_submit_dev_step10_1_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync } from 'fs';
import { join }      from 'path';
import { tmpdir }    from 'os';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import { upsert, exists, get, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { _setLeasePath, _clearLeasePath } from '../live_broker/run_lease.mjs';
import { runPaperSubmitDevOnce, submitDevExitCode } from '../live_broker/paper_submit_dev.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const ROOT = join(tmpdir(), `psd101_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

async function withEnv(tag, fn) {
  const d = join(ROOT, tag);
  mkdirSync(d, { recursive: true });
  _setOrderStorePaths({ dir: d, eventsLog: join(d, 'live_order_events.jsonl') });
  _setLeasePath(join(d, '.paper_runner.lease'));
  try { return await fn(d); } finally { _clearOrderStorePaths(); _clearLeasePath(); }
}

const ENV = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' };   // enables alpaca_paper in parseBrokerExecConfig
const BASE = ['--broker-exec', 'alpaca_paper', '--symbol', 'AAPL', '--qty', '1', '--action', 'buy'];

function seed(cid, over = {}) {
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol: 'AAPL', side: 'long', asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_x', action: 'open', order_action: 'buy', qty: 10 },
  );
  upsert({ ...r, ...over });
}
function fakeBroker(getView) {
  const calls = { submitOrder: 0, getOrderByClientId: 0 };
  return {
    calls,
    async submitOrder(req)  { calls.submitOrder += 1; return { provider: 'alpaca', client_order_id: req.client_order_id, broker_order_id: 'NB_' + req.client_order_id, broker_status: 'accepted', filled_qty: 0, avg_fill_price: null }; },
    async getOrderByClientId(cid) { calls.getOrderByClientId += 1; const v = typeof getView === 'function' ? getView(cid) : getView; return v === undefined ? null : v; },
  };
}

// ─── PSD-01: gate OFF (default) → submit proceeds, no gate IO ──────────────────
await withEnv('psd01', async () => {
  const b = fakeBroker(undefined);
  const s = await runPaperSubmitDevOnce({ argv: [...BASE, '--client-order-id', 'cid_off'], env: ENV, broker: b });
  check('PSD-01',
    s.ok === true && s.exit_code === 0 && submitDevExitCode(s) === 0
    && b.calls.submitOrder === 1 && b.calls.getOrderByClientId === 0
    && exists('cid_off') && get('cid_off').state === 'submitted',
    'gate off → one submit, record submitted, no gate lease/getOrder IO');
});

// ─── PSD-02: gate ON + unsafe store → fail-closed block, no submit, no anchor ──
await withEnv('psd02', async () => {
  seed('cid_bad', { state: 'submit_unknown', broker_order_id: 'B' });   // broker won't know it → stays blocking
  const b = fakeBroker(undefined);
  const s = await runPaperSubmitDevOnce({ argv: [...BASE, '--client-order-id', 'cid_new', '--startup-gate', 'on'], env: ENV, broker: b });
  check('PSD-02',
    s.ok === false && s.blocked_by_startup_gate === true && s.exit_code === 2
    && b.calls.submitOrder === 0 && !exists('cid_new'),
    'gate on + unsafe → blocked_by_startup_gate (exit 2), no submitOrder, no anchor for new cid');
});

// ─── PSD-03: gate ON + clean store → safe → submit proceeds ───────────────────
await withEnv('psd03', async () => {
  const b = fakeBroker(undefined);
  const s = await runPaperSubmitDevOnce({ argv: [...BASE, '--client-order-id', 'cid_safe', '--startup-gate', 'on'], env: ENV, broker: b });
  check('PSD-03',
    s.ok === true && s.exit_code === 0 && b.calls.submitOrder === 1
    && exists('cid_safe') && get('cid_safe').state === 'submitted',
    'gate on + clean store → safe → submit proceeds (exit 0)');
});

// ─── PSD-04: invalid args → exit 2, no submit ─────────────────────────────────
await withEnv('psd04', async () => {
  const b = fakeBroker(undefined);
  const qty0    = await runPaperSubmitDevOnce({ argv: ['--broker-exec', 'alpaca_paper', '--symbol', 'AAPL', '--qty', '0', '--action', 'buy'], env: ENV, broker: b });
  const noSym   = await runPaperSubmitDevOnce({ argv: ['--broker-exec', 'alpaca_paper', '--qty', '1', '--action', 'buy'], env: ENV, broker: b });
  const badAct  = await runPaperSubmitDevOnce({ argv: [...BASE.slice(0, 6), '--action', 'long'], env: ENV, broker: b });
  const badGate = await runPaperSubmitDevOnce({ argv: [...BASE, '--startup-gate', 'maybe'], env: ENV, broker: b });
  check('PSD-04',
    qty0.exit_code === 2 && noSym.exit_code === 2 && badAct.exit_code === 2 && badGate.exit_code === 2
    && [qty0, noSym, badAct, badGate].every(s => s.ok === false && s.error?.reason === 'invalid_args')
    && b.calls.submitOrder === 0,
    'qty<=0 / missing symbol / bad action / bad gate flag → exit 2 invalid_args, no submit');
});

// ─── PSD-05: dry-run → validated, no submit, no anchor ────────────────────────
await withEnv('psd05', async () => {
  const b = fakeBroker(undefined);
  const s = await runPaperSubmitDevOnce({ argv: [...BASE, '--client-order-id', 'cid_dry', '--dry-run', '--startup-gate', 'on'], env: ENV, broker: b });
  check('PSD-05',
    s.ok === true && s.dry_run === true && s.exit_code === 0
    && b.calls.submitOrder === 0 && b.calls.getOrderByClientId === 0 && !exists('cid_dry'),
    'dry-run → exit 0, no submit, no gate IO, no anchor');
});

// ─── PSD-06: broker-exec not enabled → fail-closed exit 2 ─────────────────────
await withEnv('psd06', async () => {
  const b = fakeBroker(undefined);
  const s = await runPaperSubmitDevOnce({ argv: ['--symbol', 'AAPL', '--qty', '1', '--action', 'buy'], env: {}, broker: b });
  check('PSD-06',
    s.ok === false && s.exit_code === 2 && s.error?.reason === 'broker_exec_not_enabled' && b.calls.submitOrder === 0,
    'no --broker-exec / BROKER_EXEC → broker_exec_not_enabled (exit 2), no submit');
});

// ─── PSD-07: limit order requires limit-price ─────────────────────────────────
await withEnv('psd07', async () => {
  const b = fakeBroker(undefined);
  const noLimit = await runPaperSubmitDevOnce({ argv: [...BASE, '--type', 'limit'], env: ENV, broker: b });
  const okLimit = await runPaperSubmitDevOnce({ argv: [...BASE, '--client-order-id', 'cid_lim', '--type', 'limit', '--limit-price', '190.5'], env: ENV, broker: b });
  check('PSD-07',
    noLimit.exit_code === 2 && noLimit.error?.reason === 'invalid_args'
    && okLimit.ok === true && okLimit.exit_code === 0 && b.calls.submitOrder === 1 && get('cid_lim').state === 'submitted',
    'limit without --limit-price → exit 2; with valid limit-price → submit proceeds');
});

// ─── PSD-08: auto CID is CID-safe, smoke_-prefixed, capped at 48 chars ────────
await withEnv('psd08', async () => {
  const b = fakeBroker(undefined);
  const longSym = 'X'.repeat(40) + '.B';   // forces normalization (.) + length cap
  const s = await runPaperSubmitDevOnce({ argv: ['--broker-exec', 'alpaca_paper', '--symbol', longSym, '--qty', '1', '--action', 'buy', '--dry-run'], env: ENV, broker: b });
  const cid = s.client_order_id ?? '';
  check('PSD-08',
    s.ok === true && s.dry_run === true
    && cid.startsWith('smoke_') && cid.length <= 48 && /^[A-Za-z0-9_-]+$/.test(cid)
    && b.calls.submitOrder === 0,
    'auto CID: smoke_-prefixed, CID-safe charset, length <= 48 (normalization + cap)');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_submit_dev_step10_1_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
