#!/usr/bin/env node
/**
 * macro_signal.mjs — Crypto Makro-Trade Signal Analyzer
 *
 * Analysiert BTC + ETH auf Basis von:
 *   1. Market Regime  : BTC EMA200(daily) + BTC RSI Weekly  → Era-Context
 *   2. RSI-Stack      : Daily / Weekly / Monthly             → Alignment-Check
 *   3. MACD Daily     : Impuls-Richtung
 *   4. Funding Rate   : Positioning-Squeeze-Potenzial
 *
 * Prinzip: Regime-first.
 *   Kein LONG in Bear-Regime (RSI daily noch so tief).
 *   Kein SHORT in Bull-Regime (RSI daily noch so hoch).
 *   RSI-Stack muss aligned sein: Alle drei Timeframes zeigen in dieselbe Richtung.
 *
 * Score 8–10 → Trade (SL/TP aus Lookup)
 * Score 6–7  → Watchlist
 * Score < 6  → kein Signal
 *
 * Usage:
 *   node macro_signal.mjs
 *   node macro_signal.mjs --symbols ETH,BTC
 *   node macro_signal.mjs --quiet
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath }                           from 'url';
import { dirname, join, resolve } from 'path';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const BITUNIX_BASE = 'https://fapi.bitunix.com';
const TIMEOUT_MS   = 15_000;
const OUT_PATH     = join(TRADING_DIR, 'cache', 'macro_signals.json');
const POS_PATH     = join(TRADING_DIR, 'cache', 'positioning_data.json');

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  function get(f, d) { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : d; }
  return {
    symbols: get('--symbols', 'BTC,ETH').split(',').map(s => s.trim().toUpperCase()),
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

// Fear & Greed Index (alternative.me) — contrarian sentiment indicator
// Returns { value: 0-100, classification: string } or null on failure.
async function fetchFearGreed() {
  try {
    const d = await fetchJson('https://api.alternative.me/fng/?limit=1');
    const v = parseInt(d?.data?.[0]?.value, 10);
    if (!Number.isFinite(v)) return null;
    const classification = v < 20 ? 'Extreme Fear'
                         : v < 40 ? 'Fear'
                         : v < 60 ? 'Neutral'
                         : v < 80 ? 'Greed'
                         :          'Extreme Greed';
    return { value: v, classification };
  } catch {
    return null;  // non-fatal: run continues without FNG
  }
}

// ─── Kerzen fetchen (rückwärts-Paginierung für große Mengen) ─────────────────

async function fetchCandles(symbol, interval, total) {
  const all = [];
  let endTime = Date.now();

  while (all.length < total) {
    const need = Math.min(200, total - all.length);
    const url  = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${symbol}USDT` +
                 `&interval=${interval}&limit=${need}&type=LAST_PRICE&endTime=${endTime}`;
    const d = await fetchJson(url);
    if (!d.data?.length) break;

    const batch = d.data
      .map(k => ({
        time:  parseInt(k.time),
        close: parseFloat(k.close),
        high:  parseFloat(k.high),
        low:   parseFloat(k.low),
      }))
      .sort((a, b) => a.time - b.time);

    all.unshift(...batch);
    endTime = batch[0].time - 1;
    if (batch.length < need) break;
  }

  return all.sort((a, b) => a.time - b.time).slice(-total);
}

// ─── Indikatoren ──────────────────────────────────────────────────────────────

// Wilder RSI — identisch zur scan-Pipeline
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d,  0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);
}

// EMA als Serie (für MACD benötigt)
function buildEMASeries(closes, period) {
  if (closes.length < period) return [];
  const k   = 2 / (period + 1);
  const out = new Array(period - 1).fill(null);
  let   ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

// EMA-Einzelwert (für EMA200/EMA50 Regime-Check)
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return +ema.toFixed(4);
}

// MACD (12/26/9) — gibt { hist, bullish } zurück
function calcMACD(closes) {
  const fast = 12, slow = 26, sig = 9;
  if (closes.length < slow + sig) return null;

  const ef = buildEMASeries(closes, fast);
  const es = buildEMASeries(closes, slow);

  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (ef[i] != null && es[i] != null) macdLine.push(ef[i] - es[i]);
  }
  if (macdLine.length < sig) return null;

  const kg  = 2 / (sig + 1);
  let signal = macdLine.slice(0, sig).reduce((a, b) => a + b, 0) / sig;
  for (let i = sig; i < macdLine.length; i++) signal = macdLine[i] * kg + signal * (1 - kg);

  const hist = macdLine[macdLine.length - 1] - signal;
  return { hist: +hist.toFixed(6), bullish: hist > 0 };
}

// ─── Market Regime (BTC-basiert) ──────────────────────────────────────────────
// Bull  = BTC über EMA200 UND Weekly RSI ≥ 45
// Bear  = BTC unter EMA200 UND Weekly RSI ≤ 45
// Neutral = Mischsignal

function determineRegime(btcClose, btcEMA200, btcRSIWeekly) {
  const aboveEMA = btcClose > btcEMA200;
  const weekBull = btcRSIWeekly >= 45;
  if (aboveEMA && weekBull)    return 'bull';
  if (!aboveEMA && !weekBull)  return 'bear';
  return 'neutral';
}

// ─── Score LONG ───────────────────────────────────────────────────────────────
// Max 10 Punkte:
//   Regime  2P  |  RSI Daily 3P  |  RSI Weekly 2P  |  RSI Monthly 1P
//   MACD    1P  |  Funding   1P

function scoreLong(regime, rsiD, rsiW, rsiM, macd, funding, fng) {
  const cond   = [];
  const blocks = [];
  let   score  = 0;
  let   extremeFear = false;

  // 1. Regime (2P max)
  if (regime === 'bear') {
    blocks.push('regime=BEAR → hard cap 3 (6 if Extreme Fear)');
  } else if (regime === 'bull') {
    score += 2; cond.push('regime=bull +2');
  }
  // neutral → 0

  // 2. RSI Daily (3P max) — hard block > 60
  if (rsiD !== null) {
    if (rsiD > 60) {
      blocks.push(`RSI D:${rsiD} >60 → LONG blockiert`);
    } else if (rsiD <= 25) {
      score += 3; cond.push(`RSI D:${rsiD} ≤25 +3`);
    } else if (rsiD <= 35) {
      score += 2; cond.push(`RSI D:${rsiD} ≤35 +2`);
    } else if (rsiD <= 45) {
      score += 1; cond.push(`RSI D:${rsiD} ≤45 +1`);
    }
  }

  // 3. RSI Weekly (2P max) — hard block > 65
  if (rsiW !== null) {
    if (rsiW > 65) {
      blocks.push(`RSI W:${rsiW} >65 → LONG blockiert`);
    } else if (rsiW <= 40) {
      score += 2; cond.push(`RSI W:${rsiW} ≤40 +2`);
    } else if (rsiW <= 55) {
      score += 1; cond.push(`RSI W:${rsiW} ≤55 +1`);
    }
  }

  // 4. RSI Monthly (1P / Penalty)
  if (rsiM !== null) {
    if (rsiM <= 45) {
      score += 1; cond.push(`RSI M:${rsiM} ≤45 +1`);
    } else if (rsiM > 70) {
      score -= 2; cond.push(`RSI M:${rsiM} >70 -2 (era überdehnt)`);
    } else if (rsiM > 60) {
      score -= 1; cond.push(`RSI M:${rsiM} >60 -1 (era gestreckt)`);
    }
  }

  // 5. MACD Daily (1P)
  if (macd?.bullish) {
    score += 1; cond.push('MACD bullish +1');
  }

  // 6. Funding Rate (1P / Penalty)
  if (funding !== null) {
    if (funding <= -0.0001) {
      score += 1; cond.push(`Funding ${(funding * 100).toFixed(4)}% ≤-0.01% +1`);
    } else if (funding >= 0.0005) {
      score -= 1; cond.push(`Funding ${(funding * 100).toFixed(4)}% ≥+0.05% -1`);
    }
  }

  // 7. Fear & Greed Index (contrarian — Extreme Fear = LONG opportunity; Extreme Greed = hard block)
  if (fng !== null) {
    if (fng >= 80) {
      blocks.push(`F&G:${fng} (Extreme Greed) → LONG blockiert`);
    } else if (fng < 20) {
      score += 3; cond.push(`F&G:${fng} (Extreme Fear) +3`);
      extremeFear = true;
    } else if (fng < 40) {
      score += 2; cond.push(`F&G:${fng} (Fear) +2`);
    } else if (fng >= 60) {
      score -= 1; cond.push(`F&G:${fng} (Greed) -1`);
    }
  }

  // Hard blocks überschreiben; BEAR cap raised to 6 in Extreme Fear (contrarian dip)
  const hardBlock = blocks.some(b => b.includes('blockiert'));
  if (hardBlock)              score = 0;
  else if (regime === 'bear') score = Math.min(score, extremeFear ? 6 : 3);

  return { score: Math.max(0, Math.min(10, score)), cond, blocks };
}

// ─── Score SHORT ──────────────────────────────────────────────────────────────

function scoreShort(regime, rsiD, rsiW, rsiM, macd, funding, fng) {
  const cond   = [];
  const blocks = [];
  let   score  = 0;

  // 1. Regime (2P max)
  if (regime === 'bull') {
    blocks.push('regime=BULL → hard cap 3');
  } else if (regime === 'bear') {
    score += 2; cond.push('regime=bear +2');
  }

  // 2. RSI Daily (3P max) — hard block < 40
  if (rsiD !== null) {
    if (rsiD < 40) {
      blocks.push(`RSI D:${rsiD} <40 → SHORT blockiert`);
    } else if (rsiD >= 75) {
      score += 3; cond.push(`RSI D:${rsiD} ≥75 +3`);
    } else if (rsiD >= 65) {
      score += 2; cond.push(`RSI D:${rsiD} ≥65 +2`);
    } else if (rsiD >= 55) {
      score += 1; cond.push(`RSI D:${rsiD} ≥55 +1`);
    }
  }

  // 3. RSI Weekly (2P max) — hard block < 40
  if (rsiW !== null) {
    if (rsiW < 40) {
      blocks.push(`RSI W:${rsiW} <40 → SHORT blockiert`);
    } else if (rsiW >= 60) {
      score += 2; cond.push(`RSI W:${rsiW} ≥60 +2`);
    } else if (rsiW >= 50) {
      score += 1; cond.push(`RSI W:${rsiW} ≥50 +1`);
    }
  }

  // 4. RSI Monthly (1P / Penalty)
  if (rsiM !== null) {
    if (rsiM >= 60) {
      score += 1; cond.push(`RSI M:${rsiM} ≥60 +1`);
    } else if (rsiM < 40) {
      score -= 2; cond.push(`RSI M:${rsiM} <40 -2 (era unterverkauft)`);
    } else if (rsiM < 50) {
      score -= 1; cond.push(`RSI M:${rsiM} <50 -1 (era schwach)`);
    }
  }

  // 5. MACD Daily (1P)
  if (macd !== null && !macd.bullish) {
    score += 1; cond.push('MACD bearish +1');
  }

  // 6. Funding Rate (1P / Penalty)
  if (funding !== null) {
    if (funding >= 0.0005) {
      score += 1; cond.push(`Funding ${(funding * 100).toFixed(4)}% ≥+0.05% +1`);
    } else if (funding <= -0.0001) {
      score -= 1; cond.push(`Funding ${(funding * 100).toFixed(4)}% ≤-0.01% -1`);
    }
  }

  // 7. Fear & Greed Index (contrarian — Extreme Greed = SHORT opportunity; Extreme Fear = risky to short)
  if (fng !== null) {
    if (fng < 20) {
      score -= 2; cond.push(`F&G:${fng} (Extreme Fear) -2 (shorting at bottom risky)`);
    } else if (fng >= 80) {
      score += 2; cond.push(`F&G:${fng} (Extreme Greed) +2`);
    } else if (fng >= 60) {
      score += 1; cond.push(`F&G:${fng} (Greed) +1`);
    }
  }

  const hardBlock = blocks.some(b => b.includes('blockiert'));
  if (hardBlock)              score = 0;
  else if (regime === 'bull') score = Math.min(score, 3);

  return { score: Math.max(0, Math.min(10, score)), cond, blocks };
}

// ─── Trade-Parameter (aus Score) ──────────────────────────────────────────────

function tradeParams(score) {
  if (score >= 10) return { action: 'TRADE', sl_pct: 4, tp_pct: 20, rr: 5.0, hold_days: '3–7' };
  if (score >= 9)  return { action: 'TRADE', sl_pct: 5, tp_pct: 20, rr: 4.0, hold_days: '2–5' };
  if (score >= 8)  return { action: 'TRADE', sl_pct: 6, tp_pct: 18, rr: 3.0, hold_days: '1–4' };
  if (score >= 6)  return { action: 'WATCHLIST', sl_pct: 5, tp_pct: 10, rr: 2.0, hold_days: '1–3' };
  return { action: 'NO_SIGNAL' };
}

// ─── Symbol analysieren ───────────────────────────────────────────────────────

async function analyzeSymbol(symbol, positioning) {
  // Parallel: daily (230 = EMA200 + RSI14 + MACD26+9), weekly (70 = RSI14), monthly (26 = RSI14)
  const [daily, weekly, monthly] = await Promise.all([
    fetchCandles(symbol, '1d', 230),
    fetchCandles(symbol, '1w', 70),
    fetchCandles(symbol, '1M', 26).catch(() => []),  // monatlich fail-soft
  ]);

  const dc = daily.map(c => c.close);
  const wc = weekly.map(c => c.close);
  const mc = monthly.map(c => c.close);

  return {
    symbol,
    close:      dc[dc.length - 1] ?? null,
    ema200:     calcEMA(dc, 200),
    ema50:      calcEMA(dc, 50),
    rsiDaily:   calcRSI(dc),
    rsiWeekly:  calcRSI(wc),
    rsiMonthly: mc.length >= 15 ? calcRSI(mc) : null,
    macd:       calcMACD(dc),
    funding:    positioning?.[symbol]?.funding_rate ?? null,
    candles:    { daily: daily.length, weekly: weekly.length, monthly: monthly.length },
  };
}

// ─── Report ausgeben ──────────────────────────────────────────────────────────

function printReport(result) {
  const reg  = result.regime;
  const icon = reg === 'bull' ? '🟢' : reg === 'bear' ? '🔴' : '🟡';
  const btc  = result.btc;

  const fng    = result.fear_greed;
  const fngStr = fng ? `${fng.value} — ${fng.classification}` : '—';

  const lines = [
    '',
    '═══════════════════════════════════════════════════════════',
    `  📊 Crypto Makro-Signal — ${new Date().toISOString().slice(0, 16)} UTC`,
    '═══════════════════════════════════════════════════════════',
    `  ${icon} Market Regime: ${reg.toUpperCase()}`,
    `  Fear & Greed: ${fngStr}`,
    `  BTC: $${btc.close?.toLocaleString('en')}  EMA200: $${btc.ema200?.toLocaleString('en')}  EMA50: $${btc.ema50?.toLocaleString('en')}`,
    `  BTC RSI D:${btc.rsiDaily}  W:${btc.rsiWeekly}  M:${btc.rsiMonthly ?? '—'}`,
    `  BTC MACD: ${btc.macd?.bullish ? 'bullish' : 'bearish'} (${btc.macd?.hist})`,
    '',
  ];

  for (const sig of result.signals) {
    const aIcon = sig.action === 'TRADE'     ? '🔴 TRADE'
                : sig.action === 'WATCHLIST' ? '👁  WATCHLIST'
                :                              '⬜ NO SIGNAL';
    const dirIcon = sig.best_direction === 'LONG' ? '📈' : '📉';

    lines.push(`  ── ${sig.symbol} ─────────────────────────────────────────────`);
    lines.push(`  ${aIcon}  ${dirIcon} ${sig.best_direction}  Score: ${sig.best_score}/10`);
    lines.push(`  Kurs: $${sig.close?.toLocaleString('en')}  EMA50: $${sig.ema50?.toLocaleString('en')}  EMA200: $${sig.ema200?.toLocaleString('en')}`);
    lines.push(`  RSI D:${sig.rsi_daily}  W:${sig.rsi_weekly}  M:${sig.rsi_monthly ?? '—'}`);
    lines.push(`  MACD: ${sig.macd_bullish ? 'bullish' : 'bearish'} (${sig.macd_hist})` +
               `  Funding: ${sig.funding != null ? (sig.funding * 100).toFixed(4) + '%' : '—'}`);
    lines.push(`  LONG ${sig.long_score}/10  |  SHORT ${sig.short_score}/10`);

    if (sig.action !== 'NO_SIGNAL') {
      lines.push(`  → SL: ${sig.sl_pct}%  TP: ${sig.tp_pct}%  R:R ${sig.rr}  Haltezeit: ${sig.hold_days} Tage`);
    }

    const bestCond   = sig.best_direction === 'LONG' ? sig.long_cond   : sig.short_cond;
    const bestBlocks = sig.best_direction === 'LONG' ? sig.long_blocks : sig.short_blocks;
    if (bestCond.length)   lines.push(`  ✅ ${bestCond.join(' · ')}`);
    if (bestBlocks.length) lines.push(`  ⛔ ${bestBlocks.join(' · ')}`);
    lines.push('');
  }

  lines.push('═══════════════════════════════════════════════════════════', '');
  process.stdout.write(lines.join('\n') + '\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(argv) {
  const args = parseArgs(argv);
  const pos  = existsSync(POS_PATH) ? JSON.parse(readFileSync(POS_PATH, 'utf8')) : {};

  if (!args.quiet) process.stderr.write(`Makro-Signal: ${args.symbols.join(', ')} — fetching...\n`);

  // Fear & Greed Index (parallel, fail-soft)
  if (!args.quiet) process.stderr.write('  Fear & Greed: fetching...\n');
  const fngRaw = await fetchFearGreed();
  if (!args.quiet) {
    const fngLabel = fngRaw ? `${fngRaw.value} (${fngRaw.classification})` : 'unavailable';
    process.stderr.write(`  Fear & Greed: ${fngLabel}\n`);
  }
  const fng = fngRaw?.value ?? null;

  // BTC immer fetchen (Regime-Anker), auch wenn nicht in --symbols
  const fetchSet = [...new Set(['BTC', ...args.symbols])];
  const raw = {};
  for (const sym of fetchSet) {
    if (!args.quiet) process.stderr.write(`  ${sym}: daily/weekly/monthly...\n`);
    raw[sym] = await analyzeSymbol(sym, pos);
  }

  // Regime aus BTC
  const btcRaw = raw['BTC'];
  const regime = determineRegime(btcRaw.close, btcRaw.ema200, btcRaw.rsiWeekly);

  // Signale
  const signals = args.symbols.map(sym => {
    const d = raw[sym];
    const ls = scoreLong( regime, d.rsiDaily, d.rsiWeekly, d.rsiMonthly, d.macd, d.funding, fng);
    const ss = scoreShort(regime, d.rsiDaily, d.rsiWeekly, d.rsiMonthly, d.macd, d.funding, fng);

    const bestDir   = ls.score >= ss.score ? 'LONG' : 'SHORT';
    const bestScore = Math.max(ls.score, ss.score);
    const params    = tradeParams(bestScore);

    return {
      symbol:         sym,
      close:          d.close,
      ema50:          d.ema50,
      ema200:         d.ema200,
      rsi_daily:      d.rsiDaily,
      rsi_weekly:     d.rsiWeekly,
      rsi_monthly:    d.rsiMonthly,
      macd_bullish:   d.macd?.bullish ?? null,
      macd_hist:      d.macd?.hist    ?? null,
      funding:        d.funding,
      regime,
      long_score:     ls.score,
      short_score:    ss.score,
      best_direction: bestDir,
      best_score:     bestScore,
      long_cond:      ls.cond,
      long_blocks:    ls.blocks,
      short_cond:     ss.cond,
      short_blocks:   ss.blocks,
      ...params,
      analyzed_at: new Date().toISOString(),
    };
  });

  const result = {
    regime,
    fear_greed: fngRaw,
    btc: {
      close:      btcRaw.close,
      ema200:     btcRaw.ema200,
      ema50:      btcRaw.ema50,
      rsiDaily:   btcRaw.rsiDaily,
      rsiWeekly:  btcRaw.rsiWeekly,
      rsiMonthly: btcRaw.rsiMonthly,
      macd:       btcRaw.macd,
    },
    signals,
    generated_at: new Date().toISOString(),
  };

  writeFileSync(OUT_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');

  if (!args.quiet) printReport(result);
  else process.stdout.write(JSON.stringify({ ok: true, regime, signals: signals.map(s => ({ symbol: s.symbol, direction: s.best_direction, score: s.best_score, action: s.action })) }) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv).catch(e => {
    process.stderr.write(JSON.stringify({ error: 'macro_crash', detail: e.message }) + '\n');
    process.exit(1);
  });
}
