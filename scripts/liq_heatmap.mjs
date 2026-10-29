#!/usr/bin/env node
/**
 * liq_heatmap.mjs — Liquidation Zone Detector via Bitunix Order Book Depth
 *
 * Analysiert das Bitunix Order Book (limit=max) für wichtige Crypto-Assets:
 * - Aggregiert Orders in 0.5%-Preisbuckets
 * - Identifiziert "Mauern" (Cluster mit ≥2x Durchschnittsvolumen)
 * - Kurzquetsch-Zonen: Große Sell-Walls ÜBER aktuellem Preis (Short-Squeeze-Magnete)
 * - Longquetsch-Zonen: Große Buy-Walls UNTER aktuellem Preis (Long-Squeeze-Magnete)
 * - Bias-Beurteilung: Buy/Sell-Druck in nächster ±5% Zone
 *
 * Schreibt in trading/cache/liq_heatmap.json
 * Fail-soft: einzelne Symbol-Fehler abgefangen, Exit immer 0
 *
 * Usage: node liq_heatmap.mjs
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const CACHE_PATH   = join(TRADING_DIR, 'cache', 'liq_heatmap.json');
const LOGS_DIR     = join(TRADING_DIR, 'logs');
const BITUNIX_BASE = 'https://fapi.bitunix.com';

// Symbole: immer BTC, ETH + XRP als Standard + aktuelle Crypto-Kandidaten aus letztem Run
const ANCHOR_SYMBOLS = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB'];
const BUCKET_PCT     = 0.5;   // 0.5% Bucket-Breite
const WALL_FACTOR    = 2.5;   // Wall = Bucket mit ≥2.5x Durchschnittsvolumen
const NEAR_ZONE_PCT  = 5.0;   // Analyse-Zone ±5% vom aktuellen Preis
const MAX_AGE_MIN    = 14;    // Cache-Gültigkeit (< 15min loop interval)

// ─── Cache ────────────────────────────────────────────────────────────────────

function loadCache() {
  try { return JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}

function saveCache(data) {
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function cacheAge(entry) {
  if (!entry?.updated_at) return Infinity;
  return (Date.now() - new Date(entry.updated_at).getTime()) / 60000;
}

// ─── Load crypto candidates from latest run log ───────────────────────────────

function loadCryptoCandidates() {
  try {
    const files = readdirSync(LOGS_DIR)
      .filter(f => f.startsWith('run_') && f.endsWith('.json'))
      .sort().reverse();
    if (!files.length) return [];
    const run = JSON.parse(readFileSync(join(LOGS_DIR, files[0]), 'utf8'));
    const all = [...(run.long_candidates ?? []), ...(run.short_candidates ?? [])];
    return all.filter(c => c.category !== 'Stock').map(c => c.symbol);
  } catch { return []; }
}

// ─── Bitunix depth fetch ──────────────────────────────────────────────────────

async function fetchDepth(symbol) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${BITUNIX_BASE}/api/v1/futures/market/depth?symbol=${symbol}USDT&limit=max`;
    const res  = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== 0) throw new Error(`api_${json.code}: ${json.msg}`);
    return json.data;  // { asks: [[price,size],...], bids: [[price,size],...] }
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
  }
}

// ─── Order book analysis ──────────────────────────────────────────────────────

function analyzeDepth(symbol, data) {
  const asks = data.asks.map(([p, s]) => ({ p: +p, s: +s }));
  const bids = data.bids.map(([p, s]) => ({ p: +p, s: +s }));

  if (!asks.length || !bids.length) throw new Error('empty_depth');

  // Current mid price
  const bestAsk   = Math.min(...asks.map(x => x.p));
  const bestBid   = Math.max(...bids.map(x => x.p));
  const midPrice  = (bestAsk + bestBid) / 2;

  // ── Bucket aggregation ──────────────────────────────────────────────────────
  // Group orders into 0.5% price buckets, compute USD notional per bucket
  function bucketOrders(orders, side) {
    const map = new Map();
    for (const { p, s } of orders) {
      const key = Math.round(p / (midPrice * BUCKET_PCT / 100)) * (midPrice * BUCKET_PCT / 100);
      const existing = map.get(key) ?? { price: key, size: 0, notional: 0, side, count: 0 };
      existing.size     += s;
      existing.notional += p * s;
      existing.count++;
      map.set(key, existing);
    }
    return Array.from(map.values()).sort((a, b) => a.price - b.price);
  }

  const askBuckets = bucketOrders(asks, 'sell');
  const bidBuckets = bucketOrders(bids, 'buy');

  // ── Wall detection ──────────────────────────────────────────────────────────
  function findWalls(buckets) {
    if (!buckets.length) return [];
    const avgNotional = buckets.reduce((s, b) => s + b.notional, 0) / buckets.length;
    return buckets
      .filter(b => b.notional >= avgNotional * WALL_FACTOR)
      .map(b => ({
        price:        +b.price.toFixed(8),
        notional_usd: Math.round(b.notional),
        size:         +b.size.toFixed(4),
        pct_away:     +((b.price - midPrice) / midPrice * 100).toFixed(2),
      }));
  }

  const sellWalls = findWalls(askBuckets).filter(w => w.price > midPrice);
  const buyWalls  = findWalls(bidBuckets).filter(w => w.price < midPrice);

  // ── Near-zone analysis (±NEAR_ZONE_PCT%) ────────────────────────────────────
  const lo = midPrice * (1 - NEAR_ZONE_PCT / 100);
  const hi = midPrice * (1 + NEAR_ZONE_PCT / 100);

  const nearAsks = asks.filter(x => x.p > midPrice && x.p <= hi);
  const nearBids = bids.filter(x => x.p < midPrice && x.p >= lo);
  const nearSellNotional = nearAsks.reduce((s, x) => s + x.p * x.s, 0);
  const nearBuyNotional  = nearBids.reduce((s, x) => s + x.p * x.s, 0);

  // Bias: where is more liquidity concentrated?
  const ratio = nearBuyNotional / (nearSellNotional || 1);
  let bias;
  if      (ratio >= 2.0) bias = 'buy_dominant';     // Strong buy walls below → potential support, stop-hunt downward
  else if (ratio >= 1.3) bias = 'slight_buy';
  else if (ratio <= 0.5) bias = 'sell_dominant';    // Strong sell walls above → short-squeeze potential
  else if (ratio <= 0.77) bias = 'slight_sell';
  else                   bias = 'balanced';

  // Short-squeeze indicator: are there big sell walls above that become price magnets?
  const nearSellWalls = sellWalls.filter(w => w.pct_away <= NEAR_ZONE_PCT);
  const squeezePotential = nearSellWalls.length > 0 && bias !== 'buy_dominant'
    ? 'short_squeeze_zones_detected'
    : nearBuyNotional > nearSellNotional * 2
    ? 'long_squeeze_zones_detected'
    : 'none';

  return {
    symbol,
    current_price:          +midPrice.toFixed(8),
    sell_walls:             sellWalls.slice(0, 5),   // Top 5 sell walls above price
    buy_walls:              buyWalls.slice(0, 5),    // Top 5 buy walls below price
    nearest_sell_wall:      sellWalls.sort((a,b) => a.pct_away - b.pct_away)[0] ?? null,
    nearest_buy_wall:       buyWalls.sort((a,b) => b.pct_away - a.pct_away)[0] ?? null,
    biggest_sell_wall:      [...sellWalls].sort((a,b) => b.notional_usd - a.notional_usd)[0] ?? null,
    biggest_buy_wall:       [...buyWalls].sort((a,b) => b.notional_usd - a.notional_usd)[0] ?? null,
    near_zone_pct:          NEAR_ZONE_PCT,
    near_sell_notional_usd: Math.round(nearSellNotional),
    near_buy_notional_usd:  Math.round(nearBuyNotional),
    buy_sell_ratio:         +ratio.toFixed(2),
    bias,
    squeeze_potential:      squeezePotential,
    ask_levels:             asks.length,
    bid_levels:             bids.length,
    updated_at:             new Date().toISOString(),
  };
}

// ─── Export: read from cache ──────────────────────────────────────────────────

export function readLiqHeatmap(symbol) {
  try {
    const cache = loadCache();
    const entry = cache[symbol?.toUpperCase()];
    if (!entry) return { available: false, reason: 'not_cached' };
    const age = cacheAge(entry);
    if (age > MAX_AGE_MIN) return { available: false, reason: 'stale', age_minutes: Math.round(age) };
    return { available: true, age_minutes: Math.round(age), ...entry };
  } catch { return { available: false, reason: 'read_error' }; }
}

// ─── Summary string for output ────────────────────────────────────────────────

export function liqHeatmapSummary(entry) {
  if (!entry?.available) return '—';
  const parts = [];
  if (entry.nearest_sell_wall)
    parts.push(`SellWall $${entry.nearest_sell_wall.price.toFixed(2)} (+${entry.nearest_sell_wall.pct_away}%)`);
  if (entry.nearest_buy_wall)
    parts.push(`BuyWall $${entry.nearest_buy_wall.price.toFixed(2)} (${entry.nearest_buy_wall.pct_away}%)`);
  if (entry.squeeze_potential !== 'none')
    parts.push(entry.squeeze_potential === 'short_squeeze_zones_detected' ? '⚡ ShortSqueeze' : '⚠ LongSqueeze');
  return parts.join(' · ') || '—';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cache = loadCache();

  // Determine symbols to fetch
  const candidateSyms = loadCryptoCandidates();
  const symbols = [...new Set([...ANCHOR_SYMBOLS, ...candidateSyms])];

  process.stderr.write(JSON.stringify({ info: 'liq_heatmap_start', symbols }) + '\n');

  let fetched = 0; let failed = 0;

  for (const sym of symbols) {
    // Skip if fresh cache exists
    if (cacheAge(cache[sym]) < MAX_AGE_MIN) {
      process.stderr.write(JSON.stringify({ info: 'liq_heatmap_cached', symbol: sym,
        age_min: Math.round(cacheAge(cache[sym])) }) + '\n');
      continue;
    }

    try {
      const data   = await fetchDepth(sym);
      const result = analyzeDepth(sym, data);
      cache[sym] = result;
      fetched++;
      process.stderr.write(JSON.stringify({
        info:           'liq_heatmap_ok',
        symbol:         sym,
        price:          result.current_price,
        bias:           result.bias,
        squeeze:        result.squeeze_potential,
        nearest_sell:   result.nearest_sell_wall
          ? `$${result.nearest_sell_wall.price.toFixed(2)} (+${result.nearest_sell_wall.pct_away}%)`
          : null,
        nearest_buy:    result.nearest_buy_wall
          ? `$${result.nearest_buy_wall.price.toFixed(2)} (${result.nearest_buy_wall.pct_away}%)`
          : null,
        biggest_sell:   result.biggest_sell_wall
          ? `$${result.biggest_sell_wall.price.toFixed(2)} $${(result.biggest_sell_wall.notional_usd/1000).toFixed(0)}k (+${result.biggest_sell_wall.pct_away}%)`
          : null,
      }) + '\n');
    } catch (e) {
      failed++;
      process.stderr.write(JSON.stringify({ warn: 'liq_heatmap_failed', symbol: sym, error: e.message }) + '\n');
    }

    // Small delay between requests
    await new Promise(r => setTimeout(r, 300));
  }

  // Drop symbols no longer in the active candidate list
  const cleanedCache = Object.fromEntries(
    Object.entries(cache).filter(([sym]) => symbols.includes(sym))
  );
  const keysDropped = Object.keys(cache).length - Object.keys(cleanedCache).length;
  if (fetched > 0 || keysDropped > 0) saveCache(cleanedCache);
  process.stderr.write(JSON.stringify({ info: 'liq_heatmap_done', fetched, failed, total: symbols.length, keys_dropped: keysDropped }) + '\n');
  process.exit(0);
}

// Run if called directly
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('liq_heatmap.mjs');
if (isMain) main().catch(e => {
  process.stderr.write(JSON.stringify({ error: 'liq_heatmap_crashed', detail: e.message }) + '\n');
  process.exit(0);  // fail-soft
});
