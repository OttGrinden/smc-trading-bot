#!/usr/bin/env node
/**
 * paper_exec_dev — Unit 23: dev/smoke entrypoint for the paper exec layer.
 *
 * Exercises the Unit 22 helpers (validatePaperExecConfig + runPaperExecLayer)
 * with a PREPARED scanJson — it does NOT spawn scan.mjs or run the scan pipeline.
 * Use it to smoke-test the --execution alpaca_paper path in isolation:
 *   - verify config validation behaves as expected (fail-fast, exit 2)
 *   - confirm the worker-pass layer is wired correctly (dry-run or injected stub)
 *   - validate a previously written run-log can drive a maintenance pass
 *
 * Inputs (in priority order):
 *   1. Injected scanJson param (programmatic / tests)
 *   2. --scan-log <path>  CLI flag  (reads an existing run-log from disk)
 *
 * Exit codes:
 *   0  — ok or dry-run (no error)
 *   2  — config / input error (missing keys, ALPACA_PAPER=false, bad scan-log)
 *   1  — unexpected runtime error (workerPass threw)
 *
 * SCOPE (Unit 23 ONLY): thin wrapper + dev CLI — no scan pipeline, no schema
 * changes, no new states, no order dispatch (maintenance-only, no approvedIntents).
 */

import { readFileSync }                                        from 'fs';
import { fileURLToPath }                                       from 'url';
import { validatePaperExecConfig, runPaperExecLayer }         from './paper_exec_layer.mjs';

// ─── helpers ─────────────────────────────────────────────────────────────────

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}

function defaultFileProbe(path) {
  return readFileSync(path, 'utf8');   // throws on not-found / permission error
}

const DRY_RUN_SUMMARY = Object.freeze({
  ran: false, reason: 'dry_run', gate: null,
  steps: { dispatch: { skipped: true }, cycle: { skipped: true }, sync: { skipped: true } },
  error: null,
});

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * execDevExitCode — derive process exit code from a runPaperExecDevOnce result.
 */
export function execDevExitCode(result) {
  return result?.exit_code ?? 1;
}

/**
 * runPaperExecDevOnce — smoke-test the paper exec layer with a prepared scan output.
 *
 * @param {object}   opts
 * @param {string[]} [opts.argv=[]]       — CLI args (--dry-run, --scan-log, --broker-exec)
 * @param {object}   [opts.env={}]        — env vars (ALPACA_KEY_ID, ALPACA_SECRET_KEY …)
 * @param {string}   [opts.scanJson]      — injected scan output; takes precedence over --scan-log
 * @param {Function} [opts.workerPass]    — injectable stub; default = paper_exec_layer default
 * @param {Function} [opts.fileProbe]     — injectable file reader (path→string); default = readFileSync
 * @returns {Promise<object>} { ok, dry_run?, result?, reason?, detail?, exit_code }
 */
export async function runPaperExecDevOnce({
  argv       = [],
  env        = {},
  scanJson   = undefined,
  workerPass = undefined,
  fileProbe  = undefined,
} = {}) {
  const isDryRun = argv.includes('--dry-run');
  const probe    = fileProbe ?? defaultFileProbe;

  // ── 1. Acquire scan JSON ────────────────────────────────────────────────────
  let json;
  if (scanJson !== undefined && scanJson !== null) {
    json = scanJson;
  } else {
    const scanLogPath = flag(argv, '--scan-log');
    if (!scanLogPath) {
      return { ok: false, reason: 'scan_log_missing', exit_code: 2 };
    }
    try {
      json = probe(scanLogPath);
    } catch (e) {
      return { ok: false, reason: 'scan_log_unreadable', detail: e?.message ?? String(e), exit_code: 2 };
    }
    if (json == null) {
      return { ok: false, reason: 'scan_log_unreadable', exit_code: 2 };
    }
  }

  // ── 2. Validate JSON (config/input error → exit 2) ─────────────────────────
  let run_id = null;
  try {
    run_id = JSON.parse(json)?.run_id ?? null;
  } catch (e) {
    return { ok: false, reason: 'scan_log_invalid_json', detail: e?.message ?? String(e), exit_code: 2 };
  }

  // ── 3. Dry-run: skip config validation + worker pass entirely ───────────────
  if (isDryRun) {
    return { ok: true, dry_run: true, result: { ...DRY_RUN_SUMMARY, run_id }, exit_code: 0 };
  }

  // ── 4. Validate exec config (fail-fast → exit 2) ───────────────────────────
  let execConfig;
  try {
    execConfig = validatePaperExecConfig(argv, env);
  } catch (e) {
    return { ok: false, reason: 'config_invalid', detail: e?.message ?? String(e), exit_code: 2 };
  }

  // ── 5. Run paper exec layer ─────────────────────────────────────────────────
  try {
    const opts   = workerPass !== undefined ? { workerPass } : {};
    const result = await runPaperExecLayer(json, execConfig, opts);
    return { ok: true, result, exit_code: 0 };
  } catch (e) {
    return { ok: false, reason: 'exec_layer_failed', detail: e?.message ?? String(e), exit_code: 1 };
  }
}

// ─── isMain CLI ──────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const result = await runPaperExecDevOnce({ argv: process.argv.slice(2), env: process.env });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(execDevExitCode(result));
}
