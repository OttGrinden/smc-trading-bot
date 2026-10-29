#!/usr/bin/env node
/**
 * rejection_detector.mjs — Erkennt Level-Ablehnungen auf 5min-Kerzen
 *
 * Ein "Rejection" liegt vor, wenn:
 *  - Resistance: Kerzen-High nähert sich Level (≤ approach_pct), schließt aber darunter
 *    mit dominantem oberem Docht (wick_ratio ≥ 0.50) → SHORT-Signal
 *  - Support: Kerzen-Low nähert sich Level, schließt darüber
 *    mit dominantem unterem Docht → LONG-Signal
 *
 * Output:
 *  - actionable: Rejection < 3 Kerzen alt UND Preis noch <3% von Level entfernt
 *  - recent: Rejection 3–8 Kerzen alt (zur Information, Einstieg oft verspätet)
 *  - stale: älter als 8 Kerzen (zu alt für Intraday-Einstieg)
 *
 * Usage:
 *   node rejection_detector.mjs                        # alle Symbole aus Cache
 *   node rejection_detector.mjs --symbols BTC,SNDK     # nur diese Symbole
 *   node rejection_detector.mjs --min-confidence 0.55  # Mindest-Konfidenz (Standard: 0.45)
 *   node rejection_detector.mjs --all-signals           # auch stale Signale anzeigen
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath }                           from 'url';
import { dirname, join, resolve } from 'path';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const LEVELS_PATH  = join(TRADING_DIR, 'cache', 'intraday_levels.json');
const CACHE_PATH   = join(TRADING_DIR, 'cache', 'intraday_cache.json');
const SIGNALS_PATH = join(TRADING_DIR, 'cache', 'intraday_signals.json');
const MTF_PATH     = join(TRADING_DIR, 'cache', 'mtf_context.json');

const APPROACH_PCT = 0.8;   // wie nah muss die Kerze ans Level kommen (%)
const MIN_WICK     = 0.50;  // minimale Wick-Ratio für Pin-Bar
const WINDOW       = 8;     // Kerzen-Rückblick (8 × 5min = 40min)

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const symIdx  = argv.indexOf('--symbols');
  const confIdx = argv.indexOf('--min-confidence');
  return {
    symbols:       symIdx  !== -1 ? argv[symIdx  + 1]?.split(',').map(s => s.trim().toUpperCase()) : null,
    minConf:       confIdx !== -1 ? parseFloat(argv[confIdx + 1]) : 0.45,
    allSignals:    argv.includes('--all-signals'),
    quiet:         argv.includes('--quiet'),
    json:          argv.includes('--json'),
  };
}

// ─── Pin-Bar-Analyse ──────────────────────────────────────────────────────────

function analyzePinBar(candle) {
  const { open, high, low, close } = candle;
  const range     = high - low;
  if (range < 1e-10) return { wick_up: 0, wick_dn: 0, body: 0, range: 0 };
  const bodyTop    = Math.max(open, close);
  const bodyBot    = Math.min(open, close);
  const wickUp     = high - bodyTop;
  const wickDn     = bodyBot - low;
  const body       = bodyTop - bodyBot;
  return {
    wick_up:    +(wickUp / range).toFixed(4),
    wick_dn:    +(wickDn / range).toFixed(4),
    body_ratio: +(body   / range).toFixed(4),
    range,
  };
}

// ─── Durchschnittliches Volumen der letzten N Kerzen ─────────────────────────

function avgVolume(candles, n = 10) {
  const slice = candles.slice(-n);
  return slice.reduce((s, c) => s + c.vol, 0) / slice.length;
}

// ─── Nächstes TP-Level bestimmen ─────────────────────────────────────────────

function findTP(levels, currentPrice, direction) {
  if (direction === 'SHORT') {
    // Nächste Support-Level unterhalb des aktuellen Preises (mindestens 0.5% entfernt)
    const supports = levels
      .filter(l => l.direction === 'support' && l.price < currentPrice * 0.995)
      .sort((a, b) => b.price - a.price); // nächstes zuerst
    return supports[0] || null;
  } else {
    // Nächste Resistance oberhalb des aktuellen Preises
    const resists = levels
      .filter(l => l.direction === 'resistance' && l.price > currentPrice * 1.005)
      .sort((a, b) => a.price - b.price);
    return resists[0] || null;
  }
}

// ─── Konfidenz berechnen ─────────────────────────────────────────────────────

function computeConfidence({ wickRatio, levelTypes, ageCandels, priceDistPct, volMultiple }) {
  let score = 40;

  // Wick-Qualität (50%–100% → +0 bis +30)
  score += Math.min(30, Math.round((wickRatio - MIN_WICK) / (1 - MIN_WICK) * 30));

  // Level-Wichtigkeit
  if (levelTypes.includes('session_high') || levelTypes.includes('session_low'))   score += 10;
  if (levelTypes.includes('24h_high')     || levelTypes.includes('24h_low'))       score += 8;
  if (levelTypes.includes('vwap'))                                                  score += 7;
  if (levelTypes.includes('round_number'))                                          score += 6;
  if (levelTypes.includes('swing_high')   || levelTypes.includes('swing_low'))     score += 5;
  if (levelTypes.length > 1)                                                        score += 8; // cluster

  // Volumen-Bestätigung
  if (volMultiple >= 2.0) score += 12;
  else if (volMultiple >= 1.5) score += 7;
  else if (volMultiple < 0.7)  score -= 5;

  // Aktualität
  if (ageCandels <= 1)      score += 15;
  else if (ageCandels <= 2) score += 10;
  else if (ageCandels <= 4) score += 3;
  else if (ageCandels >= 7) score -= 15;

  // Preis-Distanz zur Level nach Rejection
  if (priceDistPct <= 1.0)      score += 8;
  else if (priceDistPct <= 2.5) score += 2;
  else if (priceDistPct <= 5.0) score -= 5;
  else                          score -= 20;

  return +(Math.max(5, Math.min(95, score)) / 100).toFixed(3);
}

// ─── Resistance-Rejection erkennen (SHORT) ───────────────────────────────────

function detectResistanceRejection(candles, level, currentPrice, levels) {
  const signals = [];
  const avgVol  = avgVolume(candles, 10);

  for (let i = candles.length - WINDOW; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;

    // High nähert sich dem Level
    const highDist = Math.abs(c.high - level.price) / level.price * 100;
    if (highDist > APPROACH_PCT) continue;

    // Schlusskurs unterhalb des Levels
    if (c.close >= level.price) continue;

    // Pin-Bar-Analyse
    const pb = analyzePinBar(c);
    if (pb.wick_up < MIN_WICK) continue;

    const ageCandels     = candles.length - 1 - i;
    const priceDistPct   = Math.abs(currentPrice - level.price) / level.price * 100;
    const volMultiple    = avgVol > 0 ? c.vol / avgVol : 1;
    const levelTypes     = [level.type, ...(level.also || [])];
    const confidence     = computeConfidence({ wickRatio: pb.wick_up, levelTypes, ageCandels, priceDistPct, volMultiple });

    const slPrice = +(c.high * 1.005).toFixed(6);
    const slPct   = +((slPrice - currentPrice) / currentPrice * 100).toFixed(2);
    const tp      = findTP(levels, currentPrice, 'SHORT');

    const status  = ageCandels <= 2 && priceDistPct <= 3.0 ? 'actionable'
                  : ageCandels <= 8                         ? 'recent'
                  : 'stale';

    signals.push({
      symbol:            null, // filled later
      direction:         'SHORT',
      level_price:       level.price,
      level_type:        level.type,
      level_also:        level.also || [],
      rejection_candle:  { open: c.open, high: c.high, low: c.low, close: c.close, vol: c.vol, time: c.time },
      rejection_time:    c.time,
      age_candles:       ageCandels,
      age_mins:          ageCandels * 5,
      wick_ratio:        pb.wick_up,
      vol_multiple:      +volMultiple.toFixed(2),
      entry:             +currentPrice.toFixed(6),
      sl:                slPrice,
      sl_pct:            slPct,
      tp1:               tp ? +tp.price.toFixed(6) : null,
      tp1_pct:           tp ? +((currentPrice - tp.price) / currentPrice * 100).toFixed(2) : null,
      price_dist_pct:    +priceDistPct.toFixed(3),
      confidence,
      status,
    });
  }
  // Beste Rejection pro Level zurückgeben (höchster Confidence)
  return signals.sort((a, b) => b.confidence - a.confidence).slice(0, 1);
}

// ─── Support-Rejection erkennen (LONG) ───────────────────────────────────────

function detectSupportRejection(candles, level, currentPrice, levels) {
  const signals = [];
  const avgVol  = avgVolume(candles, 10);

  for (let i = candles.length - WINDOW; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;

    // Low nähert sich dem Level
    const lowDist = Math.abs(c.low - level.price) / level.price * 100;
    if (lowDist > APPROACH_PCT) continue;

    // Schlusskurs oberhalb des Levels
    if (c.close <= level.price) continue;

    // Pin-Bar (unterer Docht dominiert)
    const pb = analyzePinBar(c);
    if (pb.wick_dn < MIN_WICK) continue;

    const ageCandels   = candles.length - 1 - i;
    const priceDistPct = Math.abs(currentPrice - level.price) / level.price * 100;
    const volMultiple  = avgVol > 0 ? c.vol / avgVol : 1;
    const levelTypes   = [level.type, ...(level.also || [])];
    const confidence   = computeConfidence({ wickRatio: pb.wick_dn, levelTypes, ageCandels, priceDistPct, volMultiple });

    const slPrice = +(c.low * 0.995).toFixed(6);
    const slPct   = +((currentPrice - slPrice) / currentPrice * 100).toFixed(2);
    const tp      = findTP(levels, currentPrice, 'LONG');

    const status  = ageCandels <= 2 && priceDistPct <= 3.0 ? 'actionable'
                  : ageCandels <= 8                         ? 'recent'
                  : 'stale';

    signals.push({
      symbol:            null,
      direction:         'LONG',
      level_price:       level.price,
      level_type:        level.type,
      level_also:        level.also || [],
      rejection_candle:  { open: c.open, high: c.high, low: c.low, close: c.close, vol: c.vol, time: c.time },
      rejection_time:    c.time,
      age_candles:       ageCandels,
      age_mins:          ageCandels * 5,
      wick_ratio:        pb.wick_dn,
      vol_multiple:      +volMultiple.toFixed(2),
      entry:             +currentPrice.toFixed(6),
      sl:                slPrice,
      sl_pct:            slPct,
      tp1:               tp ? +tp.price.toFixed(6) : null,
      tp1_pct:           tp ? +((tp.price - currentPrice) / currentPrice * 100).toFixed(2) : null,
      price_dist_pct:    +priceDistPct.toFixed(3),
      confidence,
      status,
    });
  }
  return signals.sort((a, b) => b.confidence - a.confidence).slice(0, 1);
}

// ─── MTF-Kontext laden (fail-soft) ───────────────────────────────────────────

function loadMTFContext() {
  try {
    if (!existsSync(MTF_PATH)) return null;
    const d        = JSON.parse(readFileSync(MTF_PATH, 'utf8'));
    const ageMins  = (Date.now() - new Date(d.computed_at).getTime()) / 60_000;
    if (ageMins > 15) return null; // zu alt → nicht verwenden
    return d;
  } catch { return null; }
}

// ─── MTF-Konfidenz-Anpassung ─────────────────────────────────────────────────
// Gibt { adjustment (int, Punkte auf 0–100-Skala), mtf_detail } zurück

function applyMTFAdjustment(signal, mtfData) {
  if (!mtfData) return { adjustment: 0, mtf: null };

  const symCtx = mtfData.symbols?.[signal.symbol];
  const btcCtx = mtfData.btc_trend;
  const dir    = signal.direction;
  let   adj    = 0;
  const detail = {};

  // Kein Symbol-MTF vorhanden → Konfidenz nach oben deckeln (-12 Punkte)
  // verhindert "blindes" Vertrauen in 5min-Signal ohne höherer Zeitebene
  if (!symCtx) {
    adj -= 12;
    detail.missing_sym_ctx = 'symbol MTF unavailable→-12 (no 15m/1h data)';
  }

  // ── 1h RSI: stärkste Einzelregel ─────────────────────────────────────────
  // SHORT in überverkauftem 1h → starke Strafe (Bounce-Risiko!)
  // LONG in überkauftem 1h → starke Strafe
  if (symCtx?.rsi_1h != null) {
    const r = symCtx.rsi_1h;
    if (dir === 'SHORT') {
      if      (r >= 65)  { adj += 10; detail.rsi_1h = `${r} overbought→SHORT+10`; }
      else if (r >= 55)  { adj += 5;  detail.rsi_1h = `${r} elevated→SHORT+5`; }
      else if (r <= 35)  { adj -= 18; detail.rsi_1h = `${r} oversold→SHORT-18 (bounce risk!)`; }
      else if (r <= 45)  { adj -= 8;  detail.rsi_1h = `${r} low→SHORT-8`; }
      else               {            detail.rsi_1h = `${r} neutral`; }
    } else {
      if      (r <= 35)  { adj += 10; detail.rsi_1h = `${r} oversold→LONG+10`; }
      else if (r <= 45)  { adj += 5;  detail.rsi_1h = `${r} depressed→LONG+5`; }
      else if (r >= 65)  { adj -= 18; detail.rsi_1h = `${r} overbought→LONG-18`; }
      else if (r >= 55)  { adj -= 8;  detail.rsi_1h = `${r} high→LONG-8`; }
      else               {            detail.rsi_1h = `${r} neutral`; }
    }
  }

  // ── 15min RSI: Einstiegs-Timing ──────────────────────────────────────────
  if (symCtx?.rsi_15m != null) {
    const r = symCtx.rsi_15m;
    if (dir === 'SHORT') {
      if      (r >= 60)  { adj += 8;  detail.rsi_15m = `${r} overbought15m→+8`; }
      else if (r <= 38)  { adj -= 10; detail.rsi_15m = `${r} oversold15m→-10`; }
      else               {            detail.rsi_15m = `${r} neutral`; }
    } else {
      if      (r <= 40)  { adj += 8;  detail.rsi_15m = `${r} oversold15m→+8`; }
      else if (r >= 62)  { adj -= 10; detail.rsi_15m = `${r} overbought15m→-10`; }
      else               {            detail.rsi_15m = `${r} neutral`; }
    }
  }

  // ── 1h Trend (EMA20) ─────────────────────────────────────────────────────
  if (symCtx?.trend_1h) {
    const t = symCtx.trend_1h;
    if (dir === 'SHORT') {
      if      (t === 'bearish') { adj += 10; detail.trend_1h = 'bearish→align+10'; }
      else if (t === 'bullish') { adj -= 20; detail.trend_1h = 'bullish→contra-20!'; }
      else                      {            detail.trend_1h = 'neutral'; }
    } else {
      if      (t === 'bullish') { adj += 10; detail.trend_1h = 'bullish→align+10'; }
      else if (t === 'bearish') { adj -= 20; detail.trend_1h = 'bearish→contra-20!'; }
      else                      {            detail.trend_1h = 'neutral'; }
    }
  }

  // ── BTC Globalkontext ─────────────────────────────────────────────────────
  if (btcCtx?.direction && signal.symbol !== 'BTC') {
    const b = btcCtx.direction;
    if (dir === 'SHORT') {
      if      (b === 'bearish') { adj += 8;  detail.btc = `BTC bearish→+8`; }
      else if (b === 'bullish') { adj -= 12; detail.btc = `BTC bullish→-12`; }
      else                      {            detail.btc = 'BTC neutral'; }
    } else {
      if      (b === 'bullish') { adj += 8;  detail.btc = `BTC bullish→+8`; }
      else if (b === 'bearish') { adj -= 12; detail.btc = `BTC bearish→-12`; }
      else                      {            detail.btc = 'BTC neutral'; }
    }
    // BTC selbst überverkauft → beide Seiten vorsichtig (Volatilität)
    if (btcCtx.rsi_1h != null && btcCtx.rsi_1h < 30) {
      adj -= 5;
      detail.btc += ' (BTC RSI<30 extremly oversold→-5)';
    }
  }

  // ── Relative Stärke/Schwäche vs. BTC ─────────────────────────────────────
  if (symCtx?.rel_perf_1h_vs_btc != null && signal.symbol !== 'BTC') {
    const rp = symCtx.rel_perf_1h_vs_btc;
    if (dir === 'SHORT' && rp < -0.005) { adj += 7;  detail.rel_btc = `relWeaker ${(rp*100).toFixed(2)}%→+7`; }
    if (dir === 'LONG'  && rp > +0.005) { adj += 7;  detail.rel_btc = `relStronger ${(rp*100).toFixed(2)}%→+7`; }
  }

  // ── Funding Rate (Crypto): Extremwerte bestätigen Richtung ────────────────
  if (symCtx?.funding_rate != null) {
    const fr = symCtx.funding_rate;
    if (dir === 'SHORT' && fr > 0.001)  { adj += 6;  detail.funding = `fr=${fr} positive→SHORT+6`; }
    if (dir === 'LONG'  && fr < -0.001) { adj += 6;  detail.funding = `fr=${fr} negative→LONG+6`; }
  }

  return {
    adjustment: adj,
    mtf: {
      rsi_1h:       symCtx?.rsi_1h  ?? null,
      rsi_15m:      symCtx?.rsi_15m ?? null,
      trend_1h:     symCtx?.trend_1h ?? null,
      btc_direction: btcCtx?.direction ?? null,
      btc_rsi_1h:   btcCtx?.rsi_1h ?? null,
      rel_perf_1h:  symCtx?.rel_perf_1h_vs_btc ?? null,
      funding_rate: symCtx?.funding_rate ?? null,
      adjustment:   adj,
      detail,
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function run(argv) {
  const args = parseArgs(argv);

  for (const path of [LEVELS_PATH, CACHE_PATH]) {
    if (!existsSync(path)) {
      process.stderr.write(JSON.stringify({ error: 'missing_file', path }) + '\n');
      process.exit(1);
    }
  }

  const levelsData = JSON.parse(readFileSync(LEVELS_PATH, 'utf8'));
  const cacheData  = JSON.parse(readFileSync(CACHE_PATH,  'utf8'));
  const mtfData    = loadMTFContext();

  if (!mtfData && !args.quiet) {
    process.stderr.write(JSON.stringify({ warn: 'mtf_context_unavailable', note: 'running without MTF filter' }) + '\n');
  }

  const cacheAgeMins = (Date.now() - new Date(cacheData.fetched_at).getTime()) / 60_000;
  if (cacheAgeMins > 10) {
    process.stderr.write(
      JSON.stringify({ warn: 'stale_cache', age_mins: +cacheAgeMins.toFixed(1) }) + '\n'
    );
  }

  const symbols = args.symbols || Object.keys(levelsData.symbols);
  const allSignals = [];

  for (const sym of symbols) {
    const symLevels = levelsData.symbols[sym];
    const symCache  = cacheData.data[sym];
    if (!symLevels || !symCache) continue;

    const { candles }      = symCache;
    const { current_price, levels } = symLevels;

    for (const level of levels) {
      // Resistance → SHORT
      if (level.direction === 'resistance') {
        const sigs = detectResistanceRejection(candles, level, current_price, levels);
        sigs.forEach(s => { s.symbol = sym; allSignals.push(s); });
      }
      // Support → LONG
      if (level.direction === 'support') {
        const sigs = detectSupportRejection(candles, level, current_price, levels);
        sigs.forEach(s => { s.symbol = sym; allSignals.push(s); });
      }
    }
  }

  // MTF-Kontext auf alle Signale anwenden (vor Dedup — damit Dedup auf adjusted conf basiert)
  const mtfAdjusted = allSignals.map(s => {
    const { adjustment, mtf } = applyMTFAdjustment(s, mtfData);
    const rawConf  = s.confidence * 100;
    const newConf  = Math.max(5, Math.min(97, rawConf + adjustment)) / 100;
    return { ...s, confidence: +newConf.toFixed(3), mtf_adjustment: adjustment, mtf };
  });

  // Deduplizieren nach MTF: wenn Symbol+Direction+Candle-Zeit gleich, höchste adjusted Konfidenz gewinnt
  const dedupMap = new Map();
  for (const s of mtfAdjusted) {
    const key = `${s.symbol}_${s.direction}_${s.rejection_time}`;
    const existing = dedupMap.get(key);
    if (!existing || s.confidence > existing.confidence) {
      dedupMap.set(key, s);
    }
  }

  // Filtern und sortieren
  const filtered = [...dedupMap.values()].filter(s =>
    s.confidence >= args.minConf &&
    (args.allSignals || s.status !== 'stale')
  ).sort((a, b) => {
    // actionable zuerst, dann nach confidence
    const statusOrder = { actionable: 0, recent: 1, stale: 2 };
    const statusDiff  = (statusOrder[a.status] || 2) - (statusOrder[b.status] || 2);
    return statusDiff !== 0 ? statusDiff : b.confidence - a.confidence;
  });

  const result = {
    detected_at:   new Date().toISOString(),
    cache_age_mins: +cacheAgeMins.toFixed(2),
    total_signals:  filtered.length,
    actionable:     filtered.filter(s => s.status === 'actionable').length,
    recent:         filtered.filter(s => s.status === 'recent').length,
    stale:          filtered.filter(s => s.status === 'stale').length,
    signals:        filtered,
  };

  writeFileSync(SIGNALS_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  // Human-readable Ausgabe
  if (!args.quiet) {
    const header = `\n📊 Rejection Signals — ${result.detected_at.slice(11, 19)} UTC` +
                   `  (Cache: ${result.cache_age_mins}min alt)\n` +
                   `   Gesamt: ${result.total_signals}  |  Actionable: ${result.actionable}  |  Recent: ${result.recent}\n`;
    process.stdout.write(header);

    if (!filtered.length) {
      process.stdout.write('   → Keine Signale über Mindest-Konfidenz gefunden.\n\n');
    }

    for (const s of filtered) {
      const dir     = s.direction === 'SHORT' ? '📉 SHORT' : '📈 LONG';
      const conf    = (s.confidence * 100).toFixed(0) + '%';
      const ageStr  = s.age_mins === 0 ? 'jetzt' : `vor ${s.age_mins}min`;
      const statusE = s.status === 'actionable' ? '🔴 JETZT' : s.status === 'recent' ? '🟡 KÜRZLICH' : '⚪ STALE';
      const tpStr   = s.tp1 ? ` → TP: ${s.tp1} (+${s.tp1_pct}%)` : '';
      const adjStr  = s.mtf_adjustment != null
        ? ` MTF-Adj: ${s.mtf_adjustment > 0 ? '+' : ''}${s.mtf_adjustment}pts`
        : ' (kein MTF)';
      const mtfStr  = s.mtf
        ? `RSI15m:${s.mtf.rsi_15m ?? '?'} RSI1h:${s.mtf.rsi_1h ?? '?'} Trend:${s.mtf.trend_1h ?? '?'} BTC:${s.mtf.btc_direction ?? '?'}`
        : '';

      process.stdout.write(
        `\n   ${statusE} ${dir} ${s.symbol} @ ${s.entry}` +
        `  [Level: ${s.level_price} ${s.level_type}${s.level_also.length ? '+'+s.level_also[0] : ''}]` +
        `\n   SL: ${s.sl} (-${s.sl_pct}%)${tpStr}` +
        `\n   Wick: ${(s.wick_ratio * 100).toFixed(0)}%  Vol: ${s.vol_multiple}x avg  Conf: ${conf}${adjStr}` +
        `  ${ageStr}  Preis-Dist: ${s.price_dist_pct}%` +
        (mtfStr ? `\n   MTF: ${mtfStr}` : '') + '\n'
      );
    }
    process.stdout.write('\n');
  }

  // Stderr-Summary für Monitor
  process.stderr.write(JSON.stringify({
    info:       'rejection_detection_done',
    detected_at: result.detected_at,
    total:       result.total_signals,
    actionable:  result.actionable,
    recent:      result.recent,
  }) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'rejection_detector_crash', detail: e.message }) + '\n');
    process.exit(1);
  }
}

export { detectResistanceRejection, detectSupportRejection, computeConfidence };
