#!/usr/bin/env node
/**
 * StartupRecovery — single-shot, lease-protected recovery + read-only safety gate
 * (Phase 1, Unit 9c).
 *
 * runStartupRecoveryOnce(ctx) performs ONE conservative recovery pass and then a
 * READ-ONLY assessment of whether it is safe to proceed with new orders:
 *
 *   1. re-assert the fail-closed alpaca_paper config guard
 *   2. acquire the single-writer lease (RunLease) — not acquired → fail-closed (exit 2)
 *   3. reconcileOnce({ broker })          — resolve uncertain/flagged records
 *   4. read-only gate: any non-terminal record still in submit_unknown /
 *      reconcile_hold / pending_submit, or carrying a reconcile_flag → NOT safe
 *   5. release the lease (always, in finally)
 *
 * Exit-code contract (returned as summary.exit_code; the CLI maps it to process.exit):
 *   0  — safe to proceed (recovery clean, no blocking records)
 *   2  — fail-closed: holds/unknowns present, or the lease could not be acquired
 *   1  — unexpected error (e.g. a corrupt store record made reconcile throw)
 *
 * This is NOT a scheduler/daemon/loop, NOT a submit/cancel/replace path, NOT a
 * portfolio mutator. It changes NOTHING in scan.mjs or order_gateway.mjs. The broker
 * is INJECTED (ctx.broker) so the function is fully offline-testable; the isMain CLI
 * constructs a real paper broker only when run directly with credentials.
 */

import { fileURLToPath } from 'node:url';

import { brokerExecEnabled, parseBrokerExecConfig } from './live_broker_config.mjs';
import { acquireLease, releaseLease } from './run_lease.mjs';
import { reconcileOnce }              from './reconciler.mjs';
import * as store                     from './order_store.mjs';
import { ORDER_STATES }               from '../schemas.mjs';

// Non-terminal states that BLOCK new orders until resolved (fail-closed new-order gate).
const BLOCKING_STATES = new Set([
  ORDER_STATES.SUBMIT_UNKNOWN, ORDER_STATES.RECONCILE_HOLD, ORDER_STATES.PENDING_SUBMIT,
]);

function assertPaperConfig(execConfig) {
  if (!brokerExecEnabled(execConfig)) {
    throw new Error('startup_recovery: execConfig must be an enabled alpaca_paper config (fail-closed)');
  }
  if (execConfig.paper !== true) {
    throw new Error('startup_recovery: refuses a non-paper execConfig (fail-closed)');
  }
}

/**
 * assessGate — read-only: are there records that block safe new-order submission?
 * Blocking = a non-terminal record in submit_unknown/reconcile_hold/pending_submit,
 * or any non-terminal record carrying a reconcile_flag. Throws on corrupt store
 * (fail-closed, propagated to the caller → exit 1).
 */
export function assessGate() {
  const recs     = store.listNonTerminal();   // throws on corrupt = fail-closed
  const blocking = recs
    .filter(r => BLOCKING_STATES.has(r.state) || r.reconcile_flag != null)
    .map(r => ({ cid: r.client_order_id, state: r.state, reconcile_flag: r.reconcile_flag ?? null }));
  return { safe: blocking.length === 0, blocking_count: blocking.length, blocking };
}

/**
 * runStartupRecoveryOnce — one lease-protected recovery pass + read-only gate.
 *
 * @param {object} ctx — { broker (req: adapter w/ getOrderByClientId),
 *                         execConfig (req: enabled alpaca_paper config), leaseOpts? }
 * @returns {Promise<object>} summary incl. exit_code (0 safe / 2 fail-closed / 1 error)
 * @throws  {Error} on invalid config or missing broker (fail-closed, before any lease)
 */
export async function runStartupRecoveryOnce(ctx = {}) {
  const { broker, execConfig, leaseOpts } = ctx;

  // 1) Config guard FIRST — before any lease.
  assertPaperConfig(execConfig);
  if (!broker || typeof broker.getOrderByClientId !== 'function') {
    throw new Error('startup_recovery: ctx.broker must implement getOrderByClientId (injected paper broker)');
  }

  // 2) Single-writer lease. Not acquired → fail-closed: cannot safely recover/assess.
  const acq = acquireLease(leaseOpts ?? {});
  if (!acq.acquired) {
    return {
      ok: false, ran: false, reason: `lease_${acq.reason}`,
      lease: { acquired: false, reason: acq.reason, holder: acq.holder ?? null },
      reconcile: null,
      gate: { safe: false, blocking_count: null, blocking: [], reason: 'lease_unavailable' },
      error: null, exit_code: 2,
    };
  }

  const summary = {
    ok: false, ran: false, reason: null,
    lease: { acquired: true, reason: acq.reason, lease_id: acq.lease.lease_id },
    reconcile: null, gate: null, error: null, exit_code: 1,
  };

  try {
    // 3) Recover, then 4) assess. A reconcile failure aborts before assessment.
    summary.reconcile  = await reconcileOnce({ broker });
    summary.gate       = assessGate();
    summary.ran        = true;
    summary.reason     = 'completed';
    summary.ok         = summary.gate.safe;
    summary.exit_code  = summary.gate.safe ? 0 : 2;   // 0 safe / 2 holds present
  } catch (e) {
    summary.ran       = false;
    summary.reason    = 'worker_error';
    summary.error     = { message: e?.message ?? String(e), error_class: e?.error_class ?? null };
    summary.gate      = { safe: false, blocking_count: null, blocking: [], reason: 'worker_error' };
    summary.exit_code = 1;                             // unexpected error
  } finally {
    // 5) Always release our own lease.
    const rel = releaseLease(acq.lease);
    summary.lease.released       = rel.released;
    summary.lease.release_reason = rel.reason;
  }

  return summary;
}

/**
 * assertStartupGate — library convenience wrapper for the fail-closed gate (Unit 10).
 *
 * Runs ONE lease-protected recovery + read-only assessment and reduces it to a single
 * boolean `safe`. FAIL-CLOSED: ANY error (invalid/non-paper config, missing broker,
 * lease unavailable, worker error) yields `safe:false` — it never throws. Intended to
 * be imported and called as an early guard before any new-order submission; it is NOT
 * a CLI and performs no process.exit.
 *
 * @param {object} ctx — { broker (req), execConfig (req: enabled alpaca_paper), leaseOpts? }
 * @returns {Promise<{safe:boolean, exit_code:number, gate:object|null, summary?:object, error?:object}>}
 */
export async function assertStartupGate(ctx = {}) {
  try {
    const summary = await runStartupRecoveryOnce(ctx);
    return {
      safe:      summary.exit_code === 0 && summary.gate?.safe === true,
      exit_code: summary.exit_code,
      gate:      summary.gate ?? null,
      summary,
    };
  } catch (e) {
    // Config invalid / missing broker / unexpected → fail-closed (treat as unsafe).
    return {
      safe: false, exit_code: 1,
      gate: { safe: false, blocking_count: null, blocking: [], reason: 'gate_error' },
      error: { message: e?.message ?? String(e), error_class: e?.error_class ?? null },
    };
  }
}

// ─── CLI (single-shot; constructs a real paper broker only when run directly) ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  (async () => {
    try {
      const execConfig = parseBrokerExecConfig(process.argv.slice(2), process.env);
      if (!brokerExecEnabled(execConfig)) {
        process.stderr.write(JSON.stringify({ error: 'startup_recovery: --broker-exec alpaca_paper required (fail-closed)' }) + '\n');
        process.exit(1);
      }
      // Lazy import keeps the module offline-testable (no adapter/network unless run as CLI).
      const { AlpacaPaperBroker } = await import('./adapters/alpaca_paper_broker.mjs');
      const broker  = new AlpacaPaperBroker(execConfig);
      const summary = await runStartupRecoveryOnce({ broker, execConfig });
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      process.exit(summary.exit_code);
    } catch (e) {
      process.stderr.write(JSON.stringify({ error: 'startup_recovery_failed', detail: e?.message ?? String(e) }) + '\n');
      process.exit(1);
    }
  })();
}
