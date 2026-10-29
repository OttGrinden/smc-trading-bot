#!/usr/bin/env node
/**
 * ProtectiveExitPass — Phase 1 / Unit 19 tests (PEP-01 … PEP-08).
 *
 * Verifies the thin standalone pass: open positions → buildProtectiveExits →
 * dispatchProtectiveExits. Pure-flow cases inject the dispatcher/loader; the E2E cases
 * use the REAL planner + REAL dispatcher with a temp OrderStore + fake broker.
 *
 * Fully offline + deterministic. No network, no live, no portfolio mutation.
 *
 * node scripts/execution/tests/protective_exit_pass_step19_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { runProtectiveExitPassOnce } from '../live_broker/protective_exit_pass.mjs';
import { _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threw(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `protexitpass_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
mkdirSync(ROOT, { recursive: true });

// A persisted open position (portfolio_state.open_positions shape, as buildProtectiveExits needs).
const position = (over = {}) => ({ symbol: 'AMAT', side: 'long', quantity: 2, entry_price_usd: 100, stop_loss_pct: 8, order_id: 'o_AMAT', ...over });

function fakeBroker() {
  const seen = { submit: [] };
  return { seen,
    async submitOrder(req) { seen.submit.push(req); return { provider: 'alpaca', client_order_id: req.client_order_id, broker_order_id: 'B_' + req.client_order_id, broker_status: 'accepted' }; },
    async getOrderByClientId() { return null; } };
}
// Spy dispatcher: records the plans it received; returns a canned summary.
function spyDispatch() {
  const calls = [];
  const fn = async (plans, _ctx) => { calls.push(plans); return { total: plans.length, submitted: plans.length, already_dispatched: 0, skipped: 0, blocked_by_gate: 0, submit_uncertain: 0, rejected: 0, errored: 0, results: [] }; };
  return { fn, calls };
}
function withStore(tag, fn) {
  const dir = join(ROOT, tag);
  mkdirSync(dir, { recursive: true });
  _setOrderStorePaths({ dir, eventsLog: join(dir, 'live_order_events.jsonl') });
  return Promise.resolve(fn()).finally(() => _clearOrderStorePaths());
}

// ─── PEP-01: injected positions → real planner → dispatcher receives correct plans ─
{
  const sp = spyDispatch();
  const b = fakeBroker();
  const s = await runProtectiveExitPassOnce({ broker: b, positions: [position()], _dispatchProtectiveExits: sp.fn });
  const plan = sp.calls[0]?.[0];
  check('PEP-01',
    s.positions_in === 1 && s.planned === 1 && sp.calls.length === 1 &&
    plan && plan.order_type === 'stop' && plan.stop_price_usd === 92 && plan.order_action === 'sell' &&
    plan.action === 'close' && plan.client_order_id === 'protect_v1_AMAT_long' && plan.time_in_force === 'gtc',
    'injected position → planner → dispatcher: close-side stop@92, protect_v1 cid, gtc');
}

// ─── PEP-02: missing broker → throw (pre-flight) ────────────────────────────────
{
  const threwE = await threw(() => runProtectiveExitPassOnce({ positions: [position()] }));
  check('PEP-02', threwE === true, 'fehlender Broker → throw vor jeder Arbeit (fail-closed)');
}

// ─── PEP-03: positions via injected loader (used when ctx.positions absent) ──────
{
  const sp = spyDispatch();
  const b = fakeBroker();
  const loader = () => [position({ symbol: 'GD', side: 'short', order_action: undefined })];
  const s = await runProtectiveExitPassOnce({ broker: b, _loadOpenPositions: loader, _dispatchProtectiveExits: sp.fn });
  check('PEP-03',
    s.positions_in === 1 && s.planned === 1 && sp.calls[0][0].symbol === 'GD' && sp.calls[0][0].order_action === 'buy_to_cover',
    'ctx.positions fehlt → injizierter Loader genutzt (GD short → buy_to_cover)');
}

// ─── PEP-04: non-array positions → fail-closed throw ────────────────────────────
{
  const b = fakeBroker();
  const threwE = await threw(() => runProtectiveExitPassOnce({ broker: b, _loadOpenPositions: () => ({ not: 'array' }) }));
  check('PEP-04', threwE === true, 'positions kein Array → throw (fail-closed, nicht still als leer behandelt)');
}

// ─── PEP-05: empty positions → planned 0, dispatch([]) , kein throw ─────────────
{
  const sp = spyDispatch();
  const b = fakeBroker();
  const s = await runProtectiveExitPassOnce({ broker: b, positions: [], _dispatchProtectiveExits: sp.fn });
  check('PEP-05',
    s.positions_in === 0 && s.planned === 0 && sp.calls.length === 1 && sp.calls[0].length === 0 && s.dispatch.submitted === 0,
    'leere Positionen → planned 0, dispatch mit [] aufgerufen, kein throw');
}

// ─── PEP-06: planner-skip für unbrauchbare Position → nur valide dispatcht ───────
{
  const sp = spyDispatch();
  const b = fakeBroker();
  const s = await runProtectiveExitPassOnce({ broker: b, positions: [position(), position({ symbol: 'BAD', stop_loss_pct: undefined })], _dispatchProtectiveExits: sp.fn });
  check('PEP-06',
    s.positions_in === 2 && s.planned === 1 && s.plan_skipped === 1 && sp.calls[0].length === 1 && sp.calls[0][0].symbol === 'AMAT',
    'Position ohne stop_loss_pct → planner-skip; nur valide (AMAT) dispatcht');
}

// ─── PEP-07: END-TO-END real planner + real dispatcher + temp store + fake broker ─
await withStore('pep07', async () => {
  const b = fakeBroker();
  const s = await runProtectiveExitPassOnce({ broker: b, positions: [position(), position({ symbol: 'GD', side: 'short', order_id: 'o_GD' })] });
  const cids = b.seen.submit.map(r => r.client_order_id).sort();
  check('PEP-07',
    s.planned === 2 && s.dispatch.submitted === 2 && b.seen.submit.length === 2 &&
    b.seen.submit.every(r => r.order_type === 'stop' && Number.isFinite(r.stop_price)) &&
    cids[0] === 'protect_v1_AMAT_long' && cids[1] === 'protect_v1_GD_short',
    'E2E: 2 Positionen → 2 stop-Submits (protect_v1 cids, stop_price gesetzt)');
});

// ─── PEP-08: idempotenz E2E — zweiter Lauf → already_dispatched, kein 2. Submit ──
await withStore('pep08', async () => {
  const b = fakeBroker();
  await runProtectiveExitPassOnce({ broker: b, positions: [position()] });
  const s2 = await runProtectiveExitPassOnce({ broker: b, positions: [position()] });
  check('PEP-08',
    b.seen.submit.length === 1 && s2.dispatch.already_dispatched === 1 && s2.dispatch.submitted === 0,
    'zweiter Pass → dispatcher already_dispatched (Store-cid), kein zweiter Submit (idempotent)');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nprotective_exit_pass_step19_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
