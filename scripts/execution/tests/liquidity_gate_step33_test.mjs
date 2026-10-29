#!/usr/bin/env node
/**
 * Liquidity / Market-Quality Gate — Unit 33 tests (LG-01 … LG-14).
 *
 * Gate checks volume_usd (minimum, inclusive) and an optional range_pct
 * (maximum, EXCLUSIVE — at maxRangePct = blocked) from an injected marketData
 * snapshot. range_pct is an OHLCV-BASED PROXY — NOT a real Bid/Ask spread:
 * callers may supply abs(change_pct) or (high-low)/close×100 depending on
 * what data they have.  The gate itself makes no claim about spread precision.
 *
 * Boundary semantics (documented and nailed by tests):
 *   volume_usd >= minVolumeUsd  → passes  (minimum inclusive, like NYSE open 09:30)
 *   range_pct  >= maxRangePct   → blocked (threshold exclusive, like NYSE close 16:00)
 *
 * Data is fully injected — no file reads, no network calls, fully offline.
 *
 * Tests:
 *   LG-01  Gate disabled (no liquidityGate key) → safe
 *   LG-02  marketData missing / null → missing_market_data (fail-closed)
 *   LG-03  volume_usd below minimum → volume_below_minimum
 *   LG-04  volume_usd exactly at minimum → safe (inclusive boundary)
 *   LG-05  range_pct above maximum → range_proxy_exceeded
 *   LG-06  range_pct exactly at maximum → blocked (exclusive boundary)
 *   LG-07  good market data → safe
 *   LG-08  worker_pass integration: gate fires → dispatch blocked, cycle+sync+booking run
 *   LG-09  default-off: no safetyGates → steps.safety=null, zero behavioural change
 *   LG-10  combined with session gate: session gate wins (checked before liquidity gate)
 *   LG-11  combined with kill_switch: kill_switch wins (checked first), blocks_booking:true
 *   LG-12  stale market data (maxAgeMinutes set): age >= threshold → stale_market_data
 *   LG-13  details object contains the relevant observed values and thresholds
 *   LG-14  no reason-code or detail key uses the word "spread" (honest proxy semantics)
 *
 * node scripts/execution/tests/liquidity_gate_step33_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import {
  checkSafetyGates,
  DEFAULT_MIN_VOLUME_USD,
  DEFAULT_MAX_RANGE_PCT,
} from '../live_broker/safety_gates.mjs';
import { initPortfolio, loadOrInit, _setTestPaths, _clearTestPaths } from '../portfolio/portfolio_state.mjs';
import { _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { _setLeasePath, _clearLeasePath } from '../live_broker/run_lease.mjs';
import { runWorkerPassOnce } from '../live_broker/worker_pass.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

// ── Shared fixtures ───────────────────────────────────────────────────────────
const MIN_VOL = 1_000_000;
const MAX_RNG = 20;

// Representative market snapshot — good quality.
const GOOD = {
  volume_usd: 5_000_000_000,   // 5B USD — well above minimum
  range_pct:  1.2,              // 1.2% — well below maximum
  fetched_at: new Date().toISOString(),
};

// ── LG-01: gate disabled → safe ───────────────────────────────────────────────
{
  const r = checkSafetyGates({});
  check('LG-01', r.safe === true, 'no liquidityGate → safe: true (gate disabled by default)');
}

// ── LG-02: marketData missing / null → missing_market_data ───────────────────
{
  const r1 = checkSafetyGates({ liquidityGate: {} });          // no marketData key
  const r2 = checkSafetyGates({ liquidityGate: { marketData: null } });
  const r3 = checkSafetyGates({ liquidityGate: { marketData: {} } });  // empty object
  check('LG-02',
    r1.safe === false && r1.reason === 'missing_market_data' && r1.blocks_booking === false &&
    r2.safe === false && r2.reason === 'missing_market_data' &&
    r3.safe === false && r3.reason === 'missing_market_data',
    'missing/null/empty marketData → missing_market_data (fail-closed), blocks_booking:false');
}

// ── LG-03: volume_usd below minimum → volume_below_minimum ───────────────────
{
  const r = checkSafetyGates({
    liquidityGate: {
      minVolumeUsd: MIN_VOL,
      marketData: { 'RKLB': { volume_usd: MIN_VOL - 1, range_pct: 1.0 } },
    },
  });
  check('LG-03',
    r.safe === false &&
    r.reason === 'volume_below_minimum' &&
    r.blocks_booking === false &&
    r.details?.symbol === 'RKLB' &&
    r.details?.observed_volume_usd === MIN_VOL - 1 &&
    r.details?.min_volume_usd === MIN_VOL,
    `volume ${MIN_VOL - 1} < ${MIN_VOL} → volume_below_minimum with correct details`);
}

// ── LG-04: volume_usd exactly at minimum → safe (inclusive lower boundary) ───
{
  const r = checkSafetyGates({
    liquidityGate: {
      minVolumeUsd: MIN_VOL,
      marketData: { 'RKLB': { volume_usd: MIN_VOL, range_pct: 1.0 } },
    },
  });
  check('LG-04',
    r.safe === true,
    `volume_usd exactly at minimum (${MIN_VOL}) → safe (minimum is INCLUSIVE)`);
}

// ── LG-05: range_pct above maximum → range_proxy_exceeded ────────────────────
{
  const r = checkSafetyGates({
    liquidityGate: {
      maxRangePct: MAX_RNG,
      marketData: { 'RKLB': { volume_usd: 5_000_000_000, range_pct: MAX_RNG + 1 } },
    },
  });
  check('LG-05',
    r.safe === false &&
    r.reason === 'range_proxy_exceeded' &&
    r.blocks_booking === false &&
    r.details?.symbol === 'RKLB' &&
    r.details?.observed_range_pct === MAX_RNG + 1 &&
    r.details?.max_range_pct === MAX_RNG,
    `range_pct ${MAX_RNG + 1} > ${MAX_RNG} → range_proxy_exceeded with correct details`);
}

// ── LG-06: range_pct exactly at maximum → blocked (exclusive upper boundary) ─
{
  const r = checkSafetyGates({
    liquidityGate: {
      maxRangePct: MAX_RNG,
      marketData: { 'RKLB': { volume_usd: 5_000_000_000, range_pct: MAX_RNG } },
    },
  });
  check('LG-06',
    r.safe === false && r.reason === 'range_proxy_exceeded',
    `range_pct exactly at maximum (${MAX_RNG}) → blocked (maximum is EXCLUSIVE — first blocked value is at threshold)`);
}

// ── LG-07: good market data → safe ───────────────────────────────────────────
{
  const r = checkSafetyGates({
    liquidityGate: {
      minVolumeUsd: MIN_VOL,
      maxRangePct:  MAX_RNG,
      marketData: { 'NVDA': GOOD },
    },
  });
  check('LG-07', r.safe === true, 'volume above minimum + range below maximum → safe: true');
}

// ── Worker-pass integration helpers ─────────────────────────────────────────
const ROOT = join(tmpdir(), `lg33_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
mkdirSync(ROOT, { recursive: true });

async function withEnv(tag, fn) {
  const d         = join(ROOT, tag);
  const ordersDir = join(d, 'orders');
  const pfDir     = join(d, 'portfolio');
  mkdirSync(ordersDir, { recursive: true });
  mkdirSync(pfDir,     { recursive: true });
  const leaseP    = join(ordersDir, '.paper_runner.lease');
  const statePath = join(pfDir, 'state.json');
  writeFileSync(statePath, JSON.stringify(initPortfolio(), null, 2) + '\n', 'utf8');
  const pfPaths = { state: statePath, history: join(pfDir, 'hist.jsonl'), ledger: join(pfDir, 'ledger.jsonl') };
  const apply = () => {
    _setOrderStorePaths({ dir: ordersDir, eventsLog: join(ordersDir, 'events.jsonl') });
    _setLeasePath(leaseP);
    _setTestPaths(pfPaths);
  };
  apply();
  try { return await fn(); }
  finally { _clearOrderStorePaths(); _clearLeasePath(); _clearTestPaths(); }
}

function fakeBroker() {
  return {
    async submitOrder(r) {
      return { provider: 'alpaca', client_order_id: r.client_order_id,
               broker_order_id: 'B_' + r.client_order_id, broker_status: 'accepted' };
    },
    async getOrderByClientId(cid) {
      return { provider: 'alpaca', broker_order_id: 'B_' + cid,
               broker_status: 'accepted', filled_qty: 0, avg_fill_price: null };
    },
  };
}

const PAPER_CFG = Object.freeze({
  enabled: true, mode: 'alpaca_paper', paper: true,
  base_url: 'https://paper-api.alpaca.markets', key_id: 'k', secret_key: 's',
});

// ── LG-08: worker_pass integration — gate fires → dispatch blocked, cycle+sync+booking run ─
await withEnv('lg08', async () => {
  const s = await runWorkerPassOnce({
    broker: fakeBroker(), execConfig: PAPER_CFG,
    bookFills: true,
    safetyGates: {
      liquidityGate: {
        minVolumeUsd: MIN_VOL,
        marketData: { 'RKLB': { volume_usd: 100, range_pct: 1.0 } },  // volume too low
      },
    },
  });
  check('LG-08',
    s.ran === true &&
    s.steps.safety?.safe === false &&
    s.steps.safety?.reason === 'volume_below_minimum' &&
    s.steps.safety?.blocks_booking === false &&
    s.steps.dispatch?.skipped === true &&
    s.steps.dispatch?.reason === 'volume_below_minimum' &&
    s.steps.cycle?.ran === true &&
    s.steps.sync?.skipped !== true &&         // sync ran
    s.steps.booking?.skipped !== true &&       // booking ran (blocks_booking:false)
    s.steps.booking?.eligible === 0,
    'liquidityGate fires (volume_below_minimum): dispatch blocked, cycle+sync+booking all ran');
});

// ── LG-09: default-off — no safetyGates → zero behavioural change ─────────────
await withEnv('lg09', async () => {
  const s = await runWorkerPassOnce({ broker: fakeBroker(), execConfig: PAPER_CFG });
  check('LG-09', s.steps.safety === null && s.ran === true,
    'no safetyGates → steps.safety=null, existing behaviour byte-identical');
});

// ── LG-10: session gate + liquidity gate — session gate wins (checked first) ──
// Use a Saturday time so session gate fires; liquidity gate has bad data that would also fire.
// Result: reason = 'weekend_no_session' (session gate wins), NOT liquidity gate.
{
  const r = checkSafetyGates({
    sessionGate:  { _now: () => new Date('2026-07-25T15:00:00.000Z') },  // Saturday
    liquidityGate: {
      minVolumeUsd: MIN_VOL,
      marketData: { 'RKLB': { volume_usd: 100 } },  // would also block
    },
  });
  check('LG-10',
    r.safe === false &&
    r.reason === 'weekend_no_session' &&   // session gate fires first
    r.blocks_booking === false,
    'session gate + liquidity gate: session gate wins (checked before liquidity gate)');
}

// ── LG-11: kill_switch + liquidity gate — kill_switch wins, blocks_booking:true ─
{
  const r = checkSafetyGates({
    killSwitch:   { active: true },
    liquidityGate: {
      minVolumeUsd: MIN_VOL,
      marketData: { 'RKLB': { volume_usd: 100 } },  // would also block
    },
  });
  check('LG-11',
    r.safe === false &&
    r.reason === 'kill_switch' &&
    r.blocks_booking === true,   // kill_switch semantics preserved
    'kill_switch + liquidityGate: kill_switch wins (checked first), blocks_booking:true preserved');
}

// ── LG-12: stale market data → stale_market_data ──────────────────────────────
{
  const oldTimestamp = '2026-07-27T06:00:00.000Z';  // 2 h before fake "now"
  const fakeNow      = () => new Date('2026-07-27T08:01:00.000Z');  // 121 min later
  const r = checkSafetyGates({
    liquidityGate: {
      minVolumeUsd:  MIN_VOL,
      maxAgeMinutes: 120,         // block if data older than 2 hours
      _now:          fakeNow,
      marketData: { 'NVDA': { volume_usd: 5_000_000_000, range_pct: 1.0, fetched_at: oldTimestamp } },
    },
  });
  check('LG-12',
    r.safe === false &&
    r.reason === 'stale_market_data' &&
    r.blocks_booking === false &&
    r.details?.symbol === 'NVDA' &&
    r.details?.age_minutes >= 120 &&
    r.details?.max_age_minutes === 120 &&
    r.details?.fetched_at === oldTimestamp,
    'stale market data (121 min > 120 min limit) → stale_market_data with age details');
}

// ── LG-13: details object contains the relevant observed values ───────────────
{
  const r = checkSafetyGates({
    liquidityGate: {
      minVolumeUsd: 2_000_000,
      maxRangePct: 10,
      marketData: { 'ASTS': { volume_usd: 500_000, range_pct: 8.6 } },
    },
  });
  check('LG-13',
    r.safe === false &&
    r.reason === 'volume_below_minimum' &&
    r.details != null &&
    r.details.symbol === 'ASTS' &&
    r.details.observed_volume_usd === 500_000 &&
    r.details.min_volume_usd === 2_000_000,
    'volume_below_minimum details contain symbol, observed_volume_usd, min_volume_usd');
}

// ── LG-14: no reason-code or detail key uses the word "spread" ───────────────
// Verifies honest naming: gate is an OHLCV proxy, NOT a real Bid/Ask spread gate.
{
  const scenarios = [
    checkSafetyGates({ liquidityGate: {} }),
    checkSafetyGates({ liquidityGate: { marketData: { 'X': { volume_usd: 0 } } } }),
    checkSafetyGates({ liquidityGate: { maxRangePct: 5, marketData: { 'X': { volume_usd: 1e9, range_pct: 10 } } } }),
    checkSafetyGates({ liquidityGate: { marketData: { 'X': { volume_usd: 1e9, range_pct: 1 } } } }),
  ];
  const spreadFound = scenarios.some(r => JSON.stringify(r).toLowerCase().includes('spread'));
  check('LG-14',
    !spreadFound,
    'no reason-code or detail key contains "spread" — gate is an OHLCV-based range proxy, not a real Bid/Ask spread gate');
}

// ── Summary ───────────────────────────────────────────────────────────────────
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nLiquidity / Market-Quality Gate (Unit 33): ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed === 0 ? 0 : 1);
