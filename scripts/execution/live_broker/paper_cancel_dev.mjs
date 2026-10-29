#!/usr/bin/env node
/**
 * paper_cancel_dev — controlled DEV/SMOKE entrypoint for ONE cancel (Unit 10.3).
 *
 * A deliberate manual dev/smoke tool — NOT a productized runtime entry. It performs
 * exactly ONE `order_cancel.requestCancel(cid, ctx)` for an EXISTING local order so
 * dev/smoke runs (and later real soaks) can cancel a submitted order via CLI. NO loop,
 * NO scheduler, NO daemon, NO new states, NO changes to any core module.
 *
 *   parseBrokerExecConfig(argv, env)  → fail-closed alpaca_paper guard
 *   resolve --client-order-id (CID-safe, required)
 *   ctx = { broker }   (broker = injected for tests, else real AlpacaPaperBroker)
 *   → exactly ONE requestCancel(cid, ctx)   (REAL path delegates fully to order_cancel)
 *   --dry-run → preview only: validate config + record presence + cancelability, NO broker call
 *
 * Exit codes: 0 cancel accepted / valid no-op / dry-run ok · 2 fail-closed (invalid
 * args, config not enabled, record missing, not cancelable, blocked/uncertain) · 1 unexpected.
 *
 * Broker is INJECTABLE (opts.broker / opts.makeBroker) for offline tests; the isMain
 * CLI constructs a real paper broker only when run directly with paper credentials.
 *
 * Args:
 *   --broker-exec alpaca_paper   (or env BROKER_EXEC=alpaca_paper) — REQUIRED
 *   --client-order-id <CID>      REQUIRED (CID-safe charset [A-Za-z0-9_-])
 *   --dry-run                    preview cancelability, do NOT call requestCancel
 */

import { fileURLToPath } from 'url';

import { parseBrokerExecConfig, brokerExecEnabled } from './live_broker_config.mjs';
import { AlpacaPaperBroker }                        from './adapters/alpaca_paper_broker.mjs';
import { requestCancel }                            from './order_cancel.mjs';
import * as store                                   from './order_store.mjs';
import { SETTLED_STATES }                           from './order_store.mjs';

const CID_RE = /^[A-Za-z0-9_-]+$/;

// Dry-run preview only: mirrors order_cancel's cancelable set (real path delegates fully).
const CANCELABLE = new Set(['submitted', 'acknowledged', 'partially_filled']);

function flag(argv, name) { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null; }
function has(argv, name)  { return argv.includes(name); }

/**
 * runPaperCancelDevOnce — validate args+config, then ONE cancel attempt (or dry-run preview).
 * Never calls process.exit; returns a summary carrying exit_code. Fail-closed.
 *
 * @param {object} o — { argv?, env?, broker?, makeBroker? }
 * @returns {Promise<object>} summary { ok, client_order_id, outcome?, state?, dry_run?,
 *                                      cancelable?, preview_outcome?, exit_code, error? }
 */
export async function runPaperCancelDevOnce({
  argv = [], env = {}, broker = null,
  makeBroker = (cfg) => new AlpacaPaperBroker(cfg),
} = {}) {
  // 1) Argument validation (fail-closed → exit 2). No store/broker IO yet.
  const cid    = flag(argv, '--client-order-id');
  const dryRun = has(argv, '--dry-run');
  if (typeof cid !== 'string' || !cid || !CID_RE.test(cid)) {
    return { ok: false, exit_code: 2, error: { reason: 'invalid_args', detail: '--client-order-id is required and must match [A-Za-z0-9_-]' } };
  }

  // 2) Config guard (fail-closed → exit 2).
  let execConfig;
  try { execConfig = parseBrokerExecConfig(argv, env); }
  catch (e) { return { ok: false, exit_code: 2, client_order_id: cid, error: { reason: 'config_invalid', detail: e?.message ?? String(e) } }; }
  if (!brokerExecEnabled(execConfig)) {
    return { ok: false, exit_code: 2, client_order_id: cid, error: { reason: 'broker_exec_not_enabled', detail: 'requires --broker-exec alpaca_paper / BROKER_EXEC=alpaca_paper' } };
  }

  // 3) Dry-run: preview only — record presence + cancelability, NO broker call.
  if (dryRun) {
    const rec = store.get(cid);   // throws on corrupt = fail-closed (caught below at call site? no — propagate as unexpected)
    if (rec == null) {
      return { ok: false, dry_run: true, client_order_id: cid, state: null, cancelable: false, preview_outcome: 'not_found_local', exit_code: 2 };
    }
    let preview, cancelable, exit;
    if (rec.state === 'cancel_pending')      { preview = 'already_cancel_pending'; cancelable = false; exit = 0; }
    else if (rec.state === 'cancelled')      { preview = 'already_cancelled';      cancelable = false; exit = 0; }
    else if (CANCELABLE.has(rec.state))      { preview = 'cancel_requested';       cancelable = true;  exit = 0; }
    else { preview = SETTLED_STATES.has(rec.state) ? 'not_cancelable_terminal' : 'not_cancelable_state'; cancelable = false; exit = 2; }
    return { ok: exit === 0, dry_run: true, client_order_id: cid, state: rec.state, cancelable, preview_outcome: preview, exit_code: exit };
  }

  // 4) Real path: EXACTLY ONE requestCancel — fully delegated to order_cancel.
  const paperBroker = broker ?? makeBroker(execConfig);
  let r;
  try { r = await requestCancel(cid, { broker: paperBroker }); }
  catch (e) {
    return { ok: false, exit_code: 1, client_order_id: cid, error: { reason: 'unexpected', detail: e?.message ?? String(e) } };
  }
  return { ok: r.ok === true, client_order_id: cid, outcome: r.outcome, state: r.state ?? null, exit_code: r.ok === true ? 0 : 2 };
}

/** cancelDevExitCode — map a summary to a CLI exit code (defaults to 1 if absent). */
export function cancelDevExitCode(summary) {
  return Number.isInteger(summary?.exit_code) ? summary.exit_code : 1;
}

// ─── CLI (dev/smoke only) — single explicit invocation, never auto-runs on import ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runPaperCancelDevOnce({ argv: process.argv.slice(2), env: process.env })
    .then((summary) => {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      process.exit(cancelDevExitCode(summary));
    })
    .catch((err) => {
      process.stderr.write(JSON.stringify({ ok: false, reason: 'fatal', error: err?.message ?? String(err), exit_code: 1 }) + '\n');
      process.exit(1);
    });
}
