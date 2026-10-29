#!/usr/bin/env node
/**
 * Regression-Test: Phase 4A Registry Validation
 *
 * RA-01  Jedes notable_altcoin ist auf Bitunix als USDT-Perpetual auflösbar
 * RA-02  Keine MEXC-Artefakte in registry.json (tokenized_stocks, MEXC-Kommentare)
 * RA-03  Symbol-Roundtrip: toExchangeSymbol(sym) → toInternalSymbol() → sym
 */

import { readFileSync } from 'fs';
import { fetchTickers, toExchangeSymbol, toInternalSymbol } from '../../market_scanner.mjs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', '..', '..', 'trading');

const REGISTRY_PATH = join(TRADING_DIR, 'registry', 'registry.json');

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } else {
    process.stdout.write(`  FAIL  ${name}${detail ? ': ' + detail : ''}\n`);
    failed++;
  }
}

const reg     = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
const regStr  = JSON.stringify(reg);
const notable = reg.crypto?.notable_altcoins ?? [];

// ── RA-01: Alle notable_altcoins auflösbar auf Bitunix ────────────────────────

process.stdout.write('\nRA-01  Alle notable_altcoins auf Bitunix als USDT-Perpetual auflösbar\n');

process.stderr.write('Fetching live Bitunix tickers...\n');
const tickers = await fetchTickers();
const availableSet = new Set(
  tickers
    .filter(t => t.symbol?.endsWith('USDT'))
    .map(t => toInternalSymbol(t.symbol))
);

ok(`notable_altcoins not empty`, notable.length > 0, `length=${notable.length}`);

const missing = notable.filter(sym => !availableSet.has(sym));
ok('no notable symbol missing from Bitunix', missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : '');

// Individual spot-checks for anchors
for (const anchor of ['BTC', 'ETH', 'SOL', '1000PEPE', '1000BONK']) {
  ok(`${anchor} in notable + on Bitunix`,
    notable.includes(anchor) && availableSet.has(anchor));
}

// Verify TON/SHIB/BONK old names are NOT in registry (they'd never resolve)
const shouldBeGone = ['TON', 'SHIB', 'PEPE', 'BONK', 'FLOKI', 'MOG', 'BERT', 'NEIRO', 'FWOG', 'GIGA', 'ZEC', 'DASH'];
for (const sym of shouldBeGone) {
  ok(`old name '${sym}' removed from notable_altcoins`, !notable.includes(sym));
}

// ── RA-02: Keine MEXC-Artefakte ───────────────────────────────────────────────

process.stdout.write('\nRA-02  Keine MEXC-Artefakte in registry.json\n');

ok('no tokenized_stocks block', !('tokenized_stocks' in reg));
ok('no detect_via_mexc_naming', !regStr.includes('detect_via_mexc_naming'));
ok('no MEXC convention comment referencing NVDAX', !regStr.includes('NVDAXUSDT'));
ok('note mentions Bitunix', (reg.crypto?.note ?? '').toLowerCase().includes('bitunix'));
ok('note does not mention MEXC', !(reg.crypto?.note ?? '').toLowerCase().includes('mexc'));

// ── RA-03: Symbol-Roundtrip ───────────────────────────────────────────────────

process.stdout.write('\nRA-03  Symbol-Roundtrip: toExchangeSymbol → toInternalSymbol → original\n');

const testSymbols = ['BTC', 'ETH', 'SOL', '1000PEPE', '1000BONK', '1000000MOG', '1000FLOKI'];
for (const sym of testSymbols) {
  const exchangeSym  = toExchangeSymbol(sym);
  const backToInternal = toInternalSymbol(exchangeSym);
  ok(`roundtrip ${sym} → ${exchangeSym} → ${backToInternal}`,
    backToInternal === sym,
    `got ${backToInternal}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${'─'.repeat(40)}\n`);
process.stdout.write(`Result: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
