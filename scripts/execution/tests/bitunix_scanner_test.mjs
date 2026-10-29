#!/usr/bin/env node
/**
 * Regression-Test: Bitunix Market Scanner (market_scanner.mjs)
 *
 * SC-01  Live-Fetch → Struktur + Felder korrekt (top_gainers/losers ≤ 20, clean_symbols > 0)
 * SC-02  Sortierung: gainers descending, losers ascending nach change_pct
 * SC-03  quoteVol-Filter entfernt illiquide Märkte (vol < 75K → filtered_scam++)
 * SC-04  Symbolnormalisierung korrekt (BTCUSDT → BTC, round-trip)
 * SC-05  Fehlendes open / lastPrice → compute24hChange=null, kein Crash
 * SC-06  Nur tradable downstream: kein USDT-Suffix in base, kein leeres base
 * SC-07  Tiebreaker deterministisch: gleicher change_pct → höheres quoteVol zuerst
 */

import {
  compute24hChange,
  scamFilter,
  compareByChange,
  formatTicker,
  buildScanOutput,
  buildNotableQuotes,
  toInternalSymbol,
  toExchangeSymbol,
  fetchTickers,
} from '../../market_scanner.mjs';

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

// --- Mock ticker helpers -----------------------------------------------------

function mkTicker({ symbol = 'BTCUSDT', lastPrice = '60000', open = '58000', quoteVol = '1000000', high = '62000', low = '57000' } = {}) {
  return { symbol, lastPrice, open, quoteVol, high, low, markPrice: lastPrice };
}

// ── SC-01: Live-Fetch → Struktur korrekt ─────────────────────────────────────

async function testSC01() {
  process.stdout.write('\nSC-01  Live-Fetch → Struktur + Felder korrekt\n');
  try {
    const tickers = await fetchTickers();
    ok('fetchTickers() returns array', Array.isArray(tickers), `type=${typeof tickers}`);
    ok('at least 10 tickers', tickers.length >= 10, `got ${tickers.length}`);

    const output = buildScanOutput(tickers, new Set());

    ok('has top_gainers array', Array.isArray(output.top_gainers));
    ok('has top_losers array', Array.isArray(output.top_losers));
    ok('top_gainers ≤ 20', output.top_gainers.length <= 20, `got ${output.top_gainers.length}`);
    ok('top_losers ≤ 20', output.top_losers.length <= 20, `got ${output.top_losers.length}`);
    ok('clean_symbols > 0', output.clean_symbols > 0, `got ${output.clean_symbols}`);
    ok('total_usdt > 0', output.total_usdt > 0, `got ${output.total_usdt}`);
    ok('scanned_at is ISO string', typeof output.scanned_at === 'string' && output.scanned_at.includes('T'));

    // Verify required output fields per entry
    const g = output.top_gainers[0];
    if (g) {
      ok('entry has symbol', typeof g.symbol === 'string' && g.symbol.length > 0);
      ok('entry has base (no USDT suffix)', typeof g.base === 'string' && !g.base.endsWith('USDT'));
      ok('entry has direction', g.direction === 'LONG' || g.direction === 'SHORT');
      ok('entry has change_pct (number)', typeof g.change_pct === 'number');
      ok('entry has price_usd > 0', g.price_usd > 0);
      ok('entry has volume_usd ≥ 0', g.volume_usd >= 0);
      ok("entry category = 'Crypto'", g.category === 'Crypto');
    }
  } catch (e) {
    ok('no exception', false, e.message);
  }
}

// ── SC-02: Sortierung ─────────────────────────────────────────────────────────

async function testSC02() {
  process.stdout.write('\nSC-02  Sortierung: gainers descending, losers ascending\n');
  try {
    const tickers = await fetchTickers();
    const output  = buildScanOutput(tickers, new Set());

    const gainers = output.top_gainers;
    const losers  = output.top_losers;

    // top_gainers[0] must have the highest change_pct
    let gainersOrdered = true;
    for (let i = 1; i < gainers.length; i++) {
      if (gainers[i].change_pct > gainers[i - 1].change_pct) {
        gainersOrdered = false;
        break;
      }
    }
    ok('top_gainers sorted descending', gainersOrdered,
      gainers.length >= 2 ? `[0]=${gainers[0]?.change_pct} [1]=${gainers[1]?.change_pct}` : 'n/a');

    // top_losers[0] must have the lowest (most negative) change_pct
    let losersOrdered = true;
    for (let i = 1; i < losers.length; i++) {
      if (losers[i].change_pct < losers[i - 1].change_pct) {
        losersOrdered = false;
        break;
      }
    }
    ok('top_losers sorted ascending (biggest loser first)', losersOrdered,
      losers.length >= 2 ? `[0]=${losers[0]?.change_pct} [1]=${losers[1]?.change_pct}` : 'n/a');

    // gainers direction must all be LONG, losers all SHORT
    ok('top_gainers all direction=LONG', gainers.every(t => t.direction === 'LONG'));
    ok('top_losers all direction=SHORT', losers.every(t => t.direction === 'SHORT'));
  } catch (e) {
    ok('no exception', false, e.message);
  }
}

// ── SC-03: quoteVol-Filter ────────────────────────────────────────────────────

function testSC03() {
  process.stdout.write('\nSC-03  quoteVol-Filter entfernt illiquide Märkte\n');

  const illiquid = mkTicker({ symbol: 'JUNKUSDT', quoteVol: '50000' }); // below 75K
  const liquid   = mkTicker({ symbol: 'BTCUSDT',  quoteVol: '2000000000' });

  ok('illiquid rejected by scamFilter', scamFilter(illiquid) === 'vol<75K',
    `got: ${scamFilter(illiquid)}`);
  ok('liquid passes scamFilter', scamFilter(liquid) === null,
    `got: ${scamFilter(liquid)}`);

  const output = buildScanOutput([illiquid, liquid], new Set());
  ok('illiquid not in clean_symbols', output.clean_symbols === 1,
    `got clean_symbols=${output.clean_symbols}`);
  ok('filtered_scam = 1', output.filtered_scam === 1,
    `got filtered_scam=${output.filtered_scam}`);
  ok('top_gainers has only liquid', output.top_gainers.every(t => t.symbol === 'BTCUSDT'));
}

// ── SC-04: Symbolnormalisierung ───────────────────────────────────────────────

function testSC04() {
  process.stdout.write('\nSC-04  Symbolnormalisierung korrekt\n');

  ok("toInternalSymbol('BTCUSDT') = 'BTC'",    toInternalSymbol('BTCUSDT')   === 'BTC');
  ok("toInternalSymbol('ETHUSDT') = 'ETH'",    toInternalSymbol('ETHUSDT')   === 'ETH');
  ok("toInternalSymbol('1000BONKUSDT') strips", toInternalSymbol('1000BONKUSDT') === '1000BONK');

  ok("toExchangeSymbol('BTC') = 'BTCUSDT'",    toExchangeSymbol('BTC')       === 'BTCUSDT');
  ok("toExchangeSymbol('btc') = 'BTCUSDT'",    toExchangeSymbol('btc')       === 'BTCUSDT');

  // Round-trip
  ok('round-trip BTC',  toExchangeSymbol(toInternalSymbol('BTCUSDT'))  === 'BTCUSDT');
  ok('round-trip ETH',  toExchangeSymbol(toInternalSymbol('ETHUSDT'))  === 'ETHUSDT');

  // formatTicker must strip USDT from base
  const t   = mkTicker({ symbol: 'SOLUSDT', lastPrice: '140', open: '130', quoteVol: '500000' });
  const fmt = formatTicker(t, 'LONG');
  ok("formatTicker base = 'SOL'",      fmt.base === 'SOL');
  ok('formatTicker symbol = SOLUSDT',  fmt.symbol === 'SOLUSDT');
  ok("formatTicker category = 'Crypto'", fmt.category === 'Crypto');
}

// ── SC-05: Fehlendes open / lastPrice ─────────────────────────────────────────

function testSC05() {
  process.stdout.write('\nSC-05  Fehlendes open / lastPrice → null, kein Crash\n');

  const noOpen      = mkTicker({ open: '' });
  const zeroOpen    = mkTicker({ open: '0' });
  const noLastPrice = mkTicker({ lastPrice: '' });
  const nanOpen     = mkTicker({ open: 'NOT_A_NUMBER' });

  ok('missing open → compute24hChange null', compute24hChange(noOpen) === null);
  ok('open=0 → compute24hChange null',       compute24hChange(zeroOpen) === null);
  ok('missing lastPrice → null',             compute24hChange(noLastPrice) === null);
  ok('NaN open → null',                      compute24hChange(nanOpen) === null);

  // scamFilter should catch these with bad_open before downstream processing
  ok('missing open → bad_open',  scamFilter(noOpen)   === 'bad_open');
  ok('zero open → bad_open',     scamFilter(zeroOpen) === 'bad_open');

  // buildScanOutput must not throw with degenerate tickers
  const weirdTickers = [noOpen, zeroOpen, noLastPrice, nanOpen];
  let threw = false;
  try {
    buildScanOutput(weirdTickers, new Set());
  } catch {
    threw = true;
  }
  ok('buildScanOutput does not throw on degenerate tickers', !threw);
}

// ── SC-06: Nur tradable downstream ────────────────────────────────────────────

async function testSC06() {
  process.stdout.write('\nSC-06  Nur tradable downstream (no USDT in base, no empty base)\n');
  try {
    const tickers = await fetchTickers();
    const output  = buildScanOutput(tickers, new Set());

    const allEntries = [...output.top_gainers, ...output.top_losers];

    ok('all base fields are non-empty strings',
      allEntries.every(t => typeof t.base === 'string' && t.base.length > 0),
      `empty bases: ${allEntries.filter(t => !t.base).map(t => t.symbol).join(',') || 'none'}`);

    ok('no base field ends with USDT',
      allEntries.every(t => !t.base.endsWith('USDT')),
      `USDT in base: ${allEntries.filter(t => t.base.endsWith('USDT')).map(t => t.symbol).join(',') || 'none'}`);

    ok('all volume_usd are finite non-negative',
      allEntries.every(t => Number.isFinite(t.volume_usd) && t.volume_usd >= 0));

    ok('all price_usd are finite positive',
      allEntries.every(t => Number.isFinite(t.price_usd) && t.price_usd > 0));

  } catch (e) {
    ok('no exception', false, e.message);
  }
}

// ── SC-07: Tiebreaker deterministisch ────────────────────────────────────────

function testSC07() {
  process.stdout.write('\nSC-07  Tiebreaker deterministisch (gleicher change_pct → höheres Vol zuerst)\n');

  // Three tickers with the same 24h change (open=100, last=105 = +5%)
  const highVol  = mkTicker({ symbol: 'HIGHUSDT',  lastPrice: '105', open: '100', quoteVol: '5000000' });
  const midVol   = mkTicker({ symbol: 'MIDUSDT',   lastPrice: '105', open: '100', quoteVol: '2000000' });
  const lowVol   = mkTicker({ symbol: 'LOWUSDT',   lastPrice: '105', open: '100', quoteVol: '500000' });

  // All pass scamFilter (vol ≥ 75K)
  ok('highVol passes scamFilter', scamFilter(highVol)  === null);
  ok('midVol passes scamFilter',  scamFilter(midVol)   === null);
  ok('lowVol passes scamFilter',  scamFilter(lowVol)   === null);

  // compareByChange should order them HIGH → MID → LOW
  const arr = [lowVol, highVol, midVol];
  arr.sort(compareByChange);
  ok('tiebreaker: highVol first',  arr[0].symbol === 'HIGHUSDT', `got ${arr[0].symbol}`);
  ok('tiebreaker: midVol second',  arr[1].symbol === 'MIDUSDT',  `got ${arr[1].symbol}`);
  ok('tiebreaker: lowVol third',   arr[2].symbol === 'LOWUSDT',  `got ${arr[2].symbol}`);

  // buildScanOutput respects same order
  const output = buildScanOutput([lowVol, highVol, midVol], new Set());
  ok('buildScanOutput top_gainers[0] is highVol', output.top_gainers[0]?.symbol === 'HIGHUSDT',
    `got ${output.top_gainers[0]?.symbol}`);

  // Sort must be stable regardless of initial array order (test reverse)
  const arr2 = [highVol, midVol, lowVol];
  arr2.sort(compareByChange);
  ok('sort stable from reverse order', arr2[0].symbol === 'HIGHUSDT' && arr2[2].symbol === 'LOWUSDT');
}

// ── Runner ────────────────────────────────────────────────────────────────────

process.stdout.write('=== Bitunix Scanner Regression Test ===\n');
process.stdout.write('Target: https://fapi.bitunix.com\n');

// Run unit tests synchronously first, live tests after
testSC03();
testSC04();
testSC05();
testSC07();

// Live tests (sequential to avoid hammering the API)
await testSC01();
await testSC02();
await testSC06();

process.stdout.write(`\n${'─'.repeat(40)}\n`);
process.stdout.write(`Result: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
