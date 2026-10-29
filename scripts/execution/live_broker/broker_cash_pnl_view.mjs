/**
 * BrokerCashPnlView — Unit 30: read-only cash/PnL view derived from confirmed fill bookings.
 *
 * Derives cash, realized PnL, unrealized PnL, and NAV from the local portfolio state.
 * The portfolio state already reflects confirmed fill bookings only (via broker_fill_booking
 * or fill_sync). This module adds a structured, verifiable view on top — no new persistence,
 * no mutations, no broker calls.
 *
 * Accounting model (mirroring portfolio_state.mjs recompute()):
 *
 *   cash_committed  = Σ position.notional_eur        (entry capital in open positions)
 *   cash_free       = initial_capital + realized_pnl − cash_committed
 *   cash_total      = cash_free + cash_committed      (= initial_capital + realized_pnl)
 *   unrealized_pnl  = Σ dirFactor(side) * qty * (mark_eur − entry_eur)
 *   nav             = initial_capital + realized_pnl + unrealized_pnl
 *
 * Conservative rules (fail-safe, never silently wrong):
 *   - mark_price_eur missing/null/non-finite → unrealized_pnl_eur = 0,
 *     mark_quality = 'no_mark_unavailable'
 *   - entry_price_eur missing → unrealized_pnl_eur = 0
 *   - fee_eur = 0 (Alpaca paper; consistent with fill_sync + broker_fill_booking)
 *   - No FX estimates beyond the fixed EUR_USD_RATE placeholder (1.08 USD/EUR)
 *
 * Consistency checks — flags deviations between stored and derived fields:
 *   cash            | stored state.cash vs derived cash_free
 *   unrealized_pnl  | stored state.unrealized_pnl vs derived
 *   equity_nav      | stored state.equity_nav vs derived nav
 *   realized_pnl_vs_cs_total | state.realized_pnl vs cs.realized_pnl_total
 *
 * Injectable for offline tests:
 *   opts._loadState() — replaces loadOrInit
 *
 * Default-Off: not imported by any existing path. Call explicitly for operator use.
 */

import {
  loadOrInit, positionUnrealized, dirFactor,
} from '../portfolio/portfolio_state.mjs';

const CONSISTENCY_TOL = 1e-3; // EUR; tolerates 4 dp rounding across multiple positions

/**
 * deriveCashPnlView — derive and verify the current cash/PnL state.
 *
 * @param {object} [opts]
 * @param {Function} [opts._loadState] — injectable: replaces loadOrInit
 * @returns {object} {
 *   ok, generated_at,
 *   cash_free, cash_committed, cash_total,
 *   realized_pnl, unrealized_pnl, nav,
 *   gross_exposure, net_exposure,
 *   positions_count, positions,
 *   consistency_checks, inconsistencies,
 *   initial_capital, booked_fills_count, closed_positions_summary
 * }
 * @throws {Error} on state load failure (fail-closed, propagated)
 */
export function deriveCashPnlView(opts = {}) {
  const doLoadState = typeof opts._loadState === 'function' ? opts._loadState : loadOrInit;

  let state;
  try { state = doLoadState(); }
  catch (e) { throw new Error(`deriveCashPnlView: state load failed (fail-closed): ${e.message}`); }

  const positions   = Array.isArray(state.open_positions) ? state.open_positions : [];
  const realizedPnl = Number.isFinite(state.realized_pnl)    ? state.realized_pnl    : 0;
  const initialCap  = Number.isFinite(state.initial_capital) ? state.initial_capital : 0;

  // ── per-position derivation ───────────────────────────────────────────────
  let cashCommitted = 0;
  let unrealizedPnl = 0;
  let grossExposure = 0;
  let netExposure   = 0;

  const posViews = positions.map(pos => {
    const notional = Number.isFinite(pos.notional_eur) ? pos.notional_eur : 0;
    cashCommitted += notional;

    const unreal   = positionUnrealized(pos);  // 0 when mark or entry is null
    unrealizedPnl += unreal;

    const dir = dirFactor(pos.side);
    if (Number.isFinite(pos.mark_price_eur)) {
      const mv = pos.quantity * pos.mark_price_eur;
      grossExposure += Math.abs(mv);
      netExposure   += dir * mv;
    }

    const markOk  = Number.isFinite(pos.mark_price_eur) && pos.mark_price_eur > 0;
    const entryOk = Number.isFinite(pos.entry_price_eur);

    return {
      symbol:               pos.symbol,
      side:                 pos.side,
      quantity:             pos.quantity,
      entry_price_eur:      pos.entry_price_eur      ?? null,
      mark_price_eur:       pos.mark_price_eur        ?? null,
      notional_eur:         +notional.toFixed(4),
      unrealized_pnl_eur:   +unreal.toFixed(4),
      mark_quality:         (markOk && entryOk) ? 'available' : 'no_mark_unavailable',
      partial_realized_eur: pos.partial_realized_eur ?? null,
    };
  });

  cashCommitted = +cashCommitted.toFixed(4);
  unrealizedPnl = +unrealizedPnl.toFixed(4);
  grossExposure = +grossExposure.toFixed(4);
  netExposure   = +netExposure.toFixed(4);

  const cashFree = +(initialCap + realizedPnl - cashCommitted).toFixed(4);
  const nav      = +(initialCap + realizedPnl + unrealizedPnl).toFixed(4);

  // ── consistency checks ────────────────────────────────────────────────────
  const inconsistencies = [];
  const checks          = {};

  const chk = (key, stored, derived) => {
    const finite = Number.isFinite(stored);
    const ok     = finite && Math.abs(stored - derived) <= CONSISTENCY_TOL;
    checks[key]  = { ok: finite ? ok : false, stored: stored ?? null, derived };
    if (finite && !ok) {
      inconsistencies.push({ field: key, stored, derived, delta: +(stored - derived).toFixed(6) });
    }
  };

  chk('cash',           state.cash,          cashFree);
  chk('unrealized_pnl', state.unrealized_pnl, unrealizedPnl);
  chk('equity_nav',     state.equity_nav,     nav);

  const cs    = state.closed_positions_summary;
  const csPnl = Number.isFinite(cs?.realized_pnl_total) ? cs.realized_pnl_total : null;
  if (csPnl !== null) {
    const ok = Math.abs(realizedPnl - csPnl) <= CONSISTENCY_TOL;
    checks.realized_pnl_vs_cs_total = { ok, realized_pnl: realizedPnl, cs_total: csPnl };
    if (!ok) {
      inconsistencies.push({
        field: 'realized_pnl_vs_cs_total', stored_realized: realizedPnl,
        cs_total: csPnl, delta: +(realizedPnl - csPnl).toFixed(6),
      });
    }
  }

  return {
    generated_at:    new Date().toISOString(),
    ok:              inconsistencies.length === 0,

    // cash facts
    cash_free:       cashFree,
    cash_committed:  cashCommitted,
    cash_total:      +(cashFree + cashCommitted).toFixed(4),  // = initial_capital + realized_pnl

    // pnl facts
    realized_pnl:    realizedPnl,
    unrealized_pnl:  unrealizedPnl,
    nav,

    // exposure
    gross_exposure:  grossExposure,
    net_exposure:    netExposure,

    // position detail
    positions_count: positions.length,
    positions:       posViews,

    // consistency
    consistency_checks: checks,
    inconsistencies,

    // metadata
    initial_capital:    initialCap,
    booked_fills_count: Object.keys(state.booked_fills ?? {}).length,
    closed_positions_summary: cs ?? { count: 0, wins: 0, losses: 0, realized_pnl_total: 0 },
  };
}
