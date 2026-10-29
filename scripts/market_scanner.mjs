#!/usr/bin/env node
/**
 * Bitunix Futures Market Scanner
 * Anti-scam filters: volume, price sanity, manipulation range, extreme pumps
 * All candidates are Bitunix USDT-perpetual futures (pure crypto, no tokenized stocks)
 */

import { writeFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath }               from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const REGISTRY_PATH = join(TRADING_DIR, 'registry', 'registry.json');
const BITUNIX_BASE  = 'https://fapi.bitunix.com';

// --- Symbol normalization ----------------------------------------------------
// Centralized: never scatter replace('USDT','') across the codebase.

/** Exchange symbol → internal symbol:  BTCUSDT → BTC */
export function toInternalSymbol(exchangeSymbol) {
  return String(exchangeSymbol).replace(/USDT$/, '');
}

/** Internal symbol → exchange symbol:  BTC → BTCUSDT */
export function toExchangeSymbol(internalSymbol) {
  return String(internalSymbol).toUpperCase() + 'USDT';
}

// --- Registry ----------------------------------------------------------------

export function loadNotableSymbols() {
  try {
    const reg = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    return new Set(reg.crypto?.notable_altcoins ?? []);
  } catch {
    return new Set();
  }
}

// --- 24h change --------------------------------------------------------------
// Bitunix tickers have no pre-computed changePercent field.
// Spec: use open → lastPrice (not high/low which describe the range, not the move).

/**
 * Returns 24h change % (4 decimal precision) or null if inputs are invalid.
 * open must be > 0; both lastPrice and open must be finite numbers.
 */
export function compute24hChange(ticker) {
  const last = parseFloat(ticker.lastPrice);
  const open = parseFloat(ticker.open);
  if (!Number.isFinite(last) || !Number.isFinite(open) || open <= 0) return null;
  return +((last - open) / open * 100).toFixed(4);
}

// --- Scam / quality filter ---------------------------------------------------
// Adapted from MEXC version: field names updated for Bitunix (quoteVol, open, etc.)

/**
 * Returns a rejection reason string, or null if the ticker passes all checks.
 */
export function scamFilter(t) {
  const vol   = parseFloat(t.quoteVol  || 0);
  const price = parseFloat(t.lastPrice || 0);
  const open  = parseFloat(t.open      || 0);
  const high  = parseFloat(t.high      || 0);
  const low   = parseFloat(t.low       || price);
  const chg   = compute24hChange(t) ?? 0;

  if (vol   < 75_000)                              return 'vol<75K';
  if (price < 0.000001)                            return 'price_dust';
  if (open  <= 0)                                  return 'bad_open';
  if (Math.abs(chg) > 200 && vol < 2_000_000)     return 'extreme_pump_low_vol';
  if (low   > 0 && high / low > 25)               return 'manipulation_range';
  return null;
}

// --- Ranking sort comparator -------------------------------------------------
// Primary: 24h change descending (biggest gainer first).
// Tiebreaker: higher quoteVol first — deterministic, no random tie behaviour.

export function compareByChange(a, b) {
  const chgA = compute24hChange(a) ?? 0;
  const chgB = compute24hChange(b) ?? 0;
  if (chgB !== chgA) return chgB - chgA;
  return parseFloat(b.quoteVol || 0) - parseFloat(a.quoteVol || 0);
}

// --- Ticker formatter --------------------------------------------------------

export function formatTicker(t, dir) {
  return {
    symbol:     t.symbol,
    base:       toInternalSymbol(t.symbol),
    direction:  dir,
    change_pct: +((compute24hChange(t) ?? 0)).toFixed(2),
    price_usd:  parseFloat(t.lastPrice),
    volume_usd: Math.round(parseFloat(t.quoteVol)),
    category:   'Crypto',
  };
}

// --- Notable altcoin quotes --------------------------------------------------

export function buildNotableQuotes(clean, notableSymbols) {
  const byBase = new Map(clean.map(t => [toInternalSymbol(t.symbol), t]));
  const quotes = [];
  for (const sym of notableSymbols) {
    const t = byBase.get(sym);
    if (!t) continue;
    const chg = compute24hChange(t);
    if (chg === null) continue;
    quotes.push({
      symbol:     t.symbol,
      base:       sym,
      direction:  chg > 0 ? 'LONG' : chg < 0 ? 'SHORT' : 'NEUTRAL',
      change_pct: +chg.toFixed(2),
      price_usd:  parseFloat(t.lastPrice),
      volume_usd: Math.round(parseFloat(t.quoteVol)),
      category:   'Crypto',
    });
  }
  return quotes;
}

// --- API fetch ---------------------------------------------------------------

export async function fetchTickers() {
  const res = await fetch(`${BITUNIX_BASE}/api/v1/futures/market/tickers`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Bitunix HTTP ${res.status}: ${res.statusText}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`api_error_${json.code}: ${json.msg ?? 'unknown'}`);
  if (!Array.isArray(json.data)) throw new Error('tickers_response_no_data_array');
  return json.data;
}

// --- Market open label (unchanged) -------------------------------------------

function marketOpenLabel(utcHour, utcMin) {
  const t = utcHour * 100 + utcMin;
  if (t >= 0    && t < 30)   return 'Tokyo Open (TSE 09:00 JST)';
  if (t >= 130  && t < 200)  return 'Hong Kong Open (HKEX 09:30 HKT)';
  if (t >= 700  && t < 730)  return 'Frankfurt Open (XETRA 09:00 CEST)';
  if (t >= 800  && t < 830)  return 'London Open (LSE 09:00 BST)';
  if (t >= 1330 && t < 1400) return 'New York Open (NYSE/NASDAQ 09:30 EDT)';
  return null;
}

// --- Core scan logic (exported for testing) ----------------------------------

export function buildScanOutput(tickers, notableSymbols, now = new Date()) {
  const usdtPairs = tickers.filter(t => t.symbol?.endsWith('USDT'));

  let scamCount = 0;
  const clean = usdtPairs.filter(t => {
    const reason = scamFilter(t);
    if (reason) { scamCount++; return false; }
    return true;
  });

  clean.sort(compareByChange);

  const notableQuotes = buildNotableQuotes(clean, notableSymbols);

  return {
    scanned_at:             now.toISOString(),
    market_event:           marketOpenLabel(now.getUTCHours(), now.getUTCMinutes()),
    total_usdt:             usdtPairs.length,
    filtered_scam:          scamCount,
    clean_symbols:          clean.length,
    top_gainers:            clean.slice(0, 20).map(t => formatTicker(t, 'LONG')),
    top_losers:             clean.slice(-20).reverse().map(t => formatTicker(t, 'SHORT')),
    notable_altcoin_quotes: notableQuotes,
  };
}

// --- CLI entry point ---------------------------------------------------------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const now = new Date();

  fetchTickers()
    .then(tickers => {
      const notableSymbols = loadNotableSymbols();
      const output         = buildScanOutput(tickers, notableSymbols, now);

      process.stdout.write(JSON.stringify(output, null, 2) + '\n');

      const cacheDir  = join(TRADING_DIR, 'cache');
      const timestamp = now.toISOString().slice(0, 16).replaceAll(':', '').replace('T', '_');
      const cachePath = join(cacheDir, `scan_${timestamp}.json`);
      try {
        writeFileSync(cachePath, JSON.stringify(output, null, 2) + '\n', 'utf8');
      } catch (e) {
        process.stderr.write(JSON.stringify({ warning: 'cache_write_failed', path: cachePath, error: e.message }) + '\n');
      }
    })
    .catch(e => {
      process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
      process.exit(1);
    });
}
