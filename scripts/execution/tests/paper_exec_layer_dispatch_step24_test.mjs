#!/usr/bin/env node
/**
 * paper_exec_layer_dispatch — Unit 24 tests (PD-01 … PD-07).
 *
 * Fully offline + deterministic. No real broker, no network, no file writes.
 * makeBroker, _buildDecisions, _approvedIntentsFromDecisions all injectable.
 *
 * node scripts/execution/tests/paper_exec_layer_dispatch_step24_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { readFileSync }                                from 'fs';
import { fileURLToPath }                               from 'url';
import { join, dirname }                               from 'path';
import { validatePaperExecConfig,
         runPaperExecLayer,
         runPaperExecLayerWithDispatch }               from '../live_broker/paper_exec_layer.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const VALID_ENV  = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' };
const VALID_JSON = JSON.stringify({ run_id: 'run_unit24_smoke', long_candidates: [], short_candidates: [] });

// Stub broker: has submitOrder + getOrderByClientId + getAccount (required by runApprovedDecisionsPass)
function makeStubbedBroker() {
  return {
    submitOrder:        async () => ({ broker_order_id: 'bo1', broker_status: 'accepted' }),
    getOrderByClientId: async () => null,
    getAccount:         async () => ({ buying_power: 1000, currency: 'USD' }),
  };
}

// Stub pass: replaces runApprovedDecisionsPass with a known-good stub via _buildDecisions + _approvedIntentsFromDecisions
function stubDecisions(runOutput) { return []; }
function stubNormalize(decisions, _opts) { return { intents: [], approved: 0, emitted: 0, skipped: 0 }; }

// ─── PD-01: maintenance-only path unaffected — runPaperExecLayer still works ───
{
  let maintenanceCalled = false;
  let dispatchCalled    = false;
  const stubWorker = async (_ctx) => {
    maintenanceCalled = true;
    return { ran: true, reason: 'completed', gate: { safe: true }, steps: { dispatch: { skipped: true }, cycle: { ran: true }, sync: { ran: true } }, error: null };
  };
  let result = null;
  let threw  = false;
  try {
    result = await runPaperExecLayer(VALID_JSON, {}, { workerPass: stubWorker });
  } catch { threw = true; }
  check('PD-01',
    !threw && maintenanceCalled && !dispatchCalled && result?.ran === true,
    'maintenance-only path: runPaperExecLayer still works, no dispatch involved');
}

// ─── PD-02: --exec-dispatch calls runApprovedDecisionsPass via _buildDecisions stub ─
{
  let buildCalled    = false;
  let normalizeCalled = false;
  const buildStub = (runOutput) => { buildCalled = true; return []; };
  const normalizeStub = (decisions, opts) => { normalizeCalled = true; return { intents: [], approved: 0, emitted: 0, skipped: 0 }; };

  const execConfig = validatePaperExecConfig([], VALID_ENV);
  let result = null;
  let threw  = false;
  try {
    result = await runPaperExecLayerWithDispatch(VALID_JSON, execConfig, {
      makeBroker:                   () => makeStubbedBroker(),
      _buildDecisions:              buildStub,
      _approvedIntentsFromDecisions: normalizeStub,
    });
  } catch (e) { threw = true; process.stderr.write('  ERR PD-02: ' + e.message + '\n'); }
  check('PD-02',
    !threw && buildCalled && normalizeCalled && result?.run_id === 'run_unit24_smoke',
    'dispatch path: _buildDecisions + _approvedIntentsFromDecisions called, run_id forwarded');
}

// ─── PD-03: --exec-dispatch + invalid JSON → throws before dispatch ────────────
{
  const execConfig = validatePaperExecConfig([], VALID_ENV);
  let buildCalled = false;
  let threw = false;
  let errMsg = '';
  try {
    await runPaperExecLayerWithDispatch('{bad json', execConfig, {
      makeBroker:      () => makeStubbedBroker(),
      _buildDecisions: () => { buildCalled = true; return []; },
      _approvedIntentsFromDecisions: () => ({ intents: [], approved: 0, emitted: 0, skipped: 0 }),
    });
  } catch (e) { threw = true; errMsg = e.message; }
  check('PD-03',
    threw && !buildCalled && errMsg.includes('paper_exec_layer'),
    'invalid JSON → throws before _buildDecisions is called');
}

// ─── PD-04: broker lacking getAccount → runApprovedDecisionsPass pre-flight rejects ─
{
  const execConfig = validatePaperExecConfig([], VALID_ENV);
  const brokerNoAccount = { submitOrder: async () => ({}), getOrderByClientId: async () => null };
  let threw = false;
  let errMsg = '';
  try {
    await runPaperExecLayerWithDispatch(VALID_JSON, execConfig, {
      makeBroker:      () => brokerNoAccount,
      _buildDecisions: () => [],
      _approvedIntentsFromDecisions: () => ({ intents: [], approved: 0, emitted: 0, skipped: 0 }),
    });
  } catch (e) { threw = true; errMsg = e.message; }
  check('PD-04',
    threw && /getAccount|fail-closed/i.test(errMsg),
    'broker missing getAccount → pre-flight throws before any dispatch');
}

// ─── PD-05: dispatch path result includes decisions_total, approved, worker ────
{
  const execConfig = validatePaperExecConfig([], VALID_ENV);
  let result = null;
  try {
    result = await runPaperExecLayerWithDispatch(VALID_JSON, execConfig, {
      makeBroker:                   () => makeStubbedBroker(),
      _buildDecisions:              () => [],
      _approvedIntentsFromDecisions: () => ({ intents: [], approved: 0, emitted: 0, skipped: 0 }),
    });
  } catch { /* covered by PD-02 */ }
  check('PD-05',
    result !== null
    && 'decisions_total' in result
    && 'approved' in result
    && 'worker' in result
    && result.run_id === 'run_unit24_smoke',
    'dispatch result shape: decisions_total, approved, worker, run_id present');
}

// ─── PD-06: maintenance unaffected when EXEC_DISPATCH=false (PD-01 extension, belt+suspenders)
{
  let maintenanceCalled = false;
  const stub = async (_ctx) => {
    maintenanceCalled = true;
    return { ran: false, reason: 'gate_unsafe', gate: { safe: false }, steps: { dispatch: { skipped: true }, cycle: { skipped: true }, sync: { skipped: true } }, error: null };
  };
  let result;
  try { result = await runPaperExecLayer(VALID_JSON, {}, { workerPass: stub }); } catch { /* noop */ }
  check('PD-06',
    maintenanceCalled === true && result?.ran === false && result?.reason === 'gate_unsafe',
    'maintenance (gate_unsafe): workerPass stub called, result forwarded unmodified');
}

// ─── PD-07: static check — scan.mjs contains --exec-dispatch guard + dispatch symbol ─
// Guard error key updated in Unit 34 to exec_dispatch_requires_broker_exec (also accepts
// alpaca_paper variant for backward compat detection).
{
  const scanPath = join(dirname(fileURLToPath(import.meta.url)), '../../scan.mjs');
  const src = readFileSync(scanPath, 'utf8');
  const hasFlag        = src.includes('--exec-dispatch');
  // Accept either the old alpaca-only guard name or the new broader guard name (Unit 34 rename)
  const hasGuard       = src.includes('exec_dispatch_requires_alpaca_paper') ||
                         src.includes('exec_dispatch_requires_broker_exec');
  const hasDispatchFn  = src.includes('runPaperExecLayerWithDispatch');
  const hasDispatchArg = src.includes('EXEC_DISPATCH');
  check('PD-07',
    hasFlag && hasGuard && hasDispatchFn && hasDispatchArg,
    'scan.mjs: --exec-dispatch flag, guard, EXEC_DISPATCH, runPaperExecLayerWithDispatch all present');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_exec_layer_dispatch_step24_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
