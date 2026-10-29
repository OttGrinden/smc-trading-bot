#!/usr/bin/env node
/**
 * intraday_paper.mjs — Intraday Paper Trading Engine
 *
 * Strategie: ETH_LONG_ONLY_v1
 *   • Symbol:    ETH
 *   • Richtung:  LONG only
 *   • 1h-Trend:  bullish oder neutral (bearish blockiert)
 *   • Conf:      ≥ 0.70
 *   • SL:        ≤ 1.5%
 *   • TP:        nächstes Level ≥ 1.3R, Fallback 1.0R
 *   • Zeitstop:  120 min
 *   • Max offen: 1 Position gleichzeitig
 *   • Gebühren:  Maker-Entry 0.02% + Taker-Exit 0.05% = 0.07% round-trip
 *
 * Modi:
 *   --tick              Offene Trades prüfen + neue Signale öffnen (jeder Monitor-Cycle)
 *   --stats             Analytics-Report aller geschlossenen Trades
 *   --daily-report      Tages-Zusammenfassung (heute UTC)
 *   --list              Offene Positionen anzeigen
 *   --min-confidence N  Override Mindest-Konfidenz (Standard: 0.70)
 *   --quiet
 *
 * Dateien:
 *   trading/logs/intraday_trades_open.json    offene Trades
 *   trading/logs/intraday_trades_closed.jsonl geschlossene Trades (append-only)
 */

import { writeFileSync, readFileSync, appendFileSync, existsSync } from 'fs';
import { spawnSync }                                               from 'child_process';
import { fileURLToPath }                                           from 'url';
import { dirname, join, resolve } from 'path';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

// ─── Strategy-Konstanten (ETH LONG-only v1) ──────────────────────────────────

const STRATEGY_ID  = 'ETH_LONG_ONLY_v1';
const PAPER_MODE   = true;

const ACTIVE_SYMS  = new Set(['ETH']);
const ACTIVE_DIRS  = new Set(['LONG']);
const MAX_POSITIONS = 1;

const FEE_ENTRY_PCT = 0.02;   // Maker Entry
const FEE_EXIT_PCT  = 0.05;   // Taker Exit
const FEE_RT_PCT    = FEE_ENTRY_PCT + FEE_EXIT_PCT;  // 0.07% round-trip

const MIN_CONF_FLOOR    = 0.70;  // hard minimum — nie darunter öffnen, unabhängig vom Caller
const UPGRADE_MIN_DELTA = 0.20;  // neues Signal muss min. 20pp stärker sein um Upgrade auszulösen
const UPGRADE_MAX_AGE   = 30;    // Upgrade nur in den ersten 30 Min nach Entry

// ─── Dateipfade ───────────────────────────────────────────────────────────────

const OPEN_PATH    = join(TRADING_DIR, 'logs', 'intraday_trades_open.json');
const CLOSED_PATH  = join(TRADING_DIR, 'logs', 'intraday_trades_closed.jsonl');
const AUDIT_PATH   = join(TRADING_DIR, 'logs', 'intraday_audit.jsonl');
const SIGNALS_PATH  = join(TRADING_DIR, 'cache', 'intraday_signals.json');
const CACHE_PATH    = join(TRADING_DIR, 'cache', 'intraday_cache.json');
const LEVELS_PATH   = join(TRADING_DIR, 'cache', 'intraday_levels.json');
const REGIME_PATH   = join(TRADING_DIR, 'cache', 'intraday_regime.json');
const LIQ_CACHE_PATH = join(TRADING_DIR, 'cache', 'liq_heatmap.json');

const CANDLE_MINS    = 5;
const CACHE_STALE_MS = 10 * 60 * 1000;  // 10 min — 2 candle intervals
const LIQ_STALE_MS   = 30 * 60 * 1000;  // 30 min — matches liq_heatmap.mjs MAX_AGE_MIN

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  function get(flag, def) {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : def;
  }
  return {
    tick:        argv.includes('--tick'),
    stats:       argv.includes('--stats'),
    dailyReport: argv.includes('--daily-report'),
    list:        argv.includes('--list'),
    minConf:     Math.max(MIN_CONF_FLOOR, parseFloat(get('--min-confidence', String(MIN_CONF_FLOOR)))),
    minRR:       parseFloat(get('--min-rr', '1.3')),
    timeStop:    parseInt(get('--time-stop', '120'), 10),
    quiet:       argv.includes('--quiet'),
  };
}

// ─── Persistenz ──────────────────────────────────────────────────────────────

function loadOpen() {
  try {
    if (!existsSync(OPEN_PATH)) return [];
    return JSON.parse(readFileSync(OPEN_PATH, 'utf8')) || [];
  } catch { return []; }
}

function saveOpen(trades) {
  writeFileSync(OPEN_PATH, JSON.stringify(trades, null, 2) + '\n', 'utf8');
}

function appendClosed(trade) {
  appendFileSync(CLOSED_PATH, JSON.stringify(trade) + '\n', 'utf8');
}

function appendAudit(entry) {
  appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}

function loadClosed() {
  if (!existsSync(CLOSED_PATH)) return [];
  return readFileSync(CLOSED_PATH, 'utf8').trim().split('\n')
    .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function safeJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ─── TP-Berechnung ────────────────────────────────────────────────────────────
// Fallback: 1.0R (statt früher 1.5R) — konservativeres TP-Ziel

function calculateTP(signal, levels, minRR) {
  const { direction, entry, sl } = signal;
  const slDist    = Math.abs(entry - sl);
  const minTPDist = slDist * minRR;

  if (direction === 'LONG') {
    const valid = levels.filter(l =>
      l.direction === 'resistance' &&
      (l.price - entry) >= minTPDist &&
      (l.price - entry) <= slDist * 3.0   // max 3R — verhindert unrealistische Fernziele
    ).sort((a, b) => a.price - b.price);

    if (valid.length) {
      const tp = +valid[0].price.toFixed(6);
      return { tp, rr: +((tp - entry) / slDist).toFixed(2), tp_source: valid[0].type };
    }
    // Fallback = minRR-Distanz → besteht immer den RR-Check
    return { tp: +(entry + slDist * minRR).toFixed(6), rr: minRR, tp_source: `fallback_${minRR}R` };
  }

  // SHORT — für Vollständigkeit, tritt in v1 nie auf
  const valid = levels.filter(l =>
    l.direction === 'support' &&
    (entry - l.price) >= minTPDist &&
    (entry - l.price) <= slDist * 3.0
  ).sort((a, b) => b.price - a.price);

  if (valid.length) {
    const tp = +valid[0].price.toFixed(6);
    return { tp, rr: +((entry - tp) / slDist).toFixed(2), tp_source: valid[0].type };
  }
  return { tp: +(entry - slDist * minRR).toFixed(6), rr: minRR, tp_source: `fallback_${minRR}R` };
}

// ─── Exit-Prüfung via Kerzendaten ────────────────────────────────────────────
// Konservativ: wenn SL + TP in derselben Kerze → SL zuerst

function checkExitOnCandles(trade, candles) {
  const { direction, entry_candle_time, sl, tp, time_stop_time } = trade;
  const relevant = candles.filter(c => c.time > entry_candle_time);

  for (const c of relevant) {
    if (direction === 'LONG') {
      const slHit = c.low  <= sl;
      const tpHit = c.high >= tp;
      if (slHit && tpHit) return { reason: 'sl', exit_price: sl, candle: c };
      if (slHit)           return { reason: 'sl', exit_price: sl, candle: c };
      if (tpHit)           return { reason: 'tp', exit_price: tp, candle: c };
    } else {
      const slHit = c.high >= sl;
      const tpHit = c.low  <= tp;
      if (slHit && tpHit) return { reason: 'sl', exit_price: sl, candle: c };
      if (slHit)           return { reason: 'sl', exit_price: sl, candle: c };
      if (tpHit)           return { reason: 'tp', exit_price: tp, candle: c };
    }
    if (time_stop_time && c.time >= time_stop_time)
      return { reason: 'time_stop', exit_price: c.close, candle: c };
  }
  return null;
}

// ─── P&L (gross) ─────────────────────────────────────────────────────────────

function calcPnlGross(direction, entry, exit) {
  if (direction === 'LONG') return +((exit  - entry) / entry * 100).toFixed(3);
  return                           +((entry - exit)  / entry * 100).toFixed(3);
}

// ─── Hilfsfunktion: UTC-Datum String ─────────────────────────────────────────

function utcDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// ─── Auto-Refresh: Signals + Cache via Monitor-Pipeline ──────────────────────
// Läuft intraday_monitor --once wenn Signals oder Candle-Cache veraltet.
// Monitor ruft Fetcher intern auf → kein Double-Fetch.

function refreshSignalsIfStale(quiet) {
  // Signals-Alter prüfen
  let sigAgeMs = Infinity;
  try {
    const s = safeJson(readFileSync(SIGNALS_PATH, 'utf8'));
    if (s?.detected_at) sigAgeMs = Date.now() - new Date(s.detected_at).getTime();
  } catch { /* fehlt → Infinity */ }

  // Candle-Cache-Alter prüfen (Fallback falls detected_at fehlt)
  let cacheAgeMs = Infinity;
  try {
    const c = safeJson(readFileSync(CACHE_PATH, 'utf8'));
    if (c?.fetched_at) cacheAgeMs = Date.now() - new Date(c.fetched_at).getTime();
  } catch { /* fehlt → Infinity */ }

  // Refresh wenn Signals ODER Cache veraltet — Monitor aktualisiert beides
  if (sigAgeMs < CACHE_STALE_MS && cacheAgeMs < CACHE_STALE_MS) return;

  const monitor = join(dirname(fileURLToPath(import.meta.url)), 'intraday_monitor.mjs');
  if (!quiet) {
    process.stderr.write(JSON.stringify({
      info:           'signals_stale_auto_refresh',
      sig_age_min:    Math.round(sigAgeMs   / 60_000),
      cache_age_min:  Math.round(cacheAgeMs / 60_000),
      threshold_min:  CACHE_STALE_MS / 60_000,
    }) + '\n');
  }
  const result = spawnSync(process.execPath, [monitor, '--once', '--symbols', 'ETH', '--quiet'], {
    encoding: 'utf8',
    timeout:  60_000,
  });
  if (result.status !== 0 && !quiet) {
    process.stderr.write(JSON.stringify({
      warn:   'signals_refresh_failed',
      stderr: result.stderr?.slice(0, 300),
    }) + '\n');
  }
}

// ─── Auto-Fetch: Liquidations-Heatmap auffrischen wenn veraltet ──────────────

function refreshHeatmapIfStale(quiet) {
  let ageMs = Infinity;
  try {
    const raw = safeJson(readFileSync(LIQ_CACHE_PATH, 'utf8'));
    // liq_heatmap speichert updated_at pro Symbol — ETH als Referenz
    const updatedAt = raw?.ETH?.updated_at;
    if (updatedAt) ageMs = Date.now() - new Date(updatedAt).getTime();
  } catch { /* fehlt → Infinity */ }

  if (ageMs < LIQ_STALE_MS) return;

  const fetcher = join(dirname(fileURLToPath(import.meta.url)), 'liq_heatmap.mjs');
  if (!quiet) {
    process.stderr.write(JSON.stringify({
      info: 'heatmap_stale_auto_fetch',
      age_min: Math.round(ageMs / 60_000),
      threshold_min: LIQ_STALE_MS / 60_000,
    }) + '\n');
  }
  const result = spawnSync(process.execPath, [fetcher], {
    encoding: 'utf8',
    timeout:  20_000,
  });
  if (result.status !== 0 && !quiet) {
    process.stderr.write(JSON.stringify({
      warn: 'heatmap_refresh_failed',
      stderr: result.stderr?.slice(0, 200),
    }) + '\n');
  }
}

// ─── TICK: offene Trades prüfen + neue öffnen ─────────────────────────────────

function runTick(args) {
  refreshSignalsIfStale(args.quiet);
  refreshHeatmapIfStale(args.quiet);

  const signalData = safeJson(existsSync(SIGNALS_PATH)   ? readFileSync(SIGNALS_PATH,   'utf8') : '');
  const cacheData  = safeJson(existsSync(CACHE_PATH)     ? readFileSync(CACHE_PATH,     'utf8') : '');
  const levelsData = safeJson(existsSync(LEVELS_PATH)    ? readFileSync(LEVELS_PATH,    'utf8') : '');
  const liqData    = safeJson(existsSync(LIQ_CACHE_PATH) ? readFileSync(LIQ_CACHE_PATH, 'utf8') : '');

  if (!cacheData) {
    if (!args.quiet) process.stderr.write(JSON.stringify({ warn: 'no_cache_data' }) + '\n');
    return;
  }

  // Regime prüfen — bearish_locked blockiert alle LONG-Entries
  const regimeData   = safeJson(existsSync(REGIME_PATH) ? readFileSync(REGIME_PATH, 'utf8') : '');
  const regimeLocked = regimeData?.state === 'bearish_locked';
  if (regimeLocked && !args.quiet) {
    process.stdout.write(`   🔒 Regime LOCKED — ${regimeData.lock_reason ?? 'bearish'}  → kein LONG-Entry\n`);
  }

  let openTrades = loadOpen();
  const closedNow = [];
  const opened    = [];

  // ── 1. Offene Trades prüfen ────────────────────────────────────────────────
  const stillOpen = [];
  for (const trade of openTrades) {
    const symCache = cacheData.data?.[trade.symbol];
    if (!symCache) { stillOpen.push(trade); continue; }

    const exit = checkExitOnCandles(trade, symCache.candles);
    if (!exit) { stillOpen.push(trade); continue; }

    const pnlGross = calcPnlGross(trade.direction, trade.entry_price, exit.exit_price);
    const pnlNet   = +(pnlGross - FEE_RT_PCT).toFixed(3);
    const holdMins = Math.round((exit.candle.time - new Date(trade.entry_time).getTime()) / 60_000);

    const closed = {
      ...trade,
      status:         exit.reason === 'tp' ? 'closed_tp'
                    : exit.reason === 'sl' ? 'closed_sl' : 'closed_time',
      exit_price:     exit.exit_price,
      exit_time:      new Date(exit.candle.time).toISOString(),
      exit_reason:    exit.reason,
      pnl_pct:        pnlGross,
      pnl_pct_net:    pnlNet,
      fee_rt_pct:     FEE_RT_PCT,
      hold_candles:   Math.round((exit.candle.time - trade.entry_candle_time) / (CANDLE_MINS * 60_000)),
      hold_mins:      holdMins,
      win:            pnlNet > 0,       // Gewinn = net nach Gebühren
      win_gross:      pnlGross > 0,
    };

    appendClosed(closed);
    closedNow.push(closed);
  }

  // ── 1.5 Position-Upgrade: schwachen Trade durch stärkeres Signal ersetzen ──
  // justClosedSyms exkludiert upgrade-Closes → gleiche Position darf sofort neu öffnen
  const justClosedSyms = new Set(closedNow.filter(t => t.exit_reason !== 'upgrade').map(t => t.symbol));

  if (!regimeLocked && stillOpen.length >= MAX_POSITIONS && signalData?.signals) {
    const qualifiedNew = signalData.signals
      .filter(sig =>
        ACTIVE_SYMS.has(sig.symbol) &&
        ACTIVE_DIRS.has(sig.direction) &&
        sig.status === 'actionable' &&
        sig.confidence >= args.minConf &&
        sig.sl_pct <= 1.5 &&
        !justClosedSyms.has(sig.symbol) &&
        sig.mtf?.trend_1h === 'bullish' &&
        sig.level_type !== 'vwap'
      )
      .sort((a, b) => b.confidence - a.confidence);

    if (qualifiedNew.length) {
      const bestNew = qualifiedNew[0];
      const weakest = stillOpen.slice().sort((a, b) => a.confidence - b.confidence)[0];
      const ageMins = (Date.now() - new Date(weakest.entry_time).getTime()) / 60_000;

      if (bestNew.confidence >= weakest.confidence + UPGRADE_MIN_DELTA && ageMins <= UPGRADE_MAX_AGE) {
        const symCache   = cacheData.data?.[weakest.symbol];
        const lastCandle = symCache?.candles?.[symCache.candles.length - 1];

        if (lastCandle) {
          const exitPrice = lastCandle.close;
          const pnlGross  = calcPnlGross(weakest.direction, weakest.entry_price, exitPrice);
          const pnlNet    = +(pnlGross - FEE_RT_PCT).toFixed(3);
          const holdMins  = Math.round((lastCandle.time - new Date(weakest.entry_time).getTime()) / 60_000);

          const closed = {
            ...weakest,
            status:       'closed_upgrade',
            exit_price:   exitPrice,
            exit_time:    new Date(lastCandle.time).toISOString(),
            exit_reason:  'upgrade',
            pnl_pct:      pnlGross,
            pnl_pct_net:  pnlNet,
            fee_rt_pct:   FEE_RT_PCT,
            hold_candles: Math.round((lastCandle.time - weakest.entry_candle_time) / (CANDLE_MINS * 60_000)),
            hold_mins:    holdMins,
            win:          pnlNet > 0,
            win_gross:    pnlGross > 0,
          };
          appendClosed(closed);
          closedNow.push(closed);
          stillOpen.splice(stillOpen.indexOf(weakest), 1);

          if (!args.quiet) {
            process.stdout.write(
              `   🔄 UPGRADE: ${weakest.direction} ${weakest.symbol}` +
              ` conf=${(weakest.confidence * 100).toFixed(0)}% → ${(bestNew.confidence * 100).toFixed(0)}%` +
              `  Exit: ${exitPrice}  PnL net: ${pnlNet > 0 ? '+' : ''}${pnlNet}%\n`
            );
          }
        }
      }
    }
  }

  // ── 2. Neue Signale öffnen ─────────────────────────────────────────────────
  if (!regimeLocked && stillOpen.length < MAX_POSITIONS && signalData?.signals) {
    for (const sig of signalData.signals) {
      if (stillOpen.length + opened.length >= MAX_POSITIONS) break;

      // ── Strategy-Filter (ETH LONG-only v1) ──
      if (!ACTIVE_SYMS.has(sig.symbol))    continue;  // nur ETH
      if (!ACTIVE_DIRS.has(sig.direction)) continue;  // nur LONG

      // 1h-Trend-Filter: nur bullish erlaubt — neutral/null/bearish blockiert
      const trend1h = sig.mtf?.trend_1h;
      if (trend1h !== 'bullish' && trend1h !== 'neutral') continue;
      if (trend1h === 'neutral') {
        appendAudit({ event: 'blocked_trend_neutral', symbol: sig.symbol, direction: sig.direction, confidence: sig.confidence, level_type: sig.level_type });
        continue;
      }

      // Konfidenz und Signal-Freshness
      if (sig.status !== 'actionable')    continue;
      if (sig.confidence < args.minConf)  continue;

      // SL-Limit
      if (sig.sl_pct > 1.5) continue;

      // Vol-Filter: schwaches Volumen = schwache Rejection
      if ((sig.vol_multiple ?? 0) < 0.80) continue;

      // VWAP-Levels blockiert (schwache Edge laut Backtest)
      if (sig.level_type === 'vwap') {
        appendAudit({ event: 'blocked_vwap', symbol: sig.symbol, direction: sig.direction, confidence: sig.confidence });
        continue;
      }

      // Kein Re-Entry auf Symbol das gerade via SL/TP/time_stop geschlossen wurde
      if (justClosedSyms.has(sig.symbol)) continue;

      // Heatmap Bias-Gate: sell_dominant → LONG blockiert
      const liqEth = liqData?.[sig.symbol];
      if (liqEth?.bias === 'sell_dominant') {
        appendAudit({ event: 'blocked_sell_bias', symbol: sig.symbol, direction: sig.direction,
          confidence: sig.confidence, bias: liqEth.bias,
          nearest_sell_wall: liqEth.nearest_sell_wall?.price ?? null });
        continue;
      }

      // TP berechnen
      const symLevels = levelsData?.symbols?.[sig.symbol]?.levels ?? [];
      let { tp, rr, tp_source } = calculateTP(sig, symLevels, args.minRR);

      // TP-Cap: nächste Sell Wall als harte Obergrenze (Preis stall-Risiko)
      const nearSell = liqEth?.nearest_sell_wall;
      if (nearSell && nearSell.price > sig.entry && nearSell.price < tp) {
        const cappedTp = +(nearSell.price * 0.998).toFixed(8); // 0.2% unter der Wall
        const cappedRr = +((cappedTp - sig.entry) / Math.abs(sig.entry - sig.sl)).toFixed(2);
        if (cappedRr >= args.minRR) {
          tp        = cappedTp;
          rr        = cappedRr;
          tp_source = `sell_wall_cap_${nearSell.pct_away}pct`;
        }
        // cappedRr < minRR → ursprüngliches TP behalten (Wall zu nah, kein besseres Ziel)
      }

      if (rr < args.minRR) continue;

      const entryTime    = Date.now();
      const timeStopTime = entryTime + args.timeStop * 60_000;
      const symCache     = cacheData.data?.[sig.symbol];
      const lastCandle   = symCache?.candles?.[symCache.candles.length - 1];

      const trade = {
        trade_id:          `it_${entryTime}_${sig.symbol}_${sig.direction}`,
        paper_mode:        PAPER_MODE,
        strategy:          STRATEGY_ID,
        symbol:            sig.symbol,
        direction:         sig.direction,
        status:            'open',
        entry_price:       sig.entry,
        entry_time:        new Date(entryTime).toISOString(),
        entry_candle_time: lastCandle?.time ?? 0,
        sl:                sig.sl,
        sl_pct:            sig.sl_pct,
        tp,
        tp_pct:            +(Math.abs(sig.entry - tp) / sig.entry * 100).toFixed(3),
        rr,
        tp_source,
        time_stop_time:    timeStopTime,
        level_price:       sig.level_price,
        level_type:        sig.level_type,
        confidence:        sig.confidence,
        wick_ratio:        sig.wick_ratio,
        vol_multiple:      sig.vol_multiple,
        mtf_adjustment:    sig.mtf_adjustment ?? null,
        rsi_1h:            sig.mtf?.rsi_1h        ?? null,
        rsi_15m:           sig.mtf?.rsi_15m       ?? null,
        trend_1h:          sig.mtf?.trend_1h      ?? null,
        ema20_dist_pct:    sig.mtf?.ema20_dist_pct ?? null,
        fee_entry_pct:     FEE_ENTRY_PCT,
        fee_exit_pct:      FEE_EXIT_PCT,
        fee_rt_pct:        FEE_RT_PCT,
      };

      stillOpen.push(trade);
      opened.push(trade);
    }
  }

  saveOpen(stillOpen);

  // ── 3. Konsolen-Ausgabe ────────────────────────────────────────────────────
  if (!args.quiet) {
    for (const t of closedNow) {
      const icon = t.win ? '✅' : t.exit_reason === 'time_stop' ? '⏱' : t.exit_reason === 'upgrade' ? '🔄' : '❌';
      process.stdout.write(
        `   ${icon} CLOSED ${t.direction} ${t.symbol}  ${t.exit_reason.toUpperCase().padEnd(10)}` +
        `  Gross: ${t.pnl_pct > 0 ? '+' : ''}${t.pnl_pct}%  Net: ${t.pnl_pct_net > 0 ? '+' : ''}${t.pnl_pct_net}%` +
        `  Hold: ${t.hold_mins}min  Entry: ${t.entry_price} → Exit: ${t.exit_price}\n`
      );
    }
    for (const t of opened) {
      process.stdout.write(
        `   📂 OPEN  ${t.direction} ${t.symbol}  Entry: ${t.entry_price}  SL: ${t.sl} (-${t.sl_pct}%)` +
        `  TP: ${t.tp} (+${t.tp_pct}%)  R:R ${t.rr}  Conf: ${(t.confidence*100).toFixed(0)}%` +
        `  Trend: ${t.trend_1h ?? '?'}  RSI1h: ${t.rsi_1h ?? '?'}\n`
      );
    }
    if (stillOpen.length) process.stdout.write(`   📊 Offen: ${stillOpen.length}/${MAX_POSITIONS}\n`);
  }

  process.stderr.write(JSON.stringify({
    info: 'paper_tick_done', strategy: STRATEGY_ID,
    opened: opened.length, closed: closedNow.length, open: stillOpen.length,
  }) + '\n');

  process.stdout.write(JSON.stringify({
    opened: opened.length, closed: closedNow.length, open: stillOpen.length,
    closes: closedNow.map(t => ({ sym: t.symbol, dir: t.direction, reason: t.exit_reason, pnl: t.pnl_pct, pnl_net: t.pnl_pct_net })),
  }) + '\n');
}

// ─── LIST: offene Positionen ─────────────────────────────────────────────────

function runList() {
  const trades = loadOpen();
  const liqData = safeJson(existsSync(LIQ_CACHE_PATH) ? readFileSync(LIQ_CACHE_PATH, 'utf8') : '');
  if (!trades.length) {
    process.stdout.write(`Keine offenen Intraday-Paper-Trades. [${STRATEGY_ID}]\n`);
    return;
  }
  process.stdout.write(`\n📂 Offene Intraday-Paper-Trades (${trades.length}/${MAX_POSITIONS}) [${STRATEGY_ID}]\n`);
  process.stdout.write('─'.repeat(80) + '\n');
  for (const t of trades) {
    const openMins = Math.round((Date.now() - new Date(t.entry_time).getTime()) / 60_000);
    const minsLeft = Math.max(0, Math.round((t.time_stop_time - Date.now()) / 60_000));
    const liq      = liqData?.[t.symbol];
    const liqLine  = liq
      ? `Bias: ${liq.bias}  SellWall: ${liq.nearest_sell_wall ? `$${liq.nearest_sell_wall.price.toFixed(2)} (+${liq.nearest_sell_wall.pct_away}%)` : '—'}  BuyWall: ${liq.nearest_buy_wall ? `$${liq.nearest_buy_wall.price.toFixed(2)} (${liq.nearest_buy_wall.pct_away}%)` : '—'}${liq.squeeze_potential !== 'none' ? `  ⚡ ${liq.squeeze_potential}` : ''}`
      : 'Heatmap: —';
    process.stdout.write(
      `${t.direction.padEnd(6)} ${t.symbol.padEnd(6)} Entry: ${t.entry_price}  ` +
      `SL: ${t.sl} (-${t.sl_pct}%)  TP: ${t.tp} (+${t.tp_pct}%)  R:R ${t.rr}\n` +
      `       Conf: ${(t.confidence*100).toFixed(0)}%  Offen: ${openMins}min  TimeStop in: ${minsLeft}min\n` +
      `       Level: ${t.level_price} (${t.level_type})  Trend1h: ${t.trend_1h ?? '?'}  RSI1h: ${t.rsi_1h ?? '?'}\n` +
      `       ${liqLine}\n`
    );
  }
}

// ─── STATS: vollständiger Analytics-Report ────────────────────────────────────

function runStats() {
  const closed = loadClosed();
  const open   = loadOpen();

  if (!closed.length) {
    process.stdout.write(`Noch keine geschlossenen Trades. [${STRATEGY_ID}]\n`);
    if (open.length) process.stdout.write(`(${open.length} Trades offen)\n`);
    return;
  }

  const total      = closed.length;
  const winsNet    = closed.filter(t => t.win).length;
  const winsGross  = closed.filter(t => t.pnl_pct > 0).length;
  const sumGross   = closed.reduce((s, t) => s + t.pnl_pct, 0);
  const sumNet     = closed.reduce((s, t) => s + (t.pnl_pct_net ?? t.pnl_pct - FEE_RT_PCT), 0);
  const avgHold    = Math.round(closed.reduce((s, t) => s + (t.hold_mins || 0), 0) / total);
  const cumNetPct  = +sumNet.toFixed(3);

  const lines = [
    '',
    '═══════════════════════════════════════════════════════════',
    `  📊 Intraday Paper Trading — ${STRATEGY_ID}`,
    '═══════════════════════════════════════════════════════════',
    `  Gesamt: ${total} Trades  |  Offen: ${open.length}/${MAX_POSITIONS}`,
    `  WR (net):   ${(winsNet/total*100).toFixed(1)}%  (${winsNet}W / ${total-winsNet}L)`,
    `  WR (gross): ${(winsGross/total*100).toFixed(1)}%`,
    `  Ø P&L gross: ${(sumGross/total).toFixed(3)}%  |  Ø P&L net: ${(sumNet/total).toFixed(3)}%`,
    `  Kum. P&L net: ${cumNetPct > 0 ? '+' : ''}${cumNetPct}%  über alle ${total} Trades`,
    `  Ø Haltedauer: ${avgHold}min`,
    `  Gebühren: Entry ${FEE_ENTRY_PCT}% (Maker) + Exit ${FEE_EXIT_PCT}% (Taker) = ${FEE_RT_PCT}% RT`,
    '',
  ];

  // ── Nach Exit-Grund ───────────────────────────────────────────────────────
  lines.push('  ── Nach Exit-Grund ─────────────────────────────────────');
  for (const r of ['tp', 'sl', 'time_stop', 'upgrade']) {
    const rt  = closed.filter(t => t.exit_reason === r);
    if (!rt.length) continue;
    const rw  = rt.filter(t => t.win).length;
    const exp = (rt.reduce((s,t) => s + (t.pnl_pct_net ?? t.pnl_pct - FEE_RT_PCT), 0) / rt.length).toFixed(3);
    lines.push(`  ${r.padEnd(12)} ${rt.length} Trades  WR: ${(rw/rt.length*100).toFixed(0).padStart(3)}%  Exp(net): ${exp}%`);
  }

  // ── Nach Level-Typ ─────────────────────────────────────────────────────────
  lines.push('', '  ── Nach Level-Typ ─────────────────────────────────────');
  const ltypes = [...new Set(closed.map(t => t.level_type))].sort();
  for (const lt of ltypes) {
    const lt_ = closed.filter(t => t.level_type === lt);
    const lw  = lt_.filter(t => t.win).length;
    const exp = (lt_.reduce((s,t) => s + (t.pnl_pct_net ?? t.pnl_pct - FEE_RT_PCT), 0) / lt_.length).toFixed(3);
    lines.push(`  ${lt.padEnd(16)} ${lt_.length} Trades  WR: ${(lw/lt_.length*100).toFixed(0).padStart(3)}%  Exp(net): ${exp}%`);
  }

  // ── Nach 1h-Trend ─────────────────────────────────────────────────────────
  lines.push('', '  ── Nach 1h-Trend (EMA20) ──────────────────────────────');
  for (const tr of ['bullish', 'neutral', null]) {
    const tt  = closed.filter(t => t.trend_1h === tr);
    if (!tt.length) continue;
    const tw  = tt.filter(t => t.win).length;
    const exp = (tt.reduce((s,t) => s + (t.pnl_pct_net ?? t.pnl_pct - FEE_RT_PCT), 0) / tt.length).toFixed(3);
    lines.push(`  ${(tr ?? 'unbekannt').padEnd(12)}  ${tt.length} Trades  WR: ${(tw/tt.length*100).toFixed(0).padStart(3)}%  Exp(net): ${exp}%`);
  }

  // ── Nach 1h-RSI-Band ──────────────────────────────────────────────────────
  lines.push('', '  ── Nach 1h-RSI-Band ────────────────────────────────────');
  const rsiBands = [
    { l: 'RSI 35–50', min: 35, max: 50 },
    { l: 'RSI 50–65', min: 50, max: 65 },
    { l: 'RSI unbekannt', min: -1, max: -1 },
  ];
  for (const b of rsiBands) {
    const bt = b.min === -1
      ? closed.filter(t => t.rsi_1h == null)
      : closed.filter(t => t.rsi_1h != null && t.rsi_1h >= b.min && t.rsi_1h < b.max);
    if (!bt.length) continue;
    const bw  = bt.filter(t => t.win).length;
    const exp = (bt.reduce((s,t) => s + (t.pnl_pct_net ?? t.pnl_pct - FEE_RT_PCT), 0) / bt.length).toFixed(3);
    lines.push(`  ${b.l.padEnd(18)} ${bt.length} Trades  WR: ${(bw/bt.length*100).toFixed(0).padStart(3)}%  Exp(net): ${exp}%`);
  }

  // ── Nach Konfidenz-Band ────────────────────────────────────────────────────
  lines.push('', '  ── Nach Konfidenz-Band ─────────────────────────────────');
  const confBands = [
    { l: '70–78%', min: 0.70, max: 0.78 },
    { l: '78–87%', min: 0.78, max: 0.87 },
    { l: '87%+',   min: 0.87, max: 1.01 },
  ];
  for (const b of confBands) {
    const bt = closed.filter(t => t.confidence >= b.min && t.confidence < b.max);
    if (!bt.length) continue;
    const bw  = bt.filter(t => t.win).length;
    const exp = (bt.reduce((s,t) => s + (t.pnl_pct_net ?? t.pnl_pct - FEE_RT_PCT), 0) / bt.length).toFixed(3);
    lines.push(`  ${b.l.padEnd(10)} ${bt.length} Trades  WR: ${(bw/bt.length*100).toFixed(0).padStart(3)}%  Exp(net): ${exp}%`);
  }

  // ── Tägliche P&L-History (letzte 14 Tage) ─────────────────────────────────
  lines.push('', '  ── Tägliche P&L-History (kumulativ, net) ───────────────');
  const byDay = {};
  for (const t of closed) {
    const d = utcDate(new Date(t.exit_time).getTime());
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(t);
  }
  const sortedDays = Object.keys(byDay).sort().slice(-14);
  let cumPnl = 0;
  for (const d of sortedDays) {
    const dt    = byDay[d];
    const dNet  = dt.reduce((s,t) => s + (t.pnl_pct_net ?? t.pnl_pct - FEE_RT_PCT), 0);
    const dWins = dt.filter(t => t.win).length;
    cumPnl     += dNet;
    const cumStr = (cumPnl > 0 ? '+' : '') + cumPnl.toFixed(3);
    lines.push(
      `  ${d}  ${dt.length} Trades  WR: ${(dWins/dt.length*100).toFixed(0).padStart(3)}%` +
      `  Ø ${(dNet/dt.length > 0 ? '+' : '')}${(dNet/dt.length).toFixed(3)}%/Trade` +
      `  Kum: ${cumStr}%`
    );
  }

  // ── Letzte 10 Trades ──────────────────────────────────────────────────────
  lines.push('', '  ── Letzte 10 geschlossene Trades ──────────────────────');
  for (const t of closed.slice(-10).reverse()) {
    const icon    = t.win ? '✅' : t.exit_reason === 'time_stop' ? '⏱' : '❌';
    const netStr  = (t.pnl_pct_net ?? t.pnl_pct - FEE_RT_PCT).toFixed(3);
    lines.push(
      `  ${icon} ${t.direction.padEnd(5)} ${(t.pnl_pct > 0 ? '+' : '') + t.pnl_pct}% gross` +
      `  ${netStr > 0 ? '+' : ''}${netStr}% net` +
      `  ${t.exit_reason.padEnd(10)}  ${t.hold_mins}min` +
      `  Conf:${(t.confidence*100).toFixed(0)}%  ${t.level_type}` +
      `  ${t.exit_time?.slice(0, 16) ?? ''}`
    );
  }

  lines.push('═══════════════════════════════════════════════════════════', '');
  process.stdout.write(lines.join('\n') + '\n');
}

// ─── DAILY REPORT: Tages-Zusammenfassung ─────────────────────────────────────

function runDailyReport() {
  const closed  = loadClosed();
  const open    = loadOpen();
  const todayUTC = utcDate(Date.now());

  const todayTrades = closed.filter(t => t.exit_time && utcDate(new Date(t.exit_time).getTime()) === todayUTC);

  const lines = [
    '',
    `═══════════════════════════════════════════════════════════`,
    `  📅 Tages-Report ${todayUTC} — ${STRATEGY_ID}`,
    `═══════════════════════════════════════════════════════════`,
  ];

  if (!todayTrades.length) {
    lines.push('  Noch keine geschlossenen Trades heute.');
  } else {
    const total   = todayTrades.length;
    const wins    = todayTrades.filter(t => t.win).length;
    const sumNet  = todayTrades.reduce((s,t) => s + (t.pnl_pct_net ?? t.pnl_pct - FEE_RT_PCT), 0);
    const sumGross = todayTrades.reduce((s,t) => s + t.pnl_pct, 0);

    lines.push(
      `  Trades: ${total}  |  WR(net): ${(wins/total*100).toFixed(1)}%  (${wins}W / ${total-wins}L)`,
      `  Ø P&L gross: ${(sumGross/total).toFixed(3)}%  |  Ø P&L net: ${(sumNet/total).toFixed(3)}%`,
      `  Kum. P&L net heute: ${sumNet > 0 ? '+' : ''}${sumNet.toFixed(3)}%`,
      '',
    );

    // Exit-Gründe
    lines.push('  ── Exit-Gründe ────────────────────────────────────────');
    for (const r of ['tp', 'sl', 'time_stop', 'upgrade']) {
      const rt = todayTrades.filter(t => t.exit_reason === r);
      if (!rt.length) continue;
      lines.push(`  ${r.padEnd(12)} ${rt.length}`);
    }

    // Level-Typen
    lines.push('', '  ── Level-Typ ──────────────────────────────────────────');
    const ltypes = [...new Set(todayTrades.map(t => t.level_type))].sort();
    for (const lt of ltypes) {
      const lt_ = todayTrades.filter(t => t.level_type === lt);
      const lw  = lt_.filter(t => t.win).length;
      const exp = (lt_.reduce((s,t) => s + (t.pnl_pct_net ?? t.pnl_pct - FEE_RT_PCT), 0) / lt_.length).toFixed(3);
      lines.push(`  ${lt.padEnd(16)} ${lt_.length}  WR: ${(lw/lt_.length*100).toFixed(0)}%  Exp: ${exp}%`);
    }

    // Trades
    lines.push('', '  ── Alle Trades heute ──────────────────────────────────');
    for (const t of todayTrades) {
      const icon   = t.win ? '✅' : t.exit_reason === 'time_stop' ? '⏱' : '❌';
      const netStr = (t.pnl_pct_net ?? t.pnl_pct - FEE_RT_PCT).toFixed(3);
      lines.push(
        `  ${icon} ${(t.entry_time?.slice(11, 16) ?? '?')}→${(t.exit_time?.slice(11, 16) ?? '?')}` +
        `  ${t.level_type}  Conf:${(t.confidence*100).toFixed(0)}%  ${t.exit_reason}` +
        `  ${t.pnl_pct > 0 ? '+' : ''}${t.pnl_pct}% gross  ${netStr > 0 ? '+' : ''}${netStr}% net`
      );
    }
  }

  if (open.length) {
    lines.push('', `  📊 Offen: ${open.length}/${MAX_POSITIONS} Position(en)`);
    for (const t of open) {
      const openMins = Math.round((Date.now() - new Date(t.entry_time).getTime()) / 60_000);
      lines.push(`  → ${t.direction} ${t.symbol}  Entry: ${t.entry_price}  +${openMins}min`);
    }
  }

  lines.push('═══════════════════════════════════════════════════════════', '');
  process.stdout.write(lines.join('\n') + '\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function run(argv) {
  const args = parseArgs(argv);

  if (args.stats)       { runStats();       return; }
  if (args.dailyReport) { runDailyReport(); return; }
  if (args.list)        { runList();        return; }
  if (args.tick)        { runTick(args);    return; }

  process.stderr.write('Usage: node intraday_paper.mjs --tick | --stats | --daily-report | --list\n');
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'paper_crash', strategy: STRATEGY_ID, detail: e.message }) + '\n');
    process.exit(1);
  }
}
