#!/usr/bin/env node
/**
 * Context Builder
 * Combines Bitunix crypto scan + Yahoo Finance stock quotes,
 * scores and ranks candidates, returns token-efficient Top-N JSON.
 */

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath }             from 'url';
import { dirname, join, resolve }    from 'path';
import { execFileSync }              from 'child_process';

const _d = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR    = _d;
const TRADING_DIR    = resolve(_d, '..', 'trading');
const REGISTRY_PATH  = join(TRADING_DIR, 'registry', 'registry.json');
const CACHE_DIR      = join(TRADING_DIR, 'cache');
const TOP_N_CRYPTO               = 5;   // max crypto slots per direction
const TOP_N_MAJOR_NOTABLE        = 2;   // guaranteed slots for BTC/ETH/XRP class (notable + vol ≥ $100M)
const TOP_N_STOCKS               = 5;   // guaranteed stock slots per direction (prevents crypto squeeze-out)
const MAJOR_NOTABLE_VOL          = 100_000_000; // $100M volume threshold for major notables
const STOCK_TIMEOUT              = 90_000; // ms — Yahoo Finance batch can take ~20-30s
const NOTABLE_MIN_CHANGE_PCT     = 0.5;    // min 24h % move for notable altcoins
const NON_NOTABLE_MIN_CHANGE_PCT = 1.0;    // min 24h % move for non-notable crypto

// --- Scoring ----------------------------------------------------------------

const VOLUME_TIERS = {
  Stock:  [[500_000_000, 1.0], [50_000_000, 0.8], [5_000_000, 0.6], [0, 0.3]],
  Crypto: [[50_000_000,  1.0], [5_000_000,  0.8], [1_000_000, 0.5], [0, 0.3]],
};

function volumeFactor(volUsd, category) {
  if (!volUsd || volUsd <= 0) return 0.2;
  const tiers = VOLUME_TIERS[category] ?? VOLUME_TIERS.Crypto;
  for (const [threshold, factor] of tiers) {
    if (volUsd >= threshold) return factor;
  }
  return 0.2;
}

function scoreCandidate(c, notableSet) {
  const absChg  = Math.abs(c.change_pct ?? 0);
  const vFactor = volumeFactor(c.volume_usd, c.category);
  const notable = c.category !== 'Stock' && notableSet.has(c.symbol);
  const bonus   = notable ? 2.0 : 0;
  return +(absChg * vFactor + bonus).toFixed(3);
}

// --- Data loading -----------------------------------------------------------

function findLatestCache() {
  try {
    const files = readdirSync(CACHE_DIR)
      .filter(f => f.startsWith('scan_') && f.endsWith('.json'))
      .sort()
      .reverse();
    return files.length ? join(CACHE_DIR, files[0]) : null;
  } catch {
    return null;
  }
}

function loadScanCache(cachePath) {
  if (!cachePath) return null;
  try   { return JSON.parse(readFileSync(cachePath, 'utf8')); }
  catch { return null; }
}

function runScript(scriptName, timeout) {
  try {
    const out = execFileSync(
      process.execPath,
      [join(SCRIPTS_DIR, scriptName)],
      { timeout, maxBuffer: 10 * 1024 * 1024 }
    );
    return JSON.parse(out.toString('utf8'));
  } catch (e) {
    process.stderr.write(
      JSON.stringify({ warning: `${scriptName}_failed`, error: e.message }) + '\n'
    );
    return null;
  }
}

function loadNotableSet() {
  try {
    const reg = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    return new Set(reg.crypto?.notable_altcoins ?? []);
  } catch {
    return new Set();
  }
}

function scanAgeMinutes(scan) {
  if (!scan?.scanned_at) return null;
  return +((Date.now() - new Date(scan.scanned_at).getTime()) / 60_000).toFixed(1);
}

// --- Normalization ----------------------------------------------------------

function normalizeCrypto(entry, notable) {
  // Scanner symbols end in USDT — strip for clean display
  const sym = (entry.symbol ?? '').replace(/USDT$/, '');
  return {
    symbol:     sym,
    name:       sym,
    category:   entry.category ?? 'Crypto',
    sector:     null,
    direction:  entry.direction,
    change_pct: entry.change_pct,
    price_usd:  entry.price_usd,
    volume_usd: entry.volume_usd,
    is_notable: notable,
  };
}

function normalizeStock(entry) {
  return {
    symbol:     entry.symbol,
    name:       entry.name,
    category:   'Stock',
    sector:     entry.sector ?? null,
    direction:  entry.direction,
    change_pct: entry.change_pct,
    price_usd:  entry.price_usd,
    volume_usd: entry.volume_usd,
    is_notable: false,
  };
}

// --- Main -------------------------------------------------------------------

function main() {
  // 1. Crypto scan — prefer cache, fall back to fresh scan
  let cachePath    = findLatestCache();
  let scan         = loadScanCache(cachePath);
  let usedFreshScan = false;

  const MAX_SCAN_AGE_MS = 90 * 60_000;
  const scannedAtMs = scan?.scanned_at ? new Date(scan.scanned_at).getTime() : NaN;
  const scanAgeMs   = Number.isFinite(scannedAtMs) ? Date.now() - scannedAtMs : Infinity;

  if (!scan || scanAgeMs > MAX_SCAN_AGE_MS) {
    const reason = !scan ? 'no_cache_found' : scanAgeMs === Infinity ? 'cache_invalid_timestamp' : 'cache_stale';
    process.stderr.write(JSON.stringify({ info: 'running_market_scanner', reason, age_minutes: Number.isFinite(scanAgeMs) ? +(scanAgeMs / 60_000).toFixed(1) : null }) + '\n');
    scan         = runScript('market_scanner.mjs', 30_000);
    usedFreshScan = true;
  }

  // 2. Stock quotes (fresh each run — caching comes in a later step)
  const stocksData = runScript('stock_quotes.mjs', STOCK_TIMEOUT);

  // 3. Notable altcoins set (for scoring bonus + min-change override)
  const notableSet = loadNotableSet();

  // 4. Build candidate pool
  const candidates = [];

  if (scan) {
    const seen = new Set();

    // Source A: top gainers + losers (ranking-based, max 40 entries)
    for (const c of [...(scan.top_gainers ?? []), ...(scan.top_losers ?? [])]) {
      if (seen.has(c.symbol)) continue;
      seen.add(c.symbol);
      const base    = (c.symbol ?? '').replace(/USDT$/, '');
      const notable = notableSet.has(base);
      const absChg  = Math.abs(c.change_pct ?? 0);
      const minChg  = notable ? NOTABLE_MIN_CHANGE_PCT : NON_NOTABLE_MIN_CHANGE_PCT;
      if (absChg < minChg) continue;
      candidates.push(normalizeCrypto(c, notable));
    }

    // Source B: notable altcoin quotes — ranking-independent, always checked
    // No min-change threshold: scoring + top-N selection limits output naturally
    if (Array.isArray(scan.notable_altcoin_quotes)) {
      for (const c of scan.notable_altcoin_quotes) {
        if (seen.has(c.symbol)) continue;          // dedup: already from Source A
        seen.add(c.symbol);
        if (!c.direction || c.direction === 'NEUTRAL') continue;
        candidates.push(normalizeCrypto(c, true)); // always is_notable: true
      }
    }
  }

  if (stocksData?.quotes) {
    for (const q of stocksData.quotes) {
      if (q.error !== null || q.change_pct === null) continue;
      if (Math.abs(q.change_pct) < 0.3) continue;
      candidates.push(normalizeStock(q));
    }
  }

  // 5. Score + rank — separate crypto/stock pools to prevent extreme crypto moves
  //    from crowding out stocks entirely (e.g. +65% altcoin fills all 10 slots)
  const scored = candidates.map(c => ({ ...c, score: scoreCandidate(c, notableSet) }));

  function topByDirection(all, dir) {
    const sort = (a, b) => b.score - a.score;
    const crypto = all.filter(c => c.direction === dir && c.category !== 'Stock');
    // Major notables (BTC/ETH/XRP class) get guaranteed slots regardless of % move rank
    const isMajor = c => c.is_notable && (c.volume_usd ?? 0) >= MAJOR_NOTABLE_VOL;
    const majorTop  = crypto.filter(isMajor).sort(sort).slice(0, TOP_N_MAJOR_NOTABLE);
    const majorSyms = new Set(majorTop.map(c => c.symbol));
    const regularTop = crypto.filter(c => !majorSyms.has(c.symbol)).sort(sort).slice(0, TOP_N_CRYPTO - majorTop.length);
    const stockTop  = all.filter(c => c.direction === dir && c.category === 'Stock').sort(sort).slice(0, TOP_N_STOCKS);
    return [...majorTop, ...regularTop, ...stockTop].sort(sort).map((c, i) => ({ rank: i + 1, ...c }));
  }

  const longs  = topByDirection(scored, 'LONG');
  const shorts = topByDirection(scored, 'SHORT');

  const notablesIncluded = [...longs, ...shorts].filter(c => c.is_notable).length;

  // 6. Output — compact (no indent) for token efficiency
  const output = {
    built_at:         new Date().toISOString(),
    top_n:            TOP_N_CRYPTO + TOP_N_STOCKS,
    long_candidates:  longs,
    short_candidates: shorts,
    meta: {
      crypto_scanned:            scan?.clean_symbols  ?? 0,
      stocks_fetched:            stocksData?.successful ?? 0,
      notable_altcoins_included: notablesIncluded,
      scan_age_minutes:          usedFreshScan ? 0 : scanAgeMinutes(scan),
      used_fresh_scan:           usedFreshScan,
      market_event:              scan?.market_event ?? null,
    },
  };

  process.stdout.write(JSON.stringify(output) + '\n');
}

main();
