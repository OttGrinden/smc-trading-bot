#!/usr/bin/env node
/**
 * Cash/Allocation Policy — dedicated test cases (CAP-01 … CAP-09).
 *
 * node scripts/execution/tests/cash_policy_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 *
 * Isolation: engine tests use isolated temp state files via _setTestPaths.
 * No test reads or writes the live portfolio_state.json.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join }                     from 'path';
import { tmpdir }                   from 'os';

import {
  initPortfolio, loadOrInit,
  _setTestPaths, _clearTestPaths,
} from '../portfolio/portfolio_state.mjs';
import { allocate }     from '../portfolio/allocation_engine.mjs';
import { runPortfolio } from '../portfolio/portfolio_engine.mjs';

// ─── Harness ─────────────────────────────────────────────────────────────────

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const SCRATCH = join(tmpdir(), `cashpolicy_${process.pid}`);
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

function readTestState(tcId) {
  _setTestPaths({ state: join(SCRATCH, `state_${tcId}.json`) });
  try { return loadOrInit(); } finally { _clearTestPaths(); }
}

function makeState(committedEur = 0) {
  const s = initPortfolio();          // NAV 2000, cash 2000
  s.cash = +(s.initial_capital - committedEur).toFixed(4);
  return s;
}

function makeDecision(sym, side = 'long') {
  return {
    intent: {
      intent_id: `intent_${sym}_${side}`, symbol: sym, side,
      asset_type: 'stock', price_usd: 108,
      confidence_score_normalized: 0.6, technical_alignment: 'confirmed',
      technical: { age_minutes: 10 },
      risk: { stop_loss_pct: 5, suggested_position_pct: 3 },
      signal_timestamp: new Date().toISOString(),
      intent_created_at: new Date().toISOString(),
    },
    decision: { execution_ready: true, blocked_reasons: [] },
  };
}

const EMPTY_RUN = (runId) => ({ run_id: runId, long_candidates: [], short_candidates: [] });

// ─── CAP-01: Reserve-Floor blockiert — cash_reserve_floor, nicht insufficient ─
// NAV 2000, Reserve 20% = 400. Cash 300 (committed 1700) → available 0.
// Unreserviertes Cash 300 >= minNotional 100 → Reason muss cash_reserve_floor sein.

{
  const state = makeState(1700);
  const { newPositions, skipped } = allocate(state, [makeDecision('CAP01')], { runId: 't_cap01' });
  check('CAP-01',
    newPositions.length === 0
    && skipped.some(s => s.symbol === 'CAP01' && s.reason === 'cash_reserve_floor'),
    'Reserve bindend, unreserviertes Cash hätte gereicht → cash_reserve_floor');
}

// ─── CAP-02: Reserve kumulativ — erste Position öffnet, Rest durch Reserve blockiert
// Cash 550, Reserve 400 (20% × 2000) → verfügbar 150. 3 Kandidaten à Target 100:
// #1: 100 voll · #2: 50 < minNotional → skip cash_reserve_floor · #3: same.

{
  const state = makeState(1450);   // cash 550
  const decisions = [makeDecision('CAP02A'), makeDecision('CAP02B'), makeDecision('CAP02C')];
  const { newPositions, skipped } = allocate(state, decisions, { runId: 't_cap02' });
  const total = newPositions.reduce((s, p) => s + p.notional_eur, 0);
  check('CAP-02',
    newPositions.length === 1
    && Math.abs(total - 100) < 0.01
    && newPositions[0].sizing_constraint === null
    && skipped.filter(s => s.reason === 'cash_reserve_floor').length === 2,
    'Reserve Floor: erste Position (100 EUR) voll; zweite + dritte durch Reserve blockiert');
}

// ─── CAP-03: Run-Budget-Staffelung über Invocations + Reset bei neuer run_id ─

{
  const state = makeState(0);
  const decisions = [makeDecision('CAP03A'), makeDecision('CAP03B')];

  const r = withTestState('cap03', state, () => {
    // Invocation 1: Budget 5% × 2000 = 100 → A (100) alloziert, B run_deployment_cap
    const s1 = runPortfolio(EMPTY_RUN('cap03_run1'), decisions, { runId: 'cap03_run1', maxRunDeploymentPct: 0.05 });
    // Invocation 2, gleiche run_id: A duplicate, B weiterhin run_deployment_cap
    const s2 = runPortfolio(EMPTY_RUN('cap03_run1'), decisions, { runId: 'cap03_run1', maxRunDeploymentPct: 0.05 });
    // Invocation 3, neue run_id: Budget-Reset → B alloziert
    const s3 = runPortfolio(EMPTY_RUN('cap03_run2'), decisions, { runId: 'cap03_run2', maxRunDeploymentPct: 0.05 });
    return { s1, s2, s3 };
  });

  const st = readTestState('cap03');
  check('CAP-03',
    r.s1.new_allocations.some(a => a.symbol === 'CAP03A')
    && r.s1.skipped_allocations.some(s => s.symbol === 'CAP03B' && s.reason === 'run_deployment_cap')
    && r.s2.new_allocations.length === 0
    && r.s2.skipped_allocations.some(s => s.symbol === 'CAP03B' && s.reason === 'run_deployment_cap')
    && r.s3.new_allocations.some(a => a.symbol === 'CAP03B')
    && st.deploy_run_id === 'cap03_run2',
    'Budget hält über Invocations derselben run_id; Reset bei neuer run_id');
}

// ─── CAP-04: Attributions-Tie-Break — run_deployment_cap gewinnt ──────────────
// budgetRoom 50 == availableCash 50, beide < minNotional 100.

{
  const state = makeState(1550);   // cash 450, Reserve 400 → available 50
  const { skipped } = allocate(state, [makeDecision('CAP04')],
    { runId: 't_cap04', runBudgetEur: 50 });
  check('CAP-04',
    skipped.some(s => s.symbol === 'CAP04' && s.reason === 'run_deployment_cap'),
    'Tie-Break bei gleicher Klammer: run_deployment_cap vor cash_reserve_floor');
}

// ─── CAP-05: runId=null — Cap übersprungen, Reserve bleibt aktiv ─────────────

{
  const state = makeState(0);
  const r = withTestState('cap05', state, () =>
    runPortfolio({ long_candidates: [], short_candidates: [] }, [makeDecision('CAP05')], { runId: null }));
  const st = readTestState('cap05');
  check('CAP-05',
    r.new_allocations.some(a => a.symbol === 'CAP05')
    && r.run_deployment_cap_eur === null
    && st.deploy_run_id === null && st.deploy_run_used_eur === 0
    && r.cash_reserve_eur > 0,
    'runId=null: kein Cap, keine Budget-Felder angefasst, Reserve aktiv');
}

// ─── CAP-06: Legacy-Äquivalenz mit expliziten Off-Parametern ─────────────────
// Reserve 0 + Cap 1.0: kleines Cash (80 < min 100) → insufficient_capacity,
// NICHT cash_reserve_floor; volle Cash-Situation → ungeclampte Zielgröße 100.

{
  const stateSmall = makeState(1920);   // cash 80
  const a = allocate(stateSmall, [makeDecision('CAP06A')],
    { runId: 't_cap06', minCashReservePct: 0 });
  const stateFull = makeState(0);       // cash 2000
  const b = allocate(stateFull, [makeDecision('CAP06B')],
    { runId: 't_cap06', minCashReservePct: 0 });
  check('CAP-06',
    a.skipped.some(s => s.reason === 'insufficient_capacity')
    && !a.skipped.some(s => s.reason === 'cash_reserve_floor')
    && b.newPositions.length === 1
    && Math.abs(b.newPositions[0].notional_eur - 100) < 0.01
    && b.newPositions[0].sizing_constraint === null,
    'Off-Parameter: Alt-Verhalten (insufficient_capacity, volle Zielgröße 100, kein Constraint)');
}

// ─── CAP-07: Config-Validierung — Fail-fast bei ungültigen Werten ────────────

{
  const state = makeState(0);
  let threwReserve = false, threwCap = false;
  withTestState('cap07', state, () => {
    try { runPortfolio(EMPTY_RUN('cap07'), [], { runId: 'cap07', minCashReservePct: 1.2 }); }
    catch (e) { threwReserve = /minCashReservePct/.test(e.message); }
    try { runPortfolio(EMPTY_RUN('cap07'), [], { runId: 'cap07', maxRunDeploymentPct: 0 }); }
    catch (e) { threwCap = /maxRunDeploymentPct/.test(e.message); }
  });
  check('CAP-07', threwReserve && threwCap,
    'Reserve 1.2 und Cap 0 → jeweils Konfigurationsfehler (Fail-fast)');
}

// ─── CAP-08: Alt-State ohne Deploy-Felder lädt mit Defaults ──────────────────

{
  const legacy = initPortfolio();
  delete legacy.deploy_run_id;
  delete legacy.deploy_run_used_eur;
  const statePath = join(SCRATCH, 'state_cap08.json');
  writeFileSync(statePath, JSON.stringify(legacy, null, 2) + '\n', 'utf8');
  _setTestPaths({ state: statePath });
  let loaded;
  try { loaded = loadOrInit(); } finally { _clearTestPaths(); }
  check('CAP-08',
    loaded.deploy_run_id === null && loaded.deploy_run_used_eur === 0,
    'Alt-State: deploy_run_id=null, deploy_run_used_eur=0 migriert');
}

// ─── CAP-09: Budget < minNotional → run_deployment_cap-Skip ─────────────────
// Budget 50 < minNotional 100 → Kandidat nicht eröffnet (Budget zu klein).

{
  const state = makeState(0);
  const { newPositions, skipped } = allocate(state, [makeDecision('CAP09')],
    { runId: 't_cap09', runBudgetEur: 50 });
  check('CAP-09',
    newPositions.length === 0
    && skipped.some(s => s.symbol === 'CAP09' && s.reason === 'run_deployment_cap'),
    'Budget 50 < min-Notional 100 → run_deployment_cap');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\ncash_policy_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
