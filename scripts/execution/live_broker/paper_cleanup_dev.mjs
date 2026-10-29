#!/usr/bin/env node
/**
 * paper_cleanup_dev — controlled DEV/SMOKE store-hygiene entrypoint (Unit 10.4).
 *
 * A deliberate manual dev/smoke tool — NOT a productized runtime entry. It removes
 * LOCAL order-store records that are unambiguously dev/smoke artifacts so repeated
 * dev/smoke/soak runs don't accumulate noise. NO loop, NO scheduler, NO daemon, NO
 * broker/network call, NO new states.
 *
 * Safety (fail-closed, minimal blast radius):
 *   - Targets ONLY records whose client_order_id starts with an explicit, non-empty,
 *     CID-safe prefix (default "smoke_"). Never a wildcard / never "delete all".
 *   - Deletes ONLY records in a SETTLED/terminal state (filled/rejected/cancelled/
 *     replaced/expired/blocked/failed_reconciliation). A prefix-matching record that
 *     is still NON-TERMINAL (e.g. submitted / cancel_pending / submit_unknown) is
 *     NEVER deleted — it may still hold a live broker order. It is reported under
 *     `skipped_non_terminal` so the operator cancels it first (paper_cancel_dev).
 *   - If the store is not fully readable (corrupt record), aborts and deletes nothing.
 *   - Broker-side cancellation is OUT OF SCOPE (use paper_cancel_dev) — this is pure
 *     local store hygiene.
 *   - Idempotent: re-running after a clean run removes nothing (stable).
 *
 * The alpaca_paper config guard is required only as a CONTEXT gate (consistency with
 * the other dev entrypoints) — no broker is constructed and no network call is made.
 *
 * Exit codes: 0 ok (removed / nothing to do / dry-run) · 2 fail-closed (invalid args,
 * config not enabled, store unreadable) · 1 unexpected error.
 *
 * Args:
 *   --broker-exec alpaca_paper   (or env BROKER_EXEC=alpaca_paper) — REQUIRED (context gate)
 *   --cid-prefix <prefix>        (default "smoke_"; non-empty, CID-safe [A-Za-z0-9_-])
 *   --dry-run                    preview targets, delete nothing
 */

import { fileURLToPath } from 'url';

import { parseBrokerExecConfig, brokerExecEnabled } from './live_broker_config.mjs';
import * as store                                   from './order_store.mjs';
import { SETTLED_STATES }                           from './order_store.mjs';

const PREFIX_RE = /^[A-Za-z0-9_-]+$/;

function flag(argv, name) { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null; }
function has(argv, name)  { return argv.includes(name); }

/**
 * runPaperCleanupDevOnce — one fail-closed cleanup pass over local dev/smoke records.
 * Never calls process.exit; returns a summary carrying exit_code.
 *
 * @param {object} o — { argv?, env? }
 * @returns {Promise<object>} summary
 */
export async function runPaperCleanupDevOnce({ argv = [], env = {} } = {}) {
  // 1) Argument validation (fail-closed → exit 2). Prefix must be explicit + CID-safe.
  const prefix = flag(argv, '--cid-prefix') ?? 'smoke_';
  const dryRun = has(argv, '--dry-run');
  if (typeof prefix !== 'string' || !prefix || !PREFIX_RE.test(prefix)) {
    return { ok: false, exit_code: 2, error: { reason: 'invalid_args', detail: '--cid-prefix must be a non-empty token matching [A-Za-z0-9_-]' } };
  }

  // 2) Config context gate (fail-closed → exit 2). No broker is constructed.
  let execConfig;
  try { execConfig = parseBrokerExecConfig(argv, env); }
  catch (e) { return { ok: false, exit_code: 2, cid_prefix: prefix, error: { reason: 'config_invalid', detail: e?.message ?? String(e) } }; }
  if (!brokerExecEnabled(execConfig)) {
    return { ok: false, exit_code: 2, cid_prefix: prefix, error: { reason: 'broker_exec_not_enabled', detail: 'requires --broker-exec alpaca_paper / BROKER_EXEC=alpaca_paper' } };
  }

  // 3) Read the store. Fail-closed: a corrupt/unreadable store deletes NOTHING.
  let records;
  try { records = store.listAll(); }
  catch (e) { return { ok: false, exit_code: 2, cid_prefix: prefix, error: { reason: 'store_unreadable', detail: e?.message ?? String(e) } }; }

  const scanned        = records.length;
  const prefixMatches  = records.filter(r => typeof r.client_order_id === 'string' && r.client_order_id.startsWith(prefix));
  const deletable      = prefixMatches.filter(r => SETTLED_STATES.has(r.state));
  const skipped        = prefixMatches.filter(r => !SETTLED_STATES.has(r.state)).map(r => ({ cid: r.client_order_id, state: r.state }));
  const warnFields     = skipped.length ? { warning: 'non_terminal_matches_skipped' } : {};

  // 4) Dry-run: preview only, delete nothing.
  if (dryRun) {
    return {
      ok: true, dry_run: true, cid_prefix: prefix, scanned,
      would_remove: deletable.map(r => ({ cid: r.client_order_id, state: r.state })),
      skipped_non_terminal: skipped, ...warnFields, exit_code: 0,
    };
  }

  // 5) Delete only the eligible (prefix + settled) records.
  const removed = [];
  try {
    for (const r of deletable) { if (store.remove(r.client_order_id)) removed.push(r.client_order_id); }
  } catch (e) {
    return { ok: false, exit_code: 1, cid_prefix: prefix, removed, error: { reason: 'unexpected', detail: e?.message ?? String(e) } };
  }
  return {
    ok: true, cid_prefix: prefix, scanned, removed,
    skipped_non_terminal: skipped, ...warnFields, exit_code: 0,
  };
}

/** cleanupDevExitCode — map a summary to a CLI exit code (defaults to 1 if absent). */
export function cleanupDevExitCode(summary) {
  return Number.isInteger(summary?.exit_code) ? summary.exit_code : 1;
}

// ─── CLI (dev/smoke only) — single explicit invocation, never auto-runs on import ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runPaperCleanupDevOnce({ argv: process.argv.slice(2), env: process.env })
    .then((summary) => {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      process.exit(cleanupDevExitCode(summary));
    })
    .catch((err) => {
      process.stderr.write(JSON.stringify({ ok: false, reason: 'fatal', error: err?.message ?? String(err), exit_code: 1 }) + '\n');
      process.exit(1);
    });
}
