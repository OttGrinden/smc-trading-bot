#!/usr/bin/env node
/**
 * paper_preflight — READ-ONLY pre-flight readiness report for the two manual paper
 * dev entrypoints (Unit 21):
 *   1. E2E paper pass      (Unit 16 paper_pass_dev → runApprovedDecisionsPass)
 *   2. protective-exit pass (Unit 20 protective_exit_pass_dev → runProtectiveExitPassOnce)
 *
 * DIAGNOSTIC ONLY. It executes NOTHING: no broker is constructed, no pass/dispatch/submit
 * is called, no order store / portfolio / live_orders is written. It only inspects argv +
 * env + (optionally) the readability of explicitly named input files, and classifies how
 * ready each path is for a later controlled paper soak.
 *
 * Mirrors the SAME fail-closed config logic the CLIs use (parseBrokerExecConfig is
 * paper-only) but never throws on missing keys — missing creds are reported as not_ready,
 * not a failure (the report's purpose).
 *
 * SCOPE (Unit 21 ONLY) — deliberately tiny and additive:
 *   - a PURE function buildPaperPreflightReport({ argv, env, fileProbe? }) → structured object
 *   - a thin isMain CLI that prints the report as JSON + a diagnostic exit code
 *   - NO change to any existing module; NO execution of any pass; READ-ONLY throughout
 *
 * Status per path / overall: 'ready' | 'dry_run_only' | 'not_ready' | 'misconfigured'.
 *   misconfigured — broker-exec config is wrong (non-paper, invalid mode)
 *   not_ready     — a local prerequisite blocks even a dry-run (exec off, creds missing,
 *                   required input missing/invalid)
 *   dry_run_only  — broker-exec config + credentials present, but required inputs not yet
 *                   supplied or validated; a dry-run may still be possible per path
 *   ready         — all locally-verifiable prerequisites met (config, creds, required
 *                   inputs valid); live account connectivity is still unverified and always
 *                   disclosed in summary.caveats + summary.missing_for_soak
 *
 * EXPLICITLY NOT in this unit: running either pass, building a broker, any dry-run that
 * internally executes, scan.mjs/daemon, live execution, portfolio/order-store writes.
 */

import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

import { BROKER_EXEC_MODES } from './live_broker_config.mjs';

const ALPACA_PAPER_URL = 'https://paper-api.alpaca.markets';   // literal (matches live_broker_config)

export const PREFLIGHT_STATUS = Object.freeze({
  READY: 'ready', DRY_RUN_ONLY: 'dry_run_only', NOT_READY: 'not_ready', MISCONFIGURED: 'misconfigured',
});
const RANK = { ready: 0, dry_run_only: 1, not_ready: 2, misconfigured: 3 };   // higher = worse

function flag(argv, name) { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null; }

/** Default READ-ONLY file probe: existence + JSON parse. No writes, no execution. */
function defaultFileProbe(path) {
  if (!existsSync(path)) return { exists: false };
  try { return { exists: true, parsed: JSON.parse(readFileSync(path, 'utf8')) }; }
  catch (e) { return { exists: true, parse_error: e?.message ?? String(e) }; }
}

/** Assess the shared broker-exec config (read-only, never throws). */
function assessBrokerExec(argv, env) {
  const mode = flag(argv, '--broker-exec') ?? env.BROKER_EXEC ?? BROKER_EXEC_MODES.OFF;
  const out = { mode, enabled: false, paper: null, credentials_present: false, status: null, reasons: [] };

  if (mode === BROKER_EXEC_MODES.OFF) {
    out.status = PREFLIGHT_STATUS.NOT_READY; out.reasons.push('broker_exec_off');
    return out;
  }
  if (!Object.values(BROKER_EXEC_MODES).includes(mode)) {
    out.status = PREFLIGHT_STATUS.MISCONFIGURED; out.reasons.push('invalid_broker_exec_mode');
    return out;
  }
  // alpaca_paper — paper-only guard (mirrors parseBrokerExecConfig, read-only classification)
  if (env.ALPACA_PAPER === 'false') {
    out.paper = false; out.status = PREFLIGHT_STATUS.MISCONFIGURED; out.reasons.push('non_paper_refused');
    return out;
  }
  const baseUrl = env.ALPACA_BASE_URL ?? ALPACA_PAPER_URL;
  if (baseUrl !== ALPACA_PAPER_URL) {
    out.paper = false; out.status = PREFLIGHT_STATUS.MISCONFIGURED; out.reasons.push('non_paper_base_url');
    return out;
  }
  out.paper = true;
  out.credentials_present = Boolean(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY);
  if (!out.credentials_present) {
    out.status = PREFLIGHT_STATUS.NOT_READY; out.reasons.push('credentials_missing');
    return out;
  }
  out.enabled = true;
  out.status = PREFLIGHT_STATUS.DRY_RUN_ONLY;   // config OK; inputs decide ready vs dry_run_only
  return out;
}

/**
 * assessDispatchPass — read-only readiness for the opt-in dispatch path (Unit 24).
 *
 * Dispatch (runPaperExecLayerWithDispatch / scan.mjs --exec-dispatch) requires:
 *   - valid paper config + credentials (re-uses broker_exec assessment)
 *   - broker.getAccount() capability — always present in AlpacaPaperBroker but cannot be
 *     verified read-only; noted as `getAccount_available: 'assumed'` and added to missing_for_soak
 *   - scan log input (optional here: in automated scan mode the JSON comes live, so
 *     --scan-log absence → dry_run_only rather than not_ready)
 *
 * dispatch_requested: true iff --exec-dispatch is present in argv (informational flag).
 * The dispatch_pass status does NOT feed into overall_status (kept separate by design).
 */
function assessDispatchPass(argv, be, fileProbe) {
  const dp = {
    entrypoint: 'scan.mjs --exec-dispatch  |  paper_exec_dev.mjs --exec-dispatch',
    dispatch_requested: argv.includes('--exec-dispatch'),
    scan_log: { provided: false, status: 'absent' },
    getAccount_available: null,
    blocking_reasons: [],
    status: null,
    dry_run_possible: false,
  };

  const configBad = be.status === PREFLIGHT_STATUS.MISCONFIGURED;
  const configOff = be.status === PREFLIGHT_STATUS.NOT_READY;

  if (configBad) {
    dp.status = PREFLIGHT_STATUS.MISCONFIGURED;
    dp.blocking_reasons.push(...be.reasons);
    return dp;
  }
  if (configOff) {
    dp.status = PREFLIGHT_STATUS.NOT_READY;
    dp.blocking_reasons.push(...be.reasons);
    return dp;
  }

  // Config + credentials OK — AlpacaPaperBroker always implements getAccount()
  dp.getAccount_available = 'assumed';

  // --scan-log: optional for dispatch (live scan provides JSON; --scan-log is for dev/smoke)
  const scanLogPath = flag(argv, '--scan-log');
  if (typeof scanLogPath === 'string' && scanLogPath) {
    dp.scan_log.provided = true;
    const pr = fileProbe(scanLogPath);
    if (!pr.exists)       { dp.scan_log.status = 'unreadable'; }
    else if (pr.parse_error) { dp.scan_log.status = 'invalid_json'; }
    else if (pr.parsed == null || typeof pr.parsed !== 'object') { dp.scan_log.status = 'invalid'; }
    else                  { dp.scan_log.status = 'valid'; }
  }

  if (dp.scan_log.provided && dp.scan_log.status !== 'valid') {
    dp.status = PREFLIGHT_STATUS.NOT_READY;
    dp.blocking_reasons.push(`scan_log_${dp.scan_log.status}`);
    return dp;
  }

  if (dp.scan_log.status === 'valid') {
    dp.status = PREFLIGHT_STATUS.READY;
  } else {
    // No --scan-log: config+creds OK; live scan provides JSON, dry-run still possible
    dp.status = PREFLIGHT_STATUS.DRY_RUN_ONLY;
  }
  dp.dry_run_possible = true;
  return dp;
}

/**
 * buildPaperPreflightReport — read-only readiness report for both paper dev paths.
 *
 * @param {object} o — { argv?: string[], env?: object, fileProbe?: (path)=>{exists,parsed?,parse_error?} }
 * @returns {object} structured report (see module header)
 */
export function buildPaperPreflightReport({ argv = [], env = {}, fileProbe = defaultFileProbe } = {}) {
  const be = assessBrokerExec(argv, env);
  const configBad = be.status === PREFLIGHT_STATUS.MISCONFIGURED;
  const configOff = be.status === PREFLIGHT_STATUS.NOT_READY;   // off or creds missing

  // ── dispatch pass path (Unit 24): opt-in, requires --exec-dispatch + optional --scan-log ──
  const dp = assessDispatchPass(argv, be, fileProbe);

  // ── E2E paper pass path (Unit 16): required input = --run-log (a runOutput) ──
  const e2e = { entrypoint: 'paper_pass_dev.mjs', run_log: { provided: false, status: 'absent' }, blocking_reasons: [], status: null, dry_run_possible: false };
  const runLog = flag(argv, '--run-log');
  if (typeof runLog === 'string' && runLog) {
    e2e.run_log.provided = true;
    const pr = fileProbe(runLog);
    if (!pr.exists) { e2e.run_log.status = 'unreadable'; }
    else if (pr.parse_error) { e2e.run_log.status = 'invalid_json'; }
    else if (pr.parsed == null || typeof pr.parsed !== 'object') { e2e.run_log.status = 'invalid'; }
    else { e2e.run_log.status = 'valid'; }
  }
  if (configBad)      { e2e.status = PREFLIGHT_STATUS.MISCONFIGURED; e2e.blocking_reasons.push(...be.reasons); }
  else if (configOff) { e2e.status = PREFLIGHT_STATUS.NOT_READY;     e2e.blocking_reasons.push(...be.reasons); }
  else if (e2e.run_log.status !== 'valid') {
    e2e.status = PREFLIGHT_STATUS.NOT_READY;
    e2e.blocking_reasons.push(e2e.run_log.provided ? `run_log_${e2e.run_log.status}` : 'run_log_missing');
  } else {
    e2e.status = PREFLIGHT_STATUS.READY; e2e.dry_run_possible = true;
  }

  // ── protective-exit pass path (Unit 20): input = --positions-file OR portfolio_state ──
  const pe = { entrypoint: 'protective_exit_pass_dev.mjs', positions_source: 'portfolio_state', positions_file: { provided: false, status: 'absent' }, blocking_reasons: [], status: null, dry_run_possible: false };
  const posFile = flag(argv, '--positions-file');
  if (typeof posFile === 'string' && posFile) {
    pe.positions_file.provided = true; pe.positions_source = 'file';
    const pr = fileProbe(posFile);
    if (!pr.exists) pe.positions_file.status = 'unreadable';
    else if (pr.parse_error) pe.positions_file.status = 'invalid_json';
    else if (!Array.isArray(pr.parsed)) pe.positions_file.status = 'invalid';
    else pe.positions_file.status = 'valid';
  }
  if (configBad)      { pe.status = PREFLIGHT_STATUS.MISCONFIGURED; pe.blocking_reasons.push(...be.reasons); }
  else if (configOff) { pe.status = PREFLIGHT_STATUS.NOT_READY;     pe.blocking_reasons.push(...be.reasons); }
  else if (pe.positions_file.provided && pe.positions_file.status !== 'valid') {
    pe.status = PREFLIGHT_STATUS.NOT_READY; pe.blocking_reasons.push(`positions_file_${pe.positions_file.status}`);
  } else {
    // file valid, or no file (portfolio_state source — not validated read-only)
    pe.status = PREFLIGHT_STATUS.READY; pe.dry_run_possible = true;
  }

  // ── global summary ──────────────────────────────────────────────────────────
  // overall_status: derived from maintenance paths only (e2e + protective-exit).
  // dispatch_pass is a separate opt-in path and does NOT feed into overall_status.
  const worst = [e2e.status, pe.status].reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  const blocking = [...new Set([...e2e.blocking_reasons, ...pe.blocking_reasons])];
  const missing_for_soak = [];
  if (!be.credentials_present && be.paper !== false) missing_for_soak.push('alpaca_paper_keys');
  if (worst === PREFLIGHT_STATUS.READY) missing_for_soak.push('live_account_connectivity_not_checked');
  // dispatch: note getAccount runtime check when config is good enough to attempt dispatch
  if (dp.status === PREFLIGHT_STATUS.READY || dp.status === PREFLIGHT_STATUS.DRY_RUN_ONLY) {
    missing_for_soak.push('dispatch_broker_account_connectivity_not_checked');
  }

  let recommended_next_step;
  if (worst === PREFLIGHT_STATUS.MISCONFIGURED) recommended_next_step = 'fix broker-exec config (paper-only): use --broker-exec alpaca_paper and do not set ALPACA_PAPER=false / non-paper base_url';
  else if (!be.enabled && be.reasons.includes('broker_exec_off')) recommended_next_step = 'enable the paper path: --broker-exec alpaca_paper (+ ALPACA_KEY_ID / ALPACA_SECRET_KEY)';
  else if (!be.credentials_present) recommended_next_step = 'set ALPACA_KEY_ID / ALPACA_SECRET_KEY (paper) to proceed beyond not_ready';
  else recommended_next_step = 'provide inputs (--run-log for E2E; --positions-file or portfolio_state for protective-exit; --scan-log --exec-dispatch for dispatch), then run the dev CLIs with --dry-run before any real paper soak';

  return {
    generated_at: new Date().toISOString(),
    broker_exec: be,
    paths: { e2e_paper_pass: e2e, protective_exit_pass: pe, dispatch_pass: dp },
    summary: {
      overall_status: worst,
      dispatch_status: dp.status,   // informational: separate from overall; opt-in path
      blocking_reasons: blocking,
      missing_for_soak,
      caveats: ['read_only_report', 'live_account_connectivity_not_checked'],
      recommended_next_step,
    },
  };
}

/** preflightExitCode — 2 only for genuine misconfiguration; 0 for every diagnostic outcome. */
export function preflightExitCode(report) {
  return report?.summary?.overall_status === PREFLIGHT_STATUS.MISCONFIGURED ? 2 : 0;
}

// ─── CLI (diagnostic only) — never executes a pass, never builds a broker ──────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const report = buildPaperPreflightReport({ argv: process.argv.slice(2), env: process.env });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(preflightExitCode(report));
}
