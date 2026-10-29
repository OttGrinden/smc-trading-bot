#!/usr/bin/env node
/**
 * Conviction-based, stop-loss-derived sizing — test cases (CS-01 … CS-06).
 *
 *   risk_pct = convictionRiskPct(confidence_score_normalized)   [deterministic bands]
 *   target_notional = min( risk_pct × NAV / (stop_loss_pct/100), MAX_PCT × NAV )
 *
 * node scripts/execution/tests/conviction_sizing_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 *
 * Pure allocate() calls — no live state touched.
 */

import { initPortfolio } from '../portfolio/portfolio_state.mjs';
import { allocate, convictionRiskPct } from '../portfolio/allocation_engine.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
const near = (a, b, eps = 0.5) => Math.abs(a - b) < eps;

function makeState() { return initPortfolio(); }   // NAV 2000, cash 2000

function makeDecision(sym, { side = 'long', conf = 0.6, slPct = 5, sector = null } = {}) {
  return {
    intent: {
      intent_id: `intent_${sym}_${side}`, symbol: sym, side,
      asset_type: 'stock', price_usd: 108, sector,
      confidence_score_normalized: conf, technical_alignment: 'confirmed',
      technical: { age_minutes: 10 },
      risk: { stop_loss_pct: slPct, suggested_position_pct: 3 },
      signal_timestamp: new Date().toISOString(),
      intent_created_at: new Date().toISOString(),
    },
    decision: { decision_id: `dec_${sym}`, execution_ready: true, blocked_reasons: [] },
  };
}

// ─── CS-00: Band-Lookup deterministisch ──────────────────────────────────────
check('CS-00',
  convictionRiskPct(1.0) === 0.020 && convictionRiskPct(0.8) === 0.015 &&
  convictionRiskPct(0.6) === 0.010 && convictionRiskPct(0.4) === 0.0075 &&
  convictionRiskPct(0.2) === 0.005 && convictionRiskPct(0) === 0.005,
  'convictionRiskPct: deterministische Bänder 0.2…1.0');

// ─── CS-01: höhere Conviction → höheres Risiko → größeres Notional (in Caps) ──
// SL 10%: conv 0.6 → 1%×2000/0.10 = 200 ; conv 1.0 → 2%×2000/0.10 = 400.
// positionOverrides sets cap at 25% NAV to let conviction sizing differentiate.
{
  const ovA = { positionOverrides: { CS01A: { target_position_pct: 0.25 } } };
  const ovB = { positionOverrides: { CS01B: { target_position_pct: 0.25 } } };
  const a = allocate(makeState(), [makeDecision('CS01A', { conf: 0.6, slPct: 10 })], { runId: 't', convictionSizing: true, ...ovA });
  const b = allocate(makeState(), [makeDecision('CS01B', { conf: 1.0, slPct: 10 })], { runId: 't', convictionSizing: true, ...ovB });
  const pa = a.newPositions[0], pb = b.newPositions[0];
  check('CS-01',
    pa && pb && near(pa.notional_eur, 200) && near(pb.notional_eur, 400) && pb.notional_eur > pa.notional_eur
    && pa.sized_by === 'conviction_risk' && pa.risk_pct_at_entry === 0.010 && pb.risk_pct_at_entry === 0.020,
    'conv 0.6→200€ vs conv 1.0→400€ (höhere Conviction = größer, deterministisch)');
}

// ─── CS-02: größerer Stop → kleineres Notional (gleiche Conviction) ───────────
// conv 0.8 → 1.5%×2000 = 30€ Risiko. SL10% → 300 ; SL20% → 150.
// positionOverrides sets cap at 25% NAV to let conviction sizing differentiate.
{
  const ovA = { positionOverrides: { CS02A: { target_position_pct: 0.25 } } };
  const ovB = { positionOverrides: { CS02B: { target_position_pct: 0.25 } } };
  const s10 = allocate(makeState(), [makeDecision('CS02A', { conf: 0.8, slPct: 10 })], { runId: 't', convictionSizing: true, ...ovA });
  const s20 = allocate(makeState(), [makeDecision('CS02B', { conf: 0.8, slPct: 20 })], { runId: 't', convictionSizing: true, ...ovB });
  check('CS-02',
    near(s10.newPositions[0].notional_eur, 300) && near(s20.newPositions[0].notional_eur, 150)
    && s20.newPositions[0].notional_eur < s10.newPositions[0].notional_eur,
    'gleiche Conviction, SL10%→300€ vs SL20%→150€ (größerer Stop = kleiner)');
}

// ─── CS-03: fehlender SL bei Conviction-Sizing → harter Reject (auch Budget aus)
{
  const r = allocate(makeState(), [makeDecision('CS03', { conf: 0.8, slPct: null })],
    { runId: 't', convictionSizing: true, portfolioRiskBudget: 1.0 });   // Budget aus → trotzdem Reject
  check('CS-03',
    r.newPositions.length === 0 && r.skipped.some(s => s.symbol === 'CS03' && s.reason === 'risk_unknown'),
    'Conviction-Sizing ohne SL → risk_unknown (fail-closed, auch bei deaktiviertem Budget)');
}

// ─── CS-04: Portfolio-Risk-Budget (6%) bleibt hartes Aggregat-Ceiling ────────
// 4× conv 1.0, SL10% → je 400€ (Risiko 40€). Budget 120€ → 3 passen, 4. geskippt.
// positionOverrides sets cap at 25% NAV to get 400€ per position.
{
  const overrides = Object.fromEntries(['CS04A','CS04B','CS04C','CS04D'].map(s => [s, { target_position_pct: 0.25 }]));
  const decs = ['CS04A','CS04B','CS04C','CS04D'].map(s => makeDecision(s, { conf: 1.0, slPct: 10 }));
  const r = allocate(makeState(), decs, { runId: 't', convictionSizing: true, positionOverrides: overrides });
  const atRisk = r.newPositions.reduce((a, p) => a + p.notional_eur * (p.stop_loss_pct / 100), 0);
  check('CS-04',
    r.newPositions.length === 3 && near(atRisk, 120, 0.5)
    && r.skipped.some(s => s.reason === 'portfolio_risk_budget'),
    'Aggregat-Budget bindet trotz Conviction: 3 Entries, Σ at-risk ≈120€, 4. → portfolio_risk_budget');
}

// ─── CS-05: Backward-Compat — Conviction-Sizing AUS → Legacy-Sizing 5% NAV ───
{
  const r = allocate(makeState(), [makeDecision('CS05', { conf: 0.6, slPct: 5 })], { runId: 't' }); // kein convictionSizing
  const p = r.newPositions[0];
  check('CS-05',
    p && near(p.notional_eur, 100) && p.sized_by === 'target_pct' && p.risk_pct_at_entry === null,
    'Default (Sizing aus): Legacy 5%×NAV = 100€, sized_by=target_pct');
}

// ─── CS-06: winziger SL wird durch MAX_PCT gedeckelt (kein Size-Blow-up) ─────
// conv 1.0 → 2%×2000 = 40€. SL2% → 40/0.02 = 2000€ roh, cap MAX_PCT 5%×2000 = 100€.
// positionOverrides sets cap at 25% to show the cap mechanism.
{
  const r = allocate(makeState(), [makeDecision('CS06', { conf: 1.0, slPct: 2 })],
    { runId: 't', convictionSizing: true, positionOverrides: { CS06: { target_position_pct: 0.25 } } });
  const p = r.newPositions[0];
  check('CS-06',
    p && near(p.notional_eur, 500) && p.sized_by === 'conviction_risk',
    'winziger SL (2%): Notional auf MAX_PCT 500€ gedeckelt statt 2000€');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nconviction_sizing_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
