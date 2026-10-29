#!/usr/bin/env node
/**
 * paper_exec_layer_pe — Unit 26 tests (PE-01 … PE-05).
 *
 * Fully offline + deterministic. No real broker, no network, no file writes.
 * _runProtectiveExitPassOnce and makeBroker are injectable.
 *
 * node scripts/execution/tests/paper_exec_layer_pe_step26_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { readFileSync }                                from 'fs';
import { fileURLToPath }                               from 'url';
import { join, dirname }                               from 'path';
import { validatePaperExecConfig,
         runPaperExecLayer,
         runPaperExecLayerWithDispatch,
         runPaperExecLayerWithProtectiveExit }         from '../live_broker/paper_exec_layer.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const VALID_ENV  = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' };
const VALID_JSON = JSON.stringify({ run_id: 'run_unit26_smoke', long_candidates: [], short_candidates: [] });

function makeStubbedBroker() {
  return {
    submitOrder:        async () => ({ broker_order_id: 'bo1', broker_status: 'accepted' }),
    getOrderByClientId: async () => null,
    getAccount:         async () => ({ buying_power: 1000, currency: 'USD' }),
  };
}

const PE_SUMMARY = { positions_in: 2, planned: 2, already_protected: 0, plan_skipped: 0, dispatch: { submitted: 2 } };

// ─── PE-01: dispatch path unaffected — runPaperExecLayerWithDispatch still works ─
{
  let buildCalled = false;
  const execConfig = validatePaperExecConfig([], VALID_ENV);
  let result = null;
  let threw  = false;
  try {
    result = await runPaperExecLayerWithDispatch(VALID_JSON, execConfig, {
      makeBroker:                    () => makeStubbedBroker(),
      _buildDecisions:               () => { buildCalled = true; return []; },
      _approvedIntentsFromDecisions: () => ({ intents: [], approved: 0, emitted: 0, skipped: 0 }),
    });
  } catch (e) { threw = true; process.stderr.write('  ERR PE-01: ' + e.message + '\n'); }
  check('PE-01',
    !threw && buildCalled && result?.run_id === 'run_unit26_smoke',
    'dispatch path unaffected: runPaperExecLayerWithDispatch still works after Unit 26 additions');
}

// ─── PE-02: PE path calls _runProtectiveExitPassOnce (injectable) ─────────────
{
  const execConfig = validatePaperExecConfig([], VALID_ENV);
  let peCalled  = false;
  let passedCtx = null;
  let result    = null;
  let threw     = false;
  try {
    result = await runPaperExecLayerWithProtectiveExit(execConfig, {
      makeBroker: () => makeStubbedBroker(),
      _runProtectiveExitPassOnce: async (ctx) => {
        peCalled  = true;
        passedCtx = ctx;
        return PE_SUMMARY;
      },
    });
  } catch (e) { threw = true; process.stderr.write('  ERR PE-02: ' + e.message + '\n'); }
  check('PE-02',
    !threw
    && peCalled
    && passedCtx?.broker != null
    && passedCtx?.execConfig != null
    && result?.positions_in === 2
    && result?.planned === 2,
    'PE path: _runProtectiveExitPassOnce called with { broker, execConfig }, summary forwarded');
}

// ─── PE-03: broker without submitOrder → fail-closed throw from runProtectiveExitPassOnce ─
{
  const execConfig  = validatePaperExecConfig([], VALID_ENV);
  const badBroker   = { getOrderByClientId: async () => null };
  let threw  = false;
  let errMsg = '';
  try {
    await runPaperExecLayerWithProtectiveExit(execConfig, {
      makeBroker: () => badBroker,
    });
  } catch (e) { threw = true; errMsg = e.message; }
  check('PE-03',
    threw && /submitOrder|fail-closed/i.test(errMsg),
    'broker missing submitOrder → runProtectiveExitPassOnce throws fail-closed');
}

// ─── PE-04: maintenance path (runPaperExecLayer) unaffected — no PE involved ──
{
  let maintenanceCalled = false;
  const stubWorker = async (_ctx) => {
    maintenanceCalled = true;
    return { ran: true, reason: 'completed', gate: { safe: true }, steps: { dispatch: { skipped: true }, cycle: { ran: true }, sync: { ran: true } }, error: null };
  };
  let result = null;
  let threw  = false;
  try {
    result = await runPaperExecLayer(VALID_JSON, {}, { workerPass: stubWorker });
  } catch { threw = true; }
  check('PE-04',
    !threw && maintenanceCalled && result?.ran === true,
    'maintenance path (runPaperExecLayer) unaffected by Unit 26 additions');
}

// ─── PE-05: static check — scan.mjs contains --exec-protective-exit flag + guard ─
{
  const scanPath = join(dirname(fileURLToPath(import.meta.url)), '../../scan.mjs');
  const src = readFileSync(scanPath, 'utf8');
  const hasFlag    = src.includes('--exec-protective-exit');
  const hasGuard   = src.includes('exec_protective_exit_requires_alpaca_paper');
  const hasConst   = src.includes('EXEC_PROTECTIVE_EXIT');
  const hasFn      = src.includes('runPaperExecLayerWithProtectiveExit');
  check('PE-05',
    hasFlag && hasGuard && hasConst && hasFn,
    'scan.mjs: --exec-protective-exit flag, guard, EXEC_PROTECTIVE_EXIT, runPaperExecLayerWithProtectiveExit all present');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_exec_layer_pe_step26_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
