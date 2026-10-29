#!/usr/bin/env node
/**
 * Conviction Override — dedicated test cases (CO-01 … CO-07).
 *
 * node scripts/execution/tests/conviction_override_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 *
 * Verifies the opt-in reduced cash floor for full-conviction (★★★★★) candidates:
 *   - off by default (regression: identical to the normal cash floor)
 *   - on → only score >= CONVICTION_FULL_THRESHOLD candidates draw below the floor
 *   - non-★★★★★ candidates never benefit
 *   - eligible-but-unneeded opens are not flagged
 *   - every other gate (max_open, etc.) still binds
 *   - fail-fast config validation
 *   - end-to-end through runPortfolio
 *
 * Isolation: engine tests use isolated temp state files via _setTestPaths.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join }                     from 'path';
import { tmpdir }                   from 'os';

import {
  initPortfolio, loadOrInit,
  _setTestPaths, _clearTestPaths,
} from '../portfolio/portfolio_state.mjs';
import { allocate, CONVICTION_FULL_THRESHOLD } from '../portfolio/allocation_engine.mjs';
import { runPortfolio } from '../portfolio/portfolio_engine.mjs';

// ─── Harness ─────────────────────────────────────────────────────────────────

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const SCRATCH = join(tmpdir(), `convoverride_${process.pid}`);
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

function makeState(committedEur = 0) {
  const s = initPortfolio();          // NAV 2000, cash 2000
  s.cash = +(s.initial_capital - committedEur).toFixed(4);
  return s;
}

// score defaults to a true ★★★★★ (full conviction); override eligible.
function makeDecision(sym, score = CONVICTION_FULL_THRESHOLD, side = 'long') {
  return {
    intent: {
      intent_id: `intent_${sym}_${side}`, symbol: sym, side,
      asset_type: 'stock', price_usd: 108,   // → 100 EUR
      confidence_score_normalized: score, technical_alignment: 'confirmed',
      technical: { age_minutes: 10 },
      risk: { stop_loss_pct: 5, suggested_position_pct: 5 },
      signal_timestamp: new Date().toISOString(),
      intent_created_at: new Date().toISOString(),
    },
    decision: { decision_id: `dec_${sym}`, execution_ready: true, blocked_reasons: [] },
  };
}

const EMPTY_RUN = (runId) => ({ run_id: runId, long_candidates: [], short_candidates: [] });

// ─── CO-01: Override OFF (default) — ★★★★★ still blocked by normal floor ──────
// NAV 2000, reserve 20% = 400. Cash 300 → available 0. Even a ★★★★★ candidate
// must be skipped cash_reserve_floor when the override is off (pure regression).

{
  const state = makeState(1700);   // cash 300
  const { newPositions, skipped } = allocate(state, [makeDecision('CO01')], { runId: 't_co01' });
  check('CO-01',
    newPositions.length === 0
    && skipped.some(s => s.symbol === 'CO01' && s.reason === 'cash_reserve_floor'),
    'Override off: ★★★★★ verhält sich wie zuvor → cash_reserve_floor');
}

// ─── CO-02: Override ON — ★★★★★ draws below the floor to the reduced floor ────
// Cash 300, normal floor 20% = 400 (cash < floor → blocked without override).
// Override floor 10% = 200 → available 100 = target. Opens at full target 100,
// no sizing_constraint (available == target), conviction_override_applied=true.

{
  const state = makeState(1700);   // cash 300
  const { newPositions, skipped } = allocate(state, [makeDecision('CO02')],
    { runId: 't_co02', convictionOverride: true, convictionOverrideReservePct: 0.10 });
  const p = newPositions[0];
  check('CO-02',
    newPositions.length === 1
    && Math.abs(p.notional_eur - 100) < 0.01
    && p.conviction_override_applied === true
    && p.sizing_constraint === null
    && skipped.length === 0,
    'Override on: ★★★★★ zieht Cash bis 10%-Floor (100 EUR), als override geflaggt');
}

// ─── CO-03: Override ON but candidate is NOT ★★★★★ — no benefit ───────────────
// score 0.8 (★★★★) → does not qualify → normal floor applies → blocked.

{
  const state = makeState(1700);   // cash 300
  const { newPositions, skipped } = allocate(state, [makeDecision('CO03', 0.8)],
    { runId: 't_co03', convictionOverride: true, convictionOverrideReservePct: 0.10 });
  check('CO-03',
    newPositions.length === 0
    && skipped.some(s => s.symbol === 'CO03' && s.reason === 'cash_reserve_floor'),
    'Override on, aber ★★★★ (0.8): kein Override → cash_reserve_floor');
}

// ─── CO-04: Eligible but NOT load-bearing — flag stays false ─────────────────
// Cash 2000, available under normal floor 1600 >> target 100. ★★★★★ opens full
// size; override changed nothing → conviction_override_applied=false.

{
  const state = makeState(0);      // cash 2000
  const { newPositions } = allocate(state, [makeDecision('CO04')],
    { runId: 't_co04', convictionOverride: true, convictionOverrideReservePct: 0.10 });
  const p = newPositions[0];
  check('CO-04',
    newPositions.length === 1
    && Math.abs(p.notional_eur - 100) < 0.01
    && p.sizing_constraint === null
    && p.conviction_override_applied === false,
    'Override nicht tragend (genug Cash über Normal-Floor) → applied=false');
}

// ─── CO-05: Override does NOT bypass other gates (max_open_positions) ─────────
// MAX_OPEN_POSITIONS = 7; fill all 7 slots → gate still blocks.

{
  const state = makeState(0);
  state.open_positions = Array.from({ length: 7 }, (_, i) => ({
    symbol: `OPEN${i}`, asset_type: 'stock', side: 'long', quantity: 1,
    notional_eur: 100, entry_price_eur: 100, mark_price_eur: 100, stop_loss_pct: 5, sector: null,
  }));
  const { newPositions, skipped } = allocate(state, [makeDecision('CO05')],
    { runId: 't_co05', convictionOverride: true, convictionOverrideReservePct: 0.10 });
  check('CO-05',
    newPositions.length === 0
    && skipped.some(s => s.symbol === 'CO05' && s.reason === 'max_open_positions_reached'),
    'Override umgeht andere Gates nicht: max_open_positions bleibt bindend');
}

// ─── CO-06: Config fail-fast — reduced floor must be ≤ normal & in [0,1) ──────

{
  const state = makeState(0);
  let threwHigh = false, threwRange = false;
  withTestState('co06', state, () => {
    // reduced floor > normal reserve (0.30 > 0.20) → throw
    try { runPortfolio(EMPTY_RUN('co06'), [], { runId: 'co06', convictionOverride: true, convictionOverrideReservePct: 0.30 }); }
    catch (e) { threwHigh = /convictionOverrideReservePct/.test(e.message); }
    // out of range (1.2) → throw
    try { runPortfolio(EMPTY_RUN('co06'), [], { runId: 'co06', convictionOverride: true, convictionOverrideReservePct: 1.2 }); }
    catch (e) { threwRange = /convictionOverrideReservePct/.test(e.message); }
  });
  check('CO-06', threwHigh && threwRange,
    'Fail-fast: reduzierter Floor > Normal-Reserve bzw. außerhalb [0,1) → Konfigfehler');
}

// ─── CO-07: End-to-end via runPortfolio — ★★★★★ opens, summary + count ───────
// Cash must come from real committed capital (recompute derives cash from
// committed notional). One held position of 1700 EUR notional → cash 300.
// Its stop is kept small (3%) so the risk budget is NOT the binding gate —
// isolating the cash floor as the constraint the override relaxes.

{
  const state = makeState(0);
  state.open_positions = [{
    symbol: 'CO07HELD', asset_type: 'stock', side: 'long', quantity: 17,
    notional_eur: 1700, entry_price_usd: 108, entry_price_eur: 100,
    mark_price_usd: 108, mark_price_eur: 100, unrealized_pnl_eur: 0,
    stop_loss_pct: 3, sector: null, leverage: 1,
  }];
  const r = withTestState('co07', state, () =>
    runPortfolio(EMPTY_RUN('co07'), [makeDecision('CO07')],
      { runId: 'co07', convictionOverride: true, convictionOverrideReservePct: 0.10 }));
  const alloc = r.new_allocations.find(a => a.symbol === 'CO07');
  check('CO-07',
    r.conviction_override_enabled === true
    && r.conviction_override_reserve_pct === 0.10
    && r.conviction_override_applied === 1
    && alloc && alloc.conviction_override_applied === true,
    'runPortfolio: ★★★★★ über Override eröffnet, Summary-Felder + Count korrekt');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nconviction_override_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
