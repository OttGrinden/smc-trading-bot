#!/usr/bin/env node
/**
 * scan.mjs — Orchestrated 3-step morning scan
 *
 * Steps (in order; 1 + 3 must succeed, 2 + 2b are fail-soft):
 *   1.  research_run.mjs       → baseline candidates + last run log
 *   2.  ohlcv_fetcher.mjs      → OHLCV closes: Stocks via Yahoo Finance, Crypto via Bitunix
 *   2b. positioning_fetcher.mjs → Funding/L-S-Ratio/OI für Crypto via Bitunix (fail-soft)
 *   3.  research_run.mjs       → RSI + MACD + Positioning enrichment
 *
 * Usage:
 *   node scan.mjs
 *     [--execution off|shadow|virtual_portfolio|alpaca_paper]
 *     [--exec-dispatch]            (opt-in; only valid with --execution alpaca_paper)
 *     [--exec-protective-exit]     (opt-in; only valid with --execution alpaca_paper)
 *     [--leverage N]
 *     [--realism on|off] [--slippage-bps N] [--fee-bps N]
 *     [--min-fee-eur N] [--partial-fills on|off] [--max-fill-fraction N]
 *     [--post-sl-cooldown] [--post-sl-block-hours N]
 *     [--min-cash-reserve-pct N] [--max-run-deployment-pct N]
 *     [--broker-mode off|live_readonly]
 *     [--broker-provider alpaca]
 *
 * stdout: final JSON output (same format as research_run.mjs — Claude reads this)
 * stderr: live step progress, execution/portfolio/realism/live-broker summaries
 *
 * All summaries are additive on stderr. stdout is never modified.
 * Broker mode is INDEPENDENT of execution mode — both can be combined or used alone.
 */

import { spawnSync }                from 'child_process';
import { writeFileSync }            from 'fs';
import { dirname, join }            from 'path';
import { fileURLToPath }            from 'url';
import { compressScanOutput }       from './compress_scan_output.mjs';
import { discordNotify }            from './discord_notify.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS  = 180_000; // 3 min per step
const startTime   = Date.now();

// ─── CLI arg helpers ─────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);

function cliFlag(name) {
  const idx = cliArgs.indexOf(name);
  return idx !== -1 && cliArgs[idx + 1] !== undefined ? cliArgs[idx + 1] : null;
}

// ─── Execution mode ──────────────────────────────────────────────────────────

const EXECUTION_MODE = cliFlag('--execution') ?? process.env.EXECUTION_MODE ?? 'off';
const LEVERAGE_CAP   = cliFlag('--leverage') !== null ? parseFloat(cliFlag('--leverage')) : 1.0;

// Post-SL policy (see portfolio_engine.mjs): cooldown is opt-in (default off),
// block hours default to the engine default (48) when the flag is absent.
const POST_SL_COOLDOWN = cliArgs.includes('--post-sl-cooldown') || process.env.POST_SL_COOLDOWN === 'true';
const POST_SL_BLOCK_HOURS_RAW = cliFlag('--post-sl-block-hours') ?? process.env.POST_SL_BLOCK_HOURS ?? null;
const POST_SL_BLOCK_HOURS = POST_SL_BLOCK_HOURS_RAW !== null && Number.isFinite(parseFloat(POST_SL_BLOCK_HOURS_RAW))
  ? parseFloat(POST_SL_BLOCK_HOURS_RAW)
  : undefined;

// Cash/allocation policy (see portfolio_engine.mjs): engine defaults apply when
// the flags are absent (reserve 0.20, run cap 0.25). 0 disables the reserve;
// values >= 1.0 disable the cap. Invalid values fail fast inside the engine.
const MIN_CASH_RESERVE_RAW = cliFlag('--min-cash-reserve-pct') ?? process.env.MIN_CASH_RESERVE_PCT ?? null;
const MIN_CASH_RESERVE_PCT = MIN_CASH_RESERVE_RAW !== null && Number.isFinite(parseFloat(MIN_CASH_RESERVE_RAW))
  ? parseFloat(MIN_CASH_RESERVE_RAW)
  : undefined;
const MAX_RUN_DEPLOY_RAW = cliFlag('--max-run-deployment-pct') ?? process.env.MAX_RUN_DEPLOYMENT_PCT ?? null;
const MAX_RUN_DEPLOYMENT_PCT = MAX_RUN_DEPLOY_RAW !== null && Number.isFinite(parseFloat(MAX_RUN_DEPLOY_RAW))
  ? parseFloat(MAX_RUN_DEPLOY_RAW)
  : undefined;

// Portfolio-aware hard gates (see portfolio_engine.mjs): engine defaults apply
// when the flags are absent (sector cap 0.40, risk budget 0.06). Values >= 1.0
// disable the respective gate. Invalid values fail fast inside the engine.
const SECTOR_CAP_RAW = cliFlag('--sector-exposure-cap') ?? process.env.SECTOR_EXPOSURE_CAP ?? null;
const SECTOR_EXPOSURE_CAP = SECTOR_CAP_RAW !== null && Number.isFinite(parseFloat(SECTOR_CAP_RAW))
  ? parseFloat(SECTOR_CAP_RAW)
  : undefined;
const RISK_BUDGET_RAW = cliFlag('--portfolio-risk-budget') ?? process.env.PORTFOLIO_RISK_BUDGET ?? null;
const PORTFOLIO_RISK_BUDGET = RISK_BUDGET_RAW !== null && Number.isFinite(parseFloat(RISK_BUDGET_RAW))
  ? parseFloat(RISK_BUDGET_RAW)
  : undefined;

// Conviction-based, stop-loss-derived position sizing (opt-in; default off → legacy
// target_position_pct sizing). Higher conviction ⇒ larger per-trade risk budget,
// notional derived from risk_pct / stop-loss distance, capped by MAX_PCT.
const CONVICTION_SIZING = cliArgs.includes('--conviction-sizing') || process.env.CONVICTION_SIZING === 'true';

// Conviction override (opt-in; default off). When on, full-conviction (★★★★★)
// candidates may draw cash below the normal reserve floor down to the reduced
// override floor (default 10% NAV). Every other gate stays in force. Because a
// ★★★★★ score requires a verified catalyst (K=ja), the override cannot fire on a
// reused scan that had no fresh news research.
const CONVICTION_OVERRIDE = cliArgs.includes('--conviction-override') || process.env.CONVICTION_OVERRIDE === 'true';
const CONV_OVERRIDE_RAW = cliFlag('--conviction-override-reserve-pct') ?? process.env.CONVICTION_OVERRIDE_RESERVE_PCT ?? null;
const CONVICTION_OVERRIDE_RESERVE_PCT = CONV_OVERRIDE_RAW !== null && Number.isFinite(parseFloat(CONV_OVERRIDE_RAW))
  ? parseFloat(CONV_OVERRIDE_RAW)
  : undefined;

// Optional: take-profit (opt-in; default off). When set, new positions opened this run
// carry take_profit_pct = N and auto-close when the unrealised gain reaches N%.
// Example: --take-profit 15   (auto-close when +15% gain)
const TAKE_PROFIT_RAW = cliFlag('--take-profit') ?? process.env.TAKE_PROFIT_PCT ?? null;
const TAKE_PROFIT_PCT = TAKE_PROFIT_RAW !== null && Number.isFinite(parseFloat(TAKE_PROFIT_RAW))
  ? parseFloat(TAKE_PROFIT_RAW)
  : undefined;

// Optional: restrict allocation to an explicit comma-separated symbol list.
// Example: --symbols BTC,IONQ
const SYMBOLS_RAW = cliFlag('--symbols');
const SYMBOLS_FILTER = SYMBOLS_RAW
  ? new Set(SYMBOLS_RAW.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))
  : null;

// Optional: per-symbol position overrides (JSON).
// Example: --position-overrides '{"BTC":{"target_position_pct":0.15,"leverage":2,"stop_loss_pct":0.03}}'
// target_position_pct: fraction of NAV (0.15 = 15%)
// leverage:            metadata multiplier (does NOT reduce cash — see transparency warning)
// stop_loss_pct:       fraction (<1) or percent (≥1) — 0.03 and 3 both mean 3%
const POSITION_OVERRIDES_RAW = cliFlag('--position-overrides');
let POSITION_OVERRIDES = {};
if (POSITION_OVERRIDES_RAW) {
  try {
    POSITION_OVERRIDES = JSON.parse(POSITION_OVERRIDES_RAW);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'position_overrides_invalid_json', detail: e.message }) + '\n');
    process.exit(2);
  }
}

const VALID_EXEC_MODES = ['off', 'shadow', 'virtual_portfolio', 'alpaca_paper', 'bitunix_futures'];
if (!VALID_EXEC_MODES.includes(EXECUTION_MODE)) {
  process.stderr.write(JSON.stringify({ error: 'invalid_execution_mode', mode: EXECUTION_MODE, valid: VALID_EXEC_MODES }) + '\n');
  process.exit(2);
}

// ─── Broker mode (parsed early for fast fail on invalid config) ───────────────
// Default: 'off' — no live broker connectivity.
// Activation: --broker-mode live_readonly --broker-provider alpaca
// Credentials via env vars only: ALPACA_KEY_ID, ALPACA_SECRET_KEY
//
// Parsed eagerly so config errors fail before the scan pipeline runs.

let brokerConfig;
try {
  const { parseBrokerConfig } = await import('./execution/live_broker/live_broker_config.mjs');
  brokerConfig = parseBrokerConfig(cliArgs, process.env);
} catch (e) {
  process.stderr.write(JSON.stringify({ error: 'broker_config_invalid', detail: e.message }) + '\n');
  process.exit(2);
}

// ─── Paper exec config (validated eagerly — fail before scan pipeline starts) ─
// Only parsed when --execution alpaca_paper; mirrors the parseBrokerConfig block above.

let paperExecConfig = null;
if (EXECUTION_MODE === 'alpaca_paper') {
  try {
    const { validatePaperExecConfig } = await import('./execution/live_broker/paper_exec_layer.mjs');
    paperExecConfig = validatePaperExecConfig(cliArgs, process.env);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'paper_exec_config_invalid', detail: e.message }) + '\n');
    process.exit(2);
  }
}

// ─── Bitunix exec config (validated eagerly — fail before scan pipeline starts) ─
// Only parsed when --execution bitunix_futures.

let bitunixExecConfig = null;
if (EXECUTION_MODE === 'bitunix_futures') {
  try {
    const { validateBitunixExecConfig } = await import('./execution/live_broker/bitunix_exec_layer.mjs');
    bitunixExecConfig = validateBitunixExecConfig(cliArgs, process.env);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'bitunix_exec_config_invalid', detail: e.message }) + '\n');
    process.exit(2);
  }
}

// ─── Opt-in dispatch mode (valid with --execution alpaca_paper or bitunix_futures) ──
const EXEC_DISPATCH = cliArgs.includes('--exec-dispatch');
const EXEC_DISPATCH_VALID_MODES = new Set(['alpaca_paper', 'bitunix_futures']);
if (EXEC_DISPATCH && !EXEC_DISPATCH_VALID_MODES.has(EXECUTION_MODE)) {
  process.stderr.write(JSON.stringify({ error: 'exec_dispatch_requires_broker_exec', detail: '--exec-dispatch is only valid with --execution alpaca_paper or bitunix_futures' }) + '\n');
  process.exit(2);
}

// ─── Opt-in protective-exit pass (only valid with --execution alpaca_paper) ───
const EXEC_PROTECTIVE_EXIT = cliArgs.includes('--exec-protective-exit');
if (EXEC_PROTECTIVE_EXIT && EXECUTION_MODE !== 'alpaca_paper') {
  process.stderr.write(JSON.stringify({ error: 'exec_protective_exit_requires_alpaca_paper', detail: '--exec-protective-exit is only valid with --execution alpaca_paper' }) + '\n');
  process.exit(2);
}

// ─── Core scan steps ─────────────────────────────────────────────────────────

function step(scriptName, label) {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  process.stderr.write(JSON.stringify({ info: 'scan_step_start', label, script: scriptName }) + '\n');

  const result = spawnSync(process.execPath, [scriptPath], {
    timeout:   TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    stdio:     ['ignore', 'pipe', 'inherit'],
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`;
    process.stderr.write(JSON.stringify({ error: 'scan_step_failed', label, script: scriptName, detail }) + '\n');
    process.exit(1);
  }

  process.stderr.write(JSON.stringify({ info: 'scan_step_done', label }) + '\n');
  return result.stdout?.toString('utf8') ?? '';
}

// softStep — wie step(), aber Fehler sind nicht fatal (Enrichment-Schritte).
// Der Scan läuft weiter; der Ausfall wird als scan_step_warn geloggt.
function softStep(scriptName, label) {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  process.stderr.write(JSON.stringify({ info: 'scan_step_start', label, script: scriptName }) + '\n');
  const result = spawnSync(process.execPath, [scriptPath], {
    timeout:   TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    stdio:     ['ignore', 'pipe', 'inherit'],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`;
    process.stderr.write(JSON.stringify({ warn: 'scan_step_warn', label, script: scriptName, detail, note: 'non-fatal — scan continues' }) + '\n');
    return null;
  }
  process.stderr.write(JSON.stringify({ info: 'scan_step_done', label }) + '\n');
  return result.stdout?.toString('utf8') ?? '';
}

// pyStep / softPyStep — wie step/softStep, aber für Python-Skripte.
function pyStep(scriptName, label) {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  process.stderr.write(JSON.stringify({ info: 'scan_step_start', label, script: scriptName }) + '\n');
  const result = spawnSync('python', [scriptPath], {
    timeout:   TIMEOUT_MS,
    maxBuffer: 5 * 1024 * 1024,
    stdio:     ['ignore', 'pipe', 'inherit'],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`;
    process.stderr.write(JSON.stringify({ error: 'scan_step_failed', label, script: scriptName, detail }) + '\n');
    process.exit(1);
  }
  process.stderr.write(JSON.stringify({ info: 'scan_step_done', label }) + '\n');
  return result.stdout?.toString('utf8') ?? '';
}

function softPyStep(scriptName, label) {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  process.stderr.write(JSON.stringify({ info: 'scan_step_start', label, script: scriptName }) + '\n');
  const result = spawnSync('python', [scriptPath], {
    timeout:   TIMEOUT_MS,
    maxBuffer: 5 * 1024 * 1024,
    stdio:     ['ignore', 'pipe', 'inherit'],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`;
    process.stderr.write(JSON.stringify({ warn: 'scan_step_warn', label, script: scriptName, detail, note: 'non-fatal — scan continues' }) + '\n');
    return null;
  }
  process.stderr.write(JSON.stringify({ info: 'scan_step_done', label }) + '\n');
  return result.stdout?.toString('utf8') ?? '';
}

// 1. Baseline
step('research_run.mjs', 'baseline');

// 2. Fetch OHLCV (fail-soft — missing data leaves technical.available=false)
softStep('ohlcv_fetcher.mjs', 'ohlcv_fetch');

// 2b. Derivatives-Positioning für Crypto (fail-soft — Bitunix public API)
softStep('positioning_fetcher.mjs', 'positioning');

// 2c. Liquidation Heatmap — Order Book Walls für Crypto (fail-soft — Bitunix depth API)
softStep('liq_heatmap.mjs', 'liq_heatmap');

// 2d. SMC Regime Filter — GREEN/RED gate für Crypto-SMC-Trades (fail-soft: bei Fehler kein SMC)
let smcGreen = false;
const regimeRaw = softPyStep('regime_filter.py', 'regime_filter');
if (regimeRaw) {
  try {
    const regime = JSON.parse(regimeRaw.trim());
    smcGreen = regime.regime === 'GREEN';
    process.stderr.write(JSON.stringify({
      info:      'regime_filter_result',
      regime:    regime.regime,
      fng_value: regime.fng_value,
      atr_pct:   regime.atr_pct,
      reason:    regime.reason,
    }) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ warn: 'regime_filter_parse_error', detail: e.message }) + '\n');
  }
}

// 2e. SMC Detector — nur wenn Regime GREEN (fail-soft; NDJSON: eine Zeile pro Symbol)
let smcSignals = [];
if (smcGreen) {
  const smcRaw = softPyStep('smc_detector.py', 'smc_detector');
  if (smcRaw) {
    const lines = smcRaw.trim().split('\n').filter(Boolean);
    smcSignals = lines
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(s => s !== null && typeof s.score === 'number' && s.score >= 8);
    process.stderr.write(JSON.stringify({
      info:    'smc_detector_result',
      total:   lines.length,
      signals: smcSignals.length,
      symbols: smcSignals.map(s => `${s.symbol}(${s.score}/${s.side})`),
    }) + '\n');
  }
} else {
  process.stderr.write(JSON.stringify({ info: 'smc_detector_skipped', reason: smcGreen ? 'regime_parse_failed' : 'regime_RED' }) + '\n');
}

// 3. Full enrichment (RSI + MACD + Positioning + Liq Heatmap)
let finalOutput = step('research_run.mjs', 'full_run');

// 3b. SMC dispatch — score 8 = setup monitoring only, score 9-10 = thesis_reviewer gate → auto_open
const smc8only  = smcSignals.filter(s => s.score === 8);
const smc9plus  = smcSignals.filter(s => s.score >= 9);

// Score 8: IDM not yet swept — log as monitoring, no trade
for (const signal of smc8only) {
  process.stderr.write(JSON.stringify({
    info:   'smc_monitoring',
    symbol: signal.symbol,
    score:  signal.score,
    side:   signal.side,
    reason: signal.reason,
    note:   'IDM not swept — watching for entry trigger',
  }) + '\n');
  await discordNotify(
    `👁 **SMC Score 8 — Monitoring** | ${signal.symbol} ${signal.side.toUpperCase()}\n` +
    `IDM bei $${signal.idm_level ?? '?'} noch nicht gesweept (Preis: $${signal.current_price ?? '?'})\n` +
    `→ Kein Trade. Warte auf IDM-Sweep für Score 9.`
  );
}

// Score 9-10: IDM swept — route through thesis_reviewer before auto_open
if (smc9plus.length > 0 && EXECUTION_MODE !== 'off') {
  const reviewerPath  = join(SCRIPTS_DIR, 'thesis_reviewer.mjs');
  const autoOpenPath  = join(SCRIPTS_DIR, 'execution', 'auto_open.mjs');

  for (const signal of smc9plus) {
    process.stderr.write(JSON.stringify({
      info:   'smc_thesis_review_start',
      symbol: signal.symbol,
      score:  signal.score,
      side:   signal.side,
    }) + '\n');

    // Discord: score-9/10 signal detected — notify immediately
    await discordNotify(
      `🎯 **SMC Score ${signal.score} Signal** — ${signal.symbol} ${signal.side.toUpperCase()}\n` +
      `Entry: $${signal.entry_price ?? signal.current_price} | ${signal.reason}\n` +
      `OTE: $${signal.ote_low ?? '?'} – $${signal.ote_high ?? '?'} | thesis_reviewer läuft...`
    );

    // Step 1: Call thesis_reviewer
    const rv = spawnSync(process.execPath, [
      reviewerPath,
      '--signal', JSON.stringify(signal),
    ], {
      timeout:   90_000,
      maxBuffer: 1 * 1024 * 1024,
      stdio:     ['ignore', 'pipe', 'inherit'],
    });

    let review = { approved: false, confidence: 1, reason: 'reviewer_failed', symbol: signal.symbol, score: signal.score };
    if (!rv.error && rv.status === 0) {
      try { review = JSON.parse(rv.stdout?.toString('utf8').trim() ?? '{}'); } catch { /* keep default */ }
    } else {
      process.stderr.write(JSON.stringify({ warn: 'smc_reviewer_spawn_failed', symbol: signal.symbol, detail: rv.error?.message ?? `exit ${rv.status}` }) + '\n');
    }

    process.stderr.write(JSON.stringify({
      info:       'smc_thesis_review_result',
      symbol:     signal.symbol,
      approved:   review.approved,
      confidence: review.confidence,
      reason:     review.reason,
    }) + '\n');

    if (!review.approved) {
      process.stderr.write(JSON.stringify({ info: 'smc_auto_open_blocked', symbol: signal.symbol, reason: review.reason }) + '\n');
      await discordNotify(
        `⛔ **${signal.symbol} BLOCKED** (Score ${signal.score}) — ${review.reason}`
      );
      continue;
    }

    // Discord: trade approved — notify before execution
    await discordNotify(
      `✅ **TRADE APPROVED** — ${signal.symbol} ${signal.side.toUpperCase()} Score ${signal.score}\n` +
      `Confidence: ${review.confidence}/10 | ${review.reason}\n` +
      `→ auto_open wird ausgeführt...`
    );

    // Step 2: thesis approved → auto_open
    process.stderr.write(JSON.stringify({
      info:   'smc_auto_open_attempt',
      symbol: signal.symbol,
      score:  signal.score,
      side:   signal.side,
      reason: signal.reason,
    }) + '\n');
    const ao = spawnSync(process.execPath, [
      autoOpenPath,
      '--symbol',   signal.symbol,
      '--side',     signal.side,
      '--score',    String(signal.score),
      '--reason',   signal.reason,
      '--category', 'crypto',
    ], {
      timeout:   60_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio:     ['ignore', 'pipe', 'inherit'],
    });
    if (ao.error || ao.status !== 0) {
      process.stderr.write(JSON.stringify({ warn: 'smc_auto_open_failed', symbol: signal.symbol, detail: ao.error?.message ?? `exit ${ao.status}` }) + '\n');
    } else {
      try {
        const aoOut = JSON.parse(ao.stdout?.toString('utf8') ?? '{}');
        process.stderr.write(JSON.stringify({ info: 'smc_auto_open_result', symbol: signal.symbol, ...aoOut }) + '\n');
      } catch {
        process.stderr.write(JSON.stringify({ info: 'smc_auto_open_done', symbol: signal.symbol }) + '\n');
      }
    }
  }
} else if (smc9plus.length > 0) {
  process.stderr.write(JSON.stringify({ info: 'smc_auto_open_skipped', reason: 'execution_mode_off', signals: smc9plus.length }) + '\n');
}

// Inject smc_signals into finalOutput so slim log + Claude output includes them
if (smcSignals.length > 0 || smcGreen) {
  try {
    const parsed = JSON.parse(finalOutput);
    parsed.smc_regime = smcGreen ? 'GREEN' : 'RED_or_unknown';
    if (smcSignals.length > 0) parsed.smc_signals = smcSignals;
    finalOutput = JSON.stringify(parsed);
  } catch { /* fail-soft — finalOutput bleibt unverändert */ }
}

// 3c. Macro Signal Check + Auto-Trade (fail-soft — always paper mode, never blocks scan)
softStep('macro_trader.mjs', 'macro_trader');

// 3c. Thesis expiry — auto-close stagnant Score-8 positions after 5-day window (fail-soft)
softStep('thesis_expiry_check.mjs', 'thesis_expiry');

// 3d. Catalyst Calendar — earnings dates for all registry stocks (fail-soft).
// Result is injected into candidate/watchlist objects as `catalyst_upcoming`.
const catalystRaw = softStep('catalyst_calendar.mjs', 'catalyst_calendar');
if (catalystRaw) {
  try {
    const { catalyst_data } = JSON.parse(catalystRaw);
    if (catalyst_data && typeof catalyst_data === 'object') {
      const parsed = JSON.parse(finalOutput);
      const inject = c => {
        const cd = catalyst_data[c.symbol];
        if (cd) c.catalyst_upcoming = cd;
      };
      (parsed.long_candidates  ?? []).forEach(inject);
      (parsed.short_candidates ?? []).forEach(inject);
      (parsed.pinned_watchlist ?? []).forEach(inject);
      finalOutput = JSON.stringify(parsed);
    }
  } catch { /* fail-soft — original finalOutput used unchanged */ }
}

// Discord: Scan-Summary für alle Kandidaten mit score_bounds.ceiling >= 7
try {
  const parsed = JSON.parse(finalOutput);
  const all = [...(parsed.long_candidates ?? []), ...(parsed.short_candidates ?? [])];
  const notable = all.filter(c => (c.score_bounds?.ceiling ?? 0) >= 7 && c.category === 'Crypto');
  if (notable.length > 0) {
    const lines = notable.map(c => {
      const dir   = c.direction ?? '?';
      const ceil  = c.score_bounds?.ceiling ?? '?';
      const tstar = c.score_bounds?.t_stark ? ' ⚡T★' : '';
      const fib   = c.technical?.fib?.in_zone ? ` · Fib✓` : '';
      const earn  = c.catalyst_upcoming?.within_14_days ? ` · 📅Earnings ${c.catalyst_upcoming.days_until}d` : '';
      return `  ${dir === 'LONG' ? '🟢' : '🔴'} **${c.symbol}** ${dir} — ceiling ${ceil}${tstar}${fib}${earn} | RSI ${c.technical?.rsi?.toFixed(1) ?? '?'}`;
    });
    const runId  = parsed.run_id ?? '';
    const btcPx  = parsed.btc_positioning?.mark_price_usd ? ` · BTC $${parsed.btc_positioning.mark_price_usd.toLocaleString()}` : '';
    const smcTxt = smcSignals.length > 0
      ? `\n📡 SMC: ${smcSignals.map(s => `${s.symbol} s${s.score}`).join(', ')} (regime ${smcGreen ? 'GREEN' : 'RED'})`
      : `\n📡 SMC: kein Signal (regime ${smcGreen ? 'GREEN' : 'RED'})`;
    await discordNotify(
      `📊 **Scan ${runId}**${btcPx}\n` +
      lines.join('\n') +
      smcTxt
    );
  }
} catch { /* fail-soft */ }

// Compress for Claude/agent consumption (stdout + slim log).
// Full data stays in `finalOutput` — execution layer reads it unchanged.
let _slimJson = null;
try {
  const slim = compressScanOutput(JSON.parse(finalOutput));
  _slimJson  = JSON.stringify(slim) + '\n';
  process.stdout.write(_slimJson);
} catch {
  process.stdout.write(finalOutput + '\n');
}

// Prune stale cache entries (housekeeping — runs after all step writes are done)
try {
  const { pruneIndicatorCache } = await import('./indicator_cache.mjs');
  const pr = pruneIndicatorCache(60);
  if (pr.pruned > 0) {
    process.stderr.write(JSON.stringify({ info: 'indicator_cache_pruned', pruned: pr.pruned, kept: pr.kept }) + '\n');
  }
} catch { /* best-effort — never aborts the scan */ }

try {
  const { prunePositioningCache } = await import('./positioning_fetcher.mjs');
  const pr = prunePositioningCache(90);
  if (pr.pruned > 0) {
    process.stderr.write(JSON.stringify({ info: 'positioning_cache_pruned', pruned: pr.pruned, kept: pr.kept }) + '\n');
  }
} catch { /* best-effort — never aborts the scan */ }

// Scan summary on stderr (best-effort)
try {
  const data   = JSON.parse(finalOutput);
  const all    = [...(data.long_candidates ?? []), ...(data.short_candidates ?? [])];
  const tvOk   = all.filter(c => c.technical?.available).length;
  const risk   = {};
  for (const c of all) {
    const r = c.risk?.risk_level ?? 'UNKNOWN';
    risk[r] = (risk[r] ?? 0) + 1;
  }
  process.stderr.write(JSON.stringify({
    info:         'scan_complete',
    run_id:       data.run_id,
    longs:        data.long_candidates?.length ?? 0,
    shorts:       data.short_candidates?.length ?? 0,
    total:        all.length,
    tv_available: tvOk,
    tv_missing:   all.length - tvOk,
    risk,
    duration_ms:  Date.now() - startTime,
  }) + '\n');
} catch { /* summary is best-effort — never aborts the run */ }

// ─── Optional execution layer ────────────────────────────────────────────────

if (EXECUTION_MODE !== 'off') {
  await runExecutionLayer(finalOutput, EXECUTION_MODE, LEVERAGE_CAP, cliArgs);
}

// ─── Optional live broker read-only layer ────────────────────────────────────

if (brokerConfig.broker_mode === 'live_readonly') {
  await runLiveBrokerLayer(finalOutput, brokerConfig);
}

// ─── Optional paper exec layer ───────────────────────────────────────────────

if (EXECUTION_MODE === 'alpaca_paper') {
  await runPaperExecLayerInScan(finalOutput, paperExecConfig, EXEC_DISPATCH, EXEC_PROTECTIVE_EXIT);
}

// ─── Optional Bitunix exec layer ─────────────────────────────────────────────

if (EXECUTION_MODE === 'bitunix_futures') {
  await runBitunixExecLayerInScan(finalOutput, bitunixExecConfig, EXEC_DISPATCH);
}

// Write slim log for token-efficient session reads (best-effort).
if (_slimJson) {
  try {
    const _slimRunId = JSON.parse(_slimJson)?.run_id;
    if (_slimRunId) {
      writeFileSync(
        join(SCRIPTS_DIR, '../trading/logs', `${_slimRunId}_slim.json`),
        _slimJson,
        'utf8'
      );
    }
  } catch { /* best-effort — never aborts */ }
}

// Learning Engine: Outcome-Analytik + Pattern-Detection nach jedem Scan (fail-soft).
// Schreibt learning_state.json + Memory-Dateien wenn neue Muster erkannt werden.
try {
  const analyticsPath = join(SCRIPTS_DIR, 'outcome_analytics.mjs');
  const analyticsResult = spawnSync(
    process.execPath,
    [analyticsPath, '--save-learning', '--quiet'],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const learningInfo = analyticsResult.stderr?.toString('utf8').trim();
  if (learningInfo) process.stderr.write(learningInfo + '\n');
} catch { /* best-effort — nie abortiert den Scan */ }

// Write success status marker — consumed by session_start_hook on next session.
// Failure case is handled by run_morgenscan.vbs (VBS is the only layer that
// sees the exit code after a process.exit(1) from a step() or execution layer).
try {
  const parsed = JSON.parse(finalOutput);
  const allC   = [...(parsed.long_candidates ?? []), ...(parsed.short_candidates ?? [])];
  writeFileSync(
    join(SCRIPTS_DIR, '../trading/logs/last_scan_status.json'),
    JSON.stringify({
      status:       'ok',
      run_id:       parsed.run_id,
      finished_at:  new Date().toISOString(),
      tv_available: allC.filter(c => c.technical?.available).length,
      total:        allC.length,
      duration_ms:  Date.now() - startTime,
    }),
    'utf8'
  );
} catch { /* best-effort — never aborts the scan */ }

// ─────────────────────────────────────────────────────────────────────────────

async function runExecutionLayer(scanJson, mode, leverageCap, args) {
  let runOutput;
  try {
    runOutput = JSON.parse(scanJson);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'execution_layer_no_scan_json', detail: e.message }) + '\n');
    process.exit(1);
  }

  let buildDecisions, runPortfolio, EXECUTION_MODES, parseRealismConfig, realismEnabled;
  try {
    ({ buildDecisions }                    = await import('./execution/decision_engine.mjs'));
    ({ runPortfolio }                      = await import('./execution/portfolio/portfolio_engine.mjs'));
    ({ EXECUTION_MODES }                   = await import('./execution/schemas.mjs'));
    ({ parseRealismConfig, realismEnabled } = await import('./execution/realism_config.mjs'));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'execution_layer_import_failed', detail: e.message }) + '\n');
    process.exit(1);
  }

  let realismConfig;
  try {
    realismConfig = parseRealismConfig(args, process.env);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'realism_config_invalid', detail: e.message }) + '\n');
    process.exit(2);
  }

  let decisions;
  try {
    decisions = buildDecisions(runOutput, {}, EXECUTION_MODES.SHADOW);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'decision_engine_crashed', detail: e.message }) + '\n');
    process.exit(1);
  }

  const approved = decisions.filter(d => d.decision.execution_ready);
  const blocked  = decisions.filter(d => !d.decision.execution_ready);
  const reasonCounts = {};
  for (const d of blocked) for (const r of d.decision.blocked_reasons) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
  const topReasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  process.stderr.write('\n=== Execution Shadow Summary ===\n');
  process.stderr.write(`- mode: shadow\n`);
  process.stderr.write(`- run_id: ${runOutput.run_id}\n`);
  process.stderr.write(`- approved: ${approved.length}\n`);
  process.stderr.write(`- blocked: ${blocked.length}\n`);
  process.stderr.write(`- top blocked reasons: ${topReasons.map(([r, n]) => `${r} (${n})`).join(', ') || 'none'}\n`);
  process.stderr.write(`- decisions file: ${join(SCRIPTS_DIR, '..', 'trading', 'execution', 'decisions', `decisions_${runOutput.run_id}.json`)}\n`);
  process.stderr.write(`- audit file: ${join(SCRIPTS_DIR, '..', 'trading', 'execution', 'audit', `audit_${new Date().toISOString().slice(0,10)}.jsonl`)}\n`);
  process.stderr.write(JSON.stringify({ info: 'shadow_summary', run_id: runOutput.run_id, approved: approved.length, blocked: blocked.length }) + '\n');

  if (mode !== 'virtual_portfolio') return;

  let summary;
  try {
    summary = runPortfolio(runOutput, decisions, {
      leverageCap,
      runId:             runOutput.run_id,
      realismConfig,
      symbolsFilter:     SYMBOLS_FILTER,
      positionOverrides: POSITION_OVERRIDES,
      postSlCooldown:    POST_SL_COOLDOWN,
      ...(POST_SL_BLOCK_HOURS !== undefined ? { postSlBlockHours: POST_SL_BLOCK_HOURS } : {}),
      ...(MIN_CASH_RESERVE_PCT !== undefined ? { minCashReservePct: MIN_CASH_RESERVE_PCT } : {}),
      ...(MAX_RUN_DEPLOYMENT_PCT !== undefined ? { maxRunDeploymentPct: MAX_RUN_DEPLOYMENT_PCT } : {}),
      ...(SECTOR_EXPOSURE_CAP !== undefined ? { sectorExposureCap: SECTOR_EXPOSURE_CAP } : {}),
      ...(PORTFOLIO_RISK_BUDGET !== undefined ? { portfolioRiskBudget: PORTFOLIO_RISK_BUDGET } : {}),
      convictionSizing: CONVICTION_SIZING,
      convictionOverride: CONVICTION_OVERRIDE,
      ...(CONVICTION_OVERRIDE_RESERVE_PCT !== undefined ? { convictionOverrideReservePct: CONVICTION_OVERRIDE_RESERVE_PCT } : {}),
      ...(TAKE_PROFIT_PCT !== undefined ? { takeProfitPct: TAKE_PROFIT_PCT } : {}),
    });
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'portfolio_engine_crashed', detail: e.message }) + '\n');
    process.exit(1);
  }

  const fmt = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  process.stderr.write('\n=== Portfolio Simulation Summary ===\n');
  process.stderr.write(`- mode: virtual_portfolio\n`);
  process.stderr.write(`- NAV: EUR ${summary.equity_nav.toFixed(2)}\n`);
  process.stderr.write(`- cash: EUR ${summary.cash.toFixed(2)} (${summary.cash_pct}%)\n`);
  process.stderr.write(`- open positions: ${summary.open_positions.length} (${summary.open_positions.map(p => `${p.side} ${p.symbol}${p.partial_order_id ? ' [partial]' : ''}`).join(', ') || 'none'})\n`);
  process.stderr.write(`- realized PnL: EUR ${fmt(summary.realized_pnl)}\n`);
  process.stderr.write(`- unrealized PnL: EUR ${fmt(summary.unrealized_pnl)}\n`);
  if (summary.post_sl_cooldown_applied) {
    process.stderr.write(`- post-SL cooldown: ACTIVE — all new allocations suppressed this run\n`);
  }
  if (summary.cash_reserve_eur > 0) {
    process.stderr.write(`- cash reserve floor: EUR ${summary.cash_reserve_eur.toFixed(2)} (${(summary.cash_reserve_pct * 100).toFixed(0)}% NAV)\n`);
  }
  if (summary.run_deployment_cap_eur != null) {
    process.stderr.write(`- run deployment: EUR ${summary.deploy_run_used_eur.toFixed(2)} / ${summary.run_deployment_cap_eur.toFixed(2)} cap\n`);
  }
  if (summary.conviction_override_enabled) {
    process.stderr.write(`- conviction override: ENABLED (★★★★★ floor ${(summary.conviction_override_reserve_pct * 100).toFixed(0)}% NAV vs normal ${(summary.cash_reserve_pct * 100).toFixed(0)}%) — applied to ${summary.conviction_override_applied} position(s) this run\n`);
  }
  if (summary.portfolio_risk_budget_eur != null) {
    process.stderr.write(`- portfolio at risk: EUR ${summary.portfolio_at_risk_eur.toFixed(2)} / ${summary.portfolio_risk_budget_eur.toFixed(2)} budget (${summary.portfolio_at_risk_pct}% NAV)${summary.risk_budget_skips > 0 ? ` — ${summary.risk_budget_skips} skipped` : ''}\n`);
  }
  if (summary.sector_exposure_cap_eur != null) {
    const secLine = Object.entries(summary.sector_exposure_eur)
      .sort((a, b) => b[1] - a[1])
      .map(([s, v]) => `${s} EUR${v.toFixed(0)}`)
      .join(', ') || 'none';
    process.stderr.write(`- sector exposure cap: EUR ${summary.sector_exposure_cap_eur.toFixed(2)} (${(summary.sector_exposure_cap_pct * 100).toFixed(0)}% NAV)${summary.sector_cap_skips > 0 ? ` — ${summary.sector_cap_skips} skipped` : ''}\n`);
    process.stderr.write(`  sectors: ${secLine}\n`);
  }
  if (summary.risk_unknown_skips > 0) {
    process.stderr.write(`- risk_unknown skips (no stop-loss, fail-closed): ${summary.risk_unknown_skips}\n`);
  }
  if (summary.sector_backfill && (summary.sector_backfill.filled.length > 0 || !summary.sector_backfill.registry_ok)) {
    const bf = summary.sector_backfill;
    process.stderr.write(`- sector backfill: filled ${bf.filled.length}${bf.filled.length ? ` (${bf.filled.join(', ')})` : ''}${bf.unresolved.length ? ` · unresolved: ${bf.unresolved.join(', ')}` : ''}${bf.registry_ok ? '' : ' · ⚠ registry unavailable'}\n`);
  }
  process.stderr.write(`- committed capital: EUR ${summary.committed_capital_eur.toFixed(2)} (reserved, cash-effective)\n`);
  process.stderr.write(`- inf. leveraged notional: EUR ${summary.informational_leveraged_notional_eur.toFixed(2)} (metadata only — not cash-effective)\n`);
  process.stderr.write(`- cumulative fees paid: EUR ${(summary.cumulative_fees_eur ?? 0).toFixed(4)}\n`);
  process.stderr.write(`- top new allocations: ${summary.new_allocations.map(a => `${a.side} ${a.symbol} EUR${a.notional_eur.toFixed(0)}${a.partial ? ' [partial]' : ''}`).join(', ') || 'none'}\n`);

  // Transparency: per-position accounting when position-overrides or symbol filter are active
  if (Object.keys(POSITION_OVERRIDES).length > 0 || SYMBOLS_FILTER !== null) {
    const anyLeverage = summary.open_positions.some(p => (p.leverage ?? 1) > 1);
    process.stderr.write('\n--- Position Accounting (Override Mode) ---\n');
    if (SYMBOLS_FILTER) process.stderr.write(`  symbols filter: ${[...SYMBOLS_FILTER].join(', ')}\n`);
    for (const pos of summary.open_positions) {
      const reserved = pos.notional_eur;
      const leverage = pos.leverage ?? 1;
      const infoNotional = +(reserved * leverage).toFixed(2);
      const sl = pos.stop_loss_pct != null ? `SL ${pos.stop_loss_pct}%` : 'no SL';
      process.stderr.write(`  ${pos.side.toUpperCase()} ${pos.symbol}: reserved capital EUR ${reserved.toFixed(2)} | leverage ${leverage}x | inf. notional EUR ${infoNotional} | ${sl}\n`);
    }
    process.stderr.write(`  committed capital total:      EUR ${summary.committed_capital_eur.toFixed(2)}  (cash-effective)\n`);
    process.stderr.write(`  inf. leveraged notional total: EUR ${summary.informational_leveraged_notional_eur.toFixed(2)}  (metadata only)\n`);
    process.stderr.write(`  cash:                         EUR ${summary.cash.toFixed(2)}\n`);
    if (anyLeverage) {
      process.stderr.write('  ⚠  Leverage ist Metadatum — kein echtes Margin-Modell aktiv.\n');
      process.stderr.write('     Cash wird auf Basis des reservierten Kapitals reduziert, nicht des leveraged notionals.\n');
    }
    process.stderr.write('-------------------------------------------\n');
  }
  process.stderr.write(`- closed this run: ${summary.closed_this_run.map(c => `${c.symbol} (${c.reason})`).join(', ') || 'none'}\n`);
  process.stderr.write(`- state file: ${summary.state_file}\n`);
  process.stderr.write(`- history file: ${summary.history_file}\n`);
  process.stderr.write(JSON.stringify({ info: 'portfolio_summary', run_id: summary.run_id, nav: summary.equity_nav, open: summary.open_positions.length }) + '\n');

  const os = summary.order_stats ?? {};
  process.stderr.write('\n=== Paper Execution Summary ===\n');
  process.stderr.write(`- orders created: ${os.created ?? 0}\n`);
  process.stderr.write(`- filled: ${os.filled ?? 0}\n`);
  process.stderr.write(`- partially filled: ${os.partially_filled ?? 0}\n`);
  process.stderr.write(`- rejected: ${os.rejected ?? 0}\n`);
  process.stderr.write(`- cancelled: ${os.cancelled ?? 0}\n`);
  process.stderr.write(`- orders dir: ${summary.orders_dir}\n`);
  process.stderr.write(`- order events file: ${summary.order_events_file}\n`);
  process.stderr.write(JSON.stringify({ info: 'paper_execution_summary', run_id: summary.run_id, ...os }) + '\n');

  if (realismEnabled(realismConfig)) {
    const minFeeLabel  = realismConfig.minimum_fee_eur > 0 ? ` (min EUR ${realismConfig.minimum_fee_eur})` : '';
    const partialLabel = realismConfig.partial_fill_mode === 'on'
      ? `on (${Math.round(realismConfig.max_fill_fraction_per_cycle * 100)}%/cycle)` : 'off';

    process.stderr.write('\n=== Execution Realism Summary ===\n');
    process.stderr.write(`- realism mode: on\n`);
    process.stderr.write(`- slippage: ${realismConfig.slippage_bps} bps\n`);
    process.stderr.write(`- fees: ${realismConfig.fee_bps} bps${minFeeLabel}\n`);
    process.stderr.write(`- partial fills: ${partialLabel}\n`);
    process.stderr.write(`- orders partially filled this run: ${os.partially_filled ?? 0}\n`);
    process.stderr.write(`- total fees this run: EUR ${(os.fees_eur_this_run ?? 0).toFixed(4)}\n`);
    process.stderr.write(`- total slippage cost this run: EUR ${(os.slippage_cost_eur_this_run ?? 0).toFixed(4)}\n`);
    process.stderr.write(`- cumulative fees (all runs): EUR ${(summary.cumulative_fees_eur ?? 0).toFixed(4)}\n`);
    process.stderr.write(JSON.stringify({
      info:                       'realism_summary',
      run_id:                     summary.run_id,
      slippage_bps:               realismConfig.slippage_bps,
      fee_bps:                    realismConfig.fee_bps,
      minimum_fee_eur:            realismConfig.minimum_fee_eur,
      partial_fill_mode:          realismConfig.partial_fill_mode,
      max_fill_fraction:          realismConfig.max_fill_fraction_per_cycle,
      fees_eur_this_run:          os.fees_eur_this_run ?? 0,
      slippage_cost_eur_this_run: os.slippage_cost_eur_this_run ?? 0,
      cumulative_fees_eur:        summary.cumulative_fees_eur ?? 0,
    }) + '\n');
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function runLiveBrokerLayer(scanJson, brokerCfg) {
  let runOutput;
  try {
    runOutput = JSON.parse(scanJson);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'live_broker_no_scan_json', detail: e.message }) + '\n');
    process.exit(1);
  }

  let runLiveBroker, formatHealthReport, formatReconciliationSummary;
  try {
    ({ runLiveBroker }                = await import('./execution/live_broker/live_broker_runner.mjs'));
    ({ formatHealthReport }           = await import('./execution/live_broker/health_checks.mjs'));
    ({ formatReconciliationSummary }  = await import('./execution/live_broker/reconciliation.mjs'));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'live_broker_import_failed', detail: e.message }) + '\n');
    process.exit(1);
  }

  let liveSummary;
  try {
    liveSummary = await runLiveBroker(runOutput, brokerCfg);
  } catch (e) {
    // Config/credential errors from runLiveBroker → fail loudly
    process.stderr.write(JSON.stringify({ error: 'live_broker_failed', detail: e.message }) + '\n');
    process.exit(2);
  }

  // ── Live Broker Read-Only Summary ─────────────────────────────────────────
  const health  = liveSummary.health;
  const account = liveSummary.account;
  const recon   = liveSummary.reconciliation;

  const healthOk    = health?.all_ok ? 'ok' : 'FAILED';
  const latencyMs   = health?.checks?.health_endpoint?.latency_ms ?? null;
  const baseUrl     = health?.checks?.health_endpoint?.base_url ?? brokerCfg.alpaca?.base_url ?? '?';
  const isPaper     = brokerCfg.alpaca?.paper ?? true;

  process.stderr.write('\n=== Live Broker Read-Only Summary ===\n');
  process.stderr.write(`- provider: ${liveSummary.provider}\n`);
  process.stderr.write(`- environment: ${isPaper ? 'paper (sandbox)' : 'live account'}\n`);
  process.stderr.write(`- base URL: ${baseUrl}\n`);
  process.stderr.write(`- health: ${healthOk}${latencyMs !== null ? ` (${latencyMs}ms)` : ''}\n`);

  if (health) {
    process.stderr.write(`- health checks:\n${formatHealthReport(health)}\n`);
  }

  if (account) {
    process.stderr.write(`- account id: ${account.account_id ?? '?'}\n`);
    process.stderr.write(`- account status: ${account.status ?? '?'}\n`);
    process.stderr.write(`- cash: ${account.currency} ${account.cash?.toFixed(2) ?? '?'}\n`);
    process.stderr.write(`- buying power: ${account.currency} ${account.buying_power?.toFixed(2) ?? '?'}\n`);
    process.stderr.write(`- portfolio value: ${account.currency} ${account.portfolio_value?.toFixed(2) ?? '?'}\n`);
  } else {
    process.stderr.write('- account: not fetched (health check failed)\n');
  }

  process.stderr.write(`- positions fetched: ${liveSummary.positions_count ?? 'n/a'}\n`);
  process.stderr.write(`- open orders observed: ${liveSummary.open_orders_count ?? 'n/a'}\n`);
  process.stderr.write(`- quotes fetched: ${liveSummary.quotes_fetched} stock(s) | ${liveSummary.quotes_skipped} skipped (non-stock)\n`);

  if (recon) {
    process.stderr.write(`- reconciliation:\n${formatReconciliationSummary(recon)}\n`);
    if (liveSummary.files.reconciliation) {
      process.stderr.write(`- reconciliation file: ${liveSummary.files.reconciliation}\n`);
    }
  }

  if (liveSummary.errors.length > 0) {
    process.stderr.write(`- errors: ${liveSummary.errors.map(e => `[${e.step}] ${e.error}`).join('; ')}\n`);
  }

  process.stderr.write(`- duration: ${liveSummary.duration_ms}ms\n`);
  process.stderr.write(`- mode: READ-ONLY — no order placement, no portfolio mutations\n`);

  if (liveSummary.files.account) {
    process.stderr.write(`- snapshot files written to: ${liveSummary.files.account.replace(/[^\\]+$/, '')}\n`);
  }

  process.stderr.write(JSON.stringify({
    info:                'live_broker_summary',
    run_id:              liveSummary.run_id,
    provider:            liveSummary.provider,
    health_ok:           health?.all_ok ?? false,
    positions_count:     liveSummary.positions_count,
    open_orders_count:   liveSummary.open_orders_count,
    quotes_fetched:      liveSummary.quotes_fetched,
    discrepancy_count:   recon?.discrepancy_count ?? null,
    errors:              liveSummary.errors.length,
    duration_ms:         liveSummary.duration_ms,
  }) + '\n');
}

// ─────────────────────────────────────────────────────────────────────────────

async function runPaperExecLayerInScan(scanJson, execConfig, execDispatch = false, execProtectiveExit = false) {
  let runPaperExecLayer, runPaperExecLayerWithDispatch, runPaperExecLayerWithProtectiveExit;
  try {
    ({ runPaperExecLayer, runPaperExecLayerWithDispatch, runPaperExecLayerWithProtectiveExit } =
      await import('./execution/live_broker/paper_exec_layer.mjs'));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'paper_exec_import_failed', detail: e.message }) + '\n');
    process.exit(1);
  }

  let result;
  try {
    result = execDispatch
      ? await runPaperExecLayerWithDispatch(scanJson, execConfig)
      : await runPaperExecLayer(scanJson, execConfig);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'paper_exec_layer_failed', detail: e.message }) + '\n');
    process.exit(1);
  }

  process.stderr.write('\n=== Paper Exec Layer Summary ===\n');
  process.stderr.write(`- mode: alpaca_paper${execDispatch ? ' (dispatch)' : ' (maintenance)'}\n`);
  process.stderr.write(`- run_id: ${result.run_id ?? 'n/a'}\n`);

  if (execDispatch) {
    // runApprovedDecisionsPass summary shape
    const w = result.worker ?? {};
    process.stderr.write(`- decisions_total: ${result.decisions_total ?? 'n/a'}\n`);
    process.stderr.write(`- approved: ${result.approved ?? 'n/a'}\n`);
    process.stderr.write(`- emitted: ${result.emitted ?? 'n/a'}\n`);
    process.stderr.write(`- skipped: ${result.skipped ?? 'n/a'}\n`);
    process.stderr.write(`- worker_ran: ${w.ran ?? 'n/a'}\n`);
    process.stderr.write(`- gate_safe: ${w.gate?.safe ?? 'n/a'}\n`);
    process.stderr.write(JSON.stringify({
      info:            'paper_exec_dispatch_summary',
      run_id:          result.run_id,
      decisions_total: result.decisions_total ?? null,
      approved:        result.approved ?? null,
      emitted:         result.emitted  ?? null,
      worker_ran:      w.ran ?? null,
      gate_safe:       w.gate?.safe ?? null,
    }) + '\n');
  } else {
    // runPaperExecLayer (maintenance) summary shape
    const gSafe        = result.gate?.safe ?? null;
    const dispatchStep = result.steps?.dispatch;
    const cycleStep    = result.steps?.cycle;
    const syncStep     = result.steps?.sync;
    process.stderr.write(`- ran: ${result.ran}\n`);
    process.stderr.write(`- reason: ${result.reason ?? 'none'}\n`);
    process.stderr.write(`- gate_safe: ${gSafe}\n`);
    process.stderr.write(`- dispatch: ${dispatchStep?.skipped ? 'skipped' : (dispatchStep ? 'ran' : 'n/a')}\n`);
    process.stderr.write(`- cycle:    ${cycleStep?.skipped    ? 'skipped' : (cycleStep    ? 'ran' : 'n/a')}\n`);
    process.stderr.write(`- sync:     ${syncStep?.skipped     ? 'skipped' : (syncStep     ? 'ran' : 'n/a')}\n`);
    if (result.error) {
      process.stderr.write(`- error: ${result.error}\n`);
    }
    process.stderr.write(JSON.stringify({
      info:      'paper_exec_layer_summary',
      run_id:    result.run_id,
      ran:       result.ran,
      reason:    result.reason ?? null,
      gate_safe: gSafe,
    }) + '\n');
  }

  if (execProtectiveExit) {
    let peResult;
    try {
      peResult = await runPaperExecLayerWithProtectiveExit(execConfig);
    } catch (e) {
      process.stderr.write(JSON.stringify({ error: 'paper_exec_pe_failed', detail: e.message }) + '\n');
      process.exit(1);
    }
    process.stderr.write('\n=== Paper Protective-Exit Pass Summary ===\n');
    process.stderr.write(`- positions_in:      ${peResult.positions_in}\n`);
    process.stderr.write(`- planned:           ${peResult.planned}\n`);
    process.stderr.write(`- already_protected: ${peResult.already_protected}\n`);
    process.stderr.write(`- plan_skipped:      ${peResult.plan_skipped}\n`);
    process.stderr.write(JSON.stringify({
      info:              'paper_exec_pe_summary',
      positions_in:      peResult.positions_in,
      planned:           peResult.planned,
      already_protected: peResult.already_protected,
      plan_skipped:      peResult.plan_skipped,
    }) + '\n');
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function runBitunixExecLayerInScan(scanJson, execConfig, execDispatch = false) {
  let runBitunixExecLayerWithDispatch;
  try {
    ({ runBitunixExecLayerWithDispatch } =
      await import('./execution/live_broker/bitunix_exec_layer.mjs'));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'bitunix_exec_import_failed', detail: e.message }) + '\n');
    process.exit(1);
  }

  if (!execDispatch) {
    // Maintenance-only path (no dispatch): nothing to do for Bitunix yet.
    // The worker-pass maintenance cycle is Alpaca-specific (reconcile/poll/fill_sync).
    // For Bitunix, omit this pass until a Bitunix-specific worker pass is built.
    process.stderr.write('\n=== Bitunix Exec Layer ===\n');
    process.stderr.write('- mode: bitunix_futures (maintenance — no-op until Bitunix worker pass is built)\n');
    process.stderr.write(JSON.stringify({ info: 'bitunix_exec_layer_noop', reason: 'maintenance_not_yet_implemented' }) + '\n');
    return;
  }

  let result;
  try {
    result = await runBitunixExecLayerWithDispatch(scanJson, execConfig);
  } catch (e) {
    const isNotFound = e?.error_class === 'not_found';
    const errKey = isNotFound ? 'bitunix_account_not_found' : 'bitunix_exec_layer_failed';
    process.stderr.write(JSON.stringify({ error: errKey, detail: e.message }) + '\n');
    process.exit(1);
  }

  const d = result.dispatch ?? {};
  process.stderr.write('\n=== Bitunix Exec Layer Summary ===\n');
  process.stderr.write(`- mode: bitunix_futures (dispatch)\n`);
  process.stderr.write(`- run_id: ${result.run_id ?? 'n/a'}\n`);
  process.stderr.write(`- decisions_total: ${result.decisions_total ?? 'n/a'}\n`);
  process.stderr.write(`- approved: ${result.approved ?? 'n/a'}\n`);
  process.stderr.write(`- emitted: ${result.emitted ?? 'n/a'}\n`);
  process.stderr.write(`- skipped: ${result.skipped ?? 'n/a'}\n`);
  process.stderr.write(`- account_ok: ${result.account_ok ?? 'n/a'}\n`);
  process.stderr.write(`- account_reason: ${result.account_reason ?? 'none'}\n`);
  process.stderr.write(`- sized: ${result.sized ?? 'n/a'}\n`);
  process.stderr.write(`- dispatched: ${d.submitted ?? (result.sized === 0 ? 'no_intents' : 'n/a')}\n`);
  process.stderr.write(`- submit_uncertain: ${d.submit_uncertain ?? 'n/a'}\n`);
  process.stderr.write(JSON.stringify({
    info:            'bitunix_exec_dispatch_summary',
    run_id:          result.run_id,
    decisions_total: result.decisions_total ?? null,
    approved:        result.approved ?? null,
    emitted:         result.emitted  ?? null,
    account_ok:      result.account_ok ?? null,
    sized:           result.sized ?? null,
    dispatched:      d.submitted ?? null,
  }) + '\n');
}
