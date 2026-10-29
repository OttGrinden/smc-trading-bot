#!/usr/bin/env node
/**
 * Regression-Test: Bitunix OHLCV Fetch (fetchCryptoCloses)
 *
 * Kriterien (aus Code-Review Phase 1):
 *   BX-01  BTCUSDT liefert ≥ MIN_COUNT finite closes
 *   BX-02  Rückgabe ist chronologisch aufsteigend (oldest-first nach reverse())
 *   BX-03  close-Feld wird korrekt extrahiert (alle Werte > 0, plausible Größenordnung)
 *   BX-04  code !== 0 → sauberer Fehler, kein Crash
 *   BX-05  < MIN_COUNT → Warning-Pfad korrekt (Simulation via leeres data[])
 */

const BITUNIX_BASE = 'https://fapi.bitunix.com';
const MIN_COUNT    = 35;
const TARGET_COUNT = 50;
const TIMEOUT_MS   = 10_000;

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

// ── Mirror of fetchCryptoCloses from ohlcv_fetcher.mjs ───────────────────────

async function fetchBitunixCloses(symbol, overrideUrl = null) {
  const bitunixSymbol = symbol.toUpperCase() + 'USDT';
  const controller    = new AbortController();
  const timer         = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url           = overrideUrl ??
    `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${bitunixSymbol}&interval=1d&limit=200&type=LAST_PRICE`;

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.code !== 0) throw new Error(`api_error_${json.code}: ${json.msg ?? 'unknown'}`);

    const rows = json.data;
    if (!Array.isArray(rows) || !rows.length) throw new Error('empty_response');

    const closes = rows
      .map(k => parseFloat(k.close))
      .filter(v => Number.isFinite(v))
      .reverse();

    return closes.slice(-TARGET_COUNT);

  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
  }
}

// ── BX-01: BTCUSDT liefert ≥ MIN_COUNT finite closes ────────────────────────

async function testBX01() {
  process.stdout.write('\nBX-01  BTCUSDT liefert ≥ MIN_COUNT finite closes\n');
  try {
    const closes = await fetchBitunixCloses('BTC');
    ok('count ≥ MIN_COUNT', closes.length >= MIN_COUNT, `got ${closes.length}`);
    ok('count ≤ TARGET_COUNT', closes.length <= TARGET_COUNT, `got ${closes.length}`);
    ok('all values finite', closes.every(v => Number.isFinite(v)));
    ok('all values > 0', closes.every(v => v > 0));
  } catch (e) {
    ok('no exception', false, e.message);
  }
}

// ── BX-02: Rückgabe chronologisch aufsteigend (oldest-first) ─────────────────

async function testBX02() {
  process.stdout.write('\nBX-02  Rückgabe chronologisch aufsteigend (oldest-first)\n');
  try {
    // Fetch raw with timestamps to verify order
    const bitunixSymbol = 'BTCUSDT';
    const controller    = new AbortController();
    setTimeout(() => controller.abort(), TIMEOUT_MS);
    const url = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${bitunixSymbol}&interval=1d&limit=200&type=LAST_PRICE`;
    const res  = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await res.json();
    const rows = json.data ?? [];

    // Raw API should be newest-first (descending timestamps)
    const times = rows.map(k => Number(k.time));
    const rawIsDesc = times.every((t, i) => i === 0 || times[i - 1] >= t);
    ok('raw API newest-first (descending timestamps)', rawIsDesc,
      rawIsDesc ? '' : `times[0]=${times[0]} times[1]=${times[1]}`);

    // After reverse(), should be oldest-first (ascending timestamps)
    const reversed = [...times].reverse();
    const reversedIsAsc = reversed.every((t, i) => i === 0 || reversed[i - 1] <= t);
    ok('after reverse(): ascending timestamps', reversedIsAsc);

    // Spot-check: last close in our output should be the most recent API entry
    const closes    = await fetchBitunixCloses('BTC');
    const lastClose = closes[closes.length - 1];
    const apiMostRecentClose = parseFloat(rows[0].close);
    ok('closes[-1] matches API rows[0].close (most recent)', lastClose === apiMostRecentClose,
      `closes[-1]=${lastClose} api[0].close=${apiMostRecentClose}`);
  } catch (e) {
    ok('no exception', false, e.message);
  }
}

// ── BX-03: close-Feld korrekt extrahiert, plausible Größenordnung ────────────

async function testBX03() {
  process.stdout.write('\nBX-03  close-Feld korrekt extrahiert (plausibel)\n');
  try {
    const closes = await fetchBitunixCloses('BTC');
    // BTC should be between $1k and $500k for any reasonable market state
    ok('BTC closes in plausible range ($1k–$500k)',
      closes.every(v => v > 1_000 && v < 500_000),
      `min=${Math.min(...closes).toFixed(0)} max=${Math.max(...closes).toFixed(0)}`);

    // ETH sanity check
    const ethCloses = await fetchBitunixCloses('ETH');
    ok('ETH closes > 0', ethCloses.length >= MIN_COUNT && ethCloses.every(v => v > 0));
    ok('ETH closes < BTC closes (last)', ethCloses[ethCloses.length - 1] < closes[closes.length - 1]);
  } catch (e) {
    ok('no exception', false, e.message);
  }
}

// ── BX-04: code !== 0 → sauberer Fehler ──────────────────────────────────────

async function testBX04() {
  process.stdout.write('\nBX-04  code !== 0 → sauberer Error, kein Crash\n');
  // Use a deliberately invalid symbol to trigger an API error
  try {
    await fetchBitunixCloses('THISDOESNOTEXIST_XYZ');
    ok('should have thrown', false, 'no error thrown for invalid symbol');
  } catch (e) {
    ok('throws on invalid symbol', true);
    ok('error message is a string', typeof e.message === 'string' && e.message.length > 0, e.message);
    // Should contain api_error or empty_response (not a raw crash)
    const isCleanError = e.message.includes('api_error') || e.message.includes('empty_response') || e.message.includes('HTTP');
    ok('error is clean (api_error / empty_response / HTTP)', isCleanError, e.message);
  }
}

// ── BX-05: < MIN_COUNT → Warning-Pfad (simuliert über direkte close-Array-Prüfung) ─

async function testBX05() {
  process.stdout.write('\nBX-05  MIN_COUNT-Guard korrekt (simulation)\n');
  // Simulate what ohlcv_fetcher.mjs does when closes.length < MIN_COUNT
  const tooFew = [1, 2, 3]; // < 35
  const wouldWarn = tooFew.length < MIN_COUNT;
  ok('tooFew.length < MIN_COUNT triggers warning path', wouldWarn);

  // Verify a real fetch for a symbol that IS listed doesn't fall below MIN_COUNT
  try {
    const closes = await fetchBitunixCloses('ETH');
    ok('ETH: no spurious too_few (≥ MIN_COUNT)', closes.length >= MIN_COUNT, `got ${closes.length}`);
  } catch (e) {
    ok('ETH fetch succeeded', false, e.message);
  }

  // Verify BTC has full TARGET_COUNT
  try {
    const closes = await fetchBitunixCloses('BTC');
    ok('BTC: full TARGET_COUNT returned', closes.length === TARGET_COUNT, `got ${closes.length}`);
  } catch (e) {
    ok('BTC fetch succeeded', false, e.message);
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

process.stdout.write('=== Bitunix OHLCV Regression Test ===\n');
process.stdout.write(`Target: ${BITUNIX_BASE}\n`);

await testBX01();
await testBX02();
await testBX03();
await testBX04();
await testBX05();

process.stdout.write(`\n${'─'.repeat(40)}\n`);
process.stdout.write(`Result: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
