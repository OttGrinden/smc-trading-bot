/**
 * BrokerAccountSizing — the read-only bridge that feeds account_sizing (Unit 10.8)
 * with a REAL broker account snapshot (Unit 11), in the operative write path
 * (Phase 1, Unit 12).
 *
 * THE MISSING CONNECTOR: getAccount() (the snapshot SOURCE, Unit 11) and
 * sizeIntentsFromAccount() (the sizing LOGIC, Unit 10.8) both exist but nothing
 * joins them — approved intents reach dispatch only if a caller has ALREADY sized
 * them. This unit is the smallest safe join:
 *
 *   pre-flight: broker must expose getAccount()                       fail-closed THROW
 *   account = await broker.getAccount()        (read-only; Unit 11)
 *     └─ throws (network/auth/broker)  → caught → account_ok:false / 0 sized (fail-closed)
 *   return sizeIntentsFromAccount(intents, account, opts)            (Unit 10.8, wholesale)
 *
 * The returned summary.sized[] is EXACTLY the dispatchApproved input shape
 * (symbol, side, action:'open', quantity, run_id, decision_source, asset_type),
 * so a caller can hand summary.sized straight to order_dispatch.
 *
 * SCOPE (Unit 12 ONLY) — deliberately tiny and additive:
 *   - ONE async function: fetch snapshot (read-only) → reuse sizeIntentsFromAccount
 *   - broker is INJECTED via ctx (offline-testable; nothing constructs a real broker)
 *   - NO persistence, NO writes, NO state machine — pure aside from the read-only fetch
 *
 * EXPLICITLY NOT in this unit: any change to worker_pass / order_dispatch / account_sizing
 * / submit / cancel / replace, stop/bracket logic, a loop/daemon, a live broker, portfolio
 * mutation, or reading decisions/allocation from disk. No existing module is modified.
 *
 * Fail-closed: a missing/incapable broker throws BEFORE any fetch; ANY fetch failure
 * yields zero sized intents (never an optimistic size on a failed/uncertain account).
 */

import { sizeIntentsFromAccount } from './account_sizing.mjs';

/**
 * sizeIntentsFromBroker — fetch a live (paper) account snapshot and size approved intents.
 *
 * @param {object[]} approvedIntents — approved, PRE-SIZING intents (account_sizing input shape):
 *   { symbol, side:'long'|'short', action?:'open', price_usd|price (>0), run_id?, asset_type?,
 *     decision_source?:{decision_id,intent_id}, decision_id?, intent_id? }
 * @param {object} ctx — { broker (req: getAccount), ...sizingOpts }  where sizingOpts are the
 *   account_sizing overrides (risk_per_trade_pct, max_position_notional_usd, min_notional_usd,
 *   qty_precision, run_id).
 * @returns {Promise<object>} the account_sizing summary, augmented with:
 *   { account_source:'broker', account_id, account_ts, fetch_error }
 *   On a fetch failure: { account_ok:false, account_reason:'account_fetch_failed',
 *   fetch_error:{message,error_class}, sized:[], skipped:[all], totals, ... }
 * @throws {Error} when ctx.broker is missing or does not implement getAccount (fail-closed)
 */
export async function sizeIntentsFromBroker(approvedIntents = [], ctx = {}) {
  const broker = ctx.broker;
  if (!broker || typeof broker.getAccount !== 'function') {
    throw new Error('sizeIntentsFromBroker: ctx.broker must implement getAccount (read-only paper broker)');
  }
  const list = Array.isArray(approvedIntents) ? approvedIntents : [];

  // sizing options are the rest of ctx (account_sizing reads only the keys it knows)
  const { broker: _broker, ...opts } = ctx;

  // ── read-only account fetch (Unit 11). ANY failure → 0 sized intents (fail-closed). ──
  let account;
  try {
    account = await broker.getAccount();
  } catch (e) {
    const fetchError = { message: e?.message ?? String(e), error_class: e?.error_class ?? null };
    return {
      account_ok: false,
      account_reason: 'account_fetch_failed',
      account_source: 'broker',
      account_id: null,
      account_ts: null,
      fetch_error: fetchError,
      currency: null,
      buying_power_start: null,
      buying_power_remaining: null,
      sized: [],
      skipped: list.map((it) => ({ symbol: it?.symbol ?? null, reason: 'account_fetch_failed' })),
      totals: { intents: list.length, sized: 0, skipped: list.length },
    };
  }

  // ── size against the snapshot (Unit 10.8, reused wholesale) ──────────────────────
  const summary = sizeIntentsFromAccount(list, account, opts);
  summary.account_source = 'broker';
  summary.account_id     = account?.account_id ?? null;
  summary.account_ts     = account?.ts ?? null;
  summary.fetch_error    = null;
  return summary;
}
