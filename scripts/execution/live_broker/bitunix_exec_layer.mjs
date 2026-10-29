#!/usr/bin/env node
/**
 * bitunix_exec_layer — Unit 34: helpers for scan.mjs --execution bitunix_futures.
 *
 * Two exports consumed by scan.mjs:
 *
 *   validateBitunixExecConfig(argv, env)
 *     Validates the write-path exec config when --execution bitunix_futures is requested.
 *     Wraps parseBrokerExecConfig with a synthesised --broker-exec arg so the scan
 *     caller does not need --broker-exec on the CLI. Throws on any config error —
 *     scan.mjs catches and exits 2 BEFORE the scan pipeline starts (fail-fast).
 *
 *   runBitunixExecLayerWithDispatch(scanJson, execConfig, opts?)
 *     Called after a successful scan. Runs a direct dispatch pass:
 *       build decisions → normalise → getAccount (auth) → size → dispatchApproved
 *
 *     Deliberately does NOT use runWorkerPassOnce (which is Alpaca paper-only:
 *     it runs a reconcile/poll/fill_sync cycle that doesn't exist for Bitunix yet
 *     and has a hard paper:true guard).
 *
 *     Session gate is NOT wired — Bitunix is 24/7; NYSE hours do not apply.
 *
 *     Fail-closed guards:
 *       - invalid scanJson       → throws (scan.mjs catches → exit 1)
 *       - disabled execConfig    → throws (scan.mjs catches → exit 1)
 *       - incapable broker       → throws (scan.mjs catches → exit 1)
 *
 *     Injectable for offline tests:
 *       opts.makeBroker(execConfig)              → builds the broker (default: new BitunixBroker)
 *       opts._buildDecisions                     → replaces the real decision engine
 *       opts._approvedIntentsFromDecisions       → replaces the intent normaliser
 *       opts._getAccount()                       → replaces broker.getAccount()
 *       opts._sizeIntentsFromAccount(intents, account) → replaces sizeIntentsFromAccount
 *       opts._dispatchApproved(items, ctx)       → replaces dispatchApproved
 *
 * @param {string}   scanJson    — final stdout from the scan pipeline
 * @param {object}   execConfig  — validated config from validateBitunixExecConfig
 * @param {object}   [opts]
 * @returns {Promise<object>} summary {
 *   run_id, mode, decisions_total, approved, emitted, skipped,
 *   account_ok, account_reason, sized, dispatch
 * }
 */

import { parseBrokerExecConfig, bitunixExecEnabled } from './live_broker_config.mjs';
import { BitunixBroker }                              from './adapters/bitunix_broker.mjs';

/**
 * validateBitunixExecConfig — validate write-path config for --execution bitunix_futures.
 *
 * @param {string[]} argv — accepted for API parity; mode is unconditionally forced
 * @param {object}   env  — must contain BITUNIX_API_KEY + BITUNIX_SECRET_KEY
 * @returns {Readonly<object>} enabled execConfig (parseBrokerExecConfig return shape)
 * @throws {Error} on missing API keys or any other config error
 */
export function validateBitunixExecConfig(argv, env) {
  return parseBrokerExecConfig(['--broker-exec', 'bitunix_futures'], env);
}

/**
 * runBitunixExecLayerWithDispatch — direct E2E dispatch pass for --execution bitunix_futures.
 *
 * Flow: decisions → approved intents → getAccount (auth) → size → dispatchApproved.
 * Bypass runWorkerPassOnce entirely (it has a hard paper:true guard and runs Alpaca-specific
 * reconcile/poll cycles that don't exist for Bitunix).
 */
export async function runBitunixExecLayerWithDispatch(scanJson, execConfig, opts = {}) {
  // ── parse scan output ─────────────────────────────────────────────────────
  let runOutput;
  try {
    runOutput = JSON.parse(scanJson);
  } catch (e) {
    throw new Error(`bitunix_exec_layer: invalid scan JSON — ${e.message}`);
  }

  // ── pre-flight fail-closed ────────────────────────────────────────────────
  if (!runOutput || typeof runOutput !== 'object') {
    throw new Error('runBitunixExecLayerWithDispatch: runOutput is required (fail-closed)');
  }
  if (!bitunixExecEnabled(execConfig)) {
    throw new Error('runBitunixExecLayerWithDispatch: requires an enabled bitunix_futures execConfig (fail-closed)');
  }

  // ── broker ────────────────────────────────────────────────────────────────
  const makeBroker = typeof opts.makeBroker === 'function'
    ? opts.makeBroker
    : (cfg) => new BitunixBroker(cfg);
  const broker = makeBroker(execConfig);

  if (!broker ||
      typeof broker.submitOrder          !== 'function' ||
      typeof broker.getOrderByClientId   !== 'function' ||
      typeof broker.getAccount           !== 'function') {
    throw new Error(
      'runBitunixExecLayerWithDispatch: broker must implement submitOrder + ' +
      'getOrderByClientId + getAccount (fail-closed)'
    );
  }

  // ── run_id declared early so lazy-import closures can reference it ────────
  const run_id = runOutput?.run_id ?? null;

  // ── lazy imports (avoids startup cost when mode !== bitunix_futures) ──────
  const buildDecisionsFn = typeof opts._buildDecisions === 'function'
    ? opts._buildDecisions
    : (await import('../decision_engine.mjs')).buildDecisions;

  const normalizeFn = typeof opts._approvedIntentsFromDecisions === 'function'
    ? opts._approvedIntentsFromDecisions
    : (await import('./intents_from_decisions.mjs')).approvedIntentsFromDecisions;

  const getAccountFn = typeof opts._getAccount === 'function'
    ? opts._getAccount
    : () => broker.getAccount();

  const sizeIntentsFn = typeof opts._sizeIntentsFromAccount === 'function'
    ? opts._sizeIntentsFromAccount
    : async (intents, account) => {
        const { sizeIntentsFromAccount } = await import('./account_sizing.mjs');
        return sizeIntentsFromAccount(intents, account, { run_id });
      };

  const dispatchFn = typeof opts._dispatchApproved === 'function'
    ? opts._dispatchApproved
    : async (items, ctx) => {
        const { dispatchApproved } = await import('./order_dispatch.mjs');
        return dispatchApproved(items, ctx);
      };

  const { EXECUTION_MODES } = await import('../schemas.mjs');
  const mode = EXECUTION_MODES.SHADOW;

  // ── build decisions → normalise approved intents ─────────────────────────
  const decisions  = buildDecisionsFn(runOutput, {}, mode);
  const norm       = normalizeFn(decisions, { run_id });

  // ── getAccount — validates auth; fail means we still report, don't throw ──
  const account    = await getAccountFn();

  // ── size intents against account ──────────────────────────────────────────
  const sizeResult = await sizeIntentsFn(norm.intents, account);

  // ── dispatch sized intents (skip if account bad or nothing to dispatch) ───
  let dispatch = null;
  if (sizeResult.account_ok && sizeResult.sized.length > 0) {
    dispatch = await dispatchFn(sizeResult.sized, { broker, run_id });
  }

  return {
    run_id,
    mode,
    decisions_total: Array.isArray(decisions) ? decisions.length : 0,
    approved:        norm.approved,
    emitted:         norm.emitted,
    skipped:         norm.skipped,
    account_ok:      sizeResult.account_ok,
    account_reason:  sizeResult.account_reason ?? null,
    sized:           sizeResult.totals.sized,
    dispatch,
  };
}
