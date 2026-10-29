/**
 * E2E PaperPass — the first thin end-to-end stitch from decision-building to the
 * single-shot worker pass (Phase 1, Unit 15).
 *
 * Connects the three already-merged pieces into ONE opt-in, fail-closed, offline-
 * testable orchestration — WITHOUT a new entrypoint, daemon, scan.mjs change, or any
 * live execution:
 *
 *   buildDecisions(runOutput)                 → { intent, decision }[]   (Unit: decision_engine)
 *   approvedIntentsFromDecisions(decisions)   → UNSIZED approved intents (Unit 14)
 *   runWorkerPassOnce({ ..., sizeFromAccount:true })                     (Unit 13 → 12 → 10.6/7)
 *
 * FACHLICH VERBINDLICH: the decision-engine output is approved but UNSIZED (price_usd,
 * NO quantity); the sizing happens LATER, account-based, via the Unit 12/13 path inside
 * runWorkerPassOnce(sizeFromAccount:true). The sized allocation_engine path (quantity) is
 * a separate parallel source and is deliberately NOT used here.
 *
 * SCOPE (Unit 15 ONLY) — deliberately tiny and additive:
 *   - a single async orchestrator function: build → normalize(approved, unsized) → worker pass
 *   - broker is INJECTED (offline-testable; nothing constructs a real broker / touches network)
 *   - buildDecisions is INJECTABLE (ctx._buildDecisions) so tests avoid decision_engine file IO
 *   - reuses approvedIntentsFromDecisions + runWorkerPassOnce wholesale — no core change
 *
 * EXPLICITLY NOT in this unit: a scan.mjs / CLI / daemon entrypoint, default-on behaviour,
 * live broker / live order execution, portfolio mutation of its own, sizing/dispatch logic
 * (owned by 12/13/10.6), the sized allocation_engine path, stop/bracket logic. No existing
 * module is modified.
 *
 * Fail-closed & opt-in (structural): it ONLY runs when the caller supplies an enabled
 * alpaca_paper execConfig AND a capable paper broker (submitOrder + getOrderByClientId +
 * getAccount). A bad config / incapable broker / missing runOutput / live mode throws
 * BEFORE any decision-building side effect — so nothing is built or dispatched on doubt.
 */

import { buildDecisions as realBuildDecisions } from '../decision_engine.mjs';
import { approvedIntentsFromDecisions as realApprovedIntents } from './intents_from_decisions.mjs';
import { runWorkerPassOnce } from './worker_pass.mjs';
import { brokerExecEnabled } from './live_broker_config.mjs';
import { EXECUTION_MODES } from '../schemas.mjs';

/**
 * runApprovedDecisionsPass — thin E2E: approved decisions → unsized intents → worker pass.
 *
 * @param {object} ctx — {
 *   runOutput (req: research_run output object),
 *   broker (req: paper adapter w/ submitOrder + getOrderByClientId + getAccount),
 *   execConfig (req: enabled alpaca_paper config),
 *   katalysatorMap? ({ [symbol]: boolean } passed to buildDecisions),
 *   mode? ('shadow'|'paper'; never 'live'; default 'shadow'),
 *   sizingOpts? (account_sizing overrides, forwarded to the worker pass),
 *   run_id?, leaseOpts?,
 *   _buildDecisions? / _approvedIntentsFromDecisions? (DI overrides for offline tests)
 * }
 * @returns {Promise<object>} summary {
 *   run_id, mode, decisions_total, approved, emitted, skipped, worker
 * }
 * @throws {Error} fail-closed (pre-flight, before any decision-building): missing runOutput,
 *   live mode, non-paper/disabled execConfig, or a broker lacking the required methods.
 */
export async function runApprovedDecisionsPass(ctx = {}) {
  const { runOutput, broker, execConfig, katalysatorMap = {}, run_id, leaseOpts, sizingOpts } = ctx;
  const mode = ctx.mode ?? EXECUTION_MODES.SHADOW;

  // ── pre-flight, fail-closed: validate BEFORE any decision-building side effect ──
  if (mode === EXECUTION_MODES.LIVE) {
    throw new Error('runApprovedDecisionsPass: live mode is not supported (fail-closed)');
  }
  if (!runOutput || typeof runOutput !== 'object') {
    throw new Error('runApprovedDecisionsPass: ctx.runOutput is required (fail-closed)');
  }
  if (!brokerExecEnabled(execConfig) || execConfig.paper !== true) {
    throw new Error('runApprovedDecisionsPass: requires an enabled alpaca_paper execConfig (fail-closed)');
  }
  if (!broker || typeof broker.submitOrder !== 'function' ||
      typeof broker.getOrderByClientId !== 'function' || typeof broker.getAccount !== 'function') {
    throw new Error('runApprovedDecisionsPass: ctx.broker must implement submitOrder + getOrderByClientId + getAccount (fail-closed)');
  }

  const buildDecisionsFn = typeof ctx._buildDecisions === 'function' ? ctx._buildDecisions : realBuildDecisions;
  const normalizeFn      = typeof ctx._approvedIntentsFromDecisions === 'function' ? ctx._approvedIntentsFromDecisions : realApprovedIntents;
  const runId            = run_id ?? runOutput.run_id ?? null;

  // 1) build decisions (never live)
  const decisions = buildDecisionsFn(runOutput, katalysatorMap, mode);

  // 2+3) approved subset → UNSIZED intent shape (Unit 14)
  const norm = normalizeFn(decisions, { run_id: runId });

  // 4) hand to the single-shot worker pass with account-based sizing ON (Unit 13 → 12)
  const worker = await runWorkerPassOnce({
    broker, execConfig,
    approvedIntents: norm.intents,
    sizeFromAccount: true,
    run_id: runId, leaseOpts, sizingOpts,
  });

  return {
    run_id: runId,
    mode,
    decisions_total: Array.isArray(decisions) ? decisions.length : 0,
    approved: norm.approved,
    emitted: norm.emitted,
    skipped: norm.skipped,
    worker,
  };
}
