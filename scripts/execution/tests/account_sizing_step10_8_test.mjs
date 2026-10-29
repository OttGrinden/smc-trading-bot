#!/usr/bin/env node
/**
 * AccountSizing — Phase 1 / Unit 10.8 tests (AS-01 … AS-13).
 *
 * Pure + deterministic + offline: no store, no broker, no network. The function under
 * test takes intents + an account snapshot and returns sized/skipped results.
 *
 * node scripts/execution/tests/account_sizing_step10_8_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { sizeIntentsFromAccount } from '../live_broker/account_sizing.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const ACCT = (over = {}) => ({ provider: 'alpaca', currency: 'USD', cash: 10000, buying_power: 10000, portfolio_value: 10000, equity: 10000, status: 'ACTIVE', paper: true, ...over });
const INTENT = (over = {}) => ({ symbol: 'AMAT', side: 'long', price_usd: 100, asset_type: 'stock', run_id: 'run_as', decision_source: { decision_id: 'd_AMAT', intent_id: 'i_AMAT' }, ...over });

// ─── AS-01: valid sizing — risk fraction binds ───────────────────────────────────
{
  const s = sizeIntentsFromAccount([INTENT()], ACCT(), { risk_per_trade_pct: 0.02, max_position_notional_usd: 1000 });
  const z = s.sized[0];
  check('AS-01',
    s.account_ok && s.totals.sized === 1 && z && near(z.quantity, 2) && z.action === 'open' &&
    z.side === 'long' && z.run_id === 'run_as' && z.sizing.capped_by === 'risk_fraction',
    'equity 10000 · 2% · price 100 → qty 2, capped_by risk_fraction');
}

// ─── AS-02: buying-power cap binds ────────────────────────────────────────────────
{
  const s = sizeIntentsFromAccount([INTENT()], ACCT({ buying_power: 50 }), { risk_per_trade_pct: 0.02, max_position_notional_usd: 1000 });
  const z = s.sized[0];
  check('AS-02',
    s.totals.sized === 1 && near(z.quantity, 0.5) && z.sizing.capped_by === 'buying_power' &&
    near(s.buying_power_remaining, 0),
    'buying_power 50 binds → qty 0.5, capped_by buying_power, remaining 0');
}

// ─── AS-03: max-position cap binds ────────────────────────────────────────────────
{
  const s = sizeIntentsFromAccount([INTENT()], ACCT(), { risk_per_trade_pct: 0.02, max_position_notional_usd: 100 });
  const z = s.sized[0];
  check('AS-03',
    s.totals.sized === 1 && near(z.quantity, 1) && z.sizing.capped_by === 'max_position_notional',
    'max_position_notional 100 binds → qty 1, capped_by max_position_notional');
}

// ─── AS-04: account missing → all rejected, nothing sized ─────────────────────────
{
  const s = sizeIntentsFromAccount([INTENT()], null);
  check('AS-04',
    s.account_ok === false && s.account_reason === 'account_missing' &&
    s.sized.length === 0 && s.skipped.length === 1 && s.skipped[0].reason === 'account_missing',
    'null account → account_missing, 0 sized, intent skipped with reason');
}

// ─── AS-05: account not ACTIVE → rejected ─────────────────────────────────────────
{
  const s = sizeIntentsFromAccount([INTENT()], ACCT({ status: 'ACCOUNT_CLOSED' }));
  check('AS-05',
    s.account_ok === false && s.account_reason === 'account_not_active' && s.sized.length === 0,
    'status ACCOUNT_CLOSED → account_not_active, 0 sized');
}

// ─── AS-06: implausible account (negative / NaN) → account_invalid ────────────────
{
  const negBp  = sizeIntentsFromAccount([INTENT()], ACCT({ buying_power: -5 }));
  const nanEq  = sizeIntentsFromAccount([INTENT()], ACCT({ equity: NaN }));
  check('AS-06',
    negBp.account_reason === 'account_invalid' && nanEq.account_reason === 'account_invalid' &&
    negBp.sized.length === 0 && nanEq.sized.length === 0,
    'negative buying_power and NaN equity → account_invalid, 0 sized');
}

// ─── AS-07: non-positive price intent → skip(non_positive_price), account ok ──────
{
  const s = sizeIntentsFromAccount([INTENT({ price_usd: 0 })], ACCT());
  check('AS-07',
    s.account_ok === true && s.sized.length === 0 && s.skipped[0].reason === 'non_positive_price',
    'price 0 → skip(non_positive_price), account_ok true');
}

// ─── AS-08: insufficient buying power (remaining < min_notional) ──────────────────
{
  const s = sizeIntentsFromAccount([INTENT()], ACCT({ buying_power: 0.5 }), { min_notional_usd: 1 });
  check('AS-08',
    s.sized.length === 0 && s.skipped[0].reason === 'insufficient_buying_power',
    'buying_power 0.5 < min_notional 1 → skip(insufficient_buying_power)');
}

// ─── AS-09: below min notional (risk fraction too small, bp ample) ────────────────
{
  const s = sizeIntentsFromAccount([INTENT()], ACCT({ equity: 10, buying_power: 10000 }), { risk_per_trade_pct: 0.02, min_notional_usd: 1 });
  // target = min(0.02*10=0.2, cap, 10000) = 0.2 < 1
  check('AS-09',
    s.sized.length === 0 && s.skipped[0].reason === 'below_min_notional',
    'risk fraction yields 0.2 < min_notional 1 (bp ample) → skip(below_min_notional)');
}

// ─── AS-10: cumulative buying-power budget across intents ─────────────────────────
{
  const s = sizeIntentsFromAccount(
    [INTENT({ symbol: 'AAA' }), INTENT({ symbol: 'BBB' })],
    ACCT({ buying_power: 250 }),
    { risk_per_trade_pct: 0.02, max_position_notional_usd: 1000 },   // 0.02*10000 = 200 each
  );
  // first: target 200 → qty 2, remaining 50 ; second: target min(200,1000,50)=50 → qty 0.5 capped_by buying_power
  const a = s.sized.find(z => z.symbol === 'AAA');
  const b = s.sized.find(z => z.symbol === 'BBB');
  check('AS-10',
    s.totals.sized === 2 && near(a.quantity, 2) && near(b.quantity, 0.5) &&
    b.sizing.capped_by === 'buying_power' && near(s.buying_power_remaining, 0),
    'two intents, bp 250 → 200 + 50 (cumulative budget), remaining 0');
}

// ─── AS-11: currency mismatch → account_currency_unsupported ──────────────────────
{
  const s = sizeIntentsFromAccount([INTENT()], ACCT({ currency: 'EUR' }));
  check('AS-11',
    s.account_ok === false && s.account_reason === 'account_currency_unsupported' && s.sized.length === 0,
    'currency EUR → account_currency_unsupported, 0 sized');
}

// ─── AS-12: deterministic + dispatch-ready shape ──────────────────────────────────
{
  const s1 = sizeIntentsFromAccount([INTENT()], ACCT());
  const s2 = sizeIntentsFromAccount([INTENT()], ACCT());
  const z = s1.sized[0];
  const dispatchReady = z && typeof z.symbol === 'string' && (z.side === 'long' || z.side === 'short') &&
    z.action === 'open' && Number.isFinite(z.quantity) && z.quantity > 0 && z.run_id != null;
  check('AS-12',
    JSON.stringify(s1) === JSON.stringify(s2) && dispatchReady,
    'identical inputs → identical output; sized intent has dispatchApproved shape');
}

// ─── AS-13: NO stop/bracket semantics leak into sized intents (scope lock) ────────
{
  const s = sizeIntentsFromAccount([INTENT()], ACCT());
  const z = s.sized[0];
  const noBracket = !('stop_loss_pct' in z) && !('stop_price' in z) && !('bracket' in z) &&
    !('take_profit' in z) && !('stop_loss' in z);
  check('AS-13', noBracket, 'sized intent carries NO stop/bracket fields (10.9 not anticipated)');
}

// ─── AS-14: USDT account (Bitunix) is accepted — same sizing as USD ──────────────
// USDT is a USD stablecoin; Bitunix accounts are USDT-denominated.
{
  const s = sizeIntentsFromAccount([INTENT()], ACCT({ currency: 'USDT', provider: 'bitunix', paper: false }));
  check('AS-14',
    s.account_ok && s.totals.sized === 1,
    'USDT account (Bitunix) accepted → account_ok=true, sizing proceeds normally');
}

// ─── AS-15: lowercase 'active' status accepted (Bitunix returns 'active', not 'ACTIVE') ─
{
  const s = sizeIntentsFromAccount([INTENT()], ACCT({ status: 'active' }));
  check('AS-15',
    s.account_ok && s.totals.sized === 1,
    'lowercase status "active" accepted (case-insensitive check)');
}

// ─── Summary ───────────────────────────────────────────────────────────────────
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nAccountSizing (Unit 10.8): ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed === 0 ? 0 : 1);
