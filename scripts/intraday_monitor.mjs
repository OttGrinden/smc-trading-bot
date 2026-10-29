#!/usr/bin/env node
/**
 * intraday_monitor.mjs — Intraday Rejection Monitor (Live Loop)
 *
 * Orchestriert: intraday_fetcher → level_detector → rejection_detector
 * Läuft alle 60 Sekunden und meldet neue Signale.
 *
 * Usage:
 *   node intraday_monitor.mjs                          # Top-25, 60s Intervall
 *   node intraday_monitor.mjs --symbols BTC,ETH,SNDK   # nur diese Symbole
 *   node intraday_monitor.mjs --interval 30             # alle 30s
 *   node intraday_monitor.mjs --top 40                 # Top-40 nach Volumen
 *   node intraday_monitor.mjs --min-confidence 0.60    # höherer Filter
 *   node intraday_monitor.mjs --once                   # nur ein Durchlauf, dann Exit
 *   node intraday_monitor.mjs --alert-file path/to/alerts.jsonl  # Signal-Log
 *
 * Drücke Ctrl+C zum Beenden.
 */

import { spawnSync }    from 'child_process';
import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname, resolve } from 'path';

const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const SCRIPTS_DIR   = _d;
const SIGNALS_PATH  = join(TRADING_DIR, 'cache', 'intraday_signals.json');
const DEFAULT_ALERT = join(TRADING_DIR, 'logs', 'intraday_alerts.jsonl');

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  function getArg(flag, def) {
    const idx = argv.indexOf(flag);
    return idx !== -1 ? argv[idx + 1] : def;
  }
  const rawSyms = getArg('--symbols', null);
  return {
    symbols:     rawSyms ? rawSyms.split(',').map(s => s.trim().toUpperCase()) : null,
    interval:    parseInt(getArg('--interval', '60'), 10),
    top:         parseInt(getArg('--top', '25'), 10),
    candles:     parseInt(getArg('--candles', '100'), 10),
    minConf:     parseFloat(getArg('--min-confidence', '0.55')),
    alertFile:   getArg('--alert-file', DEFAULT_ALERT),
    once:        argv.includes('--once'),
    quiet:       argv.includes('--quiet'),
  };
}

// ─── Subprocess-Wrapper ───────────────────────────────────────────────────────

function runScript(scriptName, extraArgs, timeoutMs = 60_000) {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    timeout:   timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    stdio:     ['ignore', 'pipe', 'pipe'],
  });

  const stdout = result.stdout?.toString('utf8').trim() || '';
  const stderr = result.stderr?.toString('utf8').trim() || '';
  const ok     = result.status === 0 && !result.error;

  return { ok, stdout, stderr, error: result.error?.message };
}

// ─── JSON sicher parsen ───────────────────────────────────────────────────────

function safeJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ─── Neue Signale erkennen (verglichen mit letztem Cycle) ─────────────────────

function diffSignals(prevSignals, newSignals) {
  const prevKeys = new Set(prevSignals.map(s => `${s.symbol}_${s.direction}_${s.level_price}_${s.rejection_time}`));
  return newSignals.filter(s => !prevKeys.has(`${s.symbol}_${s.direction}_${s.level_price}_${s.rejection_time}`));
}

// ─── Signal-Ausgabe für Konsole ───────────────────────────────────────────────

function formatSignal(s, isNew) {
  const dir     = s.direction === 'SHORT' ? '📉 SHORT' : '📈 LONG';
  const badge   = isNew ? '🔔 NEU' : '   ';
  const conf    = (s.confidence * 100).toFixed(0) + '%';
  const tpStr   = s.tp1 ? ` → TP: ${s.tp1} (+${s.tp1_pct}%)` : '';
  const status  = s.status === 'actionable' ? '🔴' : s.status === 'recent' ? '🟡' : '⚪';
  const adjStr  = s.mtf_adjustment != null
    ? ` (MTF ${s.mtf_adjustment > 0 ? '+' : ''}${s.mtf_adjustment})`
    : '';
  const mtfLine = s.mtf
    ? `\n          MTF → RSI15m:${s.mtf.rsi_15m ?? '?'} | RSI1h:${s.mtf.rsi_1h ?? '?'} | Trend:${s.mtf.trend_1h ?? '?'} | BTC:${s.mtf.btc_direction ?? '?'} RSI1h:${s.mtf.btc_rsi_1h ?? '?'}`
    : '';

  return `   ${badge} ${status} ${dir} ${s.symbol.padEnd(8)} Level: ${s.level_price} (${s.level_type})` +
         `\n          Entry: ${s.entry}  SL: ${s.sl} (-${s.sl_pct}%)${tpStr}` +
         `\n          Wick: ${(s.wick_ratio*100).toFixed(0)}%  Vol: ${s.vol_multiple}x  Conf: ${conf}${adjStr}` +
         `  Alter: ${s.age_mins}min  Preis-Dist: ${s.price_dist_pct}%` +
         mtfLine + '\n';
}

// ─── Signal in Alert-File schreiben ──────────────────────────────────────────

function appendAlert(signal, alertFile) {
  try {
    appendFileSync(alertFile, JSON.stringify({ ...signal, alerted_at: new Date().toISOString() }) + '\n', 'utf8');
  } catch { /* best-effort */ }
}

// ─── Ein Scan-Cycle ───────────────────────────────────────────────────────────

function runCycle(args, cycleNum, prevSignals) {
  const now = new Date().toISOString().slice(11, 19);
  if (!args.quiet) process.stdout.write(`\n⏱  Cycle #${cycleNum} — ${now} UTC\n`);

  // Step 1: Kerzen fetchen
  const fetchArgs = args.symbols
    ? ['--symbols', args.symbols.join(','), '--candles', String(args.candles)]
    : ['--top', String(args.top), '--candles', String(args.candles)];

  const fetchResult = runScript('intraday_fetcher.mjs', [...fetchArgs, '--quiet'], 55_000);
  if (!fetchResult.ok) {
    process.stderr.write(`   ⚠ Fetcher fehlgeschlagen: ${fetchResult.error || fetchResult.stderr.slice(0, 200)}\n`);
    return prevSignals;
  }
  const fetchSummary = safeJson(fetchResult.stdout);
  if (!args.quiet && fetchSummary) {
    process.stdout.write(`   Fetched: ${fetchSummary.symbols_fetched}/${fetchSummary.symbols_requested} Symbole in ${fetchSummary.duration_ms}ms\n`);
  }

  // Step 2: MTF-Kontext (fail-soft — Rejection-Detektor läuft auch ohne)
  const mtfArgs = args.symbols ? ['--symbols', args.symbols.join(','), '--quiet'] : ['--quiet'];
  const mtfResult = runScript('mtf_context.mjs', mtfArgs, 70_000);
  if (!mtfResult.ok && !args.quiet) {
    process.stderr.write(`   ⚠ MTF-Kontext fehlgeschlagen (weiter ohne): ${mtfResult.error || mtfResult.stderr.slice(0, 120)}\n`);
  } else if (!args.quiet) {
    const mtfSum = safeJson(mtfResult.stdout);
    if (mtfSum) process.stdout.write(`   MTF: ${mtfSum.symbols_done} Symbole  BTC ${mtfSum.btc_direction} RSI1h=${mtfSum.btc_rsi_1h}\n`);
  }

  // Step 2b: Regime-Tracker (fail-soft)
  const regimeResult = runScript('regime_tracker.mjs', [], 5_000);
  if (!regimeResult.ok && !args.quiet) {
    process.stderr.write(`   ⚠ Regime-Tracker fehlgeschlagen: ${regimeResult.error || ''}\n`);
  } else if (!args.quiet && regimeResult.stdout.trim()) {
    process.stdout.write(`   ${regimeResult.stdout.trim()}\n`);
  }

  // Step 3: Level-Detektion
  const levelArgs = args.symbols ? ['--symbols', args.symbols.join(','), '--quiet'] : ['--quiet'];
  const levelResult = runScript('level_detector.mjs', levelArgs, 15_000);
  if (!levelResult.ok) {
    process.stderr.write(`   ⚠ Level-Detektor fehlgeschlagen: ${levelResult.error || levelResult.stderr.slice(0, 200)}\n`);
    return prevSignals;
  }

  // Step 4: Rejection-Detektor
  const rejArgs = [
    ...(args.symbols ? ['--symbols', args.symbols.join(',')] : []),
    '--min-confidence', String(args.minConf),
    '--quiet',
  ];
  const rejResult = runScript('rejection_detector.mjs', rejArgs, 15_000);
  if (!rejResult.ok) {
    process.stderr.write(`   ⚠ Rejection-Detektor fehlgeschlagen: ${rejResult.error || rejResult.stderr.slice(0, 200)}\n`);
    return prevSignals;
  }

  // Signals laden
  if (!existsSync(SIGNALS_PATH)) return prevSignals;
  const signalData = safeJson(readFileSync(SIGNALS_PATH, 'utf8'));
  if (!signalData) return prevSignals;

  const currentSignals = signalData.signals || [];
  const newSignals     = diffSignals(prevSignals, currentSignals);

  // Ausgabe
  if (!args.quiet) {
    const actionable = currentSignals.filter(s => s.status === 'actionable');
    const recent     = currentSignals.filter(s => s.status === 'recent');

    if (currentSignals.length === 0) {
      process.stdout.write('   → Keine aktiven Signale.\n');
    } else {
      if (actionable.length) {
        process.stdout.write(`\n   ══ ACTIONABLE (${actionable.length}) ══════════════════════════════\n`);
        for (const s of actionable) {
          const isNew = newSignals.includes(s);
          process.stdout.write(formatSignal(s, isNew));
        }
      }
      if (recent.length) {
        process.stdout.write(`\n   ── Recent (${recent.length}) ──────────────────────────────────────\n`);
        for (const s of recent) {
          const isNew = newSignals.includes(s);
          process.stdout.write(formatSignal(s, isNew));
        }
      }
    }
  }

  // Neue Signale → Alert
  for (const s of newSignals) {
    if (!args.quiet) {
      process.stdout.write(`\n🔔 NEUES SIGNAL: ${s.direction} ${s.symbol} @ ${s.entry} — Level ${s.level_price} (${s.level_type}) — Conf ${(s.confidence*100).toFixed(0)}%\n`);
    }
    appendAlert(s, args.alertFile);
  }

  // Step 5: Paper Trading Tick — ETH LONG-only v1 (fail-soft)
  const paperResult = runScript('intraday_paper.mjs', [
    '--tick',
    '--min-confidence', String(Math.max(args.minConf, 0.70)),
    '--quiet',
  ], 10_000);
  if (paperResult.ok && !args.quiet) {
    const ps = safeJson(paperResult.stdout.split('\n').filter(l => l.startsWith('{')).pop() || '');
    if (ps && (ps.opened || ps.closed || ps.open)) {
      if (ps.opened) process.stdout.write(`   📂 Paper: ${ps.opened} eröffnet\n`);
      if (ps.closed) {
        for (const c of (ps.closes || [])) {
          const icon = c.pnl > 0 ? '✅' : c.reason === 'time_stop' ? '⏱' : '❌';
          process.stdout.write(`   ${icon} Paper close: ${c.dir} ${c.sym}  ${c.pnl > 0 ? '+' : ''}${c.pnl}%  (${c.reason})\n`);
        }
      }
      if (ps.open) process.stdout.write(`   📊 Paper offen: ${ps.open}\n`);
    }
  } else if (!paperResult.ok && !args.quiet) {
    process.stderr.write(`   ⚠ Paper-Tick fehlgeschlagen: ${paperResult.error || ''}\n`);
  }

  return currentSignals;
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function main(argv) {
  const args    = parseArgs(argv);
  let prevSigs  = [];
  let cycleNum  = 0;

  const banner = [
    '',
    '═══════════════════════════════════════════════════════════',
    '  📊 Intraday Rejection Monitor — Bitunix Futures',
    '  Strategie: ETH_LONG_ONLY_v1  (Paper Mode)',
    `  Symbole: ${args.symbols ? args.symbols.join(', ') : `Top-${args.top} nach Volumen`}`,
    `  Intervall: ${args.interval}s  |  Min-Konfidenz: ${(args.minConf*100).toFixed(0)}%`,
    `  Alert-File: ${args.alertFile}`,
    '  Ctrl+C zum Beenden.',
    '═══════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  if (!args.quiet) process.stdout.write(banner);

  // Graceful Shutdown
  process.on('SIGINT', () => {
    process.stdout.write('\n\n⏹  Monitor gestoppt.\n\n');
    process.exit(0);
  });

  // Erster Cycle sofort
  cycleNum++;
  prevSigs = runCycle(args, cycleNum, prevSigs);

  if (args.once) return;

  // Loop
  while (true) {
    await new Promise(res => setTimeout(res, args.interval * 1000));
    cycleNum++;
    prevSigs = runCycle(args, cycleNum, prevSigs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv).catch(e => {
    process.stderr.write(JSON.stringify({ error: 'monitor_crash', detail: e.message }) + '\n');
    process.exit(1);
  });
}
