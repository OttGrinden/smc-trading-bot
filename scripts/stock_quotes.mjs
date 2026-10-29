#!/usr/bin/env node
/**
 * Stock Quote Fetcher
 * Reads registry.json, fetches Yahoo Finance quotes for all watchlist symbols,
 * outputs in the same JSON schema as market_scanner.mjs
 * Caches results in trading/cache/stocks_YYYYMMDD_HHMM.json (TTL: 60 min)
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const REGISTRY_PATH        = join(TRADING_DIR, 'registry', 'registry.json');
const STOCKS_CACHE_DIR     = join(TRADING_DIR, 'cache');
const STOCKS_CACHE_TTL_MIN = 60;   // minutes — cache is valid for this long
const YAHOO_BASE           = 'https://query1.finance.yahoo.com/v8/finance/chart';
const BATCH_SIZE           = 10;
const TIMEOUT_MS           = 8000;

// --- Cache helpers -----------------------------------------------------------

function findLatestStocksCache() {
  try {
    const files = readdirSync(STOCKS_CACHE_DIR)
      .filter(f => f.startsWith('stocks_') && f.endsWith('.json'))
      .sort()
      .reverse();
    return files.length ? join(STOCKS_CACHE_DIR, files[0]) : null;
  } catch {
    return null;
  }
}

function loadStocksCache(cachePath) {
  if (!cachePath) return null;
  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (!data?.fetched_at) return null;
    const ageMs         = Date.now() - new Date(data.fetched_at).getTime();
    const cache_age_minutes = +(ageMs / 60_000).toFixed(1);
    if (cache_age_minutes > STOCKS_CACHE_TTL_MIN) return null; // stale → cache miss
    // fetched_at is preserved from the original data — not set to "now"
    return { ...data, cache_hit: true, cache_age_minutes };
  } catch {
    return null; // unreadable → cache miss
  }
}

function writeStocksCache(output) {
  try {
    const ts        = new Date().toISOString().slice(0, 16).replaceAll(':', '').replace('T', '_');
    const cachePath = join(STOCKS_CACHE_DIR, `stocks_${ts}.json`);
    writeFileSync(cachePath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  } catch (e) {
    process.stderr.write(
      JSON.stringify({ warning: 'stocks_cache_write_failed', error: e.message }) + '\n'
    );
  }
}

// --- Registry ----------------------------------------------------------------

function loadRegistrySymbols() {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const seen     = new Map(); // symbol → { name, sector, tags }

  for (const [sectorKey, sector] of Object.entries(registry.stocks.sectors)) {
    for (const entry of sector.watchlist) {
      if (!seen.has(entry.symbol)) {
        seen.set(entry.symbol, {
          name:   entry.name,
          sector: sectorKey,
          tags:   entry.tags ?? [],
        });
      }
    }
  }
  return seen;
}

// --- Fetch -------------------------------------------------------------------

async function fetchQuote(symbol, meta) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url        = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data   = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result)  throw new Error('no_result_in_response');

    const m         = result.meta;
    const price     = m.regularMarketPrice  ?? null;
    const volume    = m.regularMarketVolume ?? null;
    const prevClose = m.chartPreviousClose ?? m.previousClose ?? null;
    const volUsd    = (volume !== null && price !== null) ? Math.round(volume * price) : null;

    // regularMarketChangePercent is sometimes absent — calculate as fallback
    let changePct = m.regularMarketChangePercent ?? null;
    if (changePct === null) {
      const change = m.regularMarketChange ?? null;
      if (change !== null && prevClose !== null && prevClose !== 0) {
        changePct = (change / prevClose) * 100;
      } else if (price !== null && prevClose !== null && prevClose !== 0) {
        changePct = ((price - prevClose) / prevClose) * 100;
      }
    }

    return {
      symbol,
      name:       meta.name,
      sector:     meta.sector,
      tags:       meta.tags,
      direction:  changePct > 0 ? 'LONG' : changePct < 0 ? 'SHORT' : 'NEUTRAL',
      change_pct: changePct !== null ? +changePct.toFixed(2) : null,
      price_usd:  price,
      prev_close: prevClose,
      volume_usd: volUsd,
      category:   'Stock',
      error:      null,
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      symbol,
      name:       meta.name,
      sector:     meta.sector,
      tags:       meta.tags,
      direction:  null,
      change_pct: null,
      price_usd:  null,
      prev_close: null,
      volume_usd: null,
      category:   'Stock',
      error:      e.name === 'AbortError' ? 'timeout' : e.message,
    };
  }
}

// --- Main --------------------------------------------------------------------

async function main() {
  // 1. Try cache first
  const cachePath  = findLatestStocksCache();
  const cachedData = loadStocksCache(cachePath);

  if (cachedData) {
    process.stderr.write(
      JSON.stringify({ info: 'stocks_cache_hit', age_minutes: cachedData.cache_age_minutes }) + '\n'
    );
    process.stdout.write(JSON.stringify(cachedData, null, 2) + '\n');
    return;
  }

  // 2. Cache miss — fetch live
  const symbolMap = loadRegistrySymbols();
  const entries   = [...symbolMap.entries()];
  const results   = [];

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch   = entries.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(([sym, meta]) => fetchQuote(sym, meta))
    );
    for (const r of settled) {
      results.push(r.status === 'fulfilled' ? r.value : { error: r.reason?.message });
    }
  }

  const successful = results.filter(r => r.error === null).length;
  const failed     = results.filter(r => r.error !== null).length;

  const output = {
    fetched_at:         new Date().toISOString(),
    source:             'yahoo_finance',
    cache_hit:          false,
    cache_age_minutes:  0,
    total_symbols:      entries.length,
    successful,
    failed,
    quotes:             results,
  };

  // 3. Write to cache (non-fatal)
  writeStocksCache(output);

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch(e => {
  process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
  process.exit(1);
});
