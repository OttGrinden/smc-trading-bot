#!/usr/bin/env node
/**
 * paper_exec_layer — Unit 22: helpers for scan.mjs --execution alpaca_paper.
 *
 * Two exports consumed by scan.mjs:
 *
 *   validatePaperExecConfig(argv, env)
 *     Validates the write-path exec config when --execution alpaca_paper is requested.
 *     Wraps parseBrokerExecConfig with a synthesised --broker-exec arg so the scan
 *     caller does not need --broker-exec on the CLI. Throws on any config error —
 *     scan.mjs catches and exits 2 BEFORE the scan pipeline starts (fail-fast).
 *
 *   runPaperExecLayer(scanJson, execConfig, opts?)
 *     Called after a successful scan (final stdout already written). Runs ONE
 *     maintenance worker pass (reconcile + poll + fill_sync) — no approvedIntents,
 *     no new order dispatch (Phase 2). Re-throws unexpected errors; scan.mjs exits 1.
 *     Injectable { workerPass? } keeps all tests fully offline.
 *
 * SCOPE (Unit 22 ONLY): scan.mjs wiring helpers — no new states, no schema changes,
 * no dispatch of new orders (maintenance cycle only, approvedIntents deliberately omitted).
 */

import { parseBrokerExecConfig } from './live_broker_config.mjs';
import { AlpacaPaperBroker }    from './adapters/alpaca_paper_broker.mjs';

/**
 * validatePaperExecConfig — validate write-path config for --execution alpaca_paper.
 *
 * Synthesises ['--broker-exec', 'alpaca_paper'] so parseBrokerExecConfig's paper-only
 * guards (credentials, ALPACA_PAPER, base_url) run against the passed env without
 * requiring --broker-exec on the scan.mjs CLI.
 *
 * argv is accepted for future extensibility but the mode is unconditionally forced to
 * alpaca_paper — the intent was already established by --execution alpaca_paper.
 *
 * @param {string[]} argv — process.argv slice (currently unused; forwarded for future use)
 * @param {object}   env  — process.env or subset; must contain ALPACA_KEY_ID + ALPACA_SECRET_KEY
 * @returns {Readonly<object>} enabled execConfig (parseBrokerExecConfig return shape)
 * @throws {Error} on missing keys, ALPACA_PAPER=false, or non-paper base_url
 */
export function validatePaperExecConfig(argv, env) {
  return parseBrokerExecConfig(['--broker-exec', 'alpaca_paper'], env);
}

/**
 * runPaperExecLayerWithDispatch — opt-in dispatch path for --execution alpaca_paper --exec-dispatch.
 *
 * Extends the maintenance-only runPaperExecLayer by running the full E2E decision → intent
 * → account-sized dispatch pipeline (Unit 15: runApprovedDecisionsPass) instead of the
 * maintenance-only worker pass. The maintenance cycle still runs inside the worker pass.
 *
 * Requires broker.getAccount() — enforced by runApprovedDecisionsPass pre-flight.
 * Invalid scanJson → throws (scan.mjs catches → exit 1).
 * Non-paper / incapable broker → throws (scan.mjs catches → exit 1).
 *
 * Injectable for offline tests:
 *   opts.makeBroker(execConfig)         → builds the broker (default: new AlpacaPaperBroker)
 *   opts._buildDecisions                → replaces the real decision engine
 *   opts._approvedIntentsFromDecisions  → replaces the intent normaliser
 *
 * @param {string}   scanJson    — final stdout from the scan pipeline
 * @param {object}   execConfig  — validated config from validatePaperExecConfig
 * @param {object}   [opts]
 * @returns {Promise<object>} runApprovedDecisionsPass summary: { run_id, mode, decisions_total, approved, emitted, skipped, worker }
 */
export async function runPaperExecLayerWithDispatch(scanJson, execConfig, opts = {}) {
  let runOutput;
  try {
    runOutput = JSON.parse(scanJson);
  } catch (e) {
    throw new Error(`paper_exec_layer: invalid scan JSON — ${e.message}`);
  }

  const run_id     = runOutput?.run_id ?? null;
  const makeBroker = typeof opts.makeBroker === 'function'
    ? opts.makeBroker
    : (cfg) => new AlpacaPaperBroker(cfg);
  const broker = makeBroker(execConfig);

  const { runApprovedDecisionsPass } = await import('./e2e_paper_pass.mjs');
  const summary = await runApprovedDecisionsPass({
    runOutput, broker, execConfig, run_id,
    ...(opts._buildDecisions               ? { _buildDecisions:               opts._buildDecisions               } : {}),
    ...(opts._approvedIntentsFromDecisions ? { _approvedIntentsFromDecisions:  opts._approvedIntentsFromDecisions } : {}),
  });
  return { ...summary, run_id };
}

/**
 * runPaperExecLayerWithProtectiveExit — opt-in protective-exit pass for
 * --execution alpaca_paper --exec-protective-exit.
 *
 * Builds a broker and runs one runProtectiveExitPassOnce cycle (Unit 19):
 * reads open positions from portfolio_state, plans protective stops, dispatches
 * them through the gateway. Positions are NOT passed from the scan output —
 * the pass sources them directly from portfolio_state (as Unit 19 was designed).
 *
 * Non-paper / incapable broker → runProtectiveExitPassOnce throws fail-closed.
 * No portfolio mutation in this function; all writes go through the gateway.
 *
 * Injectable for offline tests:
 *   opts.makeBroker(execConfig)             → builds the broker (default: new AlpacaPaperBroker)
 *   opts._runProtectiveExitPassOnce(ctx)    → replaces the real PE orchestrator
 *
 * @param {object} execConfig  — validated config from validatePaperExecConfig
 * @param {object} [opts]
 * @returns {Promise<object>} runProtectiveExitPassOnce summary:
 *   { positions_in, planned, already_protected, plan_skipped, dispatch }
 */
export async function runPaperExecLayerWithProtectiveExit(execConfig, opts = {}) {
  const makeBroker = typeof opts.makeBroker === 'function'
    ? opts.makeBroker
    : (cfg) => new AlpacaPaperBroker(cfg);
  const broker = makeBroker(execConfig);

  const runPE = typeof opts._runProtectiveExitPassOnce === 'function'
    ? opts._runProtectiveExitPassOnce
    : async (ctx) => {
        const { runProtectiveExitPassOnce } = await import('./protective_exit_pass.mjs');
        return runProtectiveExitPassOnce(ctx);
      };

  return runPE({ broker, execConfig });
}

/**
 * Default worker-pass: build a real AlpacaPaperBroker + call runWorkerPassOnce.
 * Lazy imports so scan.mjs startup is unaffected when mode !== alpaca_paper.
 */
async function defaultWorkerPass(ctx) {
  const { AlpacaPaperBroker } = await import('./adapters/alpaca_paper_broker.mjs');
  const { runWorkerPassOnce }  = await import('./worker_pass.mjs');
  return runWorkerPassOnce({ ...ctx, broker: new AlpacaPaperBroker(ctx.execConfig) });
}

/**
 * runPaperExecLayer — maintenance worker pass after a successful scan.
 *
 * No approvedIntents → no new order dispatch; the pass runs reconcile + poll +
 * fill_sync against existing live_orders only. Unexpected throws propagate to the
 * caller (scan.mjs catches and exits 1).
 *
 * @param {string}   scanJson    — final stdout from the scan pipeline
 * @param {object}   execConfig  — validated config from validatePaperExecConfig
 * @param {object}   [opts]
 * @param {Function} [opts.workerPass] — injectable stub; default builds AlpacaPaperBroker
 *                                       + runWorkerPassOnce (never called in offline tests)
 * @returns {Promise<object>} worker-pass summary spread with run_id:
 *   { ran, reason, gate, steps, error, run_id }
 */
export async function runPaperExecLayer(scanJson, execConfig, { workerPass = defaultWorkerPass } = {}) {
  let runOutput;
  try {
    runOutput = JSON.parse(scanJson);
  } catch (e) {
    throw new Error(`paper_exec_layer: invalid scan JSON — ${e.message}`);
  }

  const run_id = runOutput?.run_id ?? null;
  const summary = await workerPass({ execConfig, run_id });
  return { ...summary, run_id };
}
