#!/usr/bin/env node
/**
 * Session Gate — Unit 32 tests (SG32-01 … SG32-12).
 *
 * NYSE regular-session gate: Mon–Fri 09:30–16:00 America/New_York.
 * 16:00 is EXCLUSIVE — at exactly 16:00 dispatch is blocked.
 * Weekend = blocked (weekend_no_session). Weekday outside window = blocked (outside_session).
 *
 * Key semantic contract tested here:
 *   - Session gate fires → blocks_booking:false  → booking still runs outside session
 *   - Kill-switch fires  → blocks_booking:true   → booking also blocked (regression guard SG32-12)
 *   - Default-off        → steps.safety=null, zero behavioural change              (SG32-11)
 *
 * All time sources are injected via opts.sessionGate._now → fully offline-deterministic.
 * Test dates use July 2026 (EDT = UTC-4):
 *   Mon 2026-07-28, Sat 2026-07-26, Sun 2026-07-27
 *
 * node scripts/execution/tests/session_gate_step32_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import {
  checkSafetyGates,
  SESSION_OPEN_MINUTES, SESSION_CLOSE_MINUTES,
} from '../live_broker/safety_gates.mjs';
import { initPortfolio, loadOrInit, _setTestPaths, _clearTestPaths } from '../portfolio/portfolio_state.mjs';
import { _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { _setLeasePath, _clearLeasePath } from '../live_broker/run_lease.mjs';
import { runWorkerPassOnce } from '../live_broker/worker_pass.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

// ── Time helpers (EDT = UTC-4 in July 2026) ───────────────────────────────────
// Use ISO 8601 with explicit -04:00 offset for unambiguous ET timestamps.
// Verified via Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }):
//   2026-07-25 = Saturday, 2026-07-26 = Sunday, 2026-07-27 = Monday, 2026-07-28 = Tuesday
const MON = '2026-07-27';  // Monday
const SAT = '2026-07-25';  // Saturday
const SUN = '2026-07-26';  // Sunday

function et(dateStr, hh, mm) {
  // Returns a Date representing the given HH:MM on dateStr in EDT (UTC-4).
  const h = String(hh).padStart(2, '0');
  const m = String(mm).padStart(2, '0');
  return new Date(`${dateStr}T${h}:${m}:00.000-04:00`);
}
function now(date) { return () => date; }

const PAPER_CFG = Object.freeze({
  enabled: true, mode: 'alpaca_paper', paper: true,
  base_url: 'https://paper-api.alpaca.markets', key_id: 'k', secret_key: 's',
});

// ── SG32-01: gate disabled (no sessionGate key) → safe ───────────────────────
{
  const r = checkSafetyGates({});
  check('SG32-01', r.safe === true, 'no sessionGate → safe: true (gate disabled by default)');
}

// ── SG32-02: Mon 09:29 ET → outside_session (before open) ───────────────────
{
  const r = checkSafetyGates({ sessionGate: { _now: now(et(MON, 9, 29)) } });
  check('SG32-02',
    r.safe === false && r.reason === 'outside_session' && r.blocks_booking === false &&
    r.details?.weekday === 'Mon' && r.details?.minutes === (9 * 60 + 29),
    'Mon 09:29 ET → outside_session (1 min before open), blocks_booking:false');
}

// ── SG32-03: Mon 09:30 ET → inside session (open, inclusive) ─────────────────
{
  const r = checkSafetyGates({ sessionGate: { _now: now(et(MON, 9, 30)) } });
  check('SG32-03',
    r.safe === true,
    `Mon 09:30 ET → safe:true (session open at ${SESSION_OPEN_MINUTES} min, inclusive)`);
}

// ── SG32-04: Mon 15:59 ET → inside session ───────────────────────────────────
{
  const r = checkSafetyGates({ sessionGate: { _now: now(et(MON, 15, 59)) } });
  check('SG32-04',
    r.safe === true,
    'Mon 15:59 ET → safe:true (last minute of session)');
}

// ── SG32-05: Mon 16:00 ET → outside_session (close is EXCLUSIVE) ─────────────
// NYSE closes at 16:00; no new orders accepted at 16:00 or later.
// Session window: [09:30, 16:00) — 16:00 itself = blocked.
{
  const r = checkSafetyGates({ sessionGate: { _now: now(et(MON, 16, 0)) } });
  check('SG32-05',
    r.safe === false && r.reason === 'outside_session' &&
    r.details?.minutes === SESSION_CLOSE_MINUTES,
    `Mon 16:00 ET → outside_session (close=${SESSION_CLOSE_MINUTES} min is EXCLUSIVE — first blocked minute)`);
}

// ── SG32-06: Mon 16:01 ET → outside_session (after close) ────────────────────
{
  const r = checkSafetyGates({ sessionGate: { _now: now(et(MON, 16, 1)) } });
  check('SG32-06',
    r.safe === false && r.reason === 'outside_session',
    'Mon 16:01 ET → outside_session (1 min after close)');
}

// ── SG32-07: Saturday → weekend_no_session ───────────────────────────────────
{
  const r = checkSafetyGates({ sessionGate: { _now: now(et(SAT, 11, 0)) } });
  check('SG32-07',
    r.safe === false && r.reason === 'weekend_no_session' && r.blocks_booking === false &&
    r.details?.weekday === 'Sat',
    'Saturday → weekend_no_session, blocks_booking:false');
}

// ── SG32-08: Sunday → weekend_no_session ─────────────────────────────────────
{
  const r = checkSafetyGates({ sessionGate: { _now: now(et(SUN, 11, 0)) } });
  check('SG32-08',
    r.safe === false && r.reason === 'weekend_no_session' && r.details?.weekday === 'Sun',
    'Sunday → weekend_no_session');
}

// ── Worker-pass integration helpers ─────────────────────────────────────────
const ROOT = join(tmpdir(), `sg32_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
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
      return { provider: 'alpaca', client_order_id: r.client_order_id, broker_order_id: 'B_' + r.client_order_id, broker_status: 'accepted' };
    },
    async getOrderByClientId(cid) {
      return { provider: 'alpaca', broker_order_id: 'B_' + cid, broker_status: 'accepted', filled_qty: 0, avg_fill_price: null };
    },
  };
}

// ── SG32-09: outside session + bookFills=true → dispatch blocked, cycle+sync+booking run ─
// Key assertion: blocks_booking:false → booking runs even on Saturday.
await withEnv('sg32_09', async () => {
  const s = await runWorkerPassOnce({
    broker: fakeBroker(), execConfig: PAPER_CFG,
    bookFills: true,
    safetyGates: { sessionGate: { _now: now(et(SAT, 11, 0)) } },   // Saturday
  });
  check('SG32-09',
    s.ran === true &&
    s.steps.safety?.safe === false &&
    s.steps.safety?.reason === 'weekend_no_session' &&
    s.steps.safety?.blocks_booking === false &&
    s.steps.dispatch?.skipped === true &&
    s.steps.dispatch?.reason === 'weekend_no_session' &&
    s.steps.cycle?.ran === true &&
    s.steps.sync?.skipped !== true &&            // sync ran
    s.steps.booking?.skipped !== true &&          // booking ran (blocks_booking:false)
    s.steps.booking?.eligible === 0,              // empty store → 0 eligible
    'Saturday + bookFills: dispatch blocked(weekend_no_session), cycle+sync+booking all ran (blocks_booking:false)');
});

// ── SG32-10: inside session → safety passes, dispatch proceeds normally ───────
await withEnv('sg32_10', async () => {
  const s = await runWorkerPassOnce({
    broker: fakeBroker(), execConfig: PAPER_CFG,
    safetyGates: { sessionGate: { _now: now(et(MON, 10, 0)) } },   // Mon 10:00 ET
  });
  check('SG32-10',
    s.steps.safety?.safe === true &&
    // No intents → dispatch skips with no_intents (not session gate)
    s.steps.dispatch?.skipped === true && s.steps.dispatch?.reason === 'no_intents' &&
    s.steps.cycle?.ran === true,
    'Mon 10:00 ET → safety passes, dispatch skipped only due to no_intents (not session gate), cycle ran');
});

// ── SG32-11: default-off → zero behavioural change ───────────────────────────
await withEnv('sg32_11', async () => {
  const s = await runWorkerPassOnce({ broker: fakeBroker(), execConfig: PAPER_CFG });
  check('SG32-11',
    s.steps.safety === null && s.ran === true,
    'no safetyGates at all → steps.safety=null, existing behaviour byte-identical');
});

// ── SG32-12: kill_switch + sessionGate combined → kill_switch wins, blocks_booking:true ─
// Regression guard: combining gates must not accidentally produce blocks_booking:false.
{
  const r = checkSafetyGates({
    killSwitch:  { active: true },
    sessionGate: { _now: now(et(SAT, 11, 0)) },   // would also fire
  });
  check('SG32-12',
    r.safe === false &&
    r.reason === 'kill_switch' &&           // kill_switch checked first
    r.blocks_booking === true,              // kill_switch semantics preserved
    'kill_switch + sessionGate: kill_switch wins (checked first), blocks_booking:true preserved');
}

// ── Summary ───────────────────────────────────────────────────────────────────
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nSession Gate (Unit 32): ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed === 0 ? 0 : 1);
