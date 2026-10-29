#!/usr/bin/env node
/**
 * ProtectiveExit — Phase 1 / Unit 10.9 tests (PE-01 … PE-12).
 *
 * Pure + deterministic + offline: no store, no broker, no network, no portfolio.
 * The function under test takes open positions and returns protective stop plans.
 *
 * node scripts/execution/tests/protective_exit_step10_9_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { buildProtectiveExits } from '../live_broker/protective_exit.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const POS = (over = {}) => ({ symbol: 'AMAT', side: 'long', quantity: 2, entry_price_usd: 100, stop_loss_pct: 8, order_id: 'paper_AMAT', ...over });

// ─── PE-01: long protective stop → sell stop below entry ──────────────────────────
{
  const s = buildProtectiveExits([POS()]);
  const z = s.protected[0];
  check('PE-01',
    s.totals.protected === 1 && z && z.order_action === 'sell' && z.action === 'close' &&
    z.order_type === 'stop' && z.time_in_force === 'gtc' && near(z.stop_price_usd, 92) &&
    near(z.quantity, 2) && z.client_order_id === 'protect_v1_AMAT_long',
    'long entry 100 · sl 8% → sell stop @ 92, gtc, cid protect_v1_AMAT_long');
}

// ─── PE-02: short protective stop → buy_to_cover stop above entry ─────────────────
{
  const s = buildProtectiveExits([POS({ symbol: 'TSLA', side: 'short', stop_loss_pct: 5, quantity: 3 })]);
  const z = s.protected[0];
  check('PE-02',
    s.totals.protected === 1 && z.order_action === 'buy_to_cover' && near(z.stop_price_usd, 105) &&
    near(z.quantity, 3) && z.client_order_id === 'protect_v1_TSLA_short',
    'short entry 100 · sl 5% → buy_to_cover stop @ 105');
}

// ─── PE-03: idempotency via existingProtectiveCids → already_protected, no plan ───
{
  const s = buildProtectiveExits([POS()], { existingProtectiveCids: ['protect_v1_AMAT_long'] });
  check('PE-03',
    s.totals.protected === 0 && s.totals.already_protected === 1 &&
    s.skipped[0].reason === 'already_protected',
    'already-protected position → already_protected, no duplicate plan');
}

// ─── PE-04: in-batch duplicate (same symbol+side) → 1 plan + 1 already_protected ──
{
  const s = buildProtectiveExits([POS(), POS({ quantity: 5 })]);
  check('PE-04',
    s.totals.protected === 1 && s.totals.already_protected === 1,
    'two positions same symbol+side in one batch → 1 protective plan, 1 already_protected');
}

// ─── PE-05: missing stop_loss_pct → skip(invalid_stop_loss_pct) ───────────────────
{
  const s = buildProtectiveExits([POS({ stop_loss_pct: null })]);
  check('PE-05',
    s.totals.protected === 0 && s.skipped[0].reason === 'invalid_stop_loss_pct',
    'missing stop_loss_pct → skip(invalid_stop_loss_pct), no plan');
}

// ─── PE-06: invalid entry price → skip(invalid_entry_price) ───────────────────────
{
  const s = buildProtectiveExits([POS({ entry_price_usd: 0 })]);
  check('PE-06',
    s.totals.protected === 0 && s.skipped[0].reason === 'invalid_entry_price',
    'entry 0 → skip(invalid_entry_price)');
}

// ─── PE-07: invalid quantity → skip(invalid_quantity) ─────────────────────────────
{
  const s = buildProtectiveExits([POS({ quantity: 0 })]);
  check('PE-07',
    s.totals.protected === 0 && s.skipped[0].reason === 'invalid_quantity',
    'qty 0 → skip(invalid_quantity)');
}

// ─── PE-08: stop_loss_pct out of range (>=100) → skip ─────────────────────────────
{
  const hi = buildProtectiveExits([POS({ stop_loss_pct: 100 })]);
  const lo = buildProtectiveExits([POS({ stop_loss_pct: 0 })]);
  check('PE-08',
    hi.totals.protected === 0 && hi.skipped[0].reason === 'invalid_stop_loss_pct' &&
    lo.totals.protected === 0 && lo.skipped[0].reason === 'invalid_stop_loss_pct',
    'stop_loss_pct 100 and 0 → skip(invalid_stop_loss_pct)');
}

// ─── PE-09: invalid side → skip(invalid_side) ─────────────────────────────────────
{
  const s = buildProtectiveExits([POS({ side: 'flat' })]);
  check('PE-09',
    s.totals.protected === 0 && s.skipped[0].reason === 'invalid_side',
    'side flat → skip(invalid_side)');
}

// ─── PE-10: deterministic + pure (no placement / no submitted-order fields) ───────
{
  const s1 = buildProtectiveExits([POS()]);
  const s2 = buildProtectiveExits([POS()]);
  const z = s1.protected[0];
  const noPlacement = !('broker_order_id' in z) && !('state' in z) && !('fills' in z) && !('events' in z);
  check('PE-10',
    JSON.stringify(s1) === JSON.stringify(s2) && noPlacement,
    'identical input → identical output; plan carries NO submitted-order fields (not placed)');
}

// ─── PE-11: mixed batch → exact counts (valid + invalid + already) ────────────────
{
  const s = buildProtectiveExits(
    [POS({ symbol: 'AAA' }), POS({ symbol: 'BBB', entry_price_usd: -1 }), POS({ symbol: 'CCC' })],
    { existingProtectiveCids: ['protect_v1_CCC_long'] },
  );
  check('PE-11',
    s.total === 3 && s.totals.protected === 1 && s.totals.already_protected === 1 &&
    s.totals.skipped === 2 && s.protected[0].symbol === 'AAA',
    'mixed batch → 1 protected (AAA), 1 invalid (BBB), 1 already_protected (CCC)');
}

// ─── PE-12: stop-price math both sides + rounding ─────────────────────────────────
{
  const s = buildProtectiveExits([
    POS({ symbol: 'L1', side: 'long',  entry_price_usd: 250, stop_loss_pct: 3 }),
    POS({ symbol: 'S1', side: 'short', entry_price_usd: 250, stop_loss_pct: 3 }),
  ]);
  const l = s.protected.find(z => z.symbol === 'L1');
  const sh = s.protected.find(z => z.symbol === 'S1');
  check('PE-12',
    near(l.stop_price_usd, 242.5) && near(sh.stop_price_usd, 257.5),
    'long 250·-3% → 242.5 ; short 250·+3% → 257.5');
}

// ─── Summary ───────────────────────────────────────────────────────────────────
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nProtectiveExit (Unit 10.9): ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed === 0 ? 0 : 1);
