#!/usr/bin/env node
/**
 * Post-SL-Reinvestment-Policy — dedicated test cases (PSL-01 … PSL-09).
 *
 * node scripts/execution/tests/post_sl_policy_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 *
 * Isolation: engine tests use isolated temp state files via _setTestPaths.
 * No test reads or writes the live portfolio_state.json.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join }                     from 'path';
import { tmpdir }                   from 'os';

import {
  initPortfolio, loadOrInit, blockSymbol, getActiveBlock,
  _setTestPaths, _clearTestPaths,
} from '../portfolio/portfolio_state.mjs';
import { allocate }     from '../portfolio/allocation_engine.mjs';
import { runPortfolio } from '../portfolio/portfolio_engine.mjs';

// ─── Harness ─────────────────────────────────────────────────────────────────

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const SCRATCH = join(tmpdir(), `pslpolicy_${process.pid}`);
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

function makeState(openPositions = []) {
  const s = initPortfolio();
  for (const p of openPositions) s.open_positions.push(p);
  const committed = openPositions.reduce((sum, p) => sum + (p.notional_eur ?? 0), 0);
  s.cash = +(s.initial_capital - committed).toFixed(4);
  return s;
}

function makePos(overrides = {}) {
  return {
    symbol: 'PSLSYM', side: 'long', asset_type: 'stock',
    quantity: 1.0, notional_eur: 100,
    entry_price_usd: 108, entry_price_eur: 100,
    mark_price_usd: 108, mark_price_eur: 100,
    unrealized_pnl_eur: 0, stop_loss_pct: 5, leverage: 1.0,
    entry_timestamp: new Date().toISOString(), entry_run_id: null,
    strategy: 'test', thesis: 'test', decision_source: {},
    k_at_entry: null, catalyst_recognized_at: null,
    thesis_status: 'active', thesis_valid_until: null,
    catalyst_event_date: null, thesis_last_reviewed_at: null,
    ...overrides,
  };
}

function makeDecision(sym, side, alignment = 'confirmed') {
  return {
    intent: {
      intent_id: `intent_${sym}_${side}`, symbol: sym, side,
      asset_type: 'stock', price_usd: 108,
      confidence_score_normalized: 0.6, technical_alignment: alignment,
      technical: { age_minutes: 10 },
      risk: { stop_loss_pct: 5, suggested_position_pct: 3 },
      signal_timestamp: new Date().toISOString(),
      intent_created_at: new Date().toISOString(),
    },
    decision: { execution_ready: true, blocked_reasons: [] },
  };
}

// Scan price 100 USD → 92.59 EUR vs entry 100 EUR = −7.41 % → SL (5 %) feuert.
const SL_RUN = (sym) => ({ long_candidates: [{ symbol: sym, price_usd: 100 }], short_candidates: [] });

// ─── PSL-01: SL setzt time-limited same-side Block mit origin=stop_loss ──────

{
  const pos   = makePos({ symbol: 'PSL01' });
  const state = makeState([pos]);
  const summary = withTestState('psl01', state, () =>
    runPortfolio({ ...SL_RUN('PSL01'), run_id: 'psl01_run' }, [], { runId: 'psl01_run' }));

  const st    = withTestState_read('psl01');
  const block = st.blocked_symbols.find(b => b.symbol === 'PSL01' && b.side === 'long');
  const hours = block ? (new Date(block.blocked_until) - Date.now()) / 3_600_000 : -1;
  check('PSL-01',
    summary.closed_this_run.some(c => c.symbol === 'PSL01' && c.reason === 'stop_loss_hit')
    && block && block.origin === 'stop_loss' && hours > 47 && hours <= 48
    && st.last_sl_run_id === 'psl01_run' && st.last_sl_at != null,
    'SL-Exit setzt origin=stop_loss Block (~48h) + last_sl_run_id/last_sl_at');
}

function withTestState_read(tcId) {
  _setTestPaths({ state: join(SCRATCH, `state_${tcId}.json`) });
  try { return loadOrInit(); } finally { _clearTestPaths(); }
}

// ─── PSL-02: Same-side Re-Entry im selben Run wird geskippt ─────────────────

{
  const pos   = makePos({ symbol: 'PSL02' });
  const state = makeState([pos]);
  const decisions = [makeDecision('PSL02', 'long')];   // gleiche Seite, approved
  const summary = withTestState('psl02', state, () =>
    runPortfolio({ ...SL_RUN('PSL02'), run_id: 'psl02_run' }, decisions, { runId: 'psl02_run' }));

  check('PSL-02',
    summary.new_allocations.length === 0
    && summary.skipped_allocations.some(s => s.symbol === 'PSL02' && s.reason === 'post_sl_symbol_blocked'),
    'Same-side Re-Entry im SL-Run → skipped post_sl_symbol_blocked, keine Allokation');
}

// ─── PSL-03: Gegenrichtung bleibt erlaubt (Default: kein Cooldown) ──────────

{
  const pos   = makePos({ symbol: 'PSL03' });
  const state = makeState([pos]);
  const decisions = [makeDecision('PSL03', 'short')];  // Gegenrichtung
  const summary = withTestState('psl03', state, () =>
    runPortfolio({ ...SL_RUN('PSL03'), run_id: 'psl03_run' }, decisions, { runId: 'psl03_run' }));

  check('PSL-03',
    summary.new_allocations.some(a => a.symbol === 'PSL03' && a.side === 'short'),
    'Gegenrichtungs-Entry nach SL bleibt ohne Cooldown zulässig');
}

// ─── PSL-04: Manueller Block wird nicht degradiert ──────────────────────────

{
  const pos   = makePos({ symbol: 'PSL04' });
  const state = makeState([pos]);
  // Permanenter manueller Block (legacy: ohne origin-Feld) auf Symbol+Seite
  state.blocked_symbols.push({
    symbol: 'PSL04', side: 'long', reason: 'manual_close: test',
    blocked_at: new Date().toISOString(), blocked_until: null,
  });
  withTestState('psl04', state, () =>
    runPortfolio({ ...SL_RUN('PSL04'), run_id: 'psl04_run' }, [], { runId: 'psl04_run' }));

  const st    = withTestState_read('psl04');
  const block = st.blocked_symbols.find(b => b.symbol === 'PSL04' && b.side === 'long');
  check('PSL-04',
    block && block.blocked_until === null && block.origin === undefined,
    'Bestehender manueller (permanenter) Block bleibt nach SL unverändert');
}

// ─── PSL-05: Cooldown aktiv → alle Allokationen im SL-Run unterdrückt ────────

{
  const pos   = makePos({ symbol: 'PSL05' });
  const state = makeState([pos]);
  const decisions = [makeDecision('OTHER1', 'long'), makeDecision('OTHER2', 'short')];
  const summary = withTestState('psl05', state, () =>
    runPortfolio({ ...SL_RUN('PSL05'), run_id: 'psl05_run' }, decisions,
      { runId: 'psl05_run', postSlCooldown: true }));

  check('PSL-05',
    summary.new_allocations.length === 0
    && summary.skipped_allocations.filter(s => s.reason === 'post_sl_cooldown').length === 2,
    'Cooldown aktiv: beide Fremd-Kandidaten im SL-Run mit post_sl_cooldown geskippt');
}

// ─── PSL-06: Cooldown inaktiv (Default) → Fremd-Kandidat wird alloziert ──────

{
  const pos   = makePos({ symbol: 'PSL06' });
  const state = makeState([pos]);
  const decisions = [makeDecision('OTHER3', 'long')];
  const summary = withTestState('psl06', state, () =>
    runPortfolio({ ...SL_RUN('PSL06'), run_id: 'psl06_run' }, decisions, { runId: 'psl06_run' }));

  check('PSL-06',
    summary.new_allocations.some(a => a.symbol === 'OTHER3')
    && summary.post_sl_cooldown_applied === false,
    'Default (Cooldown aus): Fremd-Kandidat wird trotz SL alloziert (HII-Semantik erhalten)');
}

// ─── PSL-07: runId=null triggert keinen Cooldown ─────────────────────────────

{
  const state = initPortfolio();
  state.last_sl_run_id = null;
  const { newPositions, skipped } = allocate(state, [makeDecision('PSL07', 'long')],
    { postSlCooldown: true, runId: null });
  check('PSL-07',
    newPositions.length === 1 && !skipped.some(s => s.reason === 'post_sl_cooldown'),
    'runId=null + last_sl_run_id=null: kein Cooldown (Null-Guard greift)');
}

// ─── PSL-08: Wiederholte Invocation mit derselben run_id → Cooldown hält ─────

{
  const state = initPortfolio();
  state.last_sl_run_id = 'repeat_run';   // SL feuerte in früherer Invocation
  const { newPositions, skipped } = allocate(state, [makeDecision('PSL08', 'long')],
    { postSlCooldown: true, runId: 'repeat_run' });
  const next = allocate(state, [makeDecision('PSL08', 'long')],
    { postSlCooldown: true, runId: 'next_run' });
  check('PSL-08',
    newPositions.length === 0 && skipped.some(s => s.reason === 'post_sl_cooldown')
    && next.newPositions.length === 1,
    'Gleiche run_id: Cooldown hält über Invocations; neue run_id: Allokation wieder frei');
}

// ─── PSL-09: Alt-State ohne neue Felder lädt mit Defaults ────────────────────

{
  const legacy = initPortfolio();
  delete legacy.last_sl_run_id;
  delete legacy.last_sl_at;
  // legacy Block ohne origin
  legacy.blocked_symbols.push({
    symbol: 'LEGACY', side: 'short', reason: 'manual_close: legacy',
    blocked_at: new Date().toISOString(), blocked_until: null,
  });
  const statePath = join(SCRATCH, 'state_psl09.json');
  writeFileSync(statePath, JSON.stringify(legacy, null, 2) + '\n', 'utf8');
  _setTestPaths({ state: statePath });
  let loaded;
  try { loaded = loadOrInit(); } finally { _clearTestPaths(); }

  const block = getActiveBlock(loaded, 'LEGACY', 'short');
  check('PSL-09',
    loaded.last_sl_run_id === null && loaded.last_sl_at === null
    && block != null && block.origin === undefined,
    'Alt-State: Felder auf null migriert, origin-loser Block bleibt aktiv (= manual)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npost_sl_policy_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
