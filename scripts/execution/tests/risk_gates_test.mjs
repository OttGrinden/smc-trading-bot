#!/usr/bin/env node
/**
 * Portfolio-aware hard gates — dedicated test cases (RG-01 … RG-09).
 *
 *   sector_exposure_cap    (default 0.40 × NAV per sector)
 *   portfolio_risk_budget  (default 0.06 × NAV at risk = Σ notional_eur * sl%/100)
 *
 * node scripts/execution/tests/risk_gates_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 *
 * Isolation: engine tests use isolated temp state files via _setTestPaths.
 * No test reads or writes the live portfolio_state.json.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join }                     from 'path';
import { tmpdir }                   from 'os';

import {
  initPortfolio, loadOrInit, backfillSectors,
  _setTestPaths, _clearTestPaths,
} from '../portfolio/portfolio_state.mjs';
import { allocate }     from '../portfolio/allocation_engine.mjs';
import { runPortfolio } from '../portfolio/portfolio_engine.mjs';

// ─── Harness ─────────────────────────────────────────────────────────────────

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const SCRATCH = join(tmpdir(), `riskgates_${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });

function withTestState(tcId, initialState, fn) {
  const statePath = join(SCRATCH, `state_${tcId}.json`);
  writeFileSync(statePath, JSON.stringify(initialState, null, 2) + '\n', 'utf8');
  _setTestPaths({
    state:   statePath,
    history: join(SCRATCH, `hist_${tcId}.jsonl`),
    ledger:  join(SCRATCH, `ledger_${tcId}.jsonl`),
  });
  try { return fn(statePath); } finally { _clearTestPaths(); }
}

// Build a portfolio state (NAV 2000) with optional open positions pre-added.
function makeState(openPositions = []) {
  const s = initPortfolio();
  for (const p of openPositions) s.open_positions.push(p);
  const committed = openPositions.reduce((sum, p) => sum + (p.notional_eur ?? 0), 0);
  s.cash = +(s.initial_capital - committed).toFixed(4);
  return s;
}

// Open position. entry 108 USD → 100 EUR. `sector` omitted unless supplied (legacy-tolerant test).
function makePos(o = {}) {
  return {
    symbol: 'X', side: 'long', asset_type: 'stock',
    quantity: 1.0, notional_eur: 100,
    entry_price_usd: 108, entry_price_eur: 100,
    mark_price_usd: 108, mark_price_eur: 100,
    unrealized_pnl_eur: 0, stop_loss_pct: 5, leverage: 1.0,
    entry_timestamp: new Date().toISOString(), entry_run_id: null,
    strategy: 'test', thesis: 'test', decision_source: {},
    k_at_entry: null, catalyst_recognized_at: null,
    thesis_status: 'active', thesis_valid_until: null,
    catalyst_event_date: null, thesis_last_reviewed_at: null,
    ...o,
  };
}

// Approved decision. sector defaults to null (no named sector); slPct via intent.risk.
function makeDecision(sym, { side = 'long', sector = null, slPct = 5 } = {}) {
  return {
    intent: {
      intent_id: `intent_${sym}_${side}`, symbol: sym, side,
      asset_type: 'stock', price_usd: 108, sector,
      confidence_score_normalized: 0.6, technical_alignment: 'confirmed',
      technical: { age_minutes: 10 },
      risk: { stop_loss_pct: slPct, suggested_position_pct: 3 },
      signal_timestamp: new Date().toISOString(),
      intent_created_at: new Date().toISOString(),
    },
    decision: { decision_id: `dec_${sym}`, execution_ready: true, blocked_reasons: [] },
  };
}

const near = (a, b, eps = 0.5) => Math.abs(a - b) < eps;

// ─── RG-01 (a): Entry erlaubt unter beiden Caps → volle Zielgröße ────────────
// NAV 2000, target 100. sector room 800, risk room (120/0.05)=2400 → keine bindet.

{
  const state = makeState();
  const { newPositions, skipped } = allocate(state, [makeDecision('RG01', { sector: 'semiconductor' })],
    { runId: 't_rg01' });
  const p = newPositions[0];
  check('RG-01',
    newPositions.length === 1 && skipped.length === 0
    && near(p.notional_eur, 100) && p.sizing_constraint === null
    && p.sector === 'semiconductor',
    'Unter beiden Caps: volle Zielgröße (100), sizing_constraint=null, sector persistiert');
}

// ─── RG-02 (b): Entry wegen sector cap gekürzt ───────────────────────────────
// Bestehende Semiconductor-Exposure 600 → sector room 800-600=200 < target 500.
// positionOverrides setzt Zielgröße 500 (25% NAV) um Clamping zu demonstrieren.

{
  const existing = makePos({ symbol: 'OLDSEMI', sector: 'semiconductor', notional_eur: 600, quantity: 6, stop_loss_pct: 5 });
  const state = makeState([existing]);
  const { newPositions } = allocate(state, [makeDecision('RG02', { sector: 'semiconductor' })],
    { runId: 't_rg02', positionOverrides: { RG02: { target_position_pct: 0.25 } } });
  const p = newPositions[0];
  check('RG-02',
    newPositions.length === 1 && near(p.notional_eur, 200)
    && p.sizing_constraint === 'sector_exposure_cap',
    'Sektor 40%-Cap kürzt 500→200, sizing_constraint=sector_exposure_cap');
}

// ─── RG-03 (c): Entry wegen sector cap geskippt ──────────────────────────────
// Bestehende Semiconductor-Exposure 750 → sector room 50 < Mindestgröße 100.

{
  const existing = makePos({ symbol: 'OLDSEMI', sector: 'semiconductor', notional_eur: 750, quantity: 7.5, stop_loss_pct: 5 });
  const state = makeState([existing]);
  const { newPositions, skipped } = allocate(state, [makeDecision('RG03', { sector: 'semiconductor' })],
    { runId: 't_rg03' });
  check('RG-03',
    newPositions.length === 0
    && skipped.some(s => s.symbol === 'RG03' && s.reason === 'sector_exposure_cap'),
    'Sektor-Restbudget < Mindestgröße → harter Skip sector_exposure_cap');
}

// ─── RG-04 (d): Entry wegen portfolio risk budget gekürzt ────────────────────
// Bestehendes Risk 90 (notional 900 @ 10%). Rest 30 EUR; neue SL 10% → room 300.
// positionOverrides setzt Zielgröße 500 (25% NAV) um Clamping zu demonstrieren.

{
  const existing = makePos({ symbol: 'RISKY', notional_eur: 900, quantity: 9, stop_loss_pct: 10 }); // kein sector
  const state = makeState([existing]);
  const { newPositions } = allocate(state, [makeDecision('RG04', { slPct: 10 })],
    { runId: 't_rg04', positionOverrides: { RG04: { target_position_pct: 0.25 } } });
  const p = newPositions[0];
  check('RG-04',
    newPositions.length === 1 && near(p.notional_eur, 300)
    && p.sizing_constraint === 'portfolio_risk_budget',
    'Risk-Budget kürzt 500→300 (Rest 30€ / SL10%), sizing_constraint=portfolio_risk_budget');
}

// ─── RG-05 (e): Entry wegen portfolio risk budget geskippt ───────────────────
// Bestehendes Risk 119 (notional 1190 @ 10%). Rest 1 EUR; neue SL 10% → room 10 < 100.

{
  const existing = makePos({ symbol: 'RISKY', notional_eur: 1190, quantity: 11.9, stop_loss_pct: 10 });
  const state = makeState([existing]);
  const { newPositions, skipped } = allocate(state, [makeDecision('RG05', { slPct: 10 })],
    { runId: 't_rg05' });
  check('RG-05',
    newPositions.length === 0
    && skipped.some(s => s.symbol === 'RG05' && s.reason === 'portfolio_risk_budget'),
    'Risk-Restbudget < Mindestgröße → harter Skip portfolio_risk_budget');
}

// ─── RG-06 (f): Legacy-Position ohne sector bricht nicht ──────────────────────
// Bestehende Position OHNE sector-Feld; neue Position sektorisiert → voll erlaubt.

{
  const legacy = makePos({ symbol: 'LEGACY', notional_eur: 300, quantity: 3, stop_loss_pct: 5 }); // kein sector
  const state = makeState([legacy]);
  let threw = false, res = null;
  try {
    res = allocate(state, [makeDecision('RG06', { sector: 'semiconductor' })], { runId: 't_rg06' });
  } catch { threw = true; }
  const p = res?.newPositions?.[0];
  check('RG-06',
    !threw && res.newPositions.length === 1 && near(p.notional_eur, 100)
    && p.sector === 'semiconductor',
    'Legacy-Position ohne sector zählt nicht gegen named sector; kein Crash, volle Größe');
}

// ─── RG-07 (g): Gates >= 1.0 deaktiviert → Legacy-Sizing-Äquivalenz + Fail-fast
// Bei voller Semiconductor-Sättigung würde der Default-Cap skippen; mit cap=1.0
// fällt die Position wieder voll durch. Plus Config-Fail-fast (0 ungültig).

{
  const existing = makePos({ symbol: 'OLDSEMI', sector: 'semiconductor', notional_eur: 780, quantity: 7.8, stop_loss_pct: 0 });
  const state = makeState([existing]);
  const { newPositions } = allocate(state, [makeDecision('RG07', { sector: 'semiconductor', slPct: 5 })],
    { runId: 't_rg07', sectorExposureCap: 1.0, portfolioRiskBudget: 1.0 });
  const p = newPositions[0];

  let threwSector = false, threwRisk = false;
  withTestState('rg07', makeState(), () => {
    try { runPortfolio({ run_id: 'rg07', long_candidates: [], short_candidates: [] }, [], { runId: 'rg07', sectorExposureCap: 0 }); }
    catch (e) { threwSector = /sectorExposureCap/.test(e.message); }
    try { runPortfolio({ run_id: 'rg07', long_candidates: [], short_candidates: [] }, [], { runId: 'rg07', portfolioRiskBudget: 0 }); }
    catch (e) { threwRisk = /portfolioRiskBudget/.test(e.message); }
  });

  check('RG-07',
    newPositions.length === 1 && near(p.notional_eur, 100) && p.sizing_constraint === null
    && threwSector && threwRisk,
    'cap/budget >= 1.0 deaktiviert (volle Größe trotz Sättigung); 0 → Fail-fast');
}

// ─── RG-08: Sector cap kumulativ über mehrere neue Positionen im selben Run ───
// Cap 800. Zwei Semiconductor-Kandidaten à Target 500: #1 voll 500, #2 room 300.
// positionOverrides setzt Zielgröße 500 (25% NAV) für beide um Clamping zu zeigen.

{
  const state = makeState();
  const decisions = [makeDecision('RG08A', { sector: 'semiconductor' }), makeDecision('RG08B', { sector: 'semiconductor' })];
  const overrides = { RG08A: { target_position_pct: 0.25 }, RG08B: { target_position_pct: 0.25 } };
  const { newPositions } = allocate(state, decisions, { runId: 't_rg08', positionOverrides: overrides });
  const a = newPositions.find(p => p.symbol === 'RG08A');
  const b = newPositions.find(p => p.symbol === 'RG08B');
  check('RG-08',
    newPositions.length === 2 && near(a.notional_eur, 500) && near(b.notional_eur, 300)
    && b.sizing_constraint === 'sector_exposure_cap',
    'Kumulativer Sektor-Cap im Run: 500 + 300 = 800 (zweite geclampt)');
}

// ─── RG-09: Engine-Integration — Summary-/Audit-Signale + Exposure-Aggregation
// Zwei bestehende Semiconductor-Positionen (720) + neuer Semiconductor-Kandidat.

{
  const p1 = makePos({ symbol: 'SEMI1', sector: 'semiconductor', notional_eur: 360, quantity: 3.6, stop_loss_pct: 5 });
  const p2 = makePos({ symbol: 'SEMI2', sector: 'semiconductor', notional_eur: 360, quantity: 3.6, stop_loss_pct: 5 });
  const initial = makeState([p1, p2]);
  const runOutput = {
    run_id: 'rg09',
    long_candidates: [
      { symbol: 'SEMI1', price_usd: 108, sector: 'semiconductor' },
      { symbol: 'SEMI2', price_usd: 108, sector: 'semiconductor' },
      { symbol: 'NEWSEMI', price_usd: 108, sector: 'semiconductor' },
    ],
    short_candidates: [],
  };
  const decisions = [makeDecision('NEWSEMI', { sector: 'semiconductor' })];
  const summary = withTestState('rg09', initial, () =>
    runPortfolio(runOutput, decisions, { runId: 'rg09' }));

  check('RG-09',
    summary.new_allocations.length === 0
    && summary.sector_cap_skips === 1
    && summary.skipped_allocations.some(s => s.symbol === 'NEWSEMI' && s.reason === 'sector_exposure_cap')
    && near(summary.sector_exposure_cap_eur, 800)
    && near(summary.sector_exposure_eur.semiconductor, 720)
    && near(summary.portfolio_at_risk_eur, 36),
    'Engine: sector-skip im Summary + sector_exposure_eur (720) + portfolio_at_risk_eur (36)');
}

// ─── RG-10: Sector-Backfill — Legacy anreichern, idempotent, unresolved sichtbar
// AMAT/GEV stammen aus der Registry; ZZZUNKNOWN ist nicht gemappt.

{
  const state = makeState([
    makePos({ symbol: 'AMAT', notional_eur: 200, quantity: 2 }),                  // legacy ohne sector → semiconductor
    makePos({ symbol: 'ZZZUNKNOWN', notional_eur: 100, quantity: 1 }),            // nicht in Registry → unresolved
    makePos({ symbol: 'GEV', sector: 'energy_infrastructure', notional_eur: 100, quantity: 1 }), // bereits gesetzt
  ]);
  const r1 = backfillSectors(state);
  const amat = state.open_positions.find(p => p.symbol === 'AMAT');
  const gev  = state.open_positions.find(p => p.symbol === 'GEV');
  const zzz  = state.open_positions.find(p => p.symbol === 'ZZZUNKNOWN');
  const r2 = backfillSectors(state);   // idempotenter zweiter Lauf
  check('RG-10',
    r1.registry_ok && amat.sector === 'semiconductor'
    && gev.sector === 'energy_infrastructure' && (zzz.sector == null)
    && r1.filled.includes('AMAT') && r1.unresolved.includes('ZZZUNKNOWN') && r1.already === 1
    && r2.filled.length === 0 && r2.already === 2,
    'Backfill: AMAT→semiconductor, GEV unberührt, ZZZUNKNOWN unresolved; 2. Lauf idempotent');
}

// ─── RG-11: Reales Cluster-Exposure wird nach Backfill erkannt → Skip ────────
// AMAT 720 ohne sector → Backfill → semiconductor 720; cap 800 → room 80 < 100.

{
  const state = makeState([makePos({ symbol: 'AMAT', notional_eur: 720, quantity: 7.2, stop_loss_pct: 5 })]);
  backfillSectors(state);
  const { newPositions, skipped } = allocate(state, [makeDecision('KLAC', { sector: 'semiconductor' })],
    { runId: 't_rg11', minCashReservePct: 0, maxRunDeploymentPct: 1.0 });
  check('RG-11',
    state.open_positions[0].sector === 'semiconductor'
    && newPositions.length === 0
    && skipped.some(s => s.symbol === 'KLAC' && s.reason === 'sector_exposure_cap'),
    'Nach Backfill erkennt der Cap das reale Semiconductor-Cluster (720) → KLAC geskippt');
}

// ─── RG-12: Position ohne SL zählt konservativ (nicht 0) ─────────────────────
// NOSL 600 ohne SL → at-risk 600*20% = 120 = Budget → neue Position room 0 → skip.

{
  const state = makeState([makePos({ symbol: 'NOSL', notional_eur: 600, quantity: 6, stop_loss_pct: null })]);
  const { newPositions, skipped } = allocate(state, [makeDecision('RG12', { slPct: 5 })],
    { runId: 't_rg12', minCashReservePct: 0, maxRunDeploymentPct: 1.0, sectorExposureCap: 1.0 });
  check('RG-12',
    newPositions.length === 0
    && skipped.some(s => s.symbol === 'RG12' && s.reason === 'portfolio_risk_budget'),
    'No-SL-Bestand wird mit 20% konservativ verbucht (600→120=Budget) → neue Freigabe geblockt');
}

// ─── RG-13: Neuer Kandidat ohne SL → fail-closed risk_unknown; bei Gate aus erlaubt
{
  const state = makeState();
  const closed = allocate(state, [makeDecision('RG13', { slPct: null })], { runId: 't_rg13' });
  const open   = allocate(makeState(), [makeDecision('RG13B', { slPct: null })],
    { runId: 't_rg13b', portfolioRiskBudget: 1.0 });   // Budget deaktiviert → Policy greift nicht
  check('RG-13',
    closed.newPositions.length === 0
    && closed.skipped.some(s => s.symbol === 'RG13' && s.reason === 'risk_unknown')
    && open.newPositions.length === 1,
    'No-SL-Neueintrag: risk_unknown (fail-closed) bei aktivem Budget; bei deaktiviertem Budget erlaubt');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nrisk_gates_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
