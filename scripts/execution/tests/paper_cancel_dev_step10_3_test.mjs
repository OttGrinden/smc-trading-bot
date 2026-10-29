#!/usr/bin/env node
/**
 * paper_cancel_dev — Phase 1 / Unit 10.3 tests (PCD-01 … PCD-09).
 *
 * Offline: temp OrderStore (_setOrderStorePaths) + injected fake broker (cancelOrder spy).
 * No network. Verifies the dev/smoke cancel entrypoint: real path delegates to
 * requestCancel; dry-run is preview-only; fail-closed exit codes.
 *
 * node scripts/execution/tests/paper_cancel_dev_step10_3_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync } from 'fs';
import { join }      from 'path';
import { tmpdir }    from 'os';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import { upsert, get, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { runPaperCancelDevOnce, cancelDevExitCode } from '../live_broker/paper_cancel_dev.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const ROOT = join(tmpdir(), `pcd103_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

async function withEnv(tag, fn) {
  const d = join(ROOT, tag);
  mkdirSync(d, { recursive: true });
  _setOrderStorePaths({ dir: d, eventsLog: join(d, 'live_order_events.jsonl') });
  try { return await fn(d); } finally { _clearOrderStorePaths(); }
}

const ENV  = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' };
const BASE = ['--broker-exec', 'alpaca_paper'];

function seed(cid, state, over = {}) {
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol: 'AAPL', side: 'long', asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_x', action: 'open', order_action: 'buy', qty: 10 },
  );
  upsert({ ...r, state, broker_order_id: 'B_' + cid, ...over });
}
function fakeBroker() {
  const calls = { cancelOrder: [] };
  return { calls, async cancelOrder(id) { calls.cancelOrder.push(id); return { accepted: true, http_status: 204 }; } };
}

// ─── PCD-01: cancelable (acknowledged) → cancel_requested, exit 0, one cancel ─
await withEnv('pcd01', async () => {
  seed('cid_ack', 'acknowledged');
  const b = fakeBroker();
  const s = await runPaperCancelDevOnce({ argv: [...BASE, '--client-order-id', 'cid_ack'], env: ENV, broker: b });
  check('PCD-01',
    s.ok === true && s.outcome === 'cancel_requested' && s.state === 'cancel_pending'
    && s.exit_code === 0 && cancelDevExitCode(s) === 0
    && b.calls.cancelOrder.length === 1 && get('cid_ack').state === 'cancel_pending',
    'cancelable → requestCancel cancel_requested, one DELETE, exit 0, record cancel_pending');
});

// ─── PCD-02: missing --client-order-id → exit 2, no cancel ────────────────────
await withEnv('pcd02', async () => {
  const b = fakeBroker();
  const s = await runPaperCancelDevOnce({ argv: [...BASE], env: ENV, broker: b });
  check('PCD-02',
    s.ok === false && s.exit_code === 2 && s.error?.reason === 'invalid_args' && b.calls.cancelOrder.length === 0,
    'missing cid → exit 2 invalid_args, no cancel');
});

// ─── PCD-03: record missing → exit 2 (not_found_local), no cancel ─────────────
await withEnv('pcd03', async () => {
  const b = fakeBroker();
  const s = await runPaperCancelDevOnce({ argv: [...BASE, '--client-order-id', 'cid_ghost'], env: ENV, broker: b });
  check('PCD-03',
    s.ok === false && s.outcome === 'not_found_local' && s.exit_code === 2 && b.calls.cancelOrder.length === 0,
    'unknown cid → not_found_local (exit 2), no cancel');
});

// ─── PCD-04: terminal filled → exit 2 (not_cancelable_terminal), no cancel ────
await withEnv('pcd04', async () => {
  seed('cid_fill', 'filled');
  const b = fakeBroker();
  const s = await runPaperCancelDevOnce({ argv: [...BASE, '--client-order-id', 'cid_fill'], env: ENV, broker: b });
  check('PCD-04',
    s.ok === false && s.outcome === 'not_cancelable_terminal' && s.exit_code === 2 && b.calls.cancelOrder.length === 0,
    'filled → not_cancelable_terminal (exit 2), no cancel');
});

// ─── PCD-05: dry-run on cancelable → exit 0, preview cancel_requested, no cancel
await withEnv('pcd05', async () => {
  seed('cid_dry', 'acknowledged');
  const b = fakeBroker();
  const s = await runPaperCancelDevOnce({ argv: [...BASE, '--client-order-id', 'cid_dry', '--dry-run'], env: ENV, broker: b });
  check('PCD-05',
    s.ok === true && s.dry_run === true && s.cancelable === true && s.preview_outcome === 'cancel_requested'
    && s.exit_code === 0 && b.calls.cancelOrder.length === 0 && get('cid_dry').state === 'acknowledged',
    'dry-run cancelable → exit 0 preview cancel_requested, no DELETE, record unchanged');
});

// ─── PCD-06: already cancelled → ok no-op, exit 0, no cancel ──────────────────
await withEnv('pcd06', async () => {
  seed('cid_cd', 'cancelled');
  const b = fakeBroker();
  const s = await runPaperCancelDevOnce({ argv: [...BASE, '--client-order-id', 'cid_cd'], env: ENV, broker: b });
  check('PCD-06',
    s.ok === true && s.outcome === 'already_cancelled' && s.exit_code === 0 && b.calls.cancelOrder.length === 0,
    'cancelled → already_cancelled no-op (exit 0), no cancel');
});

// ─── PCD-07: dry-run record missing → exit 2 ──────────────────────────────────
await withEnv('pcd07', async () => {
  const b = fakeBroker();
  const s = await runPaperCancelDevOnce({ argv: [...BASE, '--client-order-id', 'cid_ghost', '--dry-run'], env: ENV, broker: b });
  check('PCD-07',
    s.ok === false && s.dry_run === true && s.preview_outcome === 'not_found_local' && s.exit_code === 2 && b.calls.cancelOrder.length === 0,
    'dry-run unknown cid → preview not_found_local (exit 2), no cancel');
});

// ─── PCD-08: broker-exec not enabled → exit 2, no cancel ──────────────────────
await withEnv('pcd08', async () => {
  const b = fakeBroker();
  const s = await runPaperCancelDevOnce({ argv: ['--client-order-id', 'cid_x'], env: {}, broker: b });
  check('PCD-08',
    s.ok === false && s.exit_code === 2 && s.error?.reason === 'broker_exec_not_enabled' && b.calls.cancelOrder.length === 0,
    'no --broker-exec → broker_exec_not_enabled (exit 2), no cancel');
});

// ─── PCD-09: dry-run on cancel_pending → preview already_cancel_pending ───────
await withEnv('pcd09', async () => {
  seed('cid_cp', 'cancel_pending');
  const b = fakeBroker();
  const s = await runPaperCancelDevOnce({ argv: [...BASE, '--client-order-id', 'cid_cp', '--dry-run'], env: ENV, broker: b });
  check('PCD-09',
    s.ok === true && s.dry_run === true && s.preview_outcome === 'already_cancel_pending'
    && s.cancelable === false && s.exit_code === 0 && b.calls.cancelOrder.length === 0,
    'dry-run cancel_pending → preview already_cancel_pending (exit 0), no cancel');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_cancel_dev_step10_3_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
