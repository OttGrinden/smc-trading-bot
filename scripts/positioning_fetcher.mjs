#!/usr/bin/env node
/**
 * positioning_fetcher.mjs — Derivatives-Positioning für Crypto-Kandidaten
 *
 * Holt von der Bitunix Futures Public API (keine Auth, nur GET):
 *   - Funding Rate  GET /api/v1/futures/market/funding_rate?symbol=BTCUSDT
 *
 * Bitunix Public API (Stand Jul 2026) liefert kein L/S-Ratio und kein OI.
 * Diese Felder werden intern als null gesetzt — kein Ersatz, kein Halluzinieren.
 *
 * fundingRate auf Bitunix ist in PROZENT (z.B. "-0.006809" = -0.006809%).
 * Interne Konvention: Decimal-Fraction (÷100), analog Binance.
 * Beispiel: "-0.006809" → intern -0.00006809.
 *
 * Symbole: alle Crypto-Kandidaten aus dem letzten Run-Log + immer BTC und ETH
 * (Markt-Anker für Bull-/Bear-Phasen-Einordnung).
 *
 * Schreibt in einen EIGENEN Cache (trading/cache/positioning_data.json) —
 * bewusst NICHT in indicator_cache.json: writeIndicatorCache() überschreibt den kompletten
 * Symbol-Eintrag und würde RSI/MACD nullen (indicator_cache.mjs).
 *
 * Fail-soft: Netzwerk-/API-Fehler pro Symbol werden geloggt, der Prozess
 * endet IMMER mit Exit 0 — Positioning ist Enrichment, kein Pflicht-Schritt.
 *
 * Usage (CLI):    node positioning_fetcher.mjs
 * Usage (module): import { readPositioning, buildPositioningSummary } from './positioning_fetcher.mjs'
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const CACHE_PATH      = join(TRADING_DIR, 'cache', 'positioning_data.json');
const LOGS_DIR        = join(TRADING_DIR, 'logs');
const BITUNIX_BASE    = 'https://fapi.bitunix.com';
const DEFAULT_MAX_AGE = 90;   // Minuten
const ANCHOR_SYMBOLS  = ['BTC', 'ETH'];

// ─── Symbol normalization ─────────────────────────────────────────────────────

/** Internal symbol → exchange symbol:  BTC → BTCUSDT */
export function toExchangeSymbol(internalSymbol) {
  return String(internalSymbol).toUpperCase() + 'USDT';
}

/** Exchange symbol → internal symbol:  BTCUSDT → BTC */
export function toInternalSymbol(exchangeSymbol) {
  return String(exchangeSymbol).replace(/USDT$/, '');
}

// ─── Deterministische Schwellen ───────────────────────────────────────────────
export const POSITIONING_RULES = Object.freeze({
  CROWDED_LONG_RATIO:   2.0,     // L/S >= 2.0  → long-crowded
  CROWDED_SHORT_RATIO:  0.5,     // L/S <= 0.5  → short-crowded
  FUNDING_ELEVATED:     0.0005,  // |funding| >= 0.05%/8h
  FUNDING_EXTREME:      0.001,   // |funding| >= 0.10%/8h
});

// ─── Cache I/O ────────────────────────────────────────────────────────────────

function loadCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try   { return JSON.parse(readFileSync(CACHE_PATH, 'utf8')); }
  catch { return {}; }
}

function saveCache(data) {
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * prunePositioningCache — removes entries older than maxAgeMinutes.
 * Called once per scan after positioning fetch; prevents unbounded growth.
 */
export function prunePositioningCache(maxAgeMinutes = DEFAULT_MAX_AGE) {
  const cache = loadCache();
  const now   = Date.now();
  let pruned  = 0;
  for (const symbol of Object.keys(cache)) {
    const entry = cache[symbol];
    if (!entry?.positioning_at) { delete cache[symbol]; pruned++; continue; }
    const ageMs = now - new Date(entry.positioning_at).getTime();
    if (ageMs / 60_000 > maxAgeMinutes) { delete cache[symbol]; pruned++; }
  }
  if (pruned > 0) saveCache(cache);
  return { pruned, kept: Object.keys(cache).length };
}

export function writePositioning(symbol, data) {
  const cache = loadCache();
  cache[symbol.toUpperCase()] = { ...data, positioning_at: new Date().toISOString() };
  saveCache(cache);
  return { ok: true, symbol: symbol.toUpperCase() };
}

/**
 * readPositioning — Cache-Read mit eigener Freshness.
 * Returns { available:false, reason:'not_found'|'stale' } or { available:true, ...fields }
 */
export function readPositioning(symbol, maxAgeMinutes = DEFAULT_MAX_AGE) {
  const entry = loadCache()[symbol.toUpperCase()];
  if (!entry) return { available: false, reason: 'not_found', symbol: symbol.toUpperCase() };

  const ageMinutes = +((Date.now() - new Date(entry.positioning_at).getTime()) / 60_000).toFixed(1);
  if (ageMinutes > maxAgeMinutes) {
    return { available: false, reason: 'stale', symbol: symbol.toUpperCase(), age_minutes: ageMinutes };
  }
  return { available: true, symbol: symbol.toUpperCase(), age_minutes: ageMinutes, ...entry };
}

// ─── Pure Funktionen (offline testbar) ───────────────────────────────────────

/**
 * assessSqueezeRisk — deterministisches Squeeze-Flag aus Ratio + Funding.
 * Gibt null zurück wenn einer der Inputs fehlt (z.B. L/S nicht verfügbar).
 */
export function assessSqueezeRisk({ long_short_ratio, funding_rate }) {
  if (long_short_ratio == null || funding_rate == null) return null;
  const R = POSITIONING_RULES;
  if (long_short_ratio >= R.CROWDED_LONG_RATIO  && funding_rate >=  R.FUNDING_ELEVATED) return 'long_squeeze_risk';
  if (long_short_ratio <= R.CROWDED_SHORT_RATIO && funding_rate <= -R.FUNDING_ELEVATED) return 'short_squeeze_risk';
  return null;
}

/**
 * buildPositioningSummary — kompakte tabellenfertige Zeile.
 * Zeigt nur verfügbare Felder — kein Crash bei null-Werten.
 * Gibt '—' nur wenn gar keine Daten vorhanden (p null oder alle Felder null).
 */
export function buildPositioningSummary(p) {
  if (p == null) return '—';
  const parts = [];

  if (p.long_short_ratio != null) {
    const longPct = p.long_account_pct != null ? ` (${(p.long_account_pct * 100).toFixed(0)}% long)` : '';
    parts.push(`L/S ${p.long_short_ratio.toFixed(2)}${longPct}`);
  }
  if (p.funding_rate != null) {
    const f = p.funding_rate * 100;
    parts.push(`Fund ${f >= 0 ? '+' : ''}${f.toFixed(4)}%`);
  }
  if (p.oi_usd != null) {
    const oiB  = p.oi_usd >= 1e9
      ? `$${(p.oi_usd / 1e9).toFixed(1)}B`
      : `$${(p.oi_usd / 1e6).toFixed(0)}M`;
    const oiChg = p.oi_change_24h_pct != null
      ? ` (${p.oi_change_24h_pct >= 0 ? '+' : ''}${p.oi_change_24h_pct.toFixed(1)}%/24h)`
      : '';
    parts.push(`OI ${oiB}${oiChg}`);
  }

  if (parts.length === 0) return '—';

  const squeeze = assessSqueezeRisk(p);
  parts.push(squeeze ? `⚠ ${squeeze.replaceAll('_', '-')}` : 'balanced');
  return parts.join(' · ');
}

// ─── Bitunix Fetch (fail-soft pro Symbol) ────────────────────────────────────

export async function fetchPositioning(symbol) {
  const pair = toExchangeSymbol(symbol);
  const res  = await fetch(
    `${BITUNIX_BASE}/api/v1/futures/market/funding_rate?symbol=${pair}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${pair}`);

  const json = await res.json();
  if (json.code !== 0) throw new Error(`api_error_${json.code}: ${json.msg ?? 'unknown'}`);
  if (!json.data)      throw new Error('empty_response');

  const d = json.data;
  // Bitunix returns fundingRate in PERCENT — divide by 100 for internal decimal fraction.
  // markPrice is available here; used for context / future OI USD computation.
  const rawFunding = d.fundingRate != null ? parseFloat(d.fundingRate) : null;
  const markPrice  = d.markPrice   != null ? parseFloat(d.markPrice)  : null;

  const data = {
    source:            'bitunix_futures',
    pair,
    funding_rate:      Number.isFinite(rawFunding) ? +(rawFunding / 100).toFixed(8) : null,
    long_short_ratio:  null,   // Bitunix public API does not provide L/S ratio
    long_account_pct:  null,   // Bitunix public API does not provide L/S breakdown
    mark_price_usd:    Number.isFinite(markPrice)  ? markPrice  : null,
    oi_usd:            null,   // Bitunix public API does not provide OI
    oi_change_24h_pct: null,   // Bitunix public API does not provide OI history
  };
  data.squeeze_risk = assessSqueezeRisk(data);  // null (requires L/S ratio)
  data.summary      = buildPositioningSummary(data);
  return data;
}

// ─── CLI main ────────────────────────────────────────────────────────────────

function cryptoSymbolsFromLatestRun() {
  try {
    const files = readdirSync(LOGS_DIR)
      .filter(f => f.startsWith('run_') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (!files.length) return [];
    const run = JSON.parse(readFileSync(join(LOGS_DIR, files[0]), 'utf8'));
    const all = [...(run.long_candidates ?? []), ...(run.short_candidates ?? [])];
    // Nur echte Crypto — Tokenized Stocks haben keine Bitunix-Futures
    return [...new Set(all
      .filter(c => c.category === 'Crypto')
      .map(c => c.symbol.toUpperCase()))];
  } catch {
    return [];
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const symbols = [...new Set([...ANCHOR_SYMBOLS, ...cryptoSymbolsFromLatestRun()])];
  const results = { fetched: [], failed: [] };

  for (const sym of symbols) {
    try {
      const data = await fetchPositioning(sym);
      writePositioning(sym, data);
      results.fetched.push(sym);
      process.stderr.write(JSON.stringify({ info: 'positioning_fetched', symbol: sym, summary: data.summary }) + '\n');
    } catch (e) {
      results.failed.push({ symbol: sym, error: e.message });
      process.stderr.write(JSON.stringify({ warn: 'positioning_fetch_failed', symbol: sym, detail: e.message }) + '\n');
    }
  }

  process.stderr.write(JSON.stringify({
    info:    'positioning_done',
    fetched: results.fetched.length,
    failed:  results.failed.length,
    cache:   CACHE_PATH,
  }) + '\n');
  process.exit(0);   // IMMER 0 — Enrichment darf den Scan nie killen
}
