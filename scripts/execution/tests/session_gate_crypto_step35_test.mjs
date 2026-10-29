#!/usr/bin/env node
/**
 * Session Gate Crypto — Unit 35 tests (SG35-01 … SG35-06).
 *
 * Tests the sessionGate.disabled flag added in Unit 35 to support 24/7 crypto
 * futures markets where NYSE session hours are not applicable.
 *
 * Key contracts:
 *   - disabled:true  → safe:true regardless of weekday/time (gate skipped entirely)
 *   - disabled:false → normal NYSE gate applies (treated as enabled)
 *   - disabled absent / undefined → normal NYSE gate applies (backward-compatible)
 *   - disabled:true + kill_switch → kill_switch still wins (kill_switch checked first)
 *
 * All time sources injected via opts.sessionGate._now → fully offline-deterministic.
 * Test dates use July 2026 (EDT = UTC-4):
 *   Sat 2026-07-25, Sun 2026-07-26, Mon 2026-07-27
 *
 * node scripts/execution/tests/session_gate_crypto_step35_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { checkSafetyGates } from '../live_broker/safety_gates.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

// ── Time helpers (EDT = UTC-4 in July 2026) ───────────────────────────────────
const SAT = '2026-07-25';
const SUN = '2026-07-26';
const MON = '2026-07-27';

function et(dateStr, hh, mm) {
  const h = String(hh).padStart(2, '0');
  const m = String(mm).padStart(2, '0');
  return new Date(`${dateStr}T${h}:${m}:00.000-04:00`);
}
function now(date) { return () => date; }

// ── SG35-01: disabled:true on Saturday → safe:true (gate skipped) ─────────────
// Saturday would normally fire weekend_no_session — disabled must suppress it.
{
  const r = checkSafetyGates({ sessionGate: { disabled: true, _now: now(et(SAT, 11, 0)) } });
  check('SG35-01',
    r.safe === true,
    'disabled:true Saturday → safe:true (gate skipped, no weekend_no_session)');
}

// ── SG35-02: disabled:true on Sunday → safe:true ─────────────────────────────
{
  const r = checkSafetyGates({ sessionGate: { disabled: true, _now: now(et(SUN, 11, 0)) } });
  check('SG35-02',
    r.safe === true,
    'disabled:true Sunday → safe:true');
}

// ── SG35-03: disabled:true Mon 09:00 ET (before NYSE open) → safe:true ────────
{
  const r = checkSafetyGates({ sessionGate: { disabled: true, _now: now(et(MON, 9, 0)) } });
  check('SG35-03',
    r.safe === true,
    'disabled:true Mon 09:00 ET (before NYSE open) → safe:true (no outside_session)');
}

// ── SG35-04: disabled:true Mon 17:00 ET (after NYSE close) → safe:true ────────
{
  const r = checkSafetyGates({ sessionGate: { disabled: true, _now: now(et(MON, 17, 0)) } });
  check('SG35-04',
    r.safe === true,
    'disabled:true Mon 17:00 ET (after NYSE close) → safe:true (no outside_session)');
}

// ── SG35-05: disabled:false on Saturday → weekend_no_session (gate active) ────
// disabled:false must NOT skip the gate — treated as normal (enabled).
{
  const r = checkSafetyGates({ sessionGate: { disabled: false, _now: now(et(SAT, 11, 0)) } });
  check('SG35-05',
    r.safe === false && r.reason === 'weekend_no_session',
    'disabled:false Saturday → weekend_no_session (gate active as normal)');
}

// ── SG35-06: disabled:true + kill_switch active → kill_switch still blocks ────
// kill_switch is checked BEFORE session_gate; disabled must not suppress kill_switch.
{
  const r = checkSafetyGates({
    killSwitch:  { active: true },
    sessionGate: { disabled: true, _now: now(et(SAT, 11, 0)) },
  });
  check('SG35-06',
    r.safe === false &&
    r.reason === 'kill_switch' &&
    r.blocks_booking === true,
    'disabled:true + kill_switch → kill_switch wins (checked first), blocks_booking:true');
}

// ── Summary ───────────────────────────────────────────────────────────────────
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nSession Gate Crypto (Unit 35): ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed === 0 ? 0 : 1);
