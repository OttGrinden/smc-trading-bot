#!/usr/bin/env node
/**
 * paper_exec_layer — Unit 22 tests (PE-01 … PE-08).
 *
 * Fully offline + deterministic. No broker is built, no network calls, no
 * file writes (workerPass is injected for PE-04..07; PE-08 reads scan.mjs source).
 *
 * node scripts/execution/tests/paper_exec_layer_step22_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { readFileSync }                              from 'fs';
import { fileURLToPath }                             from 'url';
import { join, dirname }                             from 'path';
import { validatePaperExecConfig, runPaperExecLayer } from '../live_broker/paper_exec_layer.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const VALID_ENV = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' };
const VALID_SCAN = JSON.stringify({ run_id: 'run_test_001', long_candidates: [], short_candidates: [] });

// ─── PE-01: missing keys → throws credentials error ──────────────────────────
{
  let threw = false;
  let msg   = '';
  try {
    validatePaperExecConfig([], {});
  } catch (e) {
    threw = true; msg = e.message;
  }
  check('PE-01', threw && msg.includes('ALPACA_KEY_ID'),
    'missing keys → throws with ALPACA_KEY_ID mention');
}

// ─── PE-02: ALPACA_PAPER=false → throws non_paper error ──────────────────────
{
  let threw = false;
  let msg   = '';
  try {
    validatePaperExecConfig([], { ...VALID_ENV, ALPACA_PAPER: 'false' });
  } catch (e) {
    threw = true; msg = e.message;
  }
  check('PE-02', threw && /non.paper|ALPACA_PAPER/i.test(msg),
    'ALPACA_PAPER=false → throws non-paper refusal');
}

// ─── PE-03: valid keys → returns enabled config ───────────────────────────────
{
  let cfg = null;
  let threw = false;
  try {
    cfg = validatePaperExecConfig([], VALID_ENV);
  } catch {
    threw = true;
  }
  check('PE-03',
    !threw && cfg?.enabled === true && cfg?.mode === 'alpaca_paper' && cfg?.credentials_present === true,
    'valid keys → returns enabled alpaca_paper config');
}

// ─── PE-04: workerPass stub ok → returns summary + run_id ────────────────────
{
  const stub = async (_ctx) => ({ ran: true, reason: null, gate: { safe: true }, steps: { dispatch: { skipped: true }, cycle: { ran: true }, sync: { ran: true } }, error: null });
  let result = null;
  let threw  = false;
  try {
    result = await runPaperExecLayer(VALID_SCAN, {}, { workerPass: stub });
  } catch {
    threw = true;
  }
  check('PE-04',
    !threw && result?.ran === true && result?.run_id === 'run_test_001' && result?.gate?.safe === true,
    'stub ok → ran=true, run_id forwarded from scan JSON');
}

// ─── PE-05: workerPass stub gate_unsafe → ok:false, no throw ─────────────────
{
  const stub = async (_ctx) => ({ ran: false, reason: 'gate_unsafe', gate: { safe: false }, steps: { dispatch: { skipped: true }, cycle: { skipped: true }, sync: { skipped: true } }, error: null });
  let result = null;
  let threw  = false;
  try {
    result = await runPaperExecLayer(VALID_SCAN, {}, { workerPass: stub });
  } catch {
    threw = true;
  }
  check('PE-05',
    !threw && result?.ran === false && result?.reason === 'gate_unsafe' && result?.run_id === 'run_test_001',
    'stub gate_unsafe → ran=false, no throw, run_id present');
}

// ─── PE-06: workerPass stub throws → runPaperExecLayer re-throws ─────────────
{
  const stub = async () => { throw new Error('worker_crash'); };
  let threw  = false;
  let msg    = '';
  try {
    await runPaperExecLayer(VALID_SCAN, {}, { workerPass: stub });
  } catch (e) {
    threw = true; msg = e.message;
  }
  check('PE-06', threw && msg === 'worker_crash',
    'stub throws → runPaperExecLayer re-throws unchanged');
}

// ─── PE-07: invalid scan JSON → throws before workerPass is called ────────────
{
  let stubCalled = false;
  const stub = async () => { stubCalled = true; return {}; };
  let threw = false;
  let msg   = '';
  try {
    await runPaperExecLayer('{invalid json', {}, { workerPass: stub });
  } catch (e) {
    threw = true; msg = e.message;
  }
  check('PE-07',
    threw && !stubCalled && msg.includes('paper_exec_layer'),
    'invalid JSON → throws before workerPass; stub never called');
}

// ─── PE-08: scan.mjs VALID_EXEC_MODES includes 'alpaca_paper' (static check) ──
{
  const scanPath = join(dirname(fileURLToPath(import.meta.url)), '../../scan.mjs');
  const src = readFileSync(scanPath, 'utf8');
  const hasMode  = src.includes("'alpaca_paper'");
  const hasArray = /VALID_EXEC_MODES\s*=\s*\[/.test(src);
  const hasPaperBlock = src.includes('paper_exec_config_invalid');
  check('PE-08',
    hasMode && hasArray && hasPaperBlock,
    "scan.mjs: 'alpaca_paper' in VALID_EXEC_MODES + paper_exec_config_invalid guard present");
}

// ─── Summary ─────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_exec_layer_step22_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
