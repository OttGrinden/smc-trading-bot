/**
 * WorkerPass — single-shot orchestrator for one controlled paper execution pass
 * (Phase 1, Unit 10.7).
 *
 * The bridges now exist independently (10.5 fill→portfolio sync, 10.6 intent→submit)
 * alongside the maintenance cycle (Unit 7) and the fail-closed startup gate (Unit 9c/10).
 * This unit wires them into ONE deterministic, fail-closed pass — NOT a daemon/loop:
 *
 *   1. precondition gate ...... assertStartupGate({broker, execConfig})  → unsafe ⇒ ABORT
 *   2a. account sizing ........ sizeIntentsFromBroker(...)                (OPT-IN only, default off)
 *   2b. dispatch .............. dispatchApproved(intents)                 (only if intents present)
 *   3. maintenance cycle ...... runPaperCycleOnce({broker, execConfig})   (Unit 7: lease→reconcile→poll)
 *   4. fill→portfolio sync .... syncFillsToPortfolio()                    (only if the cycle actually ran)
 *   5. return a structured summary
 *
 * Account-based sizing is OPT-IN (ctx.sizeFromAccount=true, Unit 13 wiring of Units 11+12):
 * default off keeps the legacy contract (approvedIntents already SIZED) byte-identical. When
 * on, approvedIntents are UNSIZED and sized via a read-only account snapshot before dispatch;
 * a failed/invalid account yields NO new dispatch (fail-closed) while maintenance still runs.
 *
 * It adds NO trading logic of its own and holds NO outer lease: each sub-operation
 * keeps its OWN single-writer lease (RunLease is not re-entrant, so nesting is
 * impossible by design). Sub-operations run sequentially; each is individually
 * single-writer-safe. True cross-step atomicity is deliberately OUT OF SCOPE — this is
 * a single controlled pass, not a transaction.
 *
 * 5. broker fill booking . bookBrokerFills()                             (opt-in, only if cycle ran)
 *
 * Booking is OPT-IN (ctx.bookFills=true, default off): bookBrokerFills handles both
 * FILLED and PARTIALLY_FILLED records; shares the booked_fills watermark with
 * syncFillsToPortfolio — no double-booking by design, safe to run both in sequence.
 *
 * This is NOT: a scheduler / daemon / infinite loop, a live broker / live trading path,
 * risk gating (10.8), stop/bracket logic (10.9), or any new
 * runtime/service infrastructure. The broker is INJECTED (ctx.broker) — fully offline-
 * testable; nothing here constructs a real broker or touches the network. It does not
 * invent intents: `approvedIntents` are supplied by the caller.
 *
 * Fail-closed: invalid/non-paper config or a missing broker throws BEFORE any step;
 * an unsafe gate aborts before dispatch/sync; a cycle that did not run (lease held by
 * another writer / worker error) skips the portfolio sync (back-off — never mutate the
 * portfolio while another writer is active); a corrupt store in a step aborts the pass.
 */

import { brokerExecEnabled }     from './live_broker_config.mjs';
import { assertStartupGate }     from './startup_recovery.mjs';
import { dispatchApproved }      from './order_dispatch.mjs';
import { runPaperCycleOnce }     from './paper_runner.mjs';
import { syncFillsToPortfolio }  from './fill_sync.mjs';
import { bookBrokerFills }       from './broker_fill_booking.mjs';
import { checkSafetyGates }      from './safety_gates.mjs';
import { sizeIntentsFromBroker } from './broker_account_sizing.mjs';

function assertPaperConfig(execConfig) {
  if (!brokerExecEnabled(execConfig)) {
    throw new Error('worker_pass: execConfig must be an enabled alpaca_paper config (fail-closed)');
  }
  if (execConfig.paper !== true) {
    throw new Error('worker_pass: refuses a non-paper execConfig (fail-closed)');
  }
}

/**
 * runWorkerPassOnce — one controlled, fail-closed pass over the existing primitives.
 *
 * @param {object} ctx — {
 *   broker (req: paper adapter w/ submitOrder + getOrderByClientId),
 *   execConfig (req: enabled alpaca_paper config),
 *   approvedIntents? (array of approved intents; SIZED by default — allocation newPosition
 *     shape — or UNSIZED when sizeFromAccount=true, see below),
 *   sizeFromAccount? (opt-in, default false: when true, approvedIntents are treated as
 *     UNSIZED and sized via broker.getAccount() + account_sizing BEFORE dispatch),
 *   sizingOpts? (optional account_sizing overrides; only read when sizeFromAccount=true),
 *   run_id?, leaseOpts?
 * }
 * @returns {Promise<object>} summary {
 *   ran, reason, gate, steps: { sizing, dispatch, cycle, sync }, error
 * }
 * @throws {Error} on invalid/non-paper config or a missing broker (fail-closed, pre-flight);
 *   additionally, when sizeFromAccount=true, on a broker without getAccount()
 */
export async function runWorkerPassOnce(ctx = {}) {
  const { broker, execConfig, approvedIntents, run_id, leaseOpts, sizeFromAccount } = ctx;

  // 0) Pre-flight guards — throw before ANY step (mirrors paper_runner / startup_recovery).
  assertPaperConfig(execConfig);
  if (!broker || typeof broker.submitOrder !== 'function' || typeof broker.getOrderByClientId !== 'function') {
    throw new Error('worker_pass: ctx.broker must implement submitOrder + getOrderByClientId (injected paper broker)');
  }
  // account-sizing opt-in additionally requires the read-only getAccount() capability.
  if (sizeFromAccount === true && typeof broker.getAccount !== 'function') {
    throw new Error('worker_pass: sizeFromAccount=true requires ctx.broker.getAccount (fail-closed)');
  }

  const summary = {
    ran: false, reason: null, gate: null,
    steps: { sizing: null, dispatch: null, cycle: null, sync: null, booking: null, safety: null },
    error: null,
  };

  // 1) Precondition gate (fail-closed). Unsafe → abort with NO dispatch / cycle / sync.
  const gate = await assertStartupGate({ broker, execConfig, leaseOpts });
  summary.gate = gate.gate ?? { safe: gate.safe === true };
  if (gate.safe !== true) {
    summary.reason = 'gate_unsafe';
    summary.steps.sizing   = { skipped: true, reason: 'gate_unsafe' };
    if (ctx.safetyGates != null)  summary.steps.safety  = { skipped: true, reason: 'gate_unsafe' };
    summary.steps.dispatch = { skipped: true, reason: 'gate_unsafe' };
    summary.steps.sync     = { skipped: true, reason: 'gate_unsafe' };
    if (ctx.bookFills === true)   summary.steps.booking = { skipped: true, reason: 'gate_unsafe' };
    return summary;
  }

  try {
    // 2a) Optional account-based sizing (opt-in). Default off → legacy path: approvedIntents
    //     are already SIZED and passed straight through. When on, approvedIntents are UNSIZED
    //     and sized against a live (paper) account snapshot BEFORE dispatch (fail-closed: a
    //     failed/invalid account yields NO new dispatch; the maintenance cycle still runs).
    const rawIntents = Array.isArray(approvedIntents) ? approvedIntents : [];
    let intents;          // null = skip dispatch (sizing failed); else the list to dispatch
    if (sizeFromAccount === true) {
      const sizing = await sizeIntentsFromBroker(rawIntents, { broker, run_id, ...(ctx.sizingOpts ?? {}) });
      summary.steps.sizing = sizing;
      if (sizing.account_ok !== true) {
        intents = null;
        summary.steps.dispatch = { skipped: true, reason: 'sizing_account_not_ok', account_reason: sizing.account_reason };
      } else {
        intents = sizing.sized;
      }
    } else {
      summary.steps.sizing = { skipped: true, reason: 'sizing_disabled' };
      intents = rawIntents;
    }

    // 1.5) Safety gates — opt-in (default off). Kill-switch or max-daily-loss block dispatch +
    //      booking; cycle and sync are NOT blocked — maintenance of existing positions always runs.
    let safetyBlock = null;
    if (ctx.safetyGates != null) {
      summary.steps.safety = checkSafetyGates(ctx.safetyGates);
      if (summary.steps.safety.safe !== true) safetyBlock = summary.steps.safety.reason;
    }

    // 2b) Dispatch (no startupGate here — already gated above). Sizing failure or safety block → no dispatch.
    if (intents === null) {
      // dispatch step already set to skipped(sizing_account_not_ok) above
    } else if (safetyBlock != null) {
      summary.steps.dispatch = { skipped: true, reason: safetyBlock };
    } else {
      summary.steps.dispatch = intents.length > 0
        ? await dispatchApproved(intents, { broker, run_id })
        : { skipped: true, reason: sizeFromAccount === true ? 'no_sized_intents' : 'no_intents' };
    }

    // 3) Maintenance cycle (Unit 7): own lease → reconcile → poll → release.
    summary.steps.cycle = await runPaperCycleOnce({ broker, execConfig, leaseOpts });

    // 4) Portfolio sync — ONLY if the cycle actually ran (back-off otherwise).
    if (summary.steps.cycle?.ran === true) {
      summary.steps.sync = syncFillsToPortfolio({ run_id });
    } else {
      summary.steps.sync = { skipped: true, reason: 'cycle_did_not_run' };
    }

    // 5) Broker fill booking — opt-in (default off). Handles PARTIALLY_FILLED in addition to FILLED.
    //    Shares booked_fills watermark with syncFillsToPortfolio — no double-booking by design.
    //    Blocked only by gates with blocks_booking:true (kill_switch, max_daily_loss).
    //    Session gate has blocks_booking:false — confirmed fills process even outside session.
    if (ctx.bookFills === true) {
      const blockBooking = safetyBlock != null && summary.steps.safety?.blocks_booking === true;
      if (blockBooking) {
        summary.steps.booking = { skipped: true, reason: safetyBlock };
      } else {
        summary.steps.booking = summary.steps.cycle?.ran === true
          ? bookBrokerFills({ run_id })
          : { skipped: true, reason: 'cycle_did_not_run' };
      }
    }

    summary.ran    = summary.steps.cycle?.ran === true;
    summary.reason = summary.ran ? 'completed' : 'cycle_did_not_run';
  } catch (e) {
    // Corrupt store / unexpected error in a step → fail-closed, no further steps.
    summary.ran    = false;
    summary.reason = 'worker_error';
    summary.error  = { message: e?.message ?? String(e), error_class: e?.error_class ?? null };
  }

  return summary;
}
