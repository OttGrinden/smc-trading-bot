/**
 * Deterministic Fill Model
 *
 * Pure functions for execution-cost calculation: slippage and fees.
 * No I/O, no randomness, no external data. Same input → same output, always.
 *
 * ── Slippage model ──────────────────────────────────────────────────────────
 *
 * Slippage is applied in the UNFAVORABLE direction relative to the order action:
 *
 *   buy / buy_to_cover  → effective fill price moves UP   (buyer pays more)
 *   sell / sell_short   → effective fill price moves DOWN  (seller receives less)
 *
 * Formula:
 *   effective_price = reference_price × (1 + slippage_bps / 10 000)  [buy]
 *   effective_price = reference_price × (1 − slippage_bps / 10 000)  [sell]
 *
 * The slippage_bps value comes from the realism config and is fixed per run.
 * There is no randomness. The model is fully reproducible from config inputs alone.
 *
 * ── Fee model ────────────────────────────────────────────────────────────────
 *
 * Fee is calculated on the GROSS NOTIONAL of the full ordered quantity at the
 * REFERENCE price (pre-slippage). Rationale: commissions are charged on trade
 * value, not on the execution price variance.
 *
 * Formula:
 *   gross_notional_usd = ordered_quantity × reference_price_usd
 *   gross_notional_eur = gross_notional_usd / EUR_USD_RATE
 *   fee_eur_raw        = gross_notional_eur × fee_bps / 10 000
 *   fee_eur            = max(fee_eur_raw, minimum_fee_eur)
 *
 * Fee currency is EUR (converted via the caller-provided EUR/USD rate).
 * Fee is charged ONCE per order on the FIRST fill cycle. No additional fee
 * is charged on partial-fill completion cycles (second cycle).
 *
 * ── Currency ─────────────────────────────────────────────────────────────────
 *
 * Inputs are USD; outputs that affect portfolio economics are in EUR.
 * eurUsdRate must be provided by the caller (portfolio_state.EUR_USD_RATE = 1.08
 * is a documented placeholder — no live FX feed in this phase).
 *
 * Usage (module): import { applySlippage, calcFee, buildFillDetails } from './fill_model.mjs'
 */

const BUY_ACTIONS  = new Set(['buy', 'buy_to_cover']);
const SELL_ACTIONS = new Set(['sell', 'sell_short']);

/**
 * applySlippage — deterministic price adjustment.
 *
 * @param {number} refPriceUsd  — reference fill price in USD
 * @param {string} orderAction  — 'buy' | 'buy_to_cover' | 'sell' | 'sell_short'
 * @param {number} slippageBps  — basis points (>= 0)
 * @returns {{ effective_price_usd: number, slippage_per_unit_usd: number }}
 */
export function applySlippage(refPriceUsd, orderAction, slippageBps) {
  if (slippageBps === 0) {
    return { effective_price_usd: refPriceUsd, slippage_per_unit_usd: 0 };
  }

  const factor = slippageBps / 10_000;
  let effective;

  if (BUY_ACTIONS.has(orderAction)) {
    effective = refPriceUsd * (1 + factor);
  } else if (SELL_ACTIONS.has(orderAction)) {
    effective = refPriceUsd * (1 - factor);
  } else {
    // Unknown action — no slippage applied; caller should audit this case
    effective = refPriceUsd;
  }

  return {
    effective_price_usd:   +effective.toFixed(8),
    slippage_per_unit_usd: +Math.abs(effective - refPriceUsd).toFixed(8),
  };
}

/**
 * calcFee — deterministic commission calculation.
 *
 * @param {number} orderedQuantity — total ordered qty (full order, not just fill fraction)
 * @param {number} refPriceUsd     — reference price in USD (pre-slippage)
 * @param {number} feeBps          — fee in basis points (>= 0)
 * @param {number} minimumFeeEur   — minimum fee floor in EUR (>= 0)
 * @param {number} eurUsdRate      — USD per 1 EUR (e.g. 1.08)
 * @returns {{ gross_notional_usd, gross_notional_eur, fee_eur, minimum_fee_applied }}
 */
export function calcFee(orderedQuantity, refPriceUsd, feeBps, minimumFeeEur, eurUsdRate) {
  const gross_notional_usd = +(orderedQuantity * refPriceUsd).toFixed(4);
  const gross_notional_eur = +(gross_notional_usd / eurUsdRate).toFixed(4);
  const fee_eur_raw        = +(gross_notional_eur * (feeBps / 10_000)).toFixed(6);
  const fee_eur            = +Math.max(fee_eur_raw, minimumFeeEur).toFixed(6);

  return {
    gross_notional_usd,
    gross_notional_eur,
    fee_eur,
    minimum_fee_applied: minimumFeeEur > 0 && fee_eur > fee_eur_raw,
  };
}

/**
 * buildFillDetails — combine slippage + fee into one auditable fill record.
 * Called on the FIRST fill cycle only. Persisted on the order as order.realism_details.
 *
 * @param {number} refPriceUsd   — reference price in USD (pre-slippage)
 * @param {number} orderedQty    — total ordered quantity (used for fee notional)
 * @param {string} orderAction   — 'buy' | 'sell' | 'sell_short' | 'buy_to_cover'
 * @param {object} realismConfig — from parseRealismConfig()
 * @param {number} eurUsdRate    — USD per 1 EUR
 * @returns {object}             — full fill-cost breakdown (persisted on order)
 */
export function buildFillDetails(refPriceUsd, orderedQty, orderAction, realismConfig, eurUsdRate) {
  const { effective_price_usd, slippage_per_unit_usd } = applySlippage(
    refPriceUsd,
    orderAction,
    realismConfig.slippage_bps,
  );

  const slippage_amount_usd = +(slippage_per_unit_usd * orderedQty).toFixed(6);
  const slippage_amount_eur = +(slippage_amount_usd / eurUsdRate).toFixed(6);

  const { gross_notional_usd, gross_notional_eur, fee_eur, minimum_fee_applied } = calcFee(
    orderedQty,
    refPriceUsd,
    realismConfig.fee_bps,
    realismConfig.minimum_fee_eur,
    eurUsdRate,
  );

  const effective_notional_usd  = +(effective_price_usd * orderedQty).toFixed(4);
  const effective_notional_eur  = +(effective_notional_usd / eurUsdRate).toFixed(4);
  const net_execution_value_eur = +(effective_notional_eur - fee_eur).toFixed(4);

  return {
    // Slippage
    reference_price_usd:      refPriceUsd,
    slippage_bps:             realismConfig.slippage_bps,
    slippage_per_unit_usd,
    slippage_amount_usd,
    slippage_amount_eur,
    effective_fill_price_usd: effective_price_usd,
    // Fee
    ordered_quantity:         orderedQty,
    fee_bps:                  realismConfig.fee_bps,
    gross_notional_usd,
    gross_notional_eur,
    fee_eur,
    minimum_fee_applied,
    minimum_fee_eur:          realismConfig.minimum_fee_eur,
    // Combined
    effective_notional_usd,
    effective_notional_eur,
    net_execution_value_eur,
  };
}
