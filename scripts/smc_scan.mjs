#!/usr/bin/env node
/**
 * smc_scan.mjs — SMC-only Crypto scan (kein Stock-Research)
 *
 * Steps:
 *   1. ohlcv_fetcher.mjs      → OHLCV Daily/4H/1H/15m für Crypto
 *   2. positioning_fetcher.mjs → Funding/OI für Crypto (fail-soft)
 *   3. liq_heatmap.mjs        → Liq Walls für Crypto (fail-soft)
 *   3b. level_entry.py        → 882/LSOB Limit-Order Pfad (collect only — dispatch nach Step 5)
 *   4. regime_filter.py       → GREEN/RED Gate
 *   5. smc_detector.py        → SMC-Signale (nur wenn GREEN)
 *   5b. level_conflict_filter → Level-Signale mit gegensätzlichem SMC-Signal supprimieren
 *   5c. level_dispatch        → Bereinigte Level-Signale dispatchen
 *   6. SMC Dispatch           → Score 8: Monitoring; Score 9+: thesis_reviewer → auto_open
 *   7. [DISABLED]             → macro_trader deaktiviert
 *   8. thesis_expiry_check.mjs → Positionen expiry (fail-soft)
 *   9. smc_scalp_detector.py  → OB-Scalp: 1m pin bar in 4H IDM sweep zone (fail-soft, GREEN only)
 *  10. [DISABLED]             → heatmap_trader deaktiviert
 */

import { readFileSync } from 'fs';
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
  // Windows: spawnSync ETIMEDOUT leaves a zombie Python process holding file locks on
  // level_entry_state.json, causing the next scan's save_state() to hang for another 180s.
  // taskkill /F /PID /T force-kills the process tree by PID, releasing all locks immediately.
  if (result.error?.code === 'ETIMEDOUT' && result.pid) {
    try { spawnSync('taskkill', ['/F', '/PID', String(result.pid), '/T'], { stdio: 'ignore', timeout: 5000 }); } catch {}
  }
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

// 3b. Level Entry — collect only (dispatch nach Step 5b, nach SMC-Konflikt-Check)
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

// 5b. Level Conflict Filter — Level-Signale mit gegensätzlichem SMC-Signal supprimieren.
// Hintergrund: smc_detector (BOS-basiert) und level_entry (Daily-Bias-basiert) können für
// dasselbe Symbol entgegengesetzte Richtungen signalisieren. Wenn SMC Score 8+ für LONG
// aktiv ist, darf kein Level-SHORT-Trade geöffnet werden (und umgekehrt). smc_detector ist
// strukturell präziser (BOS + IDM + EMA200), daher hat es Vorrang.
const cleanLevelSignals = levelSignals.filter(sig => {
  const conflict = smcSignals.find(smc => smc.symbol === sig.symbol && smc.side !== sig.side);
  if (conflict) {
    process.stderr.write(JSON.stringify({
      warn:       'level_conflict_suppressed',
      symbol:     sig.symbol,
      level_side: sig.side,
      smc_side:   conflict.side,
      smc_score:  conflict.score,
      note:       'level_entry direction contradicts active SMC signal — suppressed',
    }) + '\n');
    return false;
  }
  return true;
});

// 5b-2. Macro-Alignment-Filter — keine counter-trend Level-Entries gegen das Macro-Regime.
// Liest macro_signals.json (Cache). bull→SHORT supprimiert; bear→LONG supprimiert; fail-open.
let macroRegime = null;
try {
  const macroData = JSON.parse(readFileSync(join(SCRIPTS_DIR, '..', 'trading', 'cache', 'macro_signals.json'), 'utf8'));
  macroRegime = (macroData.regime ?? '').toLowerCase();
  process.stderr.write(JSON.stringify({ info: 'macro_regime_read', regime: macroRegime }) + '\n');
} catch {
  process.stderr.write(JSON.stringify({ warn: 'macro_regime_read_failed', note: 'fail-open — no level filtering' }) + '\n');
}

const macroAlignedLevelSignals = cleanLevelSignals.filter(sig => {
  const counterTrend = (macroRegime === 'bull' && sig.side === 'short')
                    || (macroRegime === 'bear' && sig.side === 'long');
  if (counterTrend) {
    process.stderr.write(JSON.stringify({
      warn:         'level_macro_conflict_suppressed',
      symbol:       sig.symbol,
      level_side:   sig.side,
      macro_regime: macroRegime,
      note:         `level ${sig.side.toUpperCase()} suppressed — macro_regime=${macroRegime}`,
    }) + '\n');
    return false;
  }
  return true;
});

// 5c. Level Dispatch (conflict- und macro-bereinigte Signale)
{
  const levelAutoOpenPath = join(SCRIPTS_DIR, 'execution', 'auto_open.mjs');
  const reviewerPath      = join(SCRIPTS_DIR, 'thesis_reviewer.mjs');

  const level8 = macroAlignedLevelSignals.filter(s => s.score === 8);
  const level9 = macroAlignedLevelSignals.filter(s => s.score >= 9);

  async function dispatchLevelOpen(sig) {
    process.stderr.write(JSON.stringify({
      info:    'level_entry_dispatch',
      symbol:  sig.symbol,
      side:    sig.side,
      score:   sig.score,
      net_rrr: sig.net_rrr,
      fib_882: sig.fib_882,
      sl:      sig.sl_price,
      tp:      sig.tp_price,
      tf:      sig.timeframe,
    }) + '\n');

    const ao = spawnSync(process.execPath, [
      levelAutoOpenPath,
      '--symbol',   sig.symbol,
      '--side',     sig.side,
      '--score',    String(sig.score),
      '--reason',   sig.reason,
      '--category', 'crypto',
      '--bypass-direction-flip-ceiling8',
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

  // Score 8 → Monitoring-only (kein auto_open, kein thesis_reviewer)
  for (const sig of level8) {
    process.stderr.write(JSON.stringify({
      info:    'level_monitoring',
      symbol:  sig.symbol,
      score:   sig.score,
      side:    sig.side,
      fib_882: sig.fib_882,
      net_rrr: sig.net_rrr,
      tf:      sig.timeframe,
      reason:  sig.reason,
      note:    'Level Score 8 — beobachten, kein Trade',
    }) + '\n');
    await discordNotify(
      `👁 **LEVEL Score 8 — Monitoring** | ${sig.symbol} ${sig.side.toUpperCase()} · ${sig.timeframe}\n` +
      `882-Level: $${sig.fib_882} | RRR: ${sig.net_rrr} | Liq: $${((sig.liq_cluster?.notional_usd ?? 0) / 1e6).toFixed(1)}M\n` +
      `→ Kein Trade. Score 9 (Notional ≥$5M) erforderlich für Reviewer-Gate.`
    );
  }

  // Score 9 → thesis_reviewer → auto_open
  for (const sig of level9) {
    const reviewerSignal = {
      ...sig,
      entry_price: sig.fib_882,
    };

    process.stderr.write(JSON.stringify({
      info: 'level_thesis_review_start', symbol: sig.symbol,
      score: sig.score, side: sig.side, net_rrr: sig.net_rrr,
    }) + '\n');

    await discordNotify(
      `🎯 **LEVEL 882/LSOB Score 9** — ${sig.symbol} ${sig.side.toUpperCase()}\n` +
      `Entry: $${sig.fib_882} | SL: $${sig.sl_price} | TP: $${sig.tp_price} | RRR: ${sig.net_rrr}\n` +
      `Liq: $${sig.liq_cluster?.price} ($${((sig.liq_cluster?.notional_usd ?? 0) / 1e6).toFixed(1)}M) · thesis_reviewer läuft...`
    );

    const rv = spawnSync(process.execPath, [
      reviewerPath, '--signal', JSON.stringify(reviewerSignal),
    ], { timeout: 90_000, maxBuffer: 1 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });

    let review = { approved: false, confidence: 1, reason: 'reviewer_failed', symbol: sig.symbol, score: sig.score };
    if (!rv.error && rv.status === 0) {
      try { review = JSON.parse(rv.stdout?.toString('utf8').trim() ?? '{}'); } catch { /* keep default */ }
    } else {
      process.stderr.write(JSON.stringify({
        warn: 'level_reviewer_spawn_failed', symbol: sig.symbol,
        detail: rv.error?.message ?? `exit ${rv.status}`,
      }) + '\n');
    }

    process.stderr.write(JSON.stringify({
      info:       'level_thesis_review_result',
      symbol:     sig.symbol,
      approved:   review.approved,
      confidence: review.confidence,
      reason:     review.reason,
    }) + '\n');

    if (!review.approved) {
      process.stderr.write(JSON.stringify({
        warn: 'level_auto_open_blocked', symbol: sig.symbol, reason: review.reason,
      }) + '\n');
      await discordNotify(`⛔ **${sig.symbol} LEVEL BLOCKED** (Score ${sig.score}) — ${review.reason}`);
      continue;
    }

    await discordNotify(
      `✅ **LEVEL APPROVED** — ${sig.symbol} ${sig.side.toUpperCase()} Score ${sig.score}\n` +
      `Confidence: ${review.confidence}/10 | ${review.reason}`
    );
    await dispatchLevelOpen(sig);
  }
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

// Score 9+ → thesis_reviewer → auto_open
{
  const smcAutoOpenPath = join(SCRIPTS_DIR, 'execution', 'auto_open.mjs');
  const smcReviewerPath = join(SCRIPTS_DIR, 'thesis_reviewer.mjs');

  for (const signal of smc9plus) {
    process.stderr.write(JSON.stringify({
      info:   'smc_thesis_review_start',
      symbol: signal.symbol,
      score:  signal.score,
      side:   signal.side,
      reason: signal.reason,
    }) + '\n');

    await discordNotify(
      `🎯 **SMC Score ${signal.score}** — ${signal.symbol} ${signal.side.toUpperCase()}\n` +
      `IDM: $${signal.idm_level ?? '?'} | Preis: $${signal.current_price ?? '?'} · thesis_reviewer läuft...`
    );

    const rv = spawnSync(process.execPath, [
      smcReviewerPath, '--signal', JSON.stringify(signal),
    ], { timeout: 90_000, maxBuffer: 1 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });

    let review = { approved: false, confidence: 1, reason: 'reviewer_failed', symbol: signal.symbol, score: signal.score };
    if (!rv.error && rv.status === 0) {
      try { review = JSON.parse(rv.stdout?.toString('utf8').trim() ?? '{}'); } catch { /* keep default */ }
    } else {
      process.stderr.write(JSON.stringify({
        warn:   'smc_reviewer_spawn_failed',
        symbol: signal.symbol,
        detail: rv.error?.message ?? `exit ${rv.status}`,
      }) + '\n');
    }

    process.stderr.write(JSON.stringify({
      info:       'smc_thesis_review_result',
      symbol:     signal.symbol,
      approved:   review.approved,
      confidence: review.confidence,
      reason:     review.reason,
    }) + '\n');

    if (!review.approved) {
      process.stderr.write(JSON.stringify({
        warn: 'smc_auto_open_blocked', symbol: signal.symbol, reason: review.reason,
      }) + '\n');
      await discordNotify(`⛔ **${signal.symbol} SMC BLOCKED** (Score ${signal.score}) — ${review.reason}`);
      continue;
    }

    await discordNotify(
      `✅ **SMC APPROVED** — ${signal.symbol} ${signal.side.toUpperCase()} Score ${signal.score}\n` +
      `Confidence: ${review.confidence}/10 | ${review.reason}`
    );

    const ao = spawnSync(process.execPath, [
      smcAutoOpenPath,
      '--symbol',   signal.symbol,
      '--side',     signal.side,
      '--score',    String(signal.score),
      '--reason',   signal.reason,
      '--category', 'crypto',
    ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });

    if (ao.error || ao.status !== 0) {
      process.stderr.write(JSON.stringify({
        warn:   'smc_auto_open_failed',
        symbol: signal.symbol,
        detail: ao.error?.message ?? `exit ${ao.status}`,
      }) + '\n');
    } else {
      try {
        const aoOut = JSON.parse(ao.stdout?.toString('utf8') ?? '{}');
        process.stderr.write(JSON.stringify({
          info: 'smc_auto_open_result', symbol: signal.symbol, ...aoOut,
        }) + '\n');
      } catch {
        process.stderr.write(JSON.stringify({
          info: 'smc_auto_open_done', symbol: signal.symbol,
        }) + '\n');
      }
    }
  }
}

// 7. Macro Trader — DISABLED (scalp_only_mode)
// softStep('macro_trader.mjs', 'macro_trader');

// 8. Thesis Expiry — bestehende SMC-Positionen prüfen (fail-soft)
softStep('thesis_expiry_check.mjs', 'thesis_expiry');

// 9. OB-Scalp Detector — 1m pin bar in 4H IDM sweep zone (fail-soft, only when GREEN)
if (smcGreen) {
  const scalp_raw = softPyStep('smc_scalp_detector.py', 'scalp_detector');
  if (scalp_raw) {
    const scalp_lines   = scalp_raw.trim().split('\n').filter(Boolean);
    const scalp_signals = scalp_lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(s => s !== null && s.strategy === 'ob_scalp' && s.symbol);

    process.stderr.write(JSON.stringify({
      info:    'scalp_detector_result',
      signals: scalp_signals.length,
      symbols: scalp_signals.map(s => `${s.symbol}(tp${s.tp_pct}%,sl${s.sl_dist_pct}%)`),
    }) + '\n');

    const scalp_open_path = join(SCRIPTS_DIR, 'execution', 'scalp_open.mjs');

    for (const sig of scalp_signals) {
      process.stderr.write(JSON.stringify({
        info:    'scalp_open_attempt',
        symbol:  sig.symbol, score: sig.score,
        tp_pct:  sig.tp_pct, sl_pct: sig.sl_dist_pct,
        pin_ts:  sig.pin_bar_ts, reason: sig.reason,
      }) + '\n');

      await discordNotify(
        `⚡ **OB-Scalp Signal** — ${sig.symbol} LONG Score ${sig.score}\n` +
        `TP: +${sig.tp_pct}% | SL: -${sig.sl_dist_pct.toFixed(3)}% | Pin: ${sig.pin_bar_ts}\n` +
        `Zone: $${sig.sl_level} → $${sig.ob_top} | scalp_open läuft...`
      );

      const ao = spawnSync(process.execPath, [
        scalp_open_path,
        '--symbol', sig.symbol,
        '--score',  String(sig.score),
        '--sl-pct', String(sig.sl_dist_pct),
        '--tp-pct', String(sig.tp_pct),
        '--reason', sig.reason,
      ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });

      if (ao.error || ao.status !== 0) {
        process.stderr.write(JSON.stringify({
          warn:   'scalp_open_failed', symbol: sig.symbol,
          detail: ao.error?.message ?? `exit ${ao.status}`,
        }) + '\n');
      } else {
        try {
          const aoOut = JSON.parse(ao.stdout?.toString('utf8') ?? '{}');
          process.stderr.write(JSON.stringify({ info: 'scalp_open_result', symbol: sig.symbol, ...aoOut }) + '\n');
          await discordNotify(
            `✅ **OB-Scalp OPENED** — ${sig.symbol} LONG Score ${sig.score}\n` +
            `Entry: $${aoOut.price_usd} | TP: $${aoOut.tp_level_usd} (+${sig.tp_pct}%) | ` +
            `SL: $${aoOut.sl_level_usd} (-${sig.sl_dist_pct.toFixed(3)}%)\n` +
            `Max-Hold: 2h | Notional: ${aoOut.notional_eur} EUR | Slots: ${aoOut.portfolio?.scalp_positions}/2`
          );
        } catch {
          process.stderr.write(JSON.stringify({ info: 'scalp_open_done', symbol: sig.symbol }) + '\n');
        }
      }
    }
  }
}

// 10. Heatmap Trader — DISABLED (scalp_only_mode)
// softStep('heatmap_trader.mjs', 'heatmap_trader');

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
