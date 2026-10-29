#!/usr/bin/env node
/**
 * protective_exit_pass_dev — controlled DEV/SMOKE entrypoint for ONE protective-exit pass
 * (Unit 20). Drives the already-merged Unit-19 pass runProtectiveExitPassOnce:
 *
 *   open positions (--positions-file, or read-only from portfolio_state)
 *     → buildProtectiveExits (10.9) → dispatchProtectiveExits (Unit 18) → stop-capable gateway
 *
 * A deliberate MANUAL dev/smoke tool — NOT a productized runtime entry. NO loop, NO
 * scheduler, NO daemon, NO scan.mjs change, NO live execution, and NO change to any core
 * module. It only makes the existing protective-exit pass explicitly invocable. Mirrors the
 * paper_pass_dev (Unit 16) convention.
 *
 * FACHLICH: downstream protective-exit execution tooling only. It does NOT touch the
 * approved-but-UNSIZED intent path (decision-engine output stays approved but unsized;
 * sizing remains account-based downstream, Units 12/13) and does NOT mix with the sized
 * allocation_engine path. The portfolio is only READ (open positions).
 *
 *   parse args → fail-closed alpaca_paper guard (paper-only, parseBrokerExecConfig)
 *   positions: --positions-file <path> (JSON array) or injected; else the pass reads
 *              portfolio_state.open_positions read-only
 *   --dry-run → validate (+ load positions file if given), do NOT build a broker or run the pass
 *   else → broker = opts.broker ?? makeBroker(execConfig)
 *        → runProtectiveExitPassOnce({ broker, positions?, run_id })
 *   → print a JSON summary, exit deterministically
 *
 * Exit codes: 0 success / dry-run · 2 fail-closed (config not enabled / non-paper / missing
 * creds, unreadable/invalid positions file) · 1 unexpected.
 *
 * The broker AND the pass are INJECTABLE (opts.broker / opts.makeBroker /
 * opts._runProtectiveExitPassOnce) so the entrypoint is fully offline-testable; the isMain
 * CLI constructs a real AlpacaPaperBroker only when run directly with paper credentials.
 *
 * Args:
 *   --broker-exec alpaca_paper     (or env BROKER_EXEC=alpaca_paper) — REQUIRED
 *   --positions-file <path>        optional JSON array of open positions (else portfolio_state)
 *   --dry-run                      validate + load, do NOT run the pass
 */

import { fileURLToPath } from 'url';
import { readFileSync }  from 'fs';

import { parseBrokerExecConfig, brokerExecEnabled }   from './live_broker_config.mjs';
import { AlpacaPaperBroker }                          from './adapters/alpaca_paper_broker.mjs';
import { runProtectiveExitPassOnce as realRunPass }   from './protective_exit_pass.mjs';

function flag(argv, name) { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null; }
function has(argv, name)  { return argv.includes(name); }

/**
 * runProtectiveExitPassDevOnce — validate config, resolve positions, run ONE pass attempt.
 * Never calls process.exit; returns a summary carrying exit_code. Fail-closed.
 *
 * @param {object} o — { argv?, env?, broker?, makeBroker?, positions?, _runProtectiveExitPassOnce? }
 * @returns {Promise<object>} summary { ok, dry_run?, positions_source?, pass?, exit_code, error? }
 */
export async function runProtectiveExitPassDevOnce({
  argv = [], env = {}, broker = null,
  makeBroker = (cfg) => new AlpacaPaperBroker(cfg),
  positions = null,
  _runProtectiveExitPassOnce = realRunPass,
} = {}) {
  const posFile = flag(argv, '--positions-file');
  const dryRun  = has(argv, '--dry-run');

  // 1) Config guard — paper-only, fail-closed (parseBrokerExecConfig refuses non-paper).
  let execConfig;
  try { execConfig = parseBrokerExecConfig(argv, env); }
  catch (e) { return { ok: false, exit_code: 2, error: { reason: 'config_invalid', detail: e?.message ?? String(e) } }; }
  if (!brokerExecEnabled(execConfig)) {
    return { ok: false, exit_code: 2, error: { reason: 'broker_exec_not_enabled', detail: 'requires --broker-exec alpaca_paper / BROKER_EXEC=alpaca_paper' } };
  }

  // 2) Positions — injected wins; else optional --positions-file (JSON array, fail-closed);
  //    else left undefined → the pass reads portfolio_state.open_positions read-only.
  let pos = positions;
  let positions_source = pos != null ? 'injected' : 'portfolio_state';
  if (pos == null && typeof posFile === 'string' && posFile) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(posFile, 'utf8')); }
    catch (e) { return { ok: false, exit_code: 2, error: { reason: 'positions_load_failed', detail: e?.message ?? String(e) } }; }
    if (!Array.isArray(parsed)) {
      return { ok: false, exit_code: 2, error: { reason: 'positions_invalid', detail: 'positions file must contain a JSON array' } };
    }
    pos = parsed;
    positions_source = 'file';
  }

  // 3) Dry-run: validated (+ positions resolved), but NO broker, NO pass call.
  if (dryRun) {
    return { ok: true, dry_run: true, positions_source, positions_count: Array.isArray(pos) ? pos.length : null, exit_code: 0 };
  }

  // 4) Broker + EXACTLY ONE pass (the pass does its own fail-closed pre-flight).
  const paperBroker = broker ?? makeBroker(execConfig);
  const passCtx = { broker: paperBroker, execConfig };
  if (pos != null) passCtx.positions = pos;   // else the pass loads from portfolio_state
  let pass;
  try { pass = await _runProtectiveExitPassOnce(passCtx); }
  catch (e) { return { ok: false, exit_code: 1, error: { reason: 'unexpected', detail: e?.message ?? String(e) } }; }

  return { ok: true, positions_source, pass, exit_code: 0 };
}

/** protectiveExitPassDevExitCode — map a summary to a CLI exit code (defaults to 1 if absent). */
export function protectiveExitPassDevExitCode(summary) {
  return Number.isInteger(summary?.exit_code) ? summary.exit_code : 1;
}

// ─── CLI (dev/smoke only) — single explicit invocation, never auto-runs on import ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runProtectiveExitPassDevOnce({ argv: process.argv.slice(2), env: process.env })
    .then((summary) => {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      process.exit(protectiveExitPassDevExitCode(summary));
    })
    .catch((err) => {
      process.stderr.write(JSON.stringify({ ok: false, reason: 'fatal', error: err?.message ?? String(err), exit_code: 1 }) + '\n');
      process.exit(1);
    });
}
