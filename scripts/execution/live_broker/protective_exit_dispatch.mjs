/**
 * ProtectiveExitDispatch — route Unit-10.9 protective stop PLANS to the (now stop-capable)
 * paper gateway (Phase 1, Unit 18).
 *
 * THE ROUTING GAP: buildProtectiveExits (10.9) emits well-formed protective stop plans
 * (order_type:'stop', stop_price_usd, close-side order_action, explicit protect_v1 cid,
 * gtc) but nothing placed them. Unit 17 made 'stop' placeable through
 * schemas → order_gateway → alpaca_paper_broker. order_dispatch (10.6) is NOT a fit here:
 * it FORCES its own dispatch_v1 cid (discarding the protect_v1 idempotency anchor),
 * REQUIRES run_id (protective plans have none), and forwards only limit_price (never
 * stop_price). This unit is the smallest correct bridge: map each plan to an orderReq
 * (stop_price_usd → stop_price, preserving the explicit protect_v1 cid) and submit it
 * through the existing order_gateway — reused wholesale.
 *
 *   per plan:
 *     fail-closed validate (cid, symbol, close-side order_action, qty>0, order_type 'stop',
 *                           stop_price_usd>0, tif day|gtc)
 *     in-batch duplicate cid               → skip(duplicate_in_batch)
 *     store.get(cid) already exists        → already_dispatched (no 2nd submit)
 *     else → order_gateway.submit({ client_order_id: cid (preserved), order_type:'stop',
 *            stop_price: stop_price_usd, action:'close', ... })   (EXACTLY ONE submit)
 *
 * SCOPE (Unit 18 ONLY) — deliberately tiny and additive:
 *   - consumes buildProtectiveExits(...).protected[] plans (already validated upstream)
 *   - reuses order_gateway.submit wholesale — NO gateway / order_dispatch / protective_exit /
 *     schemas / broker change
 *   - preserves the plan's explicit protect_v1 client_order_id (idempotency across runs)
 *
 * EXPLICITLY NOT in this unit: building the plans (10.9 owns that), placing via
 * order_dispatch, run-id semantics, open/market/limit changes, live execution,
 * scan.mjs/daemon, portfolio mutation, fill→portfolio booking. No existing module modified.
 *
 * Fail-closed: any missing/ambiguous field skips the plan with a reason (never an
 * optimistic submit); the gateway independently re-guards stop_price (Unit 17). A missing
 * broker throws before the loop; per-plan unexpected errors are isolated into the summary.
 */

import * as store     from './order_store.mjs';
import { submit }     from './order_gateway.mjs';
import { ORDER_TYPES, TIME_IN_FORCE } from '../schemas.mjs';

const CID_RE = /^[A-Za-z0-9_-]+$/;
const CLOSE_ORDER_ACTIONS = Object.freeze(['sell', 'buy_to_cover']);   // protective exits are always closes

/**
 * dispatchProtectiveExits — submit one broker stop order per protective plan (idempotent).
 *
 * @param {object[]} plans — buildProtectiveExits().protected[] items:
 *   { symbol, side:'long'|'short', action:'close', order_action:'sell'|'buy_to_cover',
 *     quantity (>0), order_type:'stop', stop_price_usd (>0), time_in_force:'gtc',
 *     client_order_id (protect_v1_…) }
 * @param {object} ctx — { broker (req: submitOrder+getOrderByClientId), startupGate?, execConfig? }
 * @returns {Promise<object>} summary { total, submitted, already_dispatched, skipped,
 *   blocked_by_gate, submit_uncertain, rejected, errored, results:[...] }
 * @throws {Error} on a missing broker, or a corrupt store record on the idempotency pre-check
 */
export async function dispatchProtectiveExits(plans = [], ctx = {}) {
  const broker = ctx.broker;
  if (!broker || typeof broker.submitOrder !== 'function' || typeof broker.getOrderByClientId !== 'function') {
    throw new Error('dispatchProtectiveExits: ctx.broker must implement submitOrder + getOrderByClientId');
  }
  const list = Array.isArray(plans) ? plans : [];

  const summary = {
    total: list.length, submitted: 0, already_dispatched: 0, skipped: 0,
    blocked_by_gate: 0, submit_uncertain: 0, rejected: 0, errored: 0, results: [],
  };
  const seenCids = new Set();
  const record = (r) => { summary.results.push(r); return r; };
  const skip = (p, reason) => {
    summary.skipped += 1;
    return record({ symbol: p?.symbol ?? null, side: p?.side ?? null, status: 'skipped', reason });
  };

  for (const plan of list) {
    // ── validate fail-closed (never submit on doubt) ───────────────────────────
    const symbol = plan?.symbol;
    if (typeof symbol !== 'string' || !symbol) { skip(plan, 'missing_symbol'); continue; }
    const side = plan?.side;
    if (side !== 'long' && side !== 'short')   { skip(plan, 'invalid_side'); continue; }
    if (plan?.action !== 'close')              { skip(plan, 'not_close_action'); continue; }
    const orderAction = plan?.order_action;
    if (!CLOSE_ORDER_ACTIONS.includes(orderAction)) { skip(plan, 'invalid_order_action'); continue; }
    const qty = Number.isFinite(plan?.quantity) ? plan.quantity : plan?.qty;
    if (!Number.isFinite(qty) || qty <= 0)     { skip(plan, 'invalid_quantity'); continue; }
    if (plan?.order_type !== ORDER_TYPES.STOP) { skip(plan, 'not_stop_order_type'); continue; }
    const stopPrice = plan?.stop_price_usd;
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) { skip(plan, 'invalid_stop_price'); continue; }
    const tif = plan?.time_in_force ?? TIME_IN_FORCE.GTC;
    if (!Object.values(TIME_IN_FORCE).includes(tif)) { skip(plan, 'invalid_time_in_force'); continue; }
    const cid = plan?.client_order_id;
    if (typeof cid !== 'string' || !CID_RE.test(cid)) { skip(plan, 'invalid_client_order_id'); continue; }

    // in-batch double-dispatch guard
    if (seenCids.has(cid)) {
      summary.skipped += 1;
      record({ symbol, side, client_order_id: cid, status: 'skipped', reason: 'duplicate_in_batch' });
      continue;
    }
    seenCids.add(cid);

    // cross-run idempotency: an existing record means this stop was already placed.
    const existing = store.get(cid);   // throws on corrupt = fail-closed (propagate)
    if (existing) {
      summary.already_dispatched += 1;
      record({ symbol, side, client_order_id: cid, status: 'already_dispatched', state: existing.state });
      continue;
    }

    // ── exactly one submit through the existing gateway (preserves explicit cid) ──
    const orderReq = {
      client_order_id: cid, symbol, qty, side, action: 'close',
      order_action: orderAction, order_type: ORDER_TYPES.STOP, time_in_force: tif,
      stop_price: stopPrice,   // map stop_price_usd → the gateway/broker stop_price contract
    };

    let result;
    try {
      result = await submit(orderReq, ctx);
    } catch (e) {
      summary.errored += 1;
      record({ symbol, side, client_order_id: cid, status: 'error', reason: e?.message ?? String(e) });
      continue;
    }

    if (result && result.blocked_by_startup_gate === true) {
      summary.blocked_by_gate += 1;
      record({ symbol, side, client_order_id: cid, status: 'blocked_by_gate', gate: result.gate ?? null });
      continue;
    }

    const state = result?.state ?? null;
    if (state === 'submitted') {
      summary.submitted += 1;
      record({ symbol, side, client_order_id: cid, status: 'submitted', state, broker_order_id: result.broker_order_id ?? null });
    } else if (state === 'rejected') {
      summary.rejected += 1;
      record({ symbol, side, client_order_id: cid, status: 'rejected', state });
    } else {
      summary.submit_uncertain += 1;
      record({ symbol, side, client_order_id: cid, status: 'submit_uncertain', state });
    }
  }

  return summary;
}
