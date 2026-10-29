/**
 * AccountSizing — derive a tradable quantity from a broker account snapshot and apply
 * the smallest sensible set of account-based hard gates (Phase 1, Unit 10.8).
 *
 * THE MISSING STEP: approved intents arrive PRE-SIZING (no qty), and the risk_engine's
 * account-based checks (portfolio_risk_limit, …) are explicit PLACEHOLDERS ("requires
 * live account value"). This unit is the smallest safe step between an approved intent
 * and a dispatchable SIZED intent, using a broker account snapshot the caller provides:
 *
 *   validate account snapshot (fail-closed)  → all intents rejected on account failure
 *   per intent (in order, cumulative buying-power budget):
 *     target_notional = min(risk_per_trade_pct · equity, max_position_notional_usd,
 *                           remaining_buying_power)
 *     qty = floor8(target_notional / price_usd)              (never exceeds budget)
 *     → sized intent (dispatchApproved shape)  OR  skip(reason)
 *
 * Account snapshot contract (the normalizeAccount / getAccount shape):
 *   { currency, cash, buying_power, portfolio_value, equity, status, paper }
 * Prices are USD (intent.price_usd); the account is USD (Alpaca) — no EUR/FX here.
 *
 * SCOPE (Unit 10.8 ONLY) — deliberately tiny and additive:
 *   - a PURE function: no broker fetch (snapshot is passed in), no network, no I/O
 *   - one transparent sizing rule + a minimal set of hard account gates
 *   - a cumulative buying-power budget so multiple intents cannot over-commit
 *   - emits exactly the dispatchApproved input shape (quantity, side, action, run_id, …)
 *
 * EXPLICITLY NOT in this unit: stop/bracket logic (10.9), live broker adapter, fetching
 * the account, multi-factor/correlation/sector portfolio strategy, any loop/daemon,
 * close-side sizing (close qty = held position, a different concern), and ANY change to
 * risk_engine, allocation_engine, order_dispatch, or worker_pass.
 *
 * Fail-closed: a missing/inactive/implausible/non-USD account rejects ALL intents with
 * a clear account reason; per-intent any missing/ambiguous field or a target below the
 * minimum notional skips that intent with a reason — never an optimistic size.
 */

export const SIZING_DEFAULTS = Object.freeze({
  risk_per_trade_pct:        0.02,   // fraction of account equity targeted per trade
  max_position_notional_usd: 1000,   // hard per-position notional cap (USD); clamps target
  min_notional_usd:          1,      // below this, the intent is skipped (too small to trade)
  qty_precision:             8,      // fractional-share rounding (floor, so notional ≤ budget)
});

function floorTo(x, dp) { const f = 10 ** dp; return Math.floor(x * f) / f; }

// USD-equivalent currencies accepted for sizing (USDT is a USD stablecoin used by Bitunix).
const ACCEPTED_CURRENCIES = new Set(['USD', 'USDT']);

/** Validate the account snapshot. Returns a reason string if invalid, else null. */
function accountReason(account) {
  if (account == null || typeof account !== 'object') return 'account_missing';
  // Case-insensitive status check (Bitunix returns lowercase 'active'; Alpaca returns 'ACTIVE').
  if (account.status != null && account.status.toUpperCase() !== 'ACTIVE') return 'account_not_active';
  if (account.currency != null && !ACCEPTED_CURRENCIES.has(account.currency)) return 'account_currency_unsupported';
  if (!Number.isFinite(account.buying_power) || account.buying_power < 0) return 'account_invalid';
  if (!Number.isFinite(account.equity) || account.equity <= 0) return 'account_invalid';
  return null;
}

/**
 * sizeIntentsFromAccount — size approved intents against a broker account snapshot.
 *
 * @param {object[]} intents — approved, PRE-SIZED intents. Per item:
 *   { symbol, side:'long'|'short', action?:'open' (default), price_usd|price (>0),
 *     run_id?, asset_type?, decision_source?:{decision_id,intent_id}, decision_id?, intent_id? }
 * @param {object} account — broker account snapshot (normalizeAccount shape)
 * @param {object} opts — overrides for SIZING_DEFAULTS + { run_id? }
 * @returns {object} summary {
 *   account_ok, account_reason, currency, buying_power_start, buying_power_remaining,
 *   sized:[...], skipped:[{symbol,reason}], totals:{intents,sized,skipped}
 * }
 */
export function sizeIntentsFromAccount(intents = [], account = null, opts = {}) {
  const cfg = {
    risk_per_trade_pct:        Number.isFinite(opts.risk_per_trade_pct)        ? opts.risk_per_trade_pct        : SIZING_DEFAULTS.risk_per_trade_pct,
    max_position_notional_usd: Number.isFinite(opts.max_position_notional_usd) ? opts.max_position_notional_usd : SIZING_DEFAULTS.max_position_notional_usd,
    min_notional_usd:          Number.isFinite(opts.min_notional_usd)          ? opts.min_notional_usd          : SIZING_DEFAULTS.min_notional_usd,
    qty_precision:             Number.isInteger(opts.qty_precision)            ? opts.qty_precision             : SIZING_DEFAULTS.qty_precision,
  };
  const list = Array.isArray(intents) ? intents : [];

  const summary = {
    account_ok: true, account_reason: null,
    currency: account?.currency ?? null,
    buying_power_start: null, buying_power_remaining: null,
    sized: [], skipped: [],
    totals: { intents: list.length, sized: 0, skipped: 0 },
  };

  // ── account-level fail-closed gate: reject ALL intents on a bad snapshot ──────
  const accReason = accountReason(account);
  if (accReason != null) {
    summary.account_ok = false;
    summary.account_reason = accReason;
    for (const it of list) summary.skipped.push({ symbol: it?.symbol ?? null, reason: accReason });
    summary.totals.skipped = summary.skipped.length;
    return summary;
  }

  let remaining = account.buying_power;
  summary.buying_power_start = account.buying_power;

  const skip = (it, reason) => { summary.skipped.push({ symbol: it?.symbol ?? null, reason }); };

  for (const it of list) {
    const symbol = it?.symbol;
    if (typeof symbol !== 'string' || !symbol) { skip(it, 'invalid_symbol'); continue; }
    const side = it?.side;
    if (side !== 'long' && side !== 'short')   { skip(it, 'invalid_side'); continue; }
    const action = it?.action ?? 'open';
    if (action !== 'open')                     { skip(it, 'unsupported_action'); continue; }   // close sizing is not this unit's job
    const price = Number.isFinite(it?.price_usd) ? it.price_usd : it?.price;
    if (!Number.isFinite(price) || price <= 0) { skip(it, 'non_positive_price'); continue; }

    // sizing rule: min of (risk fraction of equity, hard cap, remaining buying power)
    const byRisk = cfg.risk_per_trade_pct * account.equity;
    const byCap  = cfg.max_position_notional_usd;
    const byBp   = remaining;
    const target = Math.min(byRisk, byCap, byBp);

    if (target < cfg.min_notional_usd) {
      skip(it, remaining < cfg.min_notional_usd ? 'insufficient_buying_power' : 'below_min_notional');
      continue;
    }

    const qty = floorTo(target / price, cfg.qty_precision);
    if (!Number.isFinite(qty) || qty <= 0) { skip(it, 'non_positive_qty'); continue; }
    const actualNotional = qty * price;
    if (actualNotional < cfg.min_notional_usd) { skip(it, 'below_min_notional'); continue; }

    const cappedBy = target === byBp ? 'buying_power' : target === byCap ? 'max_position_notional' : 'risk_fraction';
    remaining = +(remaining - actualNotional).toFixed(8);

    summary.sized.push({
      symbol, side, action: 'open',
      quantity: qty,
      run_id:          it?.run_id ?? opts.run_id ?? null,
      asset_type:      it?.asset_type ?? null,
      price_usd:       price,
      stop_loss_pct:   it?.stop_loss_pct   ?? null,
      take_profit_pct: it?.take_profit_pct ?? null,
      decision_source: it?.decision_source ?? (it?.decision_id || it?.intent_id
        ? { decision_id: it?.decision_id ?? null, intent_id: it?.intent_id ?? null } : null),
      sizing: {
        target_notional_usd: +target.toFixed(6),
        actual_notional_usd: +actualNotional.toFixed(6),
        risk_per_trade_pct:  cfg.risk_per_trade_pct,
        equity_usd:          account.equity,
        capped_by:           cappedBy,
      },
    });
  }

  summary.buying_power_remaining = remaining;
  summary.totals.sized   = summary.sized.length;
  summary.totals.skipped = summary.skipped.length;
  return summary;
}
