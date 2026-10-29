#!/usr/bin/env node
/**
 * backtest_intraday.mjs — Historischer Backtest des Intraday Rejection Systems
 *
 * v3: + --long-only: nur LONG-Signale bei bullish/neutralem 1h-Trend
 *     + --json-out: maschinenlesbarer JSON-Output für Vergleiche
 *
 * Usage:
 *   node backtest_intraday.mjs --symbol BTC --days 14
 *   node backtest_intraday.mjs --symbol ETH --days 14 --long-only
 *   node backtest_intraday.mjs --symbol BTC --days 14 --no-mtf
 *   node backtest_intraday.mjs --symbol BTC --days 14 --out trades.jsonl
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const BITUNIX_BASE = 'https://fapi.bitunix.com';
const TIMEOUT_MS   = 12_000;
const CANDLE_MINS  = 5;
const TIME_STOP    = 120;  // Minuten

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  function get(flag, def) { const i = argv.indexOf(flag); return i !== -1 ? argv[i+1] : def; }
  return {
    symbol:    get('--symbol', 'BTC').toUpperCase(),
    days:      parseInt(get('--days', '14'), 10),
    minConf:   parseFloat(get('--min-confidence', '0.65')),
    minRR:     parseFloat(get('--min-rr', '1.3')),
    minWick:   parseFloat(get('--min-wick', '0.50')),
    approach:  parseFloat(get('--approach', '0.8')),
    noMtf:     argv.includes('--no-mtf'),
    longOnly:  argv.includes('--long-only'),
    jsonOut:   argv.includes('--json-out'),
    outFile:   get('--out', null),
  };
}

// ─── HTTP ──────────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { clearTimeout(timer); throw new Error(e.name === 'AbortError' ? 'timeout' : e.message); }
}

// ─── Historische Kerzen via rückwärts-Pagination ─────────────────────────────

async function fetchHistorical(symbol, interval, totalCandles, label) {
  const batchSize  = 200;
  const allCandles = [];
  let   endTime    = Date.now();

  process.stderr.write(`Fetching ${totalCandles} ${interval}-Kerzen (${label})...\n`);

  while (allCandles.length < totalCandles) {
    const url = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${symbol}USDT&interval=${interval}&limit=${batchSize}&type=LAST_PRICE&endTime=${endTime}`;
    const d   = await fetchJson(url);
    if (!d.data?.length) break;

    const batch = d.data.map(k => ({
      time:  parseInt(k.time),
      open:  parseFloat(k.open),
      high:  parseFloat(k.high),
      low:   parseFloat(k.low),
      close: parseFloat(k.close),
      vol:   parseFloat(k.quoteVol),
    })).sort((a, b) => a.time - b.time);

    const oldest = batch[0].time;
    allCandles.unshift(...batch);
    endTime = oldest - 1;

    process.stderr.write(`  ${Math.min(allCandles.length, totalCandles)}/${totalCandles} fetched (${new Date(oldest).toISOString().slice(0,10)})\r`);
    await new Promise(r => setTimeout(r, 250));
  }

  process.stderr.write('\n');
  return allCandles.sort((a,b) => a.time - b.time);
}

// ─── 1h RSI — rollend für jeden Zeitpunkt ─────────────────────────────────────

function buildRollingRSI(candles1h, period = 14) {
  // Map<time_ms → rsi_value>
  const map = new Map();
  const closes = candles1h.map(c => c.close);
  if (closes.length < period + 1) return map;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  const rsi0 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  map.set(candles1h[period].time, +rsi0.toFixed(2));

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain * (period-1) + Math.max(d,  0)) / period;
    avgLoss = (avgLoss * (period-1) + Math.max(-d, 0)) / period;
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    map.set(candles1h[i].time, +rsi.toFixed(2));
  }
  return map;
}

// 1h EMA20 — rollend für Trend-Richtung
function buildRollingEMA(candles1h, period = 20) {
  // Map<time_ms → { ema, trend }>  trend: 'bullish'|'bearish'|'neutral'
  const map = new Map();
  const closes = candles1h.map(c => c.close);
  if (closes.length < period) return map;

  const k = 2 / (period + 1);
  let ema  = closes.slice(0, period).reduce((s,v) => s+v, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema  = closes[i] * k + ema * (1 - k);
    const dist  = (closes[i] - ema) / ema * 100;
    const trend = dist > 0.5 ? 'bullish' : dist < -0.5 ? 'bearish' : 'neutral';
    map.set(candles1h[i].time, { ema: +ema.toFixed(4), trend });
  }
  return map;
}

// Binärsuche: letzter 1h-Wert ≤ t  (funktioniert für beide RSI- und EMA-Maps)
function getAtTime(map, sortedTimes, t) {
  let lo = 0, hi = sortedTimes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sortedTimes[mid] <= t) lo = mid; else hi = mid - 1;
  }
  if (!sortedTimes.length || sortedTimes[lo] > t) return null;
  return map.get(sortedTimes[lo]) ?? null;
}

// MTF-Filter (erweiterter v2):
//  - RSI-Extremwerte: SHORT@RSI≤35 und LONG@RSI≥65 blockiert (bounce/reversal risk)
//  - 1h Trend-Filter: Signal gegen 1h EMA-Trend wird blockiert
// true → Signal überspringen
function mtfSkip(direction, rsi1h, trend1h) {
  if (rsi1h === null && trend1h === null) return false;

  // RSI-Extreme blockieren
  if (rsi1h !== null) {
    if (direction === 'SHORT' && rsi1h <= 35) return true; // oversold bounce risk
    if (direction === 'LONG'  && rsi1h >= 65) return true; // overbought reversal risk
  }

  // Trend-Kontra blockieren: SHORT im bullishen Trend / LONG im bearishen Trend
  if (trend1h !== null && trend1h !== 'neutral') {
    if (direction === 'SHORT' && trend1h === 'bullish') return true;
    if (direction === 'LONG'  && trend1h === 'bearish') return true;
  }

  return false;
}

// ─── Level-Berechnung ─────────────────────────────────────────────────────────

function getRoundGrids(price) {
  if (price >= 10_000) return [1000, 2500, 5000];
  if (price >= 1_000)  return [100, 250, 500, 1000];
  if (price >= 100)    return [10, 25, 50, 100];
  if (price >= 10)     return [1, 2.5, 5, 10];
  if (price >= 1)      return [0.1, 0.25, 0.5, 1];
  return [0.01, 0.025, 0.05, 0.1];
}

function computeVWAP(candles) {
  let sumPV = 0, sumV = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    sumPV += tp * c.vol; sumV += c.vol;
  }
  return sumV > 0 ? sumPV / sumV : null;
}

function computeLevels(windowCandles, currentPrice) {
  const levels = [];
  const maxDist = currentPrice * 0.10;

  for (const g of getRoundGrids(currentPrice)) {
    const base = Math.floor(currentPrice / g) * g;
    for (let k = -4; k <= 4; k++) {
      const lvl = +(base + k * g).toPrecision(8);
      if (Math.abs(lvl - currentPrice) <= maxDist && lvl > 0)
        levels.push({ price: lvl, type: 'round_number' });
    }
  }

  const sessionHigh = Math.max(...windowCandles.map(c => c.high));
  const sessionLow  = Math.min(...windowCandles.map(c => c.low));
  levels.push({ price: sessionHigh, type: 'session_high' });
  levels.push({ price: sessionLow,  type: 'session_low'  });

  const vwap = computeVWAP(windowCandles);
  if (vwap) levels.push({ price: vwap, type: 'vwap' });

  // swing_high/swing_low deaktiviert — konsequent negative Expectancy in Tests

  return levels.filter(l => Math.abs(l.price - currentPrice) <= maxDist);
}

// ─── Pin-Bar-Analyse ──────────────────────────────────────────────────────────

function analyzePinBar(c) {
  const range   = c.high - c.low;
  if (range < 1e-10) return { wick_up: 0, wick_dn: 0 };
  const bodyTop = Math.max(c.open, c.close);
  const bodyBot = Math.min(c.open, c.close);
  return {
    wick_up: (c.high - bodyTop) / range,
    wick_dn: (bodyBot - c.low)  / range,
  };
}

// ─── Konfidenz ────────────────────────────────────────────────────────────────

function computeConf(wickRatio, levelType, priceDistPct, volMultiple) {
  let s = 40;
  s += Math.min(30, Math.round((wickRatio - 0.5) / 0.5 * 30));
  if (['session_high','session_low'].includes(levelType)) s += 10;
  if (levelType === 'vwap')         s += 7;
  if (levelType === 'round_number') s += 6;
  if (volMultiple >= 2.0) s += 12; else if (volMultiple >= 1.5) s += 7; else if (volMultiple < 0.7) s -= 5;
  s += 15; // Alter immer 0 (frische Kerze)
  if (priceDistPct <= 1.0) s += 8; else if (priceDistPct > 5.0) s -= 20;
  return Math.max(5, Math.min(95, s)) / 100;
}

// ─── TP-Berechnung — Fallback 1.0R statt 1.5R ───────────────────────────────

function computeTP(direction, entry, sl, levels, minRR) {
  const slDist    = Math.abs(entry - sl);
  const minTPDist = slDist * minRR;

  if (direction === 'SHORT') {
    const valid = levels
      .filter(l => ['session_low','round_number','vwap'].includes(l.type)
                   && (entry - l.price) >= minTPDist
                   && (entry - l.price) <= slDist * 4)
      .sort((a,b) => b.price - a.price);
    if (valid.length) return { tp: valid[0].price, rr: (entry - valid[0].price) / slDist, tp_source: valid[0].type };
    return { tp: entry - slDist * 1.0, rr: 1.0, tp_source: 'fallback_1.0R' };
  } else {
    const valid = levels
      .filter(l => ['session_high','round_number','vwap'].includes(l.type)
                   && (l.price - entry) >= minTPDist
                   && (l.price - entry) <= slDist * 4)
      .sort((a,b) => a.price - b.price);
    if (valid.length) return { tp: valid[0].price, rr: (valid[0].price - entry) / slDist, tp_source: valid[0].type };
    return { tp: entry + slDist * 1.0, rr: 1.0, tp_source: 'fallback_1.0R' };
  }
}

// ─── Exit-Simulation ──────────────────────────────────────────────────────────

function simulateExit(direction, entry, sl, tp, timeStopCandles, futureCandles) {
  for (let i = 0; i < futureCandles.length; i++) {
    const c = futureCandles[i];
    if (direction === 'SHORT') {
      if (c.high >= sl && c.low <= tp) return { reason: 'sl', price: sl, candles: i+1 };
      if (c.high >= sl)                return { reason: 'sl', price: sl, candles: i+1 };
      if (c.low  <= tp)                return { reason: 'tp', price: tp, candles: i+1 };
    } else {
      if (c.low <= sl && c.high >= tp) return { reason: 'sl', price: sl, candles: i+1 };
      if (c.low <= sl)                 return { reason: 'sl', price: sl, candles: i+1 };
      if (c.high >= tp)                return { reason: 'tp', price: tp, candles: i+1 };
    }
    if (i + 1 >= timeStopCandles) return { reason: 'time_stop', price: c.close, candles: i+1 };
  }
  return { reason: 'open', price: futureCandles[futureCandles.length - 1]?.close ?? entry, candles: futureCandles.length };
}

// ─── Hauptsimulation ─────────────────────────────────────────────────────────

function simulate(candles5m, rsiMap, emaMap, sortedTimes1h, args) {
  const WINDOW       = 100;
  const TIME_CANDLES = TIME_STOP / CANDLE_MINS;
  const trades       = [];
  const openPositions = new Set();
  let   mtfSkipped   = 0;

  for (let i = WINDOW; i < candles5m.length - 1; i++) {
    const windowCandles = candles5m.slice(i - WINDOW, i);
    const currentCandle = candles5m[i];
    const currentPrice  = currentCandle.close;
    const avgVol        = windowCandles.slice(-10).reduce((s,c) => s + c.vol, 0) / 10;
    const levels        = computeLevels(windowCandles, currentPrice);

    // 1h Kontext zum Zeitpunkt der Kerze
    const rsi1h  = args.noMtf ? null : (getAtTime(rsiMap, sortedTimes1h, currentCandle.time) ?? null);
    const ema1h  = args.noMtf ? null : (getAtTime(emaMap, sortedTimes1h, currentCandle.time) ?? null);
    const trend1h = ema1h?.trend ?? null;

    for (const level of levels) {
      const highDist = Math.abs(currentCandle.high - level.price) / level.price * 100;
      const lowDist  = Math.abs(currentCandle.low  - level.price) / level.price * 100;

      // SHORT — Resistance Rejection  (übersprungen bei --long-only)
      if (!args.longOnly && highDist <= args.approach && currentCandle.close < level.price) {
        const pb = analyzePinBar(currentCandle);
        if (pb.wick_up >= args.minWick) {
          if (openPositions.has(`SHORT_${i}`)) continue;
          const slPrc = +(currentCandle.high * 1.005).toFixed(6);
          const slPct = Math.abs(currentPrice - slPrc) / currentPrice * 100;
          if (slPct > 1.5) continue;

          const { tp, rr, tp_source } = computeTP('SHORT', currentPrice, slPrc, levels, args.minRR);
          if (rr < args.minRR) continue;

          const conf = computeConf(pb.wick_up, level.type, highDist, currentCandle.vol / avgVol);
          if (conf < args.minConf) continue;

          // MTF-Filter
          if (mtfSkip('SHORT', rsi1h, trend1h)) { mtfSkipped++; continue; }

          const future = candles5m.slice(i + 1, i + 1 + TIME_CANDLES + 5);
          const exit   = simulateExit('SHORT', currentPrice, slPrc, tp, TIME_CANDLES, future);
          const pnl    = (currentPrice - exit.price) / currentPrice * 100;

          trades.push({
            i, time: new Date(currentCandle.time).toISOString(),
            direction: 'SHORT', entry: currentPrice,
            sl: slPrc, sl_pct: +slPct.toFixed(3), tp, rr: +rr.toFixed(2), tp_source,
            level_price: level.price, level_type: level.type,
            wick_ratio: +pb.wick_up.toFixed(3),
            vol_multiple: +(currentCandle.vol / avgVol).toFixed(2),
            confidence: +conf.toFixed(3),
            rsi_1h: rsi1h, trend_1h: trend1h,
            exit_reason: exit.reason, exit_price: exit.price,
            pnl_pct: +pnl.toFixed(3), hold_mins: exit.candles * CANDLE_MINS,
            win: pnl > 0,
          });
          for (let k = i; k < Math.min(i + 24, candles5m.length); k++) openPositions.add(`SHORT_${k}`);
        }
      }

      // LONG — Support Rejection
      if (lowDist <= args.approach && currentCandle.close > level.price) {
        const pb = analyzePinBar(currentCandle);
        if (pb.wick_dn >= args.minWick) {
          if (openPositions.has(`LONG_${i}`)) continue;
          const slPrc = +(currentCandle.low * 0.995).toFixed(6);
          const slPct = Math.abs(currentPrice - slPrc) / currentPrice * 100;
          if (slPct > 1.5) continue;

          const { tp, rr, tp_source } = computeTP('LONG', currentPrice, slPrc, levels, args.minRR);
          if (rr < args.minRR) continue;

          const conf = computeConf(pb.wick_dn, level.type, lowDist, currentCandle.vol / avgVol);
          if (conf < args.minConf) continue;

          // MTF-Filter (inkl. bearish-Sperre bei --long-only)
          if (mtfSkip('LONG', rsi1h, trend1h)) { mtfSkipped++; continue; }
          if (args.longOnly && trend1h === 'bearish') { mtfSkipped++; continue; }

          const future = candles5m.slice(i + 1, i + 1 + TIME_CANDLES + 5);
          const exit   = simulateExit('LONG', currentPrice, slPrc, tp, TIME_CANDLES, future);
          const pnl    = (exit.price - currentPrice) / currentPrice * 100;

          trades.push({
            i, time: new Date(currentCandle.time).toISOString(),
            direction: 'LONG', entry: currentPrice,
            sl: slPrc, sl_pct: +slPct.toFixed(3), tp, rr: +rr.toFixed(2), tp_source,
            level_price: level.price, level_type: level.type,
            wick_ratio: +pb.wick_dn.toFixed(3),
            vol_multiple: +(currentCandle.vol / avgVol).toFixed(2),
            confidence: +conf.toFixed(3),
            rsi_1h: rsi1h, trend_1h: trend1h,
            exit_reason: exit.reason, exit_price: exit.price,
            pnl_pct: +pnl.toFixed(3), hold_mins: exit.candles * CANDLE_MINS,
            win: pnl > 0,
          });
          for (let k = i; k < Math.min(i + 24, candles5m.length); k++) openPositions.add(`LONG_${k}`);
        }
      }
    }
  }
  return { trades, mtfSkipped };
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printReport(trades, mtfSkipped, symbol, days, args) {
  if (!trades.length) { process.stdout.write('Keine Trades im Backtest.\n'); return; }

  const total      = trades.length;
  const wins       = trades.filter(t => t.win).length;
  const wr         = (wins / total * 100).toFixed(1);
  const avgPnl     = (trades.reduce((s,t) => s + t.pnl_pct, 0) / total).toFixed(3);
  const avgHold    = Math.round(trades.reduce((s,t) => s + t.hold_mins, 0) / total);
  const expectancy = trades.reduce((s,t) => s + t.pnl_pct, 0) / total;
  const mtfLabel   = args.noMtf ? 'DEAKTIVIERT' : `aktiv (${mtfSkipped} Signale geblockt)`;

  const lines = [
    '',
    '═══════════════════════════════════════════════════════════',
    `  📊 Backtest — ${symbol} — ${days} Tage — 5min Kerzen  [${args.longOnly ? 'LONG-only' : 'LONG+SHORT'}]`,
    `  Filter: Conf ≥${(args.minConf*100).toFixed(0)}%  R:R ≥${args.minRR}  SL ≤1.5%  Wick ≥${(args.minWick*100).toFixed(0)}%`,
    `  MTF 1h-RSI+Trend-Filter: ${mtfLabel}`,
    '═══════════════════════════════════════════════════════════',
    `  Trades:     ${total}`,
    `  Win-Rate:   ${wr}%  (${wins}W / ${total-wins}L)`,
    `  Ø P&L:      ${avgPnl}%`,
    `  Expectancy: ${expectancy > 0 ? '+' : ''}${expectancy.toFixed(3)}% pro Trade`,
    `  Ø Haltedauer: ${avgHold}min`,
    '',
  ];

  lines.push('  ── Nach Richtung ─────────────────────────────────────');
  for (const dir of ['SHORT', 'LONG']) {
    const dt = trades.filter(t => t.direction === dir);
    if (!dt.length) continue;
    const dw  = dt.filter(t => t.win).length;
    const exp = (dt.reduce((s,t)=>s+t.pnl_pct,0)/dt.length).toFixed(3);
    lines.push(`  ${dir.padEnd(6)} ${dt.length} Trades  WR: ${(dw/dt.length*100).toFixed(0).padStart(3)}%  Exp: ${exp}%  ØHold: ${Math.round(dt.reduce((s,t)=>s+t.hold_mins,0)/dt.length)}min`);
  }

  lines.push('', '  ── Nach Level-Typ ─────────────────────────────────────');
  const ltypes = [...new Set(trades.map(t => t.level_type))];
  for (const lt of ltypes.sort()) {
    const lt_ = trades.filter(t => t.level_type === lt);
    const lw  = lt_.filter(t => t.win).length;
    const exp = (lt_.reduce((s,t)=>s+t.pnl_pct,0)/lt_.length).toFixed(3);
    lines.push(`  ${lt.padEnd(16)} ${lt_.length} Trades  WR: ${(lw/lt_.length*100).toFixed(0).padStart(3)}%  Exp: ${exp}%`);
  }

  lines.push('', '  ── Nach 1h-Trend (EMA20) ────────────────────────────');
  for (const tr of ['bullish', 'neutral', 'bearish', null]) {
    const tt  = trades.filter(t => t.trend_1h === tr);
    if (!tt.length) continue;
    const tw  = tt.filter(t=>t.win).length;
    const exp = (tt.reduce((s,t)=>s+t.pnl_pct,0)/tt.length).toFixed(3);
    const lbl = (tr ?? 'unbekannt').padEnd(12);
    lines.push(`  ${lbl}     ${tt.length} Trades  WR: ${(tw/tt.length*100).toFixed(0).padStart(3)}%  Exp: ${exp}%`);
  }

  lines.push('', '  ── Nach 1h-RSI-Band (zum Signalzeitpunkt) ──────────');
  const rsiBands = [
    {l:'RSI < 35 (oversold)',min:0,   max:35},
    {l:'RSI 35–50',          min:35,  max:50},
    {l:'RSI 50–65',          min:50,  max:65},
    {l:'RSI > 65 (overbought)',min:65,max:101},
    {l:'RSI unbekannt',      min:-1,  max:-1},
  ];
  for (const b of rsiBands) {
    const bt = b.min === -1
      ? trades.filter(t => t.rsi_1h === null)
      : trades.filter(t => t.rsi_1h !== null && t.rsi_1h >= b.min && t.rsi_1h < b.max);
    if (!bt.length) continue;
    const bw  = bt.filter(t=>t.win).length;
    const exp = (bt.reduce((s,t)=>s+t.pnl_pct,0)/bt.length).toFixed(3);
    lines.push(`  ${b.l.padEnd(26)} ${bt.length} Trades  WR: ${(bw/bt.length*100).toFixed(0).padStart(3)}%  Exp: ${exp}%`);
  }

  lines.push('', '  ── Nach Konfidenz-Band ─────────────────────────────────');
  const confBands = [{l:'65–70%',min:0.65,max:0.70},{l:'70–78%',min:0.70,max:0.78},{l:'78–87%',min:0.78,max:0.87},{l:'87%+',min:0.87,max:1.01}];
  for (const b of confBands) {
    const bt = trades.filter(t => t.confidence >= b.min && t.confidence < b.max);
    if (!bt.length) continue;
    const bw  = bt.filter(t=>t.win).length;
    const exp = (bt.reduce((s,t)=>s+t.pnl_pct,0)/bt.length).toFixed(3);
    lines.push(`  ${b.l.padEnd(10)} ${bt.length} Trades  WR: ${(bw/bt.length*100).toFixed(0).padStart(3)}%  Exp: ${exp}%`);
  }

  lines.push('', '  ── Nach Exit-Grund ─────────────────────────────────────');
  for (const r of ['tp', 'sl', 'time_stop', 'open']) {
    const rt  = trades.filter(t => t.exit_reason === r);
    if (!rt.length) continue;
    const rw  = rt.filter(t=>t.win).length;
    const exp = (rt.reduce((s,t)=>s+t.pnl_pct,0)/rt.length).toFixed(3);
    lines.push(`  ${r.padEnd(12)} ${rt.length} Trades  WR: ${(rw/rt.length*100).toFixed(0).padStart(3)}%  Exp: ${exp}%`);
  }

  lines.push('', '  ── Nach TP-Quelle ────────────────────────────────────');
  const tpSources = [...new Set(trades.map(t => t.tp_source))];
  for (const ts of tpSources.sort()) {
    const tt  = trades.filter(t => t.tp_source === ts);
    const tw  = tt.filter(t=>t.win).length;
    const exp = (tt.reduce((s,t)=>s+t.pnl_pct,0)/tt.length).toFixed(3);
    lines.push(`  ${ts.padEnd(20)} ${tt.length} Trades  WR: ${(tw/tt.length*100).toFixed(0).padStart(3)}%  Exp: ${exp}%`);
  }

  lines.push('═══════════════════════════════════════════════════════════', '');
  process.stdout.write(lines.join('\n') + '\n');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function run(argv) {
  const args = parseArgs(argv);

  // 5min-Kerzen: Backtest-Zeitraum
  const candles5m = await fetchHistorical(args.symbol, '5m', args.days * 24 * 60 / CANDLE_MINS, args.symbol);

  // 1h-Kerzen: Zeitraum + 3 Tage extra für RSI/EMA-Warmup
  let rsiMap = new Map();
  let emaMap = new Map();
  let sortedTimes1h = [];
  if (!args.noMtf) {
    const candles1h = await fetchHistorical(args.symbol, '1h', (args.days + 3) * 24, `${args.symbol} 1h MTF`);
    rsiMap = buildRollingRSI(candles1h, 14);
    emaMap = buildRollingEMA(candles1h, 20);
    // Vereinigte sortedTimes: alle Zeitpunkte wo RSI vorhanden (EMA hat frühere Daten)
    sortedTimes1h = candles1h.map(c => c.time).filter(t => rsiMap.has(t) || emaMap.has(t));
    process.stderr.write(`1h RSI: ${rsiMap.size} Kerzen  EMA20: ${emaMap.size} Kerzen (${args.symbol})\n`);
  }

  process.stderr.write(`Simulation über ${candles5m.length} Kerzen...\n`);

  const { trades, mtfSkipped } = simulate(candles5m, rsiMap, emaMap, sortedTimes1h, args);
  printReport(trades, mtfSkipped, args.symbol, args.days, args);

  if (args.outFile) {
    writeFileSync(args.outFile, trades.map(t => JSON.stringify(t)).join('\n') + '\n', 'utf8');
    process.stderr.write(`Trades geschrieben: ${args.outFile}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv).catch(e => {
    process.stderr.write(JSON.stringify({ error: 'backtest_crash', detail: e.message }) + '\n');
    process.exit(1);
  });
}
