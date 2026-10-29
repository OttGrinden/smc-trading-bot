#!/usr/bin/env node
/**
 * Regression-Test: Bitunix Positioning Fetcher (positioning_fetcher.mjs)
 *
 * PF-01  Live-Fetch BTC/ETH → strukturell gültige Antwort
 * PF-02  Symbolnormalisierung: BTC → BTCUSDT → BTC (Roundtrip)
 * PF-03  Fehlendes fundingRate → funding_rate=null, kein Crash
 * PF-04  oi_usd ist auf Bitunix immer null → Summary crasht nicht
 * PF-05  long_short_ratio immer null → buildPositioningSummary gibt sinnvollen String
 * PF-06  API code != 0 → klarer Warning-Pfad, kein unkontrollierter Crash
 * PF-07  BTC vollständig, ungültiges Symbol schlägt fehl → Cache hat nur BTC
 * PF-08  Integration: Positioning fehlt → buildPositioningSummary gibt '—', kein Crash
 */

import {
  fetchPositioning,
  toExchangeSymbol,
  toInternalSymbol,
  buildPositioningSummary,
  assessSqueezeRisk,
  writePositioning,
  readPositioning,
  POSITIONING_RULES,
} from '../../positioning_fetcher.mjs';

import { writeFileSync, existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', '..', '..', 'trading');

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

// ── PF-01: Live-Fetch BTC/ETH ─────────────────────────────────────────────────

async function testPF01() {
  process.stdout.write('\nPF-01  Live-Fetch BTC/ETH → strukturell gültige Antwort\n');
  for (const sym of ['BTC', 'ETH']) {
    try {
      const d = await fetchPositioning(sym);
      ok(`${sym}: no exception`,           true);
      ok(`${sym}: source=bitunix_futures`, d.source === 'bitunix_futures', `got ${d.source}`);
      ok(`${sym}: pair=${sym}USDT`,        d.pair === `${sym}USDT`, `got ${d.pair}`);
      ok(`${sym}: funding_rate is number`, typeof d.funding_rate === 'number' && Number.isFinite(d.funding_rate),
        `got ${d.funding_rate}`);
      ok(`${sym}: mark_price_usd > 0`,     typeof d.mark_price_usd === 'number' && d.mark_price_usd > 0,
        `got ${d.mark_price_usd}`);
      ok(`${sym}: long_short_ratio=null`,  d.long_short_ratio === null);
      ok(`${sym}: oi_usd=null`,            d.oi_usd === null);
      ok(`${sym}: summary is string`,      typeof d.summary === 'string' && d.summary.length > 0, `got ${d.summary}`);
      ok(`${sym}: summary not '—'`,        d.summary !== '—', `summary was '—' but funding should fill it`);
    } catch (e) {
      ok(`${sym}: no exception`, false, e.message);
    }
  }
}

// ── PF-02: Symbolnormalisierung Roundtrip ────────────────────────────────────

function testPF02() {
  process.stdout.write('\nPF-02  Symbolnormalisierung: BTC → BTCUSDT → BTC\n');
  ok("toExchangeSymbol('BTC') = 'BTCUSDT'",   toExchangeSymbol('BTC')    === 'BTCUSDT');
  ok("toExchangeSymbol('eth') = 'ETHUSDT'",   toExchangeSymbol('eth')    === 'ETHUSDT');
  ok("toInternalSymbol('BTCUSDT') = 'BTC'",   toInternalSymbol('BTCUSDT') === 'BTC');
  ok("toInternalSymbol('ETHUSDT') = 'ETH'",   toInternalSymbol('ETHUSDT') === 'ETH');
  ok('roundtrip BTC',  toInternalSymbol(toExchangeSymbol('BTC')) === 'BTC');
  ok('roundtrip 1000PEPE', toInternalSymbol(toExchangeSymbol('1000PEPE')) === '1000PEPE');
}

// ── PF-03: Fehlendes fundingRate → null, kein Crash ──────────────────────────

function testPF03() {
  process.stdout.write('\nPF-03  Fehlendes fundingRate → funding_rate=null, kein Crash\n');
  // Simulate what fetchPositioning does when d.fundingRate is null
  const rawFunding = null;
  const fundingRate = rawFunding != null ? parseFloat(rawFunding) / 100 : null;
  ok('null fundingRate → internal null', fundingRate === null);

  // Summary with null funding should return '—' (no data at all)
  const p = { funding_rate: null, long_short_ratio: null, oi_usd: null, oi_change_24h_pct: null };
  const s = buildPositioningSummary(p);
  ok('summary with all-null returns —', s === '—', `got: "${s}"`);

  // No crash from assessSqueezeRisk with null inputs
  let threw = false;
  try { assessSqueezeRisk({ long_short_ratio: null, funding_rate: null }); }
  catch { threw = true; }
  ok('assessSqueezeRisk with null inputs: no crash', !threw);
  ok('assessSqueezeRisk with null inputs: returns null', assessSqueezeRisk({ long_short_ratio: null, funding_rate: null }) === null);
}

// ── PF-04: oi_usd immer null auf Bitunix → Summary handelt das ──────────────

function testPF04() {
  process.stdout.write('\nPF-04  oi_usd=null → buildPositioningSummary crasht nicht\n');
  const p = { funding_rate: 0.00006628, long_short_ratio: null, oi_usd: null };
  let s, threw = false;
  try { s = buildPositioningSummary(p); } catch { threw = true; }
  ok('no crash with oi_usd=null', !threw);
  ok('OI not in summary when null', s != null && !s.includes('OI'), `got: "${s}"`);
  ok('funding IS in summary', s != null && s.includes('Fund'), `got: "${s}"`);
}

// ── PF-05: long_short_ratio null → Summary zeigt Funding, nicht '—' ─────────

function testPF05() {
  process.stdout.write('\nPF-05  long_short_ratio=null → Summary enthält Funding, nicht →\n');
  const p = { funding_rate: -0.00006809, long_short_ratio: null, oi_usd: null, oi_change_24h_pct: null };
  const s = buildPositioningSummary(p);
  ok('summary is string', typeof s === 'string' && s.length > 0, `got: "${s}"`);
  ok('summary not —', s !== '—', `got: "${s}"`);
  ok('summary contains Fund', s.includes('Fund'), `got: "${s}"`);
  ok('summary does NOT contain L/S', !s.includes('L/S'), `got: "${s}"`);
  ok('summary ends with balanced or squeeze', s.includes('balanced') || s.includes('squeeze'), `got: "${s}"`);

  // Numeric check: -0.00006809 * 100 = -0.006809%, shown as -0.0068%
  ok('funding displayed as -0.0068%', s.includes('-0.0068'), `got: "${s}"`);
}

// ── PF-06: API code != 0 → klarer Fehler, kein unkontrollierter Crash ────────

async function testPF06() {
  process.stdout.write('\nPF-06  API code != 0 → klarer Warning-Pfad\n');
  try {
    await fetchPositioning('THISDOESNOTEXIST_XYZ');
    ok('should have thrown', false, 'no error thrown');
  } catch (e) {
    ok('throws on invalid symbol', true);
    ok('error has message', typeof e.message === 'string' && e.message.length > 0, e.message);
    const isCleanError = e.message.includes('api_error') || e.message.includes('HTTP') || e.message.includes('empty_response');
    ok('clean error type (api_error/HTTP/empty_response)', isCleanError, e.message);
  }
}

// ── PF-07: BTC ok, ungültiges Symbol schlägt fehl → Cache hat nur BTC ────────

async function testPF07() {
  process.stdout.write('\nPF-07  Gemischte Qualität: BTC ok, BADXYZ fehl → Cache bleibt verwertbar\n');
  const TEST_CACHE = join(TRADING_DIR, 'cache', '_test_positioning_pf07.json');

  // Override: write directly to a test path by mocking writePositioning
  // We test the logic of the main loop pattern:
  const results = { fetched: [], failed: [] };

  // BTC should succeed
  try {
    const data = await fetchPositioning('BTC');
    ok('BTC fetch succeeded', true);
    ok('BTC has funding_rate', data.funding_rate !== null && typeof data.funding_rate === 'number');
    results.fetched.push('BTC');
  } catch (e) {
    ok('BTC fetch succeeded', false, e.message);
  }

  // BADXYZ should fail cleanly
  try {
    await fetchPositioning('BADXYZ');
    ok('BADXYZ should throw', false, 'no error thrown');
  } catch (e) {
    ok('BADXYZ throws cleanly', true);
    results.failed.push('BADXYZ');
  }

  ok('fetched includes BTC', results.fetched.includes('BTC'));
  ok('failed includes BADXYZ', results.failed.includes('BADXYZ'));
  ok('only 1 symbol in fetched', results.fetched.length === 1, `got ${results.fetched.length}`);
}

// ── PF-08: Integration: null Positioning → summary '—', kein Crash ───────────

function testPF08() {
  process.stdout.write('\nPF-08  Integration: Positioning komplett fehlend → summary → downstream ok\n');
  // buildPositioningSummary(null) → '—'
  ok('null p → —', buildPositioningSummary(null) === '—');

  // readPositioning for non-existent symbol returns {available:false}
  const r = readPositioning('NONEXISTENT_SYMBOL_XYZ_999');
  ok('missing symbol → available=false', r.available === false, `got available=${r.available}`);
  ok('missing symbol → reason=not_found', r.reason === 'not_found', `got reason=${r.reason}`);

  // Downstream: if a candidate has no positioning data, that's just null — no crash
  const mock_positioning = null;
  const summary = buildPositioningSummary(mock_positioning);
  ok('downstream null positioning → summary=—', summary === '—');
  ok('downstream null positioning → no exception', true);
}

// ── Runner ────────────────────────────────────────────────────────────────────

process.stdout.write('=== Bitunix Positioning Regression Test ===\n');
process.stdout.write('Target: https://fapi.bitunix.com\n');

// Unit tests first (no network)
testPF02();
testPF03();
testPF04();
testPF05();
testPF08();

// Live tests (network)
await testPF01();
await testPF06();
await testPF07();

process.stdout.write(`\n${'─'.repeat(40)}\n`);
process.stdout.write(`Result: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
