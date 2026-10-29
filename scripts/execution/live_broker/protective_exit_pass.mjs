/**
 * ProtectiveExitPass — the first thin standalone Producer/orchestration step that feeds
 * open positions into the protective-stop branch (Phase 1, Unit 19).
 *
 * The pieces exist: buildProtectiveExits (10.9) turns positions into protective stop PLANS,
 * dispatchProtectiveExits (Unit 18) routes those PLANS through the (Unit-17 stop-capable)
 * order_gateway. What was missing is the thin step that actually SOURCES open positions and
 * runs them through that branch:
 *
 *   positions (injected OR loaded from portfolio_state.open_positions)
 *     → buildProtectiveExits(positions)            (10.9 planner)
 *     → dispatchProtectiveExits(plans, ctx)        (Unit 18 router → gateway → broker)
 *
 * SCOPE (Unit 19 ONLY) — deliberately tiny and additive:
 *   - a single async orchestrator: source positions → plan → dispatch
 *   - positions are INJECTABLE (ctx.positions) or loaded read-only from portfolio_state;
 *     broker / loader / planner / dispatcher are all injectable (offline-testable)
 *   - reuses buildProtectiveExits + dispatchProtectiveExits wholesale — NO change to
 *     protective_exit / protective_exit_dispatch / order_gateway / order_dispatch /
 *     schemas / broker / portfolio_state
 *
 * EXPLICITLY NOT in this unit: re-introducing the stop order type (Unit 17), re-building the
 * routing (Unit 18), a scan.mjs / CLI / daemon entrypoint, live execution, portfolio
 * mutation, sizing, or any open/market/limit flow. The portfolio is only READ (open
 * positions); nothing is written back to it here.
 *
 * Fail-closed & opt-in (structural): it ONLY runs when invoked with a capable broker. A
 * missing broker throws before any work; positions that are not an array throw (fail-closed,
 * never silently treated as "nothing to protect"); per-position bad data is dropped by the
 * planner, and the dispatcher independently re-guards every plan + stays idempotent.
 */

import { buildProtectiveExits }     from './protective_exit.mjs';
import { dispatchProtectiveExits }  from './protective_exit_dispatch.mjs';
import { loadOrInit }               from '../portfolio/portfolio_state.mjs';

/** Default position source: READ-ONLY open positions from the portfolio state. */
function defaultLoadOpenPositions() {
  const state = loadOrInit();
  return Array.isArray(state?.open_positions) ? state.open_positions : [];
}

/**
 * runProtectiveExitPassOnce — source open positions, plan protective stops, dispatch them.
 *
 * @param {object} ctx — {
 *   broker (req: submitOrder + getOrderByClientId),
 *   positions? (explicit open positions; else loaded read-only from portfolio_state),
 *   existingProtectiveCids? (string[]|Set forwarded to the planner),
 *   startupGate?, execConfig?, run_id? (forwarded to dispatchProtectiveExits/gateway),
 *   _loadOpenPositions? / _buildProtectiveExits? / _dispatchProtectiveExits? (DI for tests)
 * }
 * @returns {Promise<object>} summary {
 *   positions_in, planned, already_protected, plan_skipped, dispatch (dispatch summary)
 * }
 * @throws {Error} fail-closed: missing/incapable broker, or non-array positions
 */
export async function runProtectiveExitPassOnce(ctx = {}) {
  const broker = ctx.broker;
  if (!broker || typeof broker.submitOrder !== 'function' || typeof broker.getOrderByClientId !== 'function') {
    throw new Error('runProtectiveExitPassOnce: ctx.broker must implement submitOrder + getOrderByClientId (fail-closed)');
  }

  const loadPositions = typeof ctx._loadOpenPositions === 'function' ? ctx._loadOpenPositions : defaultLoadOpenPositions;
  const build         = typeof ctx._buildProtectiveExits === 'function' ? ctx._buildProtectiveExits : buildProtectiveExits;
  const dispatch      = typeof ctx._dispatchProtectiveExits === 'function' ? ctx._dispatchProtectiveExits : dispatchProtectiveExits;

  // positions: explicit input wins; else read-only load. Non-array → fail-closed throw.
  let positions = ctx.positions;
  if (positions == null) positions = loadPositions();
  if (!Array.isArray(positions)) {
    throw new Error('runProtectiveExitPassOnce: open positions must be an array (fail-closed)');
  }

  // 1) plan protective stops (10.9) — bad positions are dropped with a reason by the planner
  const built = build(positions, { existingProtectiveCids: ctx.existingProtectiveCids });

  // 2) dispatch the plans (Unit 18 → gateway → broker); idempotent + fail-closed there
  const dispatchSummary = await dispatch(built.protected, ctx);

  return {
    positions_in:      positions.length,
    planned:           built.totals.protected,
    already_protected: built.totals.already_protected,
    plan_skipped:      built.totals.skipped,
    dispatch:          dispatchSummary,
  };
}
