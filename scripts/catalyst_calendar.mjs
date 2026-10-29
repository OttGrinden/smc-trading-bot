#!/usr/bin/env node
/**
 * catalyst_calendar.mjs — Upcoming earnings fetcher for registry stock symbols.
 *
 * Source:  Nasdaq earnings calendar API (public, no auth).
 *          Fetches the next WINDOW_DAYS calendar days in parallel (one request
 *          per date). Build symbol→earningsDate map, then looks up each
 *          registry stock symbol.
 *
 * Cache:   trading/cache/catalyst_calendar.json — full-dataset TTL 6h.
 *          One re-fetch refreshes all symbols at once (21 lightweight requests
 *          rather than 92 per-symbol Yahoo Finance calls).
 *
 * Stdout:  JSON { fetched, cached, refreshed, failed, catalyst_data }
 *          catalyst_data: { [symbol]: { earnings_date, days_until,
 *                                       within_7_days, within_14_days,
 *                                       report_time, fetched_at } }
 *          Symbols with no earnings in the window: earnings_date=null.
 *
 * Runs as softStep in scan.mjs — never fatal to the pipeline.
 * scan.mjs injects catalyst_data into each candidate as `catalyst_upcoming`.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname }               from 'path';
import { fileURLToPath }               from 'url';

const __dirname     = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, '..', 'trading', 'registry', 'registry.json');
const CACHE_PATH    = join(__dirname, '..', 'trading', 'cache', 'catalyst_calendar.json');

const NASDAQ_BASE   = 'https://api.nasdaq.com/api/calendar/earnings';
const WINDOW_DAYS   = 21;                   // look ahead 3 weeks
const CACHE_TTL_MS  = 6 * 60 * 60 * 1000;  // 6h — full-dataset TTL
const FETCH_TIMEOUT = 8_000;                // per date request
const CONCURRENCY   = 10;                   // parallel date fetches (lightweight)
const BATCH_DELAY_MS = 100;                 // ms between batches

// ─── Registry ─────────────────────────────────────────────────────────────────

function loadStockSymbols() {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const symbols   = new Set();
  for (const sector of Object.values(registry.stocks?.sectors ?? {})) {
    for (const entry of (sector.watchlist ?? [])) {
      if (entry.symbol) symbols.add(entry.symbol.toUpperCase());
    }
  }
  for (const sym of (registry.pinned_symbols ?? [])) {
    symbols.add(sym.toUpperCase());
  }
  return [...symbols].sort();
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return { version: '1.0', symbols: {} };
  }
}

function saveCache(cache) {
  cache.last_updated = new Date().toISOString();
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

function cacheIsFresh(cache) {
  if (!cache?.last_full_fetch_at) return false;
  return Date.now() - new Date(cache.last_full_fetch_at).getTime() < CACHE_TTL_MS;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** Returns 'YYYY-MM-DD' for date = today + offsetDays. */
function isoDate(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toUTCString().slice(0, 16); // Not reliable — use manual approach
}

function offsetDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dy}`;
}

// ─── Nasdaq earnings fetch ────────────────────────────────────────────────────

/**
 * Fetch earnings for a single date string (YYYY-MM-DD).
 * Returns array of { symbol, date_str } — empty array on failure.
 */
async function fetchEarningsForDate(dateStr) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const url        = `${NASDAQ_BASE}?date=${dateStr}`;

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept':     'application/json, text/plain, */*',
      },
    });
    clearTimeout(timer);

    if (!res.ok) return { date: dateStr, rows: [], error: `HTTP_${res.status}` };

    const data = await res.json();
    const rows = data?.data?.rows ?? [];

    return {
      date:  dateStr,
      rows:  rows.map(r => ({
        symbol:      (r.symbol ?? '').toUpperCase().trim(),
        report_time: r.time ?? null,         // e.g. "time-pre-market", "time-after-hours"
        eps_forecast: r.epsForecast ?? null,
      })).filter(r => r.symbol),
      error: null,
    };

  } catch (e) {
    clearTimeout(timer);
    return { date: dateStr, rows: [], error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

// ─── Concurrency helper ────────────────────────────────────────────────────────

async function runBatched(items, fn, concurrency, delayMs) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch   = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(item => fn(item)));
    for (const s of settled) {
      results.push(s.status === 'fulfilled' ? s.value : { rows: [], error: s.reason?.message });
    }
    if (i + concurrency < items.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const stockSymbols = loadStockSymbols();
  const cache        = loadCache();
  const now          = Date.now();

  // ── Cache hit: use stored data, skip network ────────────────────────────────
  if (cacheIsFresh(cache)) {
    const ageMin = Math.round((now - new Date(cache.last_full_fetch_at).getTime()) / 60_000);
    process.stderr.write(JSON.stringify({
      info:    'catalyst_calendar_cache_hit',
      age_min: ageMin,
      ttl_min: Math.round(CACHE_TTL_MS / 60_000),
    }) + '\n');

    const catalyst_data = buildCatalystData(stockSymbols, cache.symbols ?? {}, now);
    logUpcoming(catalyst_data);
    process.stdout.write(JSON.stringify({
      fetched: stockSymbols.length, cached: stockSymbols.length,
      refreshed: 0, failed: 0, catalyst_data,
    }));
    return;
  }

  // ── Full re-fetch: query the next WINDOW_DAYS calendar dates in parallel ────
  const dates = Array.from({ length: WINDOW_DAYS }, (_, i) => offsetDate(i));

  process.stderr.write(JSON.stringify({
    info:        'catalyst_calendar_start',
    window_days: WINDOW_DAYS,
    dates_start: dates[0],
    dates_end:   dates[dates.length - 1],
    symbols:     stockSymbols.length,
  }) + '\n');

  const dateResults = await runBatched(dates, fetchEarningsForDate, CONCURRENCY, BATCH_DELAY_MS);

  // ── Build symbol → { date_str, report_time, eps_forecast } map ──────────────
  const earningsMap = {};  // { SYMBOL: { date_str, report_time, eps_forecast } }
  let failedDates   = 0;

  for (const dr of dateResults) {
    if (dr.error) { failedDates++; continue; }
    for (const row of dr.rows) {
      // Keep the earliest date per symbol (first occurrence wins).
      if (!earningsMap[row.symbol]) {
        earningsMap[row.symbol] = {
          date_str:     dr.date,
          report_time:  row.report_time,
          eps_forecast: row.eps_forecast,
        };
      }
    }
  }

  // ── Populate cache for every registry symbol ─────────────────────────────────
  const fetchedAt = new Date().toISOString();
  const newSymbols = {};

  for (const sym of stockSymbols) {
    const hit = earningsMap[sym];
    if (hit) {
      const nextMs    = new Date(hit.date_str + 'T12:00:00Z').getTime(); // noon UTC as proxy
      const daysUntil = Math.ceil((nextMs - now) / 86_400_000);
      newSymbols[sym] = {
        earnings_date:  new Date(nextMs).toISOString(),
        days_until:     Math.max(0, daysUntil),
        within_7_days:  daysUntil >= 0 && daysUntil <= 7,
        within_14_days: daysUntil >= 0 && daysUntil <= 14,
        report_time:    hit.report_time,
        eps_forecast:   hit.eps_forecast,
        fetched_at:     fetchedAt,
      };
    } else {
      newSymbols[sym] = {
        earnings_date:  null, days_until: null,
        within_7_days:  false, within_14_days: false,
        report_time:    null, eps_forecast: null,
        fetched_at:     fetchedAt,
      };
    }
  }

  // ── Persist ─────────────────────────────────────────────────────────────────
  cache.version           = '1.0';
  cache.last_full_fetch_at = fetchedAt;
  cache.window_days       = WINDOW_DAYS;
  cache.symbols           = newSymbols;
  saveCache(cache);

  // ── Output ──────────────────────────────────────────────────────────────────
  const catalyst_data = buildCatalystData(stockSymbols, newSymbols, now);
  logUpcoming(catalyst_data);

  process.stderr.write(JSON.stringify({
    info:         'catalyst_calendar_done',
    symbols:      stockSymbols.length,
    with_earnings: Object.values(catalyst_data).filter(v => v.earnings_date).length,
    failed_dates: failedDates,
    upcoming_7d:  Object.values(catalyst_data).filter(v => v.within_7_days).length,
    upcoming_14d: Object.values(catalyst_data).filter(v => v.within_14_days).length,
  }) + '\n');

  process.stdout.write(JSON.stringify({
    fetched:      stockSymbols.length,
    cached:       0,
    refreshed:    stockSymbols.length,
    failed:       failedDates,
    catalyst_data,
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildCatalystData(symbols, stored, now) {
  const out = {};
  for (const sym of symbols) {
    const e = stored[sym];
    if (!e) continue;
    out[sym] = {
      earnings_date:  e.earnings_date  ?? null,
      days_until:     e.days_until     ?? null,
      within_7_days:  e.within_7_days  ?? false,
      within_14_days: e.within_14_days ?? false,
      report_time:    e.report_time    ?? null,
      eps_forecast:   e.eps_forecast   ?? null,
      fetched_at:     e.fetched_at,
    };
  }
  return out;
}

function logUpcoming(catalyst_data) {
  const u7  = Object.entries(catalyst_data).filter(([, v]) => v.within_7_days);
  const u14 = Object.entries(catalyst_data).filter(([, v]) => v.within_14_days && !v.within_7_days);
  if (u7.length || u14.length) {
    process.stderr.write(JSON.stringify({
      info:            'catalyst_calendar_upcoming',
      within_7_days:   u7.map( ([s, v]) => `${s} in ${v.days_until}d (${v.report_time ?? '?'})`),
      within_8_14_days: u14.map(([s, v]) => `${s} in ${v.days_until}d (${v.report_time ?? '?'})`),
    }) + '\n');
  }
}

main().catch(e => {
  process.stderr.write(JSON.stringify({ error: 'catalyst_calendar_crashed', detail: e.message }) + '\n');
  process.exit(1);
});
