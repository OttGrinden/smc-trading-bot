#!/usr/bin/env node
/**
 * mtf_context.mjs — Multi-Timeframe Kontext für Intraday-Signale
 *
 * Fetcht 15min + 1h Kerzen (Bitunix) und berechnet:
 *  - RSI 14-Perioden auf 15min und 1h (Wilder's Smoothing)
 *  - EMA 20-Perioden auf 1h für Trend-Richtung
 *  - BTC 1h-Trend als globalen Marktkontext
 *  - Relative Performance vs. BTC auf 1h und 4h
 *  - Funding-Rate aus positioning_data.json (fail-soft)
 *
 * Schreibt: trading/cache/mtf_context.json
 *
 * Usage:
 *   node mtf_context.mjs                        # alle Symbole aus intraday_cache
 *   node mtf_context.mjs --symbols BTC,ETH,SNDK
 *   node mtf_context.mjs --quiet
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath }                           from 'url';
import { dirname, join, resolve } from 'path';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const INTRADAY_CACHE  = join(TRADING_DIR, 'cache', 'intraday_cache.json');
const POSITIONING     = join(TRADING_DIR, 'cache', 'positioning_data.json');
const MTF_OUT         = join(TRADING_DIR, 'cache', 'mtf_context.json');
const BITUNIX_BASE    = 'https://fapi.bitunix.com';

const TIMEOUT_MS  = 12_000;
const BATCH_SIZE  = 4;
const BATCH_DELAY = 350;

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const symIdx = argv.indexOf('--symbols');
  return {
    symbols: symIdx !== -1 ? argv[symIdx + 1]?.split(',').map(s => s.trim().toUpperCase()) : null,
    quiet:   argv.includes('--quiet'),
  };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
  }
}

async function fetchCandles(symbol, interval, limit) {
  const url = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${symbol}USDT&interval=${interval}&limit=${limit}&type=LAST_PRICE`;
  const d   = await fetchJson(url);
  if (d.code !== 0) throw new Error(`kline_error_${d.code}`);
  if (!Array.isArray(d.data) || !d.data.length) throw new Error('empty_response');
  return d.data.reverse().map(k => ({
    time:  parseInt(k.time),
    open:  parseFloat(k.open),
    high:  parseFloat(k.high),
    low:   parseFloat(k.low),
    close: parseFloat(k.close),
    vol:   parseFloat(k.quoteVol),
  }));
}

// ─── Indikatoren ─────────────────────────────────────────────────────────────

// RSI mit Wilder's Smoothing (identisch zu scan-Pipeline)
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const d    = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain    = (avgGain * (period - 1) + gain) / period;
    avgLoss    = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  return +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);
}

// EMA mit exponentieller Glättung
function computeEMA(closes, period = 20) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema  = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return +ema.toFixed(6);
}

// Trend-Richtung: bullish / bearish / neutral (Puffer ±0.5%)
function trendDirection(price, ema) {
  if (!ema) return 'unknown';
  const dist = (price - ema) / ema * 100;
  if (dist >  0.5) return 'bullish';
  if (dist < -0.5) return 'bearish';
  return 'neutral';
}

// Relative Performance vs. BTC: wie viel besser/schlechter auf N Kerzen
function relPerf(symCloses, btcCloses) {
  if (!symCloses?.length || !btcCloses?.length) return null;
  const symRet = (symCloses[symCloses.length - 1] - symCloses[0]) / symCloses[0];
  const btcRet = (btcCloses[btcCloses.length - 1] - btcCloses[0]) / btcCloses[0];
  return +(symRet - btcRet).toFixed(6);
}

// ─── Batch-Fetch für Symbol × Interval ───────────────────────────────────────

async function batchFetch(tasks, log) {
  // tasks = [{ sym, interval, limit }]
  const results = {};
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch   = tasks.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(t => fetchCandles(t.sym, t.interval, t.limit).then(c => ({ key: `${t.sym}_${t.interval}`, candles: c })))
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        results[r.value.key] = r.value.candles;
      } else {
        const t = batch[settled.indexOf(r)];
        if (!log.quiet) process.stderr.write(
          JSON.stringify({ warn: 'mtf_fetch_failed', sym: t.sym, interval: t.interval, err: r.reason?.message }) + '\n'
        );
      }
    }
    if (i + BATCH_SIZE < tasks.length) {
      await new Promise(res => setTimeout(res, BATCH_DELAY));
    }
  }
  return results;
}

// ─── Positioning-Daten laden (fail-soft) ─────────────────────────────────────

function loadPositioning() {
  try {
    if (!existsSync(POSITIONING)) return {};
    const raw = JSON.parse(readFileSync(POSITIONING, 'utf8'));
    // Format: { "BTCUSDT": { funding_rate, long_short_ratio, ... } }
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const sym = k.replace('USDT', '');
      out[sym]  = {
        funding_rate:       v.funding_rate ?? null,
        long_short_ratio:   v.long_short_ratio ?? null,
      };
    }
    return out;
  } catch { return {}; }
}

// ─── BTC Trend Context ────────────────────────────────────────────────────────

function computeBtcContext(candles15m, candles1h) {
  if (!candles1h?.length) return { direction: 'unknown', rsi_1h: null, rsi_15m: null, ema20_dist_pct: null };

  const closes1h  = candles1h.map(c => c.close);
  const closes15m = candles15m?.map(c => c.close) ?? [];
  const price     = closes1h[closes1h.length - 1];
  const rsi_1h    = computeRSI(closes1h, 14);
  const rsi_15m   = closes15m.length >= 15 ? computeRSI(closes15m, 14) : null;
  const ema20     = computeEMA(closes1h, 20);
  const dir       = trendDirection(price, ema20);
  const ema20_dist = ema20 ? +((price - ema20) / ema20 * 100).toFixed(3) : null;

  return { direction: dir, rsi_1h, rsi_15m, ema20_dist_pct: ema20_dist };
}

// ─── Symbol Kontext berechnen ─────────────────────────────────────────────────

function computeSymContext(sym, rawData, btcCloses1h, btcCloses4c, positioning) {
  const c15m = rawData[`${sym}_15m`];
  const c1h  = rawData[`${sym}_1h`];

  if (!c1h?.length) return null;

  const closes1h  = c1h.map(c => c.close);
  const closes15m = c15m?.map(c => c.close) ?? [];
  const price     = closes1h[closes1h.length - 1];

  const rsi_15m     = closes15m.length >= 15 ? computeRSI(closes15m, 14) : null;
  const rsi_1h      = computeRSI(closes1h, 14);
  const ema20_1h    = computeEMA(closes1h, 20);
  const trend_1h    = trendDirection(price, ema20_1h);
  const ema20_dist  = ema20_1h ? +((price - ema20_1h) / ema20_1h * 100).toFixed(3) : null;

  // Relative Performance: letzten 4 1h-Kerzen vs. BTC
  const sym4cCloses = closes1h.slice(-4);
  const rel_1h_vs_btc = sym !== 'BTC' ? relPerf(sym4cCloses, btcCloses4c) : null;

  const pos = positioning[sym] ?? {};

  return {
    rsi_15m,
    rsi_1h,
    ema20_1h,
    trend_1h,
    ema20_dist_pct:  ema20_dist,
    rel_perf_1h_vs_btc: rel_1h_vs_btc,
    funding_rate:    pos.funding_rate    ?? null,
    long_short_ratio: pos.long_short_ratio ?? null,
    candles_15m:     c15m?.length ?? 0,
    candles_1h:      c1h?.length  ?? 0,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(argv) {
  const args = parseArgs(argv);
  const t0   = Date.now();

  // Symbole aus intraday_cache laden
  if (!existsSync(INTRADAY_CACHE)) {
    process.stderr.write(JSON.stringify({ error: 'intraday_cache_missing' }) + '\n');
    process.exit(1);
  }
  const intradayCache = JSON.parse(readFileSync(INTRADAY_CACHE, 'utf8'));
  const symbols = args.symbols ?? Object.keys(intradayCache.data);

  // BTC immer inklusive (für Kontext)
  const allSymbols = [...new Set(['BTC', ...symbols])];

  if (!args.quiet) process.stderr.write(JSON.stringify({
    info: 'mtf_fetch_start', symbols: allSymbols.length,
  }) + '\n');

  // Fetch-Tasks aufbauen: 15min (60 Kerzen = 15h) + 1h (60 Kerzen = 2.5 Tage)
  const tasks = [];
  for (const sym of allSymbols) {
    tasks.push({ sym, interval: '15m', limit: 60 });
    tasks.push({ sym, interval: '1h',  limit: 60 });
  }

  const rawData    = await batchFetch(tasks, args);
  const positioning = loadPositioning();

  // BTC-Kontext berechnen
  const btcCtx      = computeBtcContext(rawData['BTC_15m'], rawData['BTC_1h']);
  const btcCloses1h = rawData['BTC_1h']?.map(c => c.close) ?? [];
  const btcCloses4c = btcCloses1h.slice(-4);

  // Symbole auswerten
  const symContexts = {};
  let fetched = 0, failed = 0;

  for (const sym of symbols) {
    const ctx = computeSymContext(sym, rawData, btcCloses1h, btcCloses4c, positioning);
    if (ctx) { symContexts[sym] = ctx; fetched++; }
    else      { failed++; }
  }

  const result = {
    computed_at:   new Date().toISOString(),
    duration_ms:   Date.now() - t0,
    symbols_done:  fetched,
    symbols_failed: failed,
    btc_trend:     btcCtx,
    symbols:       symContexts,
  };

  writeFileSync(MTF_OUT, JSON.stringify(result, null, 2) + '\n', 'utf8');

  const summary = {
    info:          'mtf_context_done',
    computed_at:   result.computed_at,
    duration_ms:   result.duration_ms,
    symbols_done:  fetched,
    btc_direction: btcCtx.direction,
    btc_rsi_1h:    btcCtx.rsi_1h,
  };

  if (!args.quiet) process.stderr.write(JSON.stringify(summary) + '\n');
  process.stdout.write(JSON.stringify(summary) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv).catch(e => {
    process.stderr.write(JSON.stringify({ error: 'mtf_context_crash', detail: e.message }) + '\n');
    process.exit(1);
  });
}

export { computeRSI, computeEMA, trendDirection, relPerf };
