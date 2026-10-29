#!/usr/bin/env node
/**
 * Phase 4A — Registry Validation
 * Checks every notable_altcoin in registry.json against live Bitunix tickers.
 * Outputs: available, missing, and volume info for context.
 * Run: node scripts/validate_registry.mjs
 */

import { readFileSync } from 'fs';
import { fetchTickers, toExchangeSymbol, toInternalSymbol } from './market_scanner.mjs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const REGISTRY_PATH = join(TRADING_DIR, 'registry', 'registry.json');

const reg    = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
const pinned = new Set(reg.pinned_symbols ?? []);

process.stderr.write('Fetching live Bitunix tickers...\n');
const tickers = await fetchTickers();

// Build index: base symbol (e.g. BTC) → ticker object
const available = new Map();
for (const t of tickers) {
  if (!t.symbol?.endsWith('USDT')) continue;
  const base = toInternalSymbol(t.symbol);
  available.set(base, t);
}

process.stdout.write(`Live Bitunix USDT pairs: ${available.size}\n\n`);

// --- Check notable_altcoins --------------------------------------------------

const notable = reg.crypto?.notable_altcoins ?? [];
const found   = [];
const missing = [];

for (const sym of notable) {
  const t = available.get(sym);
  if (t) {
    found.push({
      symbol:     sym,
      exchange:   toExchangeSymbol(sym),
      volume_usd: Math.round(parseFloat(t.quoteVol || 0)),
      price_usd:  parseFloat(t.lastPrice || 0),
    });
  } else {
    missing.push(sym);
  }
}

process.stdout.write(`=== notable_altcoins (${notable.length} total) ===\n`);
process.stdout.write(`  Available on Bitunix: ${found.length}\n`);
process.stdout.write(`  Missing from Bitunix: ${missing.length}\n\n`);

if (found.length) {
  process.stdout.write('Available:\n');
  for (const f of found.sort((a, b) => b.volume_usd - a.volume_usd)) {
    process.stdout.write(`  ${f.symbol.padEnd(10)} ${f.exchange.padEnd(14)} vol=$${(f.volume_usd / 1_000_000).toFixed(1)}M  price=$${f.price_usd}\n`);
  }
}

if (missing.length) {
  process.stdout.write(`\nMissing (not available on Bitunix as USDT-perpetual):\n`);
  for (const m of missing) {
    process.stdout.write(`  ${m}\n`);
  }
}

// --- Check pinned_symbols (stocks — just informational) ----------------------

process.stdout.write(`\n=== pinned_symbols (stocks, informational) ===\n`);
for (const sym of pinned) {
  process.stdout.write(`  ${sym} (stock — not checked against Bitunix)\n`);
}

process.stdout.write('\nDone.\n');
