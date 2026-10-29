#!/usr/bin/env node
/**
 * Regression smoke test — 16 cases for Swing-Trading invariants.
 *
 * node scripts/execution/tests/regression_smoke.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL (case named in output).
 *
 * Isolation guarantees:
 *  - No test reads or writes the live portfolio_state.json.
 *  - Engine tests (TC-01–06, TC-12) use isolated temp state files via _setTestPaths.
 *  - manual_close tests (TC-13–16) use --dry-run with --state-path temp files.
 *  - audit_log and paper-broker orders write to real append-only files (acceptable;
 *    entries carry test run IDs and are identifiable).
 *
 * See project_regression_tests.md for the full 16-case spec.
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join }                                  from 'path';
import { tmpdir }                                from 'os';
import { spawnSync }                             from 'child_process';
import { fileURLToPath }                         from 'url';

import {
  initPortfolio, blockSymbol, isBlocked, pruneExpiredBlocks,
  _setTestPaths, _clearTestPaths,
} from '../portfolio/portfolio_state.mjs';
import { runCheck }                    from '../risk_engine.mjs';
import { makeGateResult }              from '../schemas.mjs';
import { allocate }                    from '../portfolio/allocation_engine.mjs';
import { runPortfolio }                from '../portfolio/portfolio_engine.mjs';

// ─── Harness ─────────────────────────────────────────────────────────────────

const RESULTS = [];

function pass(id, msg) {
  RESULTS.push({ id, status: 'PASS', msg });
  process.stderr.write(`  PASS  ${id}: ${msg}\n`);
}

function fail(id, msg) {
  RESULTS.push({ id, status: 'FAIL', msg });
  process.stderr.write(`  FAIL  ${id}: ${msg}\n`);
}

function check(id, cond, msg) {
  if (cond) pass(id, msg);
  else       fail(id, `${msg} [ASSERTION FAILED]`);
}

// ─── Temp scratch helpers ─────────────────────────────────────────────────────

const SCRATCH = join(tmpdir(), `regsmoke_${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });

function scratchPath(name) { return join(SCRATCH, name); }

/** Write a test state to a scratch path, run fn(statePath), always clear test paths. */
function withTestState(tcId, initialState, fn) {
  const statePath  = scratchPath(`state_${tcId}.json`);
  const histPath   = scratchPath(`hist_${tcId}.jsonl`);
  const ledgerPath = scratchPath(`ledger_${tcId}.jsonl`);
  writeFileSync(statePath, JSON.stringify(initialState, null, 2) + '\n', 'utf8');
  _setTestPaths({ state: statePath, history: histPath, ledger: ledgerPath });
  try {
    return fn(statePath);
  } finally {
    _clearTestPaths();
  }
}

/** Build a minimal portfolio state with optional open positions pre-added. */
function makeState(openPositions = []) {
  const s = initPortfolio();
  for (const p of openPositions) s.open_positions.push(p);
  const committed = openPositions.reduce((sum, p) => sum + (p.notional_eur ?? 0), 0);
  s.cash = +(s.initial_capital - committed).toFixed(4);
  return s;
}

/**
 * Build a minimal open position suitable for engine tests.
 * entry_price_usd = 108  →  entry_price_eur = 100 (108 / EUR_USD_RATE 1.08)
 */
function makePos(overrides = {}) {
  return {
    symbol:                  'TSTSYM',
    side:                    'long',
    asset_type:              'stock',
    quantity:                1.0,
    notional_eur:            100,
    entry_price_usd:         108,
    entry_price_eur:         100,
    mark_price_usd:          108,
    mark_price_eur:          100,
    unrealized_pnl_eur:      0,
    stop_loss_pct:           null,    // default: no SL (override per test)
    leverage:                1.0,
    entry_timestamp:         new Date().toISOString(),
    entry_run_id:            null,
    strategy:                'test',
    thesis:                  'test position',
    decision_source:         {},
    k_at_entry:              null,
    catalyst_recognized_at:  null,
    thesis_status:           'active',
    thesis_valid_until:      null,
    catalyst_event_date:     null,
    thesis_last_reviewed_at: null,
    ...overrides,
  };
}

/** Minimal approved decision for use in runPortfolio decisions array. */
function makeDecision(sym, side, techAlignment = 'confirmed') {
  return {
    intent: {
      intent_id:                    `intent_${sym}_${side}`,
      symbol:                       sym,
      side,
      asset_type:                   'stock',
      price_usd:                    108,
      confidence_score_normalized:  0.6,
      technical_alignment:          techAlignment,
      technical:                    { age_minutes: 10 },
      risk:                         { stop_loss_pct: 5, suggested_position_pct: 3 },
      signal_timestamp:             new Date().toISOString(),
      intent_created_at:            new Date().toISOString(),
    },
    decision: { execution_ready: true, blocked_reasons: [] },
  };
}

// ─── Path to manual_close.mjs ────────────────────────────────────────────────

const MANUAL_CLOSE = fileURLToPath(new URL('../manual_close.mjs', import.meta.url));

// ─── TC-09: permanent block → isBlocked=true; pruneExpiredBlocks is a no-op ──

{
  const state = initPortfolio();
  blockSymbol(state, 'SYMTC09', 'long', 'test', null);
  const beforePrune = isBlocked(state, 'SYMTC09', 'long');
  pruneExpiredBlocks(state);
  const afterPrune  = isBlocked(state, 'SYMTC09', 'long');
  check('TC-09', beforePrune === true && afterPrune === true,
    'permanent block: isBlocked=true before and after pruneExpiredBlocks');
}

// ─── TC-10: past-dated block → isBlocked=false; pruneExpiredBlocks removes it ─

{
  const state   = initPortfolio();
  const pastISO = new Date(Date.now() - 5_000).toISOString(); // 5 s ago
  blockSymbol(state, 'SYMTC10', 'long', 'test', pastISO);
  const alreadyExpired = isBlocked(state, 'SYMTC10', 'long');   // false before prune
  pruneExpiredBlocks(state);
  const stillPresent = state.blocked_symbols.some(b => b.symbol === 'SYMTC10');
  check('TC-10', alreadyExpired === false && !stillPresent,
    'past-dated block: isBlocked=false, pruneExpiredBlocks removes the entry');
}

// ─── TC-07: TierA conflicted → technical_conflict passed=true, placeholder=true

{
  const result = runCheck('technical_conflict', {
    technical_alignment: 'conflicted',
    risk_tier:           'A',
    side:                'long',
  });
  check('TC-07', result.passed === true && result.placeholder === true,
    'TierA conflicted: passed=true (swing exception), placeholder=true');
}

// ─── TC-08: TierB conflicted → passed=false; gate blocked, blocked_reasons set ─

{
  const result = runCheck('technical_conflict', {
    technical_alignment: 'conflicted',
    risk_tier:           'B',
    side:                'long',
  });
  const gate = makeGateResult([result]);
  check('TC-08',
    result.passed === false &&
    gate.gate_passed === false &&
    gate.blocked_reasons.length > 0,
    'TierB conflicted: passed=false, gate blocked, blocked_reasons non-empty');
}

// ─── TC-11: allocator skips blocked symbol with reason=manual_close_blocked ───

{
  const state = initPortfolio();
  blockSymbol(state, 'TSTTC11', 'long', 'test_block', null);

  const approved = [{
    intent: {
      intent_id:                    'intent_tc11',
      symbol:                       'TSTTC11',
      side:                         'long',
      asset_type:                   'stock',
      price_usd:                    108,
      confidence_score_normalized:  0.7,
      technical_alignment:          'confirmed',
      technical:                    { age_minutes: 5 },
      risk:                         { stop_loss_pct: 5, suggested_position_pct: 3 },
    },
    decision: { execution_ready: true, blocked_reasons: [] },
  }];

  const { newPositions, skipped } = allocate(state, approved, { runId: 'test_tc11' });
  const blocked = skipped.some(s => s.symbol === 'TSTTC11' && s.reason === 'manual_close_blocked');
  check('TC-11',
    newPositions.length === 0 && blocked,
    'blocked symbol → skipped with reason=manual_close_blocked');
}

// ─── TC-01: stop_loss_hit fires, appears in closed_this_run ───────────────────
// Entry: 108 USD / 1.08 = 100 EUR. Scan price: 100 USD / 1.08 = 92.59 EUR.
// pnlPct = (92.59 - 100) / 100 * 100 = -7.41%. stop_loss_pct=5 → SL fires.

{
  const pos = makePos({ symbol: 'TSTTC01', stop_loss_pct: 5 });
  const state = makeState([pos]);
  const runOutput = { long_candidates: [{ symbol: 'TSTTC01', price_usd: 100 }], short_candidates: [] };

  const result = withTestState('tc01', state, () =>
    runPortfolio(runOutput, [], { runId: 'test_tc01' })
  );

  const slHit = result.closed_this_run.some(c => c.symbol === 'TSTTC01' && c.reason === 'stop_loss_hit');
  check('TC-01', slHit, 'stop_loss_hit fires and is reported in closed_this_run');
}

// ─── TC-02: direction_watch confirmed — HOLD, note=opposite_signal_confirmed ──

{
  const pos = makePos({ symbol: 'TSTTC02', side: 'long' });
  const state = makeState([pos]);
  // Approved SHORT with confirmed alignment = opposite signal
  const decisions = [makeDecision('TSTTC02', 'short', 'confirmed')];
  const runOutput = { long_candidates: [], short_candidates: [{ symbol: 'TSTTC02', price_usd: 108 }] };

  const result = withTestState('tc02', state, () =>
    runPortfolio(runOutput, decisions, { runId: 'test_tc02' })
  );

  const held   = result.open_positions.some(p => p.symbol === 'TSTTC02' && p.side === 'long');
  const note   = result.unranked_positions.find(u => u.symbol === 'TSTTC02')?.note;
  const closed = result.closed_this_run.some(c => c.symbol === 'TSTTC02');
  check('TC-02',
    held && note === 'opposite_signal_confirmed' && !closed,
    'direction_watch confirmed: HOLD, note=opposite_signal_confirmed, no close');
}

// ─── TC-03: direction_watch partial — HOLD, note=opposite_signal_partial ──────

{
  const pos = makePos({ symbol: 'TSTTC03', side: 'long' });
  const state = makeState([pos]);
  const decisions = [makeDecision('TSTTC03', 'short', 'partial')];
  const runOutput = { long_candidates: [], short_candidates: [{ symbol: 'TSTTC03', price_usd: 108 }] };

  const result = withTestState('tc03', state, () =>
    runPortfolio(runOutput, decisions, { runId: 'test_tc03' })
  );

  const note   = result.unranked_positions.find(u => u.symbol === 'TSTTC03')?.note;
  const held   = result.open_positions.some(p => p.symbol === 'TSTTC03' && p.side === 'long');
  const closed = result.closed_this_run.some(c => c.symbol === 'TSTTC03');
  check('TC-03',
    held && note === 'opposite_signal_partial' && !closed,
    'direction_watch partial: HOLD, note=opposite_signal_partial');
}

// ─── TC-04: direction_watch neutral — HOLD, note=opposite_signal_neutral ──────

{
  const pos = makePos({ symbol: 'TSTTC04', side: 'long' });
  const state = makeState([pos]);
  const decisions = [makeDecision('TSTTC04', 'short', 'neutral')];
  const runOutput = { long_candidates: [], short_candidates: [{ symbol: 'TSTTC04', price_usd: 108 }] };

  const result = withTestState('tc04', state, () =>
    runPortfolio(runOutput, decisions, { runId: 'test_tc04' })
  );

  const note   = result.unranked_positions.find(u => u.symbol === 'TSTTC04')?.note;
  const held   = result.open_positions.some(p => p.symbol === 'TSTTC04' && p.side === 'long');
  const closed = result.closed_this_run.some(c => c.symbol === 'TSTTC04');
  check('TC-04',
    held && note === 'opposite_signal_neutral' && !closed,
    'direction_watch neutral: HOLD, note=opposite_signal_neutral');
}

// ─── TC-05: not_in_top_candidates — HOLD, approval_status set ─────────────────

{
  const pos = makePos({ symbol: 'TSTTC05', side: 'long' });
  const state = makeState([pos]);
  // Symbol in scan (has price) but no decision → not in approved set at all
  const runOutput = { long_candidates: [{ symbol: 'TSTTC05', price_usd: 108 }], short_candidates: [] };

  const result = withTestState('tc05', state, () =>
    runPortfolio(runOutput, [], { runId: 'test_tc05' })
  );

  const outPos = result.open_positions.find(p => p.symbol === 'TSTTC05');
  const closed = result.closed_this_run.some(c => c.symbol === 'TSTTC05');
  check('TC-05',
    outPos?.approval_status === 'not_in_top_candidates' && !closed,
    'not_in_top_candidates: position HELD, approval_status=not_in_top_candidates');
}

// ─── TC-06: missing_from_scan — HOLD, mark_status=missing_from_scan ───────────

{
  const pos = makePos({ symbol: 'TSTTC06', side: 'long' });
  const state = makeState([pos]);
  // Symbol NOT in scan → missing_from_scan
  const runOutput = { long_candidates: [], short_candidates: [] };

  const result = withTestState('tc06', state, () =>
    runPortfolio(runOutput, [], { runId: 'test_tc06' })
  );

  const outPos    = result.open_positions.find(p => p.symbol === 'TSTTC06');
  const unmatched = result.unmatched_positions.some(u => u.symbol === 'TSTTC06');
  const closed    = result.closed_this_run.some(c => c.symbol === 'TSTTC06');
  check('TC-06',
    outPos?.mark_status === 'missing_from_scan' && unmatched && !closed,
    'missing_from_scan: position HELD, mark_status=missing_from_scan, in unmatched_positions');
}

// ─── TC-12: thesis null-defaults — expired=false, attention=null, age=null ────

{
  const pos = makePos({
    symbol:                  'TSTTC12',
    side:                    'long',
    thesis_valid_until:      null,
    catalyst_recognized_at:  null,
    thesis_status:           null,
  });
  const state = makeState([pos]);
  const runOutput = { long_candidates: [{ symbol: 'TSTTC12', price_usd: 108 }], short_candidates: [] };

  const result = withTestState('tc12', state, () =>
    runPortfolio(runOutput, [], { runId: 'test_tc12' })
  );

  const outPos = result.open_positions.find(p => p.symbol === 'TSTTC12');
  let ok = false;
  let detail = 'position not found in output';
  if (outPos) {
    const { thesis_expired, thesis_attention, catalyst_age_days } = outPos;
    ok = thesis_expired === false && thesis_attention === null && catalyst_age_days === null;
    detail = `thesis_expired=${thesis_expired}, thesis_attention=${thesis_attention}, catalyst_age_days=${catalyst_age_days}`;
  }
  check('TC-12', ok,
    `thesis null-defaults: expired=false, attention=null, age=null (${detail})`);
}

// ─── TC-13: dry-run with future blocked_until → exit 0, block_type=explicit_temporary ──

{
  const scratchState = makeState([makePos({ symbol: 'TSTTC13', side: 'long' })]);
  const sp = scratchPath('state_mc13.json');
  writeFileSync(sp, JSON.stringify(scratchState, null, 2) + '\n', 'utf8');

  const proc = spawnSync(process.execPath, [
    MANUAL_CLOSE,
    '--symbol', 'TSTTC13',
    '--side',   'long',
    '--reason', 'test_reason',
    '--blocked-until', '2099-01-01',
    '--dry-run',
    '--state-path', sp,
  ], { encoding: 'utf8' });

  let ok = false;
  let detail = `exit=${proc.status}, stdout=${proc.stdout?.slice(0, 120)}`;
  if (proc.status === 0 && proc.stdout) {
    try {
      const out = JSON.parse(proc.stdout);
      ok = out.dry_run === true && out.status === 'would_close' &&
           out.block_type === 'explicit_temporary' && out.blocked_until === '2099-01-01';
      detail = `block_type=${out.block_type}, blocked_until=${out.blocked_until}`;
    } catch { detail = `JSON parse failed: ${proc.stdout.slice(0, 80)}`; }
  }
  check('TC-13', ok,
    `dry-run future blocked_until: exit 0, block_type=explicit_temporary (${detail})`);
}

// ─── TC-14: blocked-until past date → exit 1, stderr contains "future date" ───

{
  const proc = spawnSync(process.execPath, [
    MANUAL_CLOSE,
    '--symbol', 'TC14SYM',
    '--side',   'long',
    '--reason', 'test',
    '--blocked-until', '2020-01-01',
  ], { encoding: 'utf8' });

  const stderrHasFutureDate = proc.stderr?.includes('future date');
  check('TC-14',
    proc.status === 1 && stderrHasFutureDate,
    `past blocked-until: exit 1, stderr contains "future date"`);
}

// ─── TC-15: blocked-until invalid string → exit 1, stderr contains "valid ISO date"

{
  const proc = spawnSync(process.execPath, [
    MANUAL_CLOSE,
    '--symbol', 'TC15SYM',
    '--side',   'long',
    '--reason', 'test',
    '--blocked-until', 'not-a-date',
  ], { encoding: 'utf8' });

  const stderrHasValidISO = proc.stderr?.includes('valid ISO date');
  check('TC-15',
    proc.status === 1 && stderrHasValidISO,
    `invalid blocked-until: exit 1, stderr contains "valid ISO date"`);
}

// ─── TC-16: dry-run without blocked-until → exit 0, block_type=default_30d ────

{
  const scratchState = makeState([makePos({ symbol: 'TSTTC16', side: 'long' })]);
  const sp = scratchPath('state_mc16.json');
  writeFileSync(sp, JSON.stringify(scratchState, null, 2) + '\n', 'utf8');

  const proc = spawnSync(process.execPath, [
    MANUAL_CLOSE,
    '--symbol', 'TSTTC16',
    '--side',   'long',
    '--reason', 'test_reason',
    '--dry-run',
    '--state-path', sp,
  ], { encoding: 'utf8' });

  let ok = false;
  let detail = `exit=${proc.status}`;
  if (proc.status === 0 && proc.stdout) {
    try {
      const out = JSON.parse(proc.stdout);
      ok = out.dry_run === true && out.status === 'would_close' &&
           out.block_type === 'default_30d' && out.blocked_until != null;
      detail = `block_type=${out.block_type}, blocked_until=${out.blocked_until}`;
    } catch { detail = `JSON parse failed: ${proc.stdout.slice(0, 80)}`; }
  }
  check('TC-16', ok,
    `dry-run no blocked_until: exit 0, block_type=default_30d, blocked_until=+30d (${detail})`);
}

// ─── Final report ─────────────────────────────────────────────────────────────

const passed = RESULTS.filter(r => r.status === 'PASS').length;
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
const total  = RESULTS.length;

process.stderr.write('\n');
if (failed === 0) {
  process.stderr.write(`regression_smoke: all ${total} cases PASS\n`);
  process.exit(0);
} else {
  process.stderr.write(`regression_smoke: ${failed} FAIL / ${passed} PASS / ${total} total\n`);
  for (const r of RESULTS.filter(r => r.status === 'FAIL')) {
    process.stderr.write(`  → ${r.id}: ${r.msg}\n`);
  }
  process.exit(1);
}
