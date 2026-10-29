#!/usr/bin/env node
/**
 * Decision Engine
 *
 * Converts enriched scan candidates (from research_run output) into structured
 * TradeIntents, runs them through the risk engine, and produces ExecutionDecisions.
 *
 * Does NOT execute any trades. Output is audit-only in shadow mode.
 *
 * Usage (module):
 *   import { buildDecisions } from './decision_engine.mjs'
 *
 * Usage (CLI):
 *   node decision_engine.mjs [--run-log <path>] [--katalysator '{"ENPH":true}'] [--mode shadow|paper]
 *
 * Output (stdout): JSON array of ExecutionDecisions
 * Decisions written to: trading/execution/decisions/decisions_{run_id}.json
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath }                                        from 'url';

import { makeTradeIntent, makeExecutionDecision,
         TECHNICAL_ALIGNMENT, RISK_LEVEL_TO_TIER,
         EXECUTION_MODES }                           from './schemas.mjs';
import { runAllChecks }                              from './risk_engine.mjs';
import { auditLog }                                  from './audit_log.mjs';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', '..', 'trading');

const LOGS_DIR      = join(TRADING_DIR, 'logs');
const DECISIONS_DIR = join(TRADING_DIR, 'execution', 'decisions');

// ─── Technical alignment ─────────────────────────────────────────────────────

function computeTechnicalAlignment(candidate) {
  const tech = candidate.technical;
  if (!tech?.available) return TECHNICAL_ALIGNMENT.UNAVAILABLE;

  const { rsi, macd_signal } = tech;
  const isLong  = candidate.direction === 'LONG';

  const rsiConfirms  = isLong ? rsi <= 40 : rsi >= 60;
  const rsiConflicts = isLong ? rsi >= 70 : rsi <= 30;
  const macdConfirms = isLong ? macd_signal === 'bullish' : macd_signal === 'bearish';
  const macdConflicts= isLong ? macd_signal === 'bearish' : macd_signal === 'bullish';

  if (rsiConflicts && macdConflicts) return TECHNICAL_ALIGNMENT.CONFLICTED;
  if (rsiConflicts || macdConflicts) return TECHNICAL_ALIGNMENT.PARTIAL;  // one conflicts, one neutral/confirms
  if (rsiConfirms  && macdConfirms)  return TECHNICAL_ALIGNMENT.CONFIRMED;
  if (rsiConfirms  || macdConfirms)  return TECHNICAL_ALIGNMENT.PARTIAL;
  return TECHNICAL_ALIGNMENT.NEUTRAL;
}

// ─── Strategy classification ─────────────────────────────────────────────────

function classifyStrategy(candidate) {
  const tech = candidate.technical;
  if (!tech?.available) return 'unknown';

  const { rsi, macd_signal } = tech;
  const isLong = candidate.direction === 'LONG';

  // Oversold bounce or overbought fade = reversal
  if (isLong  && rsi <= 30) return 'momentum_reversal';
  if (!isLong && rsi >= 70) return 'momentum_reversal';

  // Trending with confirmation = continuation
  if (isLong  && macd_signal === 'bullish') return 'momentum_continuation';
  if (!isLong && macd_signal === 'bearish') return 'momentum_continuation';

  return 'unknown';
}

// ─── Confidence score (mirrors CLAUDE.md Konfidenz lookup) ───────────────────

function computeConfidenceScore(candidate, katalysator) {
  const R          = candidate.risk?.risk_level;
  const T          = candidate.technical?.available ?? false;
  const K          = katalysator ?? false;   // default: no catalyst confirmed
  const rsi        = candidate.technical?.rsi ?? null;
  const isLong     = candidate.direction === 'LONG';
  const rsiConfirms = rsi !== null && (isLong ? rsi <= 40 : rsi >= 60);

  // Mirror the 5-star lookup table from CLAUDE.md, normalised to 0–1
  if (R === 'EXTREME')                         return 0.2;
  if (R === 'HIGH')                            return 0.4;
  if (R === 'MEDIUM' && !K)                   return 0.4;
  if (R === 'MEDIUM' && K)                    return 0.6;
  if (R === 'LOW' && !K && !T)                return 0.6;
  if (R === 'LOW' && (K || T) && !(K && T))   return 0.8;
  if (R === 'LOW' && K && T && !rsiConfirms)  return 0.8;
  if (R === 'LOW' && K && T && rsiConfirms)   return 1.0;
  return 0.5; // fallback
}

// ─── Data freshness ──────────────────────────────────────────────────────────

function buildDataFreshness(candidate, runAt, scanAgeMinutes) {
  const indicatorAge = candidate.technical?.age_minutes ?? null;
  const priceAge     = scanAgeMinutes ?? null;
  const allFresh     = priceAge !== null && priceAge < 120 &&
                       indicatorAge !== null && indicatorAge < 90;
  return {
    price_age_minutes:     priceAge,
    indicator_age_minutes: indicatorAge,
    news_age_hours:        null,    // not yet machine-tracked
    all_fresh:             allFresh,
  };
}

// ─── Core intent builder ──────────────────────────────────────────────────────

function buildIntent(candidate, runId, runAt, scanAgeMinutes, katalysatorMap) {
  const symbol      = candidate.symbol;
  const katalysator = katalysatorMap?.[symbol] ?? null;
  const alignment   = computeTechnicalAlignment(candidate);

  const executionFields = {
    intent_id:                `intent_${runId}_${symbol}_${candidate.direction}`,
    intent_created_at:        new Date().toISOString(),
    signal_timestamp:         runAt,
    price_snapshot_timestamp: scanAgeMinutes != null
      ? new Date(new Date(runAt).getTime() - scanAgeMinutes * 60_000).toISOString()
      : runAt,
    news_timestamp:           null,   // not yet machine-tracked
    side:                     candidate.direction === 'LONG' ? 'long' : 'short',
    asset_type:               candidate.category === 'Stock' ? 'stock' : 'crypto',
    strategy:                 classifyStrategy(candidate),
    technical_alignment:      alignment,
    data_freshness:           buildDataFreshness(candidate, runAt, scanAgeMinutes),
    risk_tier:                RISK_LEVEL_TO_TIER[candidate.risk?.risk_level] ?? 'D',
    portfolio_risk_pct:       null,   // PLACEHOLDER — requires live account
    katalysator,
    confidence_score_normalized: computeConfidenceScore(candidate, katalysator),
  };

  return makeTradeIntent(candidate, executionFields);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * buildDecisions — process all candidates from a research_run output object.
 *
 * @param {object} runOutput      — parsed JSON from research_run.mjs stdout
 * @param {object} katalysatorMap — { [symbol]: boolean } — news catalyst presence
 * @param {string} mode           — 'shadow' | 'paper' (never 'live')
 * @returns {object[]}            — array of ExecutionDecisions
 */
export function buildDecisions(runOutput, katalysatorMap = {}, mode = EXECUTION_MODES.SHADOW) {
  if (mode === EXECUTION_MODES.LIVE) {
    throw new Error('Live execution mode is not supported in this phase.');
  }

  const { run_id, run_at, long_candidates = [], short_candidates = [], meta = {} } = runOutput;
  const scanAgeMinutes = meta.scan_age_minutes ?? null;
  const allCandidates  = [...long_candidates, ...short_candidates];
  const decisions      = [];

  process.stderr.write(JSON.stringify({
    info:       'decision_engine_start',
    run_id,
    candidates: allCandidates.length,
    mode,
  }) + '\n');

  for (const candidate of allCandidates) {
    auditLog('decision_started', { symbol: candidate.symbol, run_id, mode });

    const intent     = buildIntent(candidate, run_id, run_at, scanAgeMinutes, katalysatorMap);
    const gateResult = runAllChecks(intent);

    // Log failed checks to audit
    for (const check of gateResult.checks) {
      if (!check.passed) {
        auditLog('risk_check_failed', {
          symbol:  candidate.symbol,
          check:   check.check,
          reason:  check.reason,
          run_id,
        });
      }
      if (check.placeholder) {
        auditLog('risk_check_placeholder', { symbol: candidate.symbol, check: check.check, run_id });
      }
    }

    const decision = makeExecutionDecision(
      intent.intent_id,
      intent.symbol,
      intent.side,
      gateResult,
      { run_id, mode, confidence_score: intent.confidence_score_normalized },
    );

    auditLog(decision.execution_ready ? 'trade_approved' : 'trade_blocked', {
      symbol:          decision.symbol,
      side:            decision.side,
      blocked_reasons: decision.blocked_reasons,
      run_id,
      mode,
    });

    process.stderr.write(JSON.stringify({
      info:            decision.execution_ready ? 'decision_approved' : 'decision_blocked',
      symbol:          decision.symbol,
      side:            decision.side,
      blocked_reasons: decision.blocked_reasons,
      confidence:      intent.confidence_score_normalized,
      alignment:       intent.technical_alignment,
    }) + '\n');

    auditLog('decision_completed', { symbol: candidate.symbol, decision_id: decision.decision_id, run_id });

    decisions.push({ intent, decision });
  }

  // Persist all decisions to file
  try {
    mkdirSync(DECISIONS_DIR, { recursive: true });
    const outPath = join(DECISIONS_DIR, `decisions_${run_id}.json`);
    writeFileSync(outPath, JSON.stringify(decisions, null, 2) + '\n', 'utf8');
    process.stderr.write(JSON.stringify({ info: 'decisions_written', path: outPath, count: decisions.length }) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ warning: 'decisions_write_failed', error: e.message }) + '\n');
  }

  return decisions;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  // Parse CLI args
  const args         = process.argv.slice(2);
  const runLogFlag   = args.indexOf('--run-log');
  const katFlag      = args.indexOf('--katalysator');
  const modeFlag     = args.indexOf('--mode');

  let runOutput;
  if (runLogFlag !== -1 && args[runLogFlag + 1]) {
    runOutput = JSON.parse(readFileSync(args[runLogFlag + 1], 'utf8'));
  } else {
    // Use latest run log
    const files = readdirSync(LOGS_DIR)
      .filter(f => f.startsWith('run_') && f.endsWith('.json'))
      .sort().reverse();
    if (!files.length) {
      process.stderr.write(JSON.stringify({ error: 'no_run_log_found' }) + '\n');
      process.exit(1);
    }
    runOutput = JSON.parse(readFileSync(join(LOGS_DIR, files[0]), 'utf8'));
  }

  const katalysatorMap = katFlag !== -1 && args[katFlag + 1]
    ? JSON.parse(args[katFlag + 1])
    : {};

  const mode = modeFlag !== -1 && args[modeFlag + 1]
    ? args[modeFlag + 1]
    : EXECUTION_MODES.SHADOW;

  try {
    const results = buildDecisions(runOutput, katalysatorMap, mode);
    const summary = {
      run_id:   runOutput.run_id,
      total:    results.length,
      approved: results.filter(r => r.decision.execution_ready).length,
      blocked:  results.filter(r => !r.decision.execution_ready).length,
      mode,
    };
    process.stderr.write(JSON.stringify({ info: 'decision_engine_complete', ...summary }) + '\n');
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'decision_engine_failed', detail: e.message }) + '\n');
    process.exit(1);
  }
}
