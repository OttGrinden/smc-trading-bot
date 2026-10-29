#!/usr/bin/env node
/**
 * Master Runner — research_run.mjs
 * Orchestrates the full research pipeline:
 *   context_builder → risk_scorer (per candidate) → indicator_cache → log + stdout
 */

import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync, statSync, unlinkSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync }                                                                              from 'child_process';
import { assessRisk }                                from './risk_scorer.mjs';
import { readIndicatorCache, readClosesFromCache }   from './indicator_cache.mjs';
import { computeFibLevels }                          from './fib_levels.mjs';
import { readPositioning }                           from './positioning_fetcher.mjs';
import { readLiqHeatmap, liqHeatmapSummary }         from './liq_heatmap.mjs';

const SCRIPTS_DIR      = _d;
const LOGS_DIR         = join(TRADING_DIR, 'logs');
const MEMORY_DIR       = join(TRADING_DIR, 'memory');
const CACHE_DIR        = join(TRADING_DIR, 'cache');
const PORTFOLIO_STATE  = join(TRADING_DIR, 'execution', 'portfolio', 'portfolio_state.json');
const REGISTRY_PATH    = join(TRADING_DIR, 'registry', 'registry.json');
const RUNS_JSONL       = join(LOGS_DIR, 'runs.jsonl');
const MARK_TIMEOUT_MS  = 8_000; // MEXC-Ticker-Fallback für Crypto-Positions-Marks
const CB_TIMEOUT       = 120_000; // ms — context_builder spawns stock_quotes (~30-90s)
const OHLCV_PENDING         = join(TRADING_DIR, 'cache', 'ohlcv_pending.json');
const OHLCV_PENDING_WEEKLY  = join(TRADING_DIR, 'cache', 'ohlcv_pending_weekly.json');
const OHLCV_PENDING_MONTHLY = join(TRADING_DIR, 'cache', 'ohlcv_pending_monthly.json');
const RSI_CALC_SCRIPT  = join(SCRIPTS_DIR, 'rsi_calc.mjs');
const MACD_CALC_SCRIPT = join(SCRIPTS_DIR, 'macd_calc.mjs');
const OHLCV_MAX_AGE_MS = 5 * 60_000; // pending file older than 5 min is skipped
const MIN_CLOSES_WEEKLY  = 15;
const MIN_CLOSES_MONTHLY = 15;

// --- Step 0: RSI + MACD pre-computation from pending OHLCV closes ----------
//
// If ohlcv_pending.json exists (written by Claude after data_get_ohlcv calls),
// rsi_calc.mjs and macd_calc.mjs are invoked per symbol before enrichment.
// Format: { "ENPH": [close0, close1, ...], "MRVL": [...] }  (oldest-first)
// Minimum 35 closes required (MACD EMA(26)+signal(9) warmup).

function processOHLCVPending() {
  if (!existsSync(OHLCV_PENDING)) return;

  // Hard fail: invalid JSON
  let pending;
  try {
    pending = JSON.parse(readFileSync(OHLCV_PENDING, 'utf8'));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'ohlcv_pending_parse_failed', detail: e.message }) + '\n');
    process.exit(1);
  }

  // Hard fail: stale file
  const ageMs = Date.now() - statSync(OHLCV_PENDING).mtimeMs;
  if (ageMs > OHLCV_MAX_AGE_MS) {
    process.stderr.write(JSON.stringify({ error: 'ohlcv_pending_stale', age_minutes: +(ageMs / 60_000).toFixed(1), max_minutes: OHLCV_MAX_AGE_MS / 60_000 }) + '\n');
    process.exit(1);
  }

  // Hard fail: any symbol with fewer than 35 closes (MACD warmup requirement)
  for (const [symbol, closes] of Object.entries(pending)) {
    if (!Array.isArray(closes) || closes.length < 35) {
      process.stderr.write(JSON.stringify({ error: 'ohlcv_pending_too_few_closes', symbol, count: closes?.length ?? 0, required: 35 }) + '\n');
      process.exit(1);
    }
  }

  // Hard fail: any rsi_calc or macd_calc invocation that fails — pending file is NOT deleted on error
  let computed = 0;
  for (const [symbol, closes] of Object.entries(pending)) {
    try {
      execFileSync(process.execPath, [RSI_CALC_SCRIPT,  symbol, JSON.stringify(closes)], { timeout: 10_000 });
      execFileSync(process.execPath, [MACD_CALC_SCRIPT, symbol, JSON.stringify(closes)], { timeout: 10_000 });
      computed++;
    } catch (e) {
      process.stderr.write(JSON.stringify({ error: 'indicator_calc_failed', symbol, detail: e.message }) + '\n');
      process.exit(1);
    }
  }

  // Delete only after all symbols processed successfully
  unlinkSync(OHLCV_PENDING);
  process.stderr.write(JSON.stringify({ info: 'ohlcv_pending_processed', computed }) + '\n');
}

// --- Step 0b/0c: Weekly + Monthly RSI from separate pending files ----------
// Fail-soft: warnings only — missing weekly/monthly RSI never blocks a scan.

function processOHLCVPendingWithTimeframe(pendingPath, timeframe, minCloses) {
  if (!existsSync(pendingPath)) return;

  let pending;
  try {
    pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
  } catch (e) {
    process.stderr.write(JSON.stringify({ warning: `ohlcv_pending_${timeframe}_parse_failed`, detail: e.message }) + '\n');
    return;
  }

  let computed = 0;
  for (const [symbol, closes] of Object.entries(pending)) {
    if (!Array.isArray(closes) || closes.length < minCloses) {
      process.stderr.write(JSON.stringify({ warning: `ohlcv_${timeframe}_too_few`, symbol, count: closes?.length ?? 0, required: minCloses }) + '\n');
      continue;
    }
    try {
      execFileSync(process.execPath, [RSI_CALC_SCRIPT, symbol, JSON.stringify(closes), '--timeframe', timeframe], { timeout: 10_000 });
      computed++;
    } catch (e) {
      process.stderr.write(JSON.stringify({ warning: `rsi_${timeframe}_calc_failed`, symbol, detail: e.message }) + '\n');
    }
  }

  try { unlinkSync(pendingPath); } catch { /* ignore */ }
  process.stderr.write(JSON.stringify({ info: `ohlcv_pending_${timeframe}_processed`, computed }) + '\n');
}

// --- Step 1: Context Builder -----------------------------------------------

function runContextBuilder() {
  try {
    const out = execFileSync(
      process.execPath,
      [join(SCRIPTS_DIR, 'context_builder.mjs')],
      { timeout: CB_TIMEOUT, maxBuffer: 10 * 1024 * 1024 }
    );
    return JSON.parse(out.toString('utf8'));
  } catch (e) {
    process.stderr.write(
      JSON.stringify({ error: 'context_builder_failed', detail: e.message }) + '\n'
    );
    return null;
  }
}

// --- Step 2: Enrich candidates ---------------------------------------------

function technicalSummary(tv) {
  if (!tv.available) {
    if (tv.reason === 'stale')    return `⚠ veraltet (${tv.age_minutes}min)`;
    if (tv.reason === 'rsi_null') return '⚠ RSI fehlt';
    return '—';
  }
  const rsiTag = tv.rsi <= 30 ? ' ↓' : tv.rsi >= 70 ? ' ↑' : '';

  let rsiStr;
  if (tv.rsi_weekly != null || tv.rsi_monthly != null) {
    // Multi-timeframe: prefix daily with D:
    const parts = [`D:${tv.rsi.toFixed(1)}${rsiTag}`];
    if (tv.rsi_weekly  != null) parts.push(`W:${tv.rsi_weekly.toFixed(1)}`);
    if (tv.rsi_monthly != null) parts.push(`M:${tv.rsi_monthly.toFixed(1)}`);
    rsiStr = `RSI ${parts.join(' ')}`;
  } else {
    rsiStr = `RSI ${tv.rsi.toFixed(1)}${rsiTag}`;
  }

  const macdStr = tv.macd_signal != null && tv.macd_hist != null
    ? ` · MACD ${tv.macd_signal} (${tv.macd_hist >= 0 ? '+' : ''}${tv.macd_hist})`
    : '';
  return `${rsiStr}${macdStr}`;
}

import { SCORE_LEVERAGE_MAP, computeTStark, computeScoreBounds } from './technical_scoring.mjs';
import { fileURLToPath } from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

function enrichOne(candidate) {
  // Risk scoring (synchronous, no I/O)
  const risk = assessRisk(candidate);

  // Technical data from indicator cache
  const tv = readIndicatorCache(candidate.symbol);

  const enriched = {
    ...candidate,
    risk: {
      risk_level:             risk.risk_level,
      composite:              risk.risk_scores.composite,
      suggested_position_pct: risk.suggested_position_pct,
      stop_loss_pct:          risk.stop_loss_pct,
      flags:                  risk.flags,
    },
    technical: tv.available
      ? { available: true, rsi: tv.rsi, rsi_weekly: tv.rsi_weekly ?? null, rsi_monthly: tv.rsi_monthly ?? null, macd_hist: tv.macd_hist, macd_signal: tv.macd_signal, age_minutes: tv.age_minutes, summary: technicalSummary(tv) }
      : { available: false, reason: tv.reason, age_minutes: tv.age_minutes ?? null, summary: technicalSummary(tv) },
  };

  // Fibonacci retracement (V1 — fail-soft, niemals blockierend)
  const closesData = readClosesFromCache(candidate.symbol);
  enriched.technical.fib = (closesData.available && candidate.price_usd > 0)
    ? computeFibLevels({ closes: closesData.closes_20, direction: candidate.direction, currentPrice: candidate.price_usd })
    : { available: false, reason: closesData.reason ?? 'no_current_price' };

  // T_stark: Multi-Timeframe-Alignment (benötigt Fib — nach Fib-Block berechnen)
  const tStark = computeTStark(enriched.technical, candidate.direction);
  enriched.technical.t_stark         = tStark.t_stark;
  enriched.technical.t_stark_score   = tStark.t_stark_score;
  enriched.technical.t_stark_signals = tStark.t_stark_signals;
  if (tStark.t_stark) enriched.technical.summary += ' · ⚡T★';

  // Score-Bounds (technisch, ohne K) — kein finaler Score, nur Ober-/Untergrenze
  // floor = 8 wenn T_stark=ja (kein K nötig) | ceiling = erreichbares Max mit K
  // Finaler Score wird von Claude nach WebSearch (oder T_stark) bestimmt.
  enriched.score_bounds = computeScoreBounds(risk.risk_level, enriched.technical, candidate.direction);

  // Derivatives positioning + Liquidation Heatmap (Crypto only)
  if (candidate.category === 'Crypto') {
    const pos = readPositioning(candidate.symbol);
    enriched.positioning = pos.available
      ? {
          available: true,
          funding_rate:      pos.funding_rate,
          long_short_ratio:  pos.long_short_ratio,
          long_account_pct:  pos.long_account_pct,
          oi_usd:            pos.oi_usd,
          oi_change_24h_pct: pos.oi_change_24h_pct,
          squeeze_risk:      pos.squeeze_risk ?? null,
          age_minutes:       pos.age_minutes,
          summary:           pos.summary ?? '—',
        }
      : { available: false, reason: pos.reason, summary: '—' };

    // Liq Heatmap — Order Book Walls (fail-soft)
    const liq = readLiqHeatmap(candidate.symbol);
    enriched.liq_heatmap = liq.available
      ? {
          available:            true,
          current_price:        liq.current_price,
          nearest_sell_wall:    liq.nearest_sell_wall,
          nearest_buy_wall:     liq.nearest_buy_wall,
          biggest_sell_wall:    liq.biggest_sell_wall,
          biggest_buy_wall:     liq.biggest_buy_wall,
          near_sell_notional:   liq.near_sell_notional_usd,
          near_buy_notional:    liq.near_buy_notional_usd,
          buy_sell_ratio:       liq.buy_sell_ratio,
          bias:                 liq.bias,
          squeeze_potential:    liq.squeeze_potential,
          age_minutes:          liq.age_minutes,
          summary:              liqHeatmapSummary(liq),
        }
      : { available: false, reason: liq.reason, summary: '—' };
  }

  return enriched;
}

function enrichCandidates(list) {
  return (list ?? []).map(enrichOne);
}

// --- Step 2b: Portfolio-Marks für offene Positionen -------------------------
//
// Problem #2-Fix (11.06.2026): Offene Positionen fallen aus dem Top-20-Filter
// und wurden bisher nicht mehr gemarkt → SL-Überwachung blind.
// Die Preise existieren aber bereits pro Run in den Caches (stocks_*.json hat
// das volle 88er-Registry-Universum; scan_*.json Mover + Notables).
//
// buildPortfolioMarks liest portfolio_state.json READ-ONLY und liefert ein
// additives Top-Level-Feld `portfolio_marks` für den Run-Output.
// Quellen-Kaskade pro Position (erste Quelle gewinnt):
//   1. scan_candidate    — Symbol ist ohnehin Kandidat dieses Runs
//   2. stocks_cache      — volles Stock-Universum (Stocks)
//   3. crypto_scan_cache — Mover/Notables (Crypto)
//   4. mexc_ticker       — Live-Ticker-Fallback (nur Crypto, 8s Timeout)
// Fail-soft pro Symbol: { available:false, reason } + stderr-Warnung.
// indicator_cache.json wird hier weder gelesen noch geschrieben (Contract unberührt).

function loadLatestCacheFile(prefix) {
  try {
    const files = readdirSync(CACHE_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf8'));
        // Skip caches where all fetches failed (successful=0 → no usable prices)
        if (prefix === 'stocks_' && (data.successful ?? 0) === 0) continue;
        return data;
      } catch { continue; }
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchExternalTickerPrice(symbol) {
  const sym = symbol.toUpperCase() + 'USDT';
  const sources = [
    { name: 'binance', url: `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, parse: d => parseFloat(d.price) },
    { name: 'mexc',    url: `https://api.mexc.com/api/v3/ticker/price?symbol=${sym}`,    parse: d => parseFloat(d.price) },
  ];
  let lastErr = 'all_sources_failed';
  for (const src of sources) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MARK_TIMEOUT_MS);
    try {
      const res = await fetch(src.url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const price = src.parse(await res.json());
      if (!Number.isFinite(price) || price <= 0) throw new Error('invalid_price');
      return { price, source: src.name };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? 'timeout' : e.message;
    }
  }
  throw new Error(lastErr);
}

async function buildPortfolioMarks(enrichedCandidates) {
  // Offene Positionen read-only laden — fehlend/unlesbar ist kein Fehler des Runs
  let positions;
  try {
    const state = JSON.parse(readFileSync(PORTFOLIO_STATE, 'utf8'));
    positions   = Array.isArray(state.open_positions) ? state.open_positions : [];
  } catch (e) {
    process.stderr.write(JSON.stringify({ warning: 'portfolio_marks_state_unreadable', detail: e.message }) + '\n');
    return {};
  }
  if (!positions.length) return {};

  // Quelle 1: Kandidaten dieses Runs
  const candidatePrices = {};
  for (const c of enrichedCandidates) {
    if (c.price_usd != null && Number.isFinite(c.price_usd)) candidatePrices[c.symbol] = c.price_usd;
  }

  // Quelle 2: Stocks-Cache (volles Registry-Universum)
  const stocksCache = loadLatestCacheFile('stocks_');
  const stockPrices = {};
  for (const q of stocksCache?.quotes ?? []) {
    if (q.symbol && q.price_usd != null && Number.isFinite(q.price_usd)) stockPrices[q.symbol] = q.price_usd;
  }

  // Quelle 3: Crypto-Scan-Cache (Mover + Notables; Symbol normalisiert in `base`)
  const scanCache    = loadLatestCacheFile('scan_');
  const cryptoPrices = {};
  for (const list of [scanCache?.top_gainers, scanCache?.top_losers, scanCache?.notable_altcoin_quotes]) {
    for (const q of list ?? []) {
      const sym = q.base ?? q.symbol;
      if (sym && cryptoPrices[sym] === undefined && q.price_usd != null && Number.isFinite(q.price_usd)) {
        cryptoPrices[sym] = q.price_usd;
      }
    }
  }

  const nowIso = new Date().toISOString();
  const marks  = {};

  for (const pos of positions) {
    const sym = pos.symbol;
    if (!sym || marks[sym] !== undefined) continue;
    const isStock = pos.asset_type === 'stock';

    let entry;
    if (candidatePrices[sym] !== undefined) {
      entry = { available: true, price_usd: candidatePrices[sym], source: 'scan_candidate', fetched_at: nowIso };
    } else if (isStock && stockPrices[sym] !== undefined) {
      entry = { available: true, price_usd: stockPrices[sym], source: 'stocks_cache', fetched_at: stocksCache?.fetched_at ?? nowIso };
    } else if (!isStock && cryptoPrices[sym] !== undefined) {
      entry = { available: true, price_usd: cryptoPrices[sym], source: 'crypto_scan_cache', fetched_at: scanCache?.scanned_at ?? nowIso };
    } else if (!isStock) {
      try {
        const { price, source } = await fetchExternalTickerPrice(sym);
        entry = { available: true, price_usd: price, source: `ext_ticker_${source}`, fetched_at: new Date().toISOString() };
      } catch (e) {
        entry = { available: false, reason: `ext_ticker_failed: ${e.message}` };
      }
    } else {
      // Stock not in stocks_cache — last resort: try external ticker (covers tokenized stocks)
      try {
        const { price, source } = await fetchExternalTickerPrice(sym);
        entry = { available: true, price_usd: price, source: `ext_ticker_${source}_stock_fallback`, fetched_at: new Date().toISOString() };
      } catch {
        entry = { available: false, reason: 'no_price_source' };
      }
    }

    marks[sym] = entry;
    if (entry.available) {
      process.stderr.write(JSON.stringify({ info: 'portfolio_mark', symbol: sym, source: entry.source, price_usd: entry.price_usd }) + '\n');
    } else {
      process.stderr.write(JSON.stringify({ warning: 'portfolio_mark_failed', symbol: sym, reason: entry.reason }) + '\n');
    }
  }

  return marks;
}

// --- Step 2c: Pinned Watchlist (strategische Titel — immer sichtbar) --------
//
// Symbole aus registry.pinned_symbols erscheinen unabhängig vom Top-10-Cut
// als additives Top-Level-Feld `pinned_watchlist` im Run-Output.
// Reine Sichtbarkeit: kein Einfluss auf Kandidaten-Ranking, Decision-Engine
// oder Allokation (diese lesen ausschließlich long_/short_candidates).
// Dopplungs-Regel: ist ein Symbol bereits Kandidat dieses Runs, wird nur eine
// schlanke Referenz {in_candidates:true, list, rank} ausgegeben.
// Fail-soft: fehlende pinned_symbols-Liste oder fehlende Quote → kein Run-Abbruch.

function buildPinnedWatchlist(longs, shorts) {
  let pinned = [];
  try {
    const reg = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    pinned = Array.isArray(reg.pinned_symbols) ? reg.pinned_symbols : [];
  } catch (e) {
    process.stderr.write(JSON.stringify({ warning: 'pinned_registry_unreadable', detail: e.message }) + '\n');
    return [];
  }
  if (!pinned.length) return [];

  const stocksCache = loadLatestCacheFile('stocks_');
  const quoteBySym  = {};
  for (const q of stocksCache?.quotes ?? []) quoteBySym[q.symbol] = q;

  const out = [];
  for (const sym of pinned) {
    const inLong  = longs.find(c => c.symbol === sym);
    const inShort = inLong ? null : shorts.find(c => c.symbol === sym);
    if (inLong || inShort) {
      out.push({ symbol: sym, pinned: true, in_candidates: true, list: inLong ? 'long' : 'short', rank: (inLong ?? inShort).rank });
      continue;
    }

    const q = quoteBySym[sym];
    if (!q || q.error || !Number.isFinite(q.price_usd)) {
      out.push({ symbol: sym, pinned: true, in_candidates: false, available: false,
                 reason: q?.error ? `quote_error: ${q.error}` : 'not_fetched' });
      process.stderr.write(JSON.stringify({ warning: 'pinned_quote_missing', symbol: sym }) + '\n');
      continue;
    }

    // Gleiche Enrichment-Pipeline wie reguläre Kandidaten (risk + technical)
    const enriched = enrichOne({
      symbol:     q.symbol,
      name:       q.name ?? sym,
      category:   q.category ?? 'Stock',
      sector:     q.sector ?? null,
      direction:  q.direction ?? null,
      change_pct: q.change_pct,
      price_usd:  q.price_usd,
      volume_usd: q.volume_usd,
      is_notable: false,
    });
    out.push({ ...enriched, pinned: true, in_candidates: false, available: true });
  }

  process.stderr.write(JSON.stringify({
    info:          'pinned_watchlist_built',
    total:         out.length,
    in_candidates: out.filter(p => p.in_candidates).map(p => p.symbol),
    standalone:    out.filter(p => !p.in_candidates && p.available).map(p => p.symbol),
    unavailable:   out.filter(p => p.available === false).map(p => p.symbol),
  }) + '\n');
  return out;
}

// --- Step 3: Log -----------------------------------------------------------

function makeRunId(now) {
  return 'run_' + now.toISOString().slice(0, 16).replaceAll(':', '').replace('T', '_');
}

function writeRunLog(runId, output) {
  const logPath = join(LOGS_DIR, `${runId}.json`);
  writeFileSync(logPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  const all          = [...output.long_candidates, ...output.short_candidates];
  const tvAvailable  = all.filter(c => c.technical?.available).length;

  const summary = {
    run_at:       output.run_at,
    run_id:       runId,
    status:       'ok',
    longs:        output.long_candidates.length,
    shorts:       output.short_candidates.length,
    stocks:       all.filter(c => c.category === 'Stock').length,
    crypto:       all.filter(c => c.category !== 'Stock').length,
    tv_available: tvAvailable,
  };

  // Dedup: scan.mjs calls research_run.mjs twice (baseline + full_run) — write run_id only once
  let alreadyLogged = false;
  try {
    const lines = readFileSync(RUNS_JSONL, 'utf8').trim().split('\n').slice(-3);
    alreadyLogged = lines.some(l => { try { return JSON.parse(l).run_id === runId; } catch { return false; } });
  } catch { /* file may not exist yet on first run */ }
  if (!alreadyLogged) {
    appendFileSync(RUNS_JSONL, JSON.stringify(summary) + '\n', 'utf8');
  }
  return logPath;
}

// --- Step 4: Memory writeback (non-fatal) ----------------------------------

function writeMemory(runId, output) {
  try {
    mkdirSync(MEMORY_DIR, { recursive: true });

    const all    = [...output.long_candidates, ...output.short_candidates];
    const meta   = output.meta ?? {};

    // Filename: second-precision derived from run timestamp — no collision
    const ts      = new Date(output.run_at).toISOString().slice(0, 19).replaceAll(':', '').replace('T', '_');
    const memPath = join(MEMORY_DIR, `memory_${ts}.json`);

    // Top 3 candidates each side — slim fields only
    const slim = c => ({
      rank:       c.rank,
      symbol:     c.symbol,
      category:   c.category,
      sector:     c.sector ?? null,
      change_pct: c.change_pct,
      score:      c.score,
      risk_level: c.risk?.risk_level ?? null,
      is_notable: c.is_notable ?? false,
    });

    // Asset learnings: candidates with notable move (≥5%) or at least one risk flag
    const learnings = all
      .filter(c => Math.abs(c.change_pct ?? 0) >= 5 || (c.risk?.flags?.length ?? 0) > 0)
      .map(c => ({
        symbol:    c.symbol,
        sector:    c.sector ?? null,
        direction: c.direction,
        move_pct:  c.change_pct,
        flags:     c.risk?.flags ?? [],
      }));

    // Notable flags: aggregated count per flag type across all candidates
    const flagCounts = {};
    for (const c of all) {
      for (const flag of (c.risk?.flags ?? [])) {
        flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
      }
    }

    // Open tasks: rule-based only — derived deterministically from run data
    const openTasks = [];
    const tvCount   = all.filter(c => c.technical?.available).length;
    if (tvCount === 0)
      openTasks.push(`TV layer unavailable: all ${all.length} candidates have technical.available=false`);
    if ((meta.scan_age_minutes ?? 0) > 30)
      openTasks.push(`Scan data is ${meta.scan_age_minutes}min old — consider fresh scan next run`);
    if ((meta.notable_altcoins_included ?? 0) === 0)
      openTasks.push('No notable altcoins reached final top-N — market may be very quiet');
    if (all.filter(c => c.category !== 'Stock').length === 0)
      openTasks.push('No crypto candidates in output — check NOTABLE_MIN_CHANGE_PCT or market conditions');

    const memory = {
      session: {
        run_id:           runId,
        run_at:           output.run_at,
        scan_age_minutes: meta.scan_age_minutes ?? null,
        market_event:     meta.market_event     ?? null,
      },
      market_snapshot: {
        crypto_scanned:            meta.crypto_scanned            ?? 0,
        stocks_fetched:            meta.stocks_fetched            ?? 0,
        notable_altcoins_included: meta.notable_altcoins_included ?? 0,
      },
      top_candidates: {
        long:  output.long_candidates.slice(0, 3).map(slim),
        short: output.short_candidates.slice(0, 3).map(slim),
      },
      asset_learnings: learnings,
      notable_flags:   flagCounts,
      open_tasks:      openTasks,
    };

    writeFileSync(memPath, JSON.stringify(memory, null, 2) + '\n', 'utf8');
    process.stderr.write(JSON.stringify({ info: 'memory_written', path: memPath }) + '\n');
  } catch (e) {
    process.stderr.write(
      JSON.stringify({ warning: 'memory_writeback_failed', error: e.message }) + '\n'
    );
  }
}

// --- Main ------------------------------------------------------------------

async function main() {
  const now   = new Date();
  const runId = makeRunId(now);

  process.stderr.write(JSON.stringify({ info: 'research_run_start', run_id: runId }) + '\n');

  // 0. Compute RSI/MACD from pending OHLCV closes (no-op if file absent)
  processOHLCVPending();
  processOHLCVPendingWithTimeframe(OHLCV_PENDING_WEEKLY,  'weekly',  MIN_CLOSES_WEEKLY);
  processOHLCVPendingWithTimeframe(OHLCV_PENDING_MONTHLY, 'monthly', MIN_CLOSES_MONTHLY);

  // 1. Get candidates from context builder
  const ctx = runContextBuilder();
  if (!ctx) process.exit(1);

  // 2. Enrich each candidate with risk + TV data
  // Pre-filter: ceiling < 6 → selbst K=ja reicht nicht für Score 6 → nicht zeigen.
  // Crypto: ceiling ≥ 5 allowed so OHLCV gets fetched and RSI can raise ceiling to 6+ on full_run.
  const longs  = enrichCandidates(ctx.long_candidates)
    .filter(c => c.score_bounds.ceiling >= (c.category === 'Stock' ? 6 : 5));
  const shorts = enrichCandidates(ctx.short_candidates)
    .filter(c => c.score_bounds.ceiling >= (c.category === 'Stock' ? 6 : 5));

  process.stderr.write(JSON.stringify({ info: 'pre_filter_applied',
    longs_after: longs.length, shorts_after: shorts.length }) + '\n');

  // 2a. Blocked-Symbol-Annotation — fail-soft, addiert blocked:true + block_reason
  // Kandidaten bleiben im Output (Research-Sichtbarkeit), werden aber klar markiert.
  // Abgelaufene blocked_until-Blöcke werden übersprungen.
  try {
    const state = JSON.parse(readFileSync(PORTFOLIO_STATE, 'utf8'));
    const nowTs = Date.now();
    const blockedMap = new Map();
    for (const b of state.blocked_symbols ?? []) {
      const expired = b.blocked_until && new Date(b.blocked_until).getTime() < nowTs;
      if (!expired) blockedMap.set(`${b.symbol}:${b.side}`, b.reason);
    }
    if (blockedMap.size > 0) {
      for (const c of [...longs, ...shorts]) {
        const key = `${c.symbol}:${c.direction.toLowerCase()}`;
        if (blockedMap.has(key)) {
          c.blocked = true;
          c.block_reason = blockedMap.get(key);
        }
      }
      const annotated = [...longs, ...shorts].filter(c => c.blocked).map(c => `${c.symbol} ${c.direction}`);
      if (annotated.length) {
        process.stderr.write(JSON.stringify({ info: 'blocked_candidates_annotated', symbols: annotated }) + '\n');
      }
    }
  } catch { /* fail-soft — never aborts the run */ }

  // 2b. Marks für offene Positionen (Problem #2-Fix — fail-soft, additiv)
  const portfolioMarks = await buildPortfolioMarks([...longs, ...shorts]);

  // 2b-alerts: Direction Watch + Mark-Failed Toasts (fail-soft — never blocks run)
  try {
    const { alertDirectionWatch, alertMarkFailed } = await import('./notify.mjs');
    const candidateSymbols = new Set([...longs, ...shorts].map(c => c.symbol));
    let state;
    try { state = JSON.parse(readFileSync(PORTFOLIO_STATE, 'utf8')); } catch { state = null; }
    if (state?.open_positions?.length) {
      for (const pos of state.open_positions) {
        if (!candidateSymbols.has(pos.symbol)) {
          alertDirectionWatch({ symbol: pos.symbol, side: pos.side, daysOpen: pos.days_open, reason: 'not_in_top_candidates' });
        }
        if (portfolioMarks[pos.symbol]?.available === false) {
          alertMarkFailed({ symbol: pos.symbol, side: pos.side });
        }
      }
    }
  } catch { /* best-effort — never aborts the run */ }

  // 2c. Pinned Watchlist (strategische Titel — fail-soft, additiv)
  const pinnedWatchlist = buildPinnedWatchlist(longs, shorts);

  // 3. Assemble final output
  // btc_positioning: Markt-Anker für Bull-/Bear-Phasen-Einordnung — immer aus dem
  // Positioning-Cache gelesen, unabhängig davon ob BTC Kandidat ist.
  const btcPos = readPositioning('BTC');
  const output = {
    run_at:           now.toISOString(),
    run_id:           runId,
    long_candidates:  longs,
    short_candidates: shorts,
    portfolio_marks:  portfolioMarks,
    pinned_watchlist: pinnedWatchlist,
    btc_positioning:  btcPos.available
      ? { available: true, funding_rate: btcPos.funding_rate, long_short_ratio: btcPos.long_short_ratio,
          oi_usd: btcPos.oi_usd, oi_change_24h_pct: btcPos.oi_change_24h_pct,
          squeeze_risk: btcPos.squeeze_risk ?? null, age_minutes: btcPos.age_minutes, summary: btcPos.summary ?? '—',
          mark_price_usd: btcPos.mark_price_usd ?? null }
      : { available: false, reason: btcPos.reason },
    meta:             ctx.meta ?? {},
  };

  // 4. Write full log + summary line
  const logPath = writeRunLog(runId, output);
  process.stderr.write(JSON.stringify({ info: 'log_written', path: logPath }) + '\n');

  // 5. Write memory snapshot (non-fatal — failure does not stop the run)
  writeMemory(runId, output);

  // 6. stdout — compact JSON for Claude consumption (token-efficient)
  process.stdout.write(JSON.stringify(output) + '\n');
}

main().catch(e => {
  process.stderr.write(JSON.stringify({ error: 'research_run_failed', detail: e.message }) + '\n');
  process.exit(1);
});
