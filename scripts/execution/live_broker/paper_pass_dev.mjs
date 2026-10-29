#!/usr/bin/env node
/**
 * paper_pass_dev — controlled DEV/SMOKE entrypoint for ONE end-to-end paper pass
 * (Unit 16). Drives the already-merged Unit-15 orchestrator runApprovedDecisionsPass:
 *
 *   buildDecisions(runOutput) → approvedIntentsFromDecisions (approved, UNSIZED)
 *                             → runWorkerPassOnce(sizeFromAccount:true)
 *
 * A deliberate MANUAL dev/smoke tool — NOT a productized runtime entry. NO loop, NO
 * scheduler, NO daemon, NO scan.mjs change, NO live execution, and NO change to any
 * core module. It only makes the existing E2E path explicitly invocable.
 *
 * FACHLICH VERBINDLICH: the decision-engine output is approved but UNSIZED (price_usd,
 * NO quantity); the sizing happens LATER account-based via the Unit 12/13 path inside
 * runApprovedDecisionsPass. The sized allocation_engine path (quantity) is a separate
 * parallel source and is NOT used here.
 *
 *   parse args → fail-closed alpaca_paper guard (paper-only, parseBrokerExecConfig)
 *   load runOutput (--run-log file, or injected opts.runOutput)
 *   --dry-run → validate + report, do NOT build a broker or call the orchestrator
 *   else → broker = opts.broker ?? makeBroker(execConfig)
 *        → runApprovedDecisionsPass({ runOutput, broker, execConfig, mode, run_id })
 *   → print a JSON summary, exit deterministically
 *
 * Exit codes: 0 success / dry-run · 2 fail-closed (invalid args, config not enabled /
 * non-paper / missing creds, missing or unreadable runOutput, live mode) · 1 unexpected.
 *
 * The broker AND the orchestrator are INJECTABLE (opts.broker / opts.makeBroker /
 * opts._runApprovedDecisionsPass) so the entrypoint is fully offline-testable; the isMain
 * CLI constructs a real AlpacaPaperBroker only when run directly with paper credentials.
 *
 * Args:
 *   --broker-exec alpaca_paper     (or env BROKER_EXEC=alpaca_paper) — REQUIRED
 *   --run-log <path>               path to a research_run output JSON (REQUIRED unless injected)
 *   --mode shadow|paper            (default shadow; live is refused fail-closed)
 *   --dry-run                      validate + load, do NOT execute the pass
 */

import { fileURLToPath } from 'url';
import { readFileSync }  from 'fs';

import { parseBrokerExecConfig, brokerExecEnabled } from './live_broker_config.mjs';
import { AlpacaPaperBroker }                        from './adapters/alpaca_paper_broker.mjs';
import { runApprovedDecisionsPass as realRunPass }  from './e2e_paper_pass.mjs';
import { EXECUTION_MODES }                          from '../schemas.mjs';

function flag(argv, name) { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null; }
function has(argv, name)  { return argv.includes(name); }

/**
 * runPaperPassDevOnce — validate args+config, load runOutput, perform ONE E2E pass attempt.
 * Never calls process.exit; returns a summary carrying exit_code. Fail-closed.
 *
 * @param {object} o — { argv?, env?, broker?, makeBroker?, runOutput?, _runApprovedDecisionsPass? }
 * @returns {Promise<object>} summary { ok, mode?, run_id?, dry_run?, pass?, exit_code, error? }
 */
export async function runPaperPassDevOnce({
  argv = [], env = {}, broker = null,
  makeBroker = (cfg) => new AlpacaPaperBroker(cfg),
  runOutput = null,
  _runApprovedDecisionsPass = realRunPass,
} = {}) {
  // 1) Argument validation (fail-closed → exit 2). No file/broker IO yet.
  const mode    = flag(argv, '--mode') ?? EXECUTION_MODES.SHADOW;
  const runLog  = flag(argv, '--run-log');
  const dryRun  = has(argv, '--dry-run');

  const errs = [];
  if (mode !== EXECUTION_MODES.SHADOW && mode !== EXECUTION_MODES.PAPER) {
    errs.push(`--mode must be ${EXECUTION_MODES.SHADOW}|${EXECUTION_MODES.PAPER} (live is refused)`);
  }
  if (errs.length) return { ok: false, exit_code: 2, error: { reason: 'invalid_args', detail: errs } };

  // 2) Config guard — paper-only, fail-closed (parseBrokerExecConfig refuses non-paper).
  let execConfig;
  try { execConfig = parseBrokerExecConfig(argv, env); }
  catch (e) { return { ok: false, exit_code: 2, error: { reason: 'config_invalid', detail: e?.message ?? String(e) } }; }
  if (!brokerExecEnabled(execConfig)) {
    return { ok: false, exit_code: 2, error: { reason: 'broker_exec_not_enabled', detail: 'requires --broker-exec alpaca_paper / BROKER_EXEC=alpaca_paper' } };
  }

  // 3) runOutput — injected wins; else load from --run-log (fail-closed on missing/unreadable).
  let runOut = runOutput;
  if (runOut == null) {
    if (typeof runLog !== 'string' || !runLog) {
      return { ok: false, exit_code: 2, error: { reason: 'runoutput_missing', detail: 'provide --run-log <path> (or inject runOutput)' } };
    }
    try { runOut = JSON.parse(readFileSync(runLog, 'utf8')); }
    catch (e) { return { ok: false, exit_code: 2, error: { reason: 'runoutput_load_failed', detail: e?.message ?? String(e) } }; }
  }
  if (!runOut || typeof runOut !== 'object') {
    return { ok: false, exit_code: 2, error: { reason: 'runoutput_invalid', detail: 'runOutput must be an object' } };
  }
  const run_id = runOut.run_id ?? null;

  // 4) Dry-run: validated + loaded, but NO broker, NO orchestrator call.
  if (dryRun) {
    return { ok: true, dry_run: true, mode, run_id, exit_code: 0 };
  }

  // 5) Broker + EXACTLY ONE orchestrator pass (orchestrator does its own fail-closed pre-flight).
  const paperBroker = broker ?? makeBroker(execConfig);
  let pass;
  try {
    pass = await _runApprovedDecisionsPass({ runOutput: runOut, broker: paperBroker, execConfig, mode, run_id });
  } catch (e) {
    return { ok: false, exit_code: 1, run_id, error: { reason: 'unexpected', detail: e?.message ?? String(e) } };
  }

  return { ok: true, mode, run_id, pass, exit_code: 0 };
}

/** paperPassDevExitCode — map a summary to a CLI exit code (defaults to 1 if absent). */
export function paperPassDevExitCode(summary) {
  return Number.isInteger(summary?.exit_code) ? summary.exit_code : 1;
}

// ─── CLI (dev/smoke only) — single explicit invocation, never auto-runs on import ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runPaperPassDevOnce({ argv: process.argv.slice(2), env: process.env })
    .then((summary) => {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      process.exit(paperPassDevExitCode(summary));
    })
    .catch((err) => {
      process.stderr.write(JSON.stringify({ ok: false, reason: 'fatal', error: err?.message ?? String(err), exit_code: 1 }) + '\n');
      process.exit(1);
    });
}
