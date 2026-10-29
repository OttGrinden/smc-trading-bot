/**
 * PaperRunner — single, safe, lease-protected paper execution cycle (Phase 1, Unit 7).
 *
 * runPaperCycleOnce(ctx) coordinates the EXISTING async maintenance workers under a
 * single-writer lease. It adds NO trading logic of its own:
 *
 *   1. re-assert the fail-closed alpaca_paper config guard
 *   2. acquire the single-writer lease (RunLease)         — not acquired → no run, no workers
 *   3. reconcileOnce({ broker })                          — resolve uncertain/flagged records
 *   4. pollOnce({ broker })                               — sync broker truth + idempotent fills
 *   5. aggregate a summary
 *   6. release the lease (always, in finally)
 *
 * Order rationale: reconcile BEFORE poll — uncertain records (pending_submit /
 * submit_unknown / reconcile_hold / flagged) are first re-entered into the live lane,
 * so the poller can then advance + apply fills for them in the SAME cycle.
 *
 * This is NOT: a scheduler / daemon / loop, a submit / cancel / replace path, a
 * recovery-submit, a portfolio / cash / PnL mutator, or any scan.mjs / engine / CLI
 * wiring. The broker is INJECTED (ctx.broker) — the runner never constructs a real
 * broker or touches the network, keeping it fully offline-testable.
 *
 * Fail-closed throughout: bad config throws before any lease; a lease that cannot be
 * acquired means no run and no worker call; a worker error aborts the cycle (no
 * half-run) but the lease is still released.
 */

import { brokerExecEnabled }        from './live_broker_config.mjs';
import { acquireLease, releaseLease } from './run_lease.mjs';
import { reconcileOnce }            from './reconciler.mjs';
import { pollOnce }                 from './fill_poller.mjs';

function assertPaperConfig(execConfig) {
  if (!brokerExecEnabled(execConfig)) {
    throw new Error('paper_runner: execConfig must be an enabled alpaca_paper config (fail-closed)');
  }
  if (execConfig.paper !== true) {
    throw new Error('paper_runner: refuses a non-paper execConfig (fail-closed)');
  }
}

/**
 * runPaperCycleOnce — one lease-protected reconcile→poll cycle.
 *
 * @param {object} ctx — { broker (req: paper adapter w/ getOrderByClientId),
 *                         execConfig (req: enabled alpaca_paper config), leaseOpts? }
 * @returns {Promise<object>} summary { ran, reason, lease, reconcile, poll, error }
 * @throws  {Error} on invalid config or missing broker (fail-closed, before any lease)
 */
export async function runPaperCycleOnce(ctx = {}) {
  const { broker, execConfig, leaseOpts } = ctx;

  // 1) Config guard FIRST — before any lease is created.
  assertPaperConfig(execConfig);
  if (!broker || typeof broker.getOrderByClientId !== 'function') {
    throw new Error('paper_runner: ctx.broker must implement getOrderByClientId (injected paper broker)');
  }

  // 2) Single-writer lease. Not acquired → no run, no worker call.
  const acq = acquireLease(leaseOpts ?? {});
  if (!acq.acquired) {
    return {
      ran: false,
      reason: `lease_${acq.reason}`,
      lease: { acquired: false, reason: acq.reason, holder: acq.holder ?? null },
      reconcile: null, poll: null, error: null,
    };
  }

  const summary = {
    ran: false, reason: null,
    lease: { acquired: true, reason: acq.reason, lease_id: acq.lease.lease_id },
    reconcile: null, poll: null, error: null,
  };

  try {
    // 3) Reconcile, then 4) poll. A reconcile failure aborts before polling (no half-run).
    summary.reconcile = await reconcileOnce({ broker });
    summary.poll      = await pollOnce({ broker });
    summary.ran    = true;
    summary.reason = 'completed';
  } catch (e) {
    summary.ran    = false;
    summary.reason = 'worker_error';
    summary.error  = { message: e?.message ?? String(e), error_class: e?.error_class ?? null };
  } finally {
    // 6) Always release our own lease.
    const rel = releaseLease(acq.lease);
    summary.lease.released        = rel.released;
    summary.lease.release_reason  = rel.reason;
  }

  return summary;
}
