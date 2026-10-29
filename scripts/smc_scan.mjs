#!/usr/bin/env node
/**
 * smc_scan.mjs — SMC-only Crypto scan (kein Stock-Research)
 *
 * Steps:
 *   1. ohlcv_fetcher.mjs      → OHLCV Daily/4H/1H/15m für Crypto
 *   2. positioning_fetcher.mjs → Funding/OI für Crypto (fail-soft)
 *   3. liq_heatmap.mjs        → Liq Walls für Crypto (fail-soft)
 *   3b. level_entry.py        → 882/LSOB Limit-Order Pfad (regime-unabhängig)
 *   4. regime_filter.py       → GREEN/RED Gate
 *   5. smc_detector.py        → SMC-Signale (nur wenn GREEN)
 *   6. SMC Dispatch           → Score 8: Monitoring-Log; Score 9+: thesis_reviewer → auto_open
 *   7. macro_trader.mjs       → BTC/ETH Macro-Signale (fail-soft)
 *   8. thesis_expiry_check.mjs → SMC-Positionen expiry (fail-soft)
 */

import { spawnSync }  from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { discordNotify } from './discord_notify.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS  = 180_000;
const startTime   = Date.now();

function step(scriptName, label) {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  process.stderr.write(JSON.stringify({ info: 'scan_step_start', label, script: scriptName }) + '\n');
  const result = spawnSync(process.execPath, [scriptPath], {
    timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`;
    process.stderr.write(JSON.stringify({ error: 'scan_step_failed', label, script: scriptName, detail }) + '\n');
    process.exit(1);
  }
  process.stderr.write(JSON.stringify({ info: 'scan_step_done', label }) + '\n');
  return result.stdout?.toString('utf8') ?? '';
}

function softStep(scriptName, label) {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  process.stderr.write(JSON.stringify({ info: 'scan_step_start', label, script: scriptName }) + '\n');
  const result = spawnSync(process.execPath, [scriptPath], {
    timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`;
    process.stderr.write(JSON.stringify({ warn: 'scan_step_warn', label, script: scriptName, detail, note: 'non-fatal — scan continues' }) + '\n');
    return null;
  }
  process.stderr.write(JSON.stringify({ info: 'scan_step_done', label }) + '\n');
  return result.stdout?.toString('utf8') ?? '';
}

function softPyStep(scriptName, label) {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  process.stderr.write(JSON.stringify({ info: 'scan_step_start', label, script: scriptName }) + '\n');
  const result = spawnSync('python', [scriptPath], {
    timeout: TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`;
    process.stderr.write(JSON.stringify({ warn: 'scan_step_warn', label, script: scriptName, detail, note: 'non-fatal — scan continues' }) + '\n');
    return null;
  }
  process.stderr.write(JSON.stringify({ info: 'scan_step_done', label }) + '\n');
  return result.stdout?.toString('utf8') ?? '';
}

// 1. OHLCV Fetch (schreibt ohlcv_daily_*.json — wird von smc_detector.py gelesen)
softStep('ohlcv_fetcher.mjs', 'ohlcv_fetch');

// 2. Crypto Positioning (fail-soft)
softStep('positioning_fetcher.mjs', 'positioning');

// 3. Liq Heatmap (fail-soft)
softStep('liq_heatmap.mjs', 'liq_heatmap');

// 3b. Level Entry — 882/LSOB Limit-Order Pfad (regime-unabhängig, fail-soft)
const levelRaw = softPyStep('level_entry.py', 'level_entry');
let levelSignals = [];
if (levelRaw) {
  const levelLines = levelRaw.trim().split('\n').filter(Boolean);
  levelSignals = levelLines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(s => s !== null && s.action === 'open_level_order');
  if (levelSignals.length) {
    process.stderr.write(JSON.stringify({
      info:    'level_entry_result',
      signals: levelSignals.length,
      symbols: levelSignals.map(s => `${s.symbol}(${s.side}/${s.timeframe})`),
    }) + '\n');
  }

  const levelAutoOpenPath = join(SCRIPTS_DIR, 'execution', 'auto_open.mjs');
  for (const sig of levelSignals) {
    process.stderr.write(JSON.stringify({
      info:    'level_entry_dispatch',
      symbol:  sig.symbol,
      side:    sig.side,
      fib_882: sig.fib_882,
      sl:      sig.sl_price,
      tp:      sig.tp_price,
      tf:      sig.timeframe,
    }) + '\n');

    await discordNotify(
      `🎯 **LEVEL 882/LSOB** | ${sig.symbol} ${sig.side.toUpperCase()} · ${sig.timeframe}\n` +
      `Entry ~$${sig.fib_882} | SL: $${sig.sl_price} | TP: $${sig.tp_price}\n` +
      `Liq Cluster: $${sig.liq_cluster?.price} (${sig.liq_cluster?.dist_atr}× ATR) · ${sig.reason}`
    );

    const ao = spawnSync(process.execPath, [
      levelAutoOpenPath,
      '--symbol',   sig.symbol,
      '--side',     sig.side,
      '--score',    '8',
      '--reason',   sig.reason,
      '--category', 'crypto',
    ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });

    if (ao.error || ao.status !== 0) {
      process.stderr.write(JSON.stringify({
        warn:   'level_auto_open_failed',
        symbol: sig.symbol,
        detail: ao.error?.message ?? `exit ${ao.status}`,
      }) + '\n');
    } else {
      try {
        const aoOut = JSON.parse(ao.stdout?.toString('utf8') ?? '{}');
        process.stderr.write(JSON.stringify({
          info: 'level_auto_open_result', symbol: sig.symbol, ...aoOut,
        }) + '\n');
      } catch {
        process.stderr.write(JSON.stringify({
          info: 'level_auto_open_done', symbol: sig.symbol,
        }) + '\n');
      }
    }
  }
}

// 4. SMC Regime Filter
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

// 5. SMC Detector (nur wenn Regime GREEN)
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

// 6. SMC Dispatch
const smc8only = smcSignals.filter(s => s.score === 8);
const smc9plus = smcSignals.filter(s => s.score >= 9);

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

for (const signal of smc9plus) {
  const reviewerPath = join(SCRIPTS_DIR, 'thesis_reviewer.mjs');
  const autoOpenPath = join(SCRIPTS_DIR, 'execution', 'auto_open.mjs');

  process.stderr.write(JSON.stringify({ info: 'smc_thesis_review_start', symbol: signal.symbol, score: signal.score, side: signal.side }) + '\n');

  await discordNotify(
    `🎯 **SMC Score ${signal.score} Signal** — ${signal.symbol} ${signal.side.toUpperCase()}\n` +
    `Entry: $${signal.entry_price ?? signal.current_price} | ${signal.reason}\n` +
    `OTE: $${signal.ote_low ?? '?'} – $${signal.ote_high ?? '?'} | thesis_reviewer läuft...`
  );

  const rv = spawnSync(process.execPath, [reviewerPath, '--signal', JSON.stringify(signal)], {
    timeout: 90_000, maxBuffer: 1 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
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
    process.stderr.write(JSON.stringify({ warn: 'smc_auto_open_blocked', symbol: signal.symbol, reason: review.reason }) + '\n');
    await discordNotify(`⛔ **${signal.symbol} BLOCKED** (Score ${signal.score}) — ${review.reason}`);
    continue;
  }

  await discordNotify(
    `✅ **TRADE APPROVED** — ${signal.symbol} ${signal.side.toUpperCase()} Score ${signal.score}\n` +
    `Confidence: ${review.confidence}/10 | ${review.reason}\n` +
    `→ auto_open wird ausgeführt...`
  );

  const ao = spawnSync(process.execPath, [
    autoOpenPath,
    '--symbol',   signal.symbol,
    '--side',     signal.side,
    '--score',    String(signal.score),
    '--reason',   signal.reason,
    '--category', 'crypto',
  ], {
    timeout: 60_000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
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

// 7. Macro Trader — BTC/ETH Macro (fail-soft)
softStep('macro_trader.mjs', 'macro_trader');

// 8. Thesis Expiry — bestehende SMC-Positionen prüfen (fail-soft)
softStep('thesis_expiry_check.mjs', 'thesis_expiry');

// 9. Heatmap Trader — auto-execution from liq_heatmap signals (fail-soft)
softStep('heatmap_trader.mjs', 'heatmap_trader');

// Discord: Scan-Summary
await discordNotify(
  `📡 **SMC Scan** — Regime ${smcGreen ? 'GREEN' : 'RED'} · ${smcSignals.length} Signal(e)\n` +
  (smcSignals.length > 0
    ? smcSignals.map(s => `  ${s.side === 'long' ? '🟢' : '🔴'} **${s.symbol}** Score ${s.score} — ${s.reason}`).join('\n')
    : '  Keine Signale.')
);

// Stdout: JSON summary (wird von paper_runbook.mjs ausgewertet)
process.stdout.write(JSON.stringify({
  run_at:      new Date().toISOString(),
  smc_regime:  smcGreen ? 'GREEN' : 'RED',
  smc_signals: smcSignals.length,
  symbols:     smcSignals.map(s => `${s.symbol}(${s.score}/${s.side})`),
  duration_ms: Date.now() - startTime,
}) + '\n');
