/**
 * OrderDispatch — turn approved + already-sized order intents into broker submits
 * (Phase 1, Unit 10.6).
 *
 * THE MISSING BRIDGE (entry side): the decision/allocation layer produces approved,
 * SIZED intents (e.g. allocation_engine.allocate().newPositions[] carry quantity +
 * side + decision_source), but nothing turns them into a real submit — the
 * OrderGateway is fed only by dev/smoke entrypoints today. This unit is the smallest
 * safe translator: one approved+sized intent → exactly one `order_gateway.submit()`,
 * idempotent and fail-closed.
 *
 *   for item in items:
 *     validate (symbol, side∈{long,short}, action∈{open,close}, qty>0, run_id)  fail-closed skip
 *     order_action = derive(action, side)
 *     cid = dispatch_v1_{run_id}_{symbol}_{side}_{order_action}   (deterministic, CID-safe)
 *     in-batch duplicate cid                                       → skip(duplicate_in_batch)
 *     store.get(cid) already exists                                → already_dispatched (no 2nd submit)
 *     else → order_gateway.submit(orderReq, ctx)   (EXACTLY ONE submit; gateway is idempotent too)
 *
 * SCOPE (Unit 10.6 ONLY) — deliberately tiny and additive:
 *   - consumes intents that are ALREADY approved AND ALREADY sized (qty provided)
 *   - reuses order_gateway.submit() wholesale — no gateway change
 *   - owns a deterministic client_order_id so dispatch is idempotent and double-dispatch
 *     is guarded both in-batch and across runs (plus the gateway's own NO_OP guard)
 *
 * EXPLICITLY NOT in this unit: position sizing / account sizing (10.8), risk gates
 * (10.8), reading or running decisions/allocation from disk, portfolio mutation, any
 * loop / worker / daemon (10.7), live broker (paper only, via injected ctx.broker),
 * stop/bracket logic (10.9), retry/recovery (the reconciler owns uncertain records),
 * and fill→portfolio booking (10.5 owns that). No existing module is modified.
 *
 * Safety: missing/ambiguous fields skip the item (never an optimistic submit); a
 * corrupt store record on the idempotency pre-check propagates (fail-closed); a
 * missing broker throws before the loop; per-item unexpected errors are isolated into
 * the summary so one bad intent never drops the rest.
 */

import * as store        from './order_store.mjs';
import { submit }        from './order_gateway.mjs';
import { ORDER_TYPES, TIME_IN_FORCE } from '../schemas.mjs';

const CID_RE  = /^[A-Za-z0-9_-]+$/;   // must match OrderStore / OrderGateway charset
const CID_MAX = 64;

/** Explicit buy/sell semantics from (action, side) — same mapping the engine uses. */
function deriveOrderAction(action, side) {
  if (action === 'open')  return side === 'long' ? 'buy'  : 'sell_short';
  if (action === 'close') return side === 'long' ? 'sell' : 'buy_to_cover';
  return null;
}

/** CID-safe sanitiser (collapse anything outside the store charset to '_'). */
function safe(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_'); }

/**
 * dispatchApproved — submit one broker order per approved+sized intent (idempotent).
 *
 * @param {object[]} items — approved + SIZED intents. Per item (tolerant of the
 *   allocation_engine newPosition shape):
 *     { symbol, side:'long'|'short', action?:'open'|'close' (default 'open'),
 *       quantity|qty (>0), run_id?, decision_source?:{decision_id,intent_id},
 *       decision_id?, intent_id?, asset_type?, order_type?, time_in_force?, limit_price? }
 * @param {object} ctx — { broker (req: submitOrder+getOrderByClientId), run_id?,
 *                          startupGate?, execConfig? }  (passed through to submit)
 * @returns {Promise<object>} summary { total, submitted, already_dispatched, skipped,
 *   blocked_by_gate, submit_uncertain, rejected, errored, results:[...] }
 * @throws {Error} on missing broker, or a corrupt store record (fail-closed)
 */
export async function dispatchApproved(items = [], ctx = {}) {
  const broker = ctx.broker;
  if (!broker || typeof broker.submitOrder !== 'function' || typeof broker.getOrderByClientId !== 'function') {
    throw new Error('dispatchApproved: ctx.broker must implement submitOrder + getOrderByClientId');
  }
  const list = Array.isArray(items) ? items : [];

  const summary = {
    total: list.length, submitted: 0, already_dispatched: 0, skipped: 0,
    blocked_by_gate: 0, submit_uncertain: 0, rejected: 0, errored: 0, results: [],
  };
  const seenCids = new Set();

  const record = (r) => { summary.results.push(r); return r; };
  const skip = (item, reason) => {
    summary.skipped += 1;
    return record({ symbol: item?.symbol ?? null, side: item?.side ?? null, status: 'skipped', reason });
  };

  for (const item of list) {
    // ── validate fail-closed (never submit on doubt) ───────────────────────────
    const symbol = item?.symbol;
    if (typeof symbol !== 'string' || !symbol) { skip(item, 'missing_symbol'); continue; }
    const side = item?.side;
    if (side !== 'long' && side !== 'short')   { skip(item, 'invalid_side'); continue; }
    const action = item?.action ?? 'open';     // allocation newPositions imply open
    const orderAction = deriveOrderAction(action, side);
    if (orderAction == null)                   { skip(item, 'invalid_action'); continue; }
    const qty = Number.isFinite(item?.quantity) ? item.quantity : item?.qty;
    if (!Number.isFinite(qty) || qty <= 0)     { skip(item, 'invalid_quantity'); continue; }
    const runId = item?.run_id ?? ctx.run_id ?? null;
    if (!runId)                                { skip(item, 'missing_run_id'); continue; }

    const orderType = item?.order_type ?? ORDER_TYPES.MARKET;
    if (!Object.values(ORDER_TYPES).includes(orderType)) { skip(item, 'invalid_order_type'); continue; }
    const tif = item?.time_in_force ?? TIME_IN_FORCE.DAY;
    if (!Object.values(TIME_IN_FORCE).includes(tif))     { skip(item, 'invalid_time_in_force'); continue; }
    let limitPrice = null;
    if (orderType === ORDER_TYPES.LIMIT) {
      limitPrice = item?.limit_price;
      if (!Number.isFinite(limitPrice) || limitPrice <= 0) { skip(item, 'limit_without_price'); continue; }
    }

    // ── deterministic, CID-safe idempotency key ────────────────────────────────
    const cid = `dispatch_v1_${safe(runId)}_${safe(symbol)}_${side}_${orderAction}`.slice(0, CID_MAX);
    if (!CID_RE.test(cid)) { skip(item, 'unbuildable_client_order_id'); continue; }

    // in-batch double-dispatch guard
    if (seenCids.has(cid)) {
      summary.skipped += 1;
      record({ symbol, side, action, client_order_id: cid, status: 'skipped', reason: 'duplicate_in_batch' });
      continue;
    }
    seenCids.add(cid);

    // cross-run idempotency: an existing record means this order was already dispatched.
    const existing = store.get(cid);   // throws on corrupt = fail-closed (propagate)
    if (existing) {
      summary.already_dispatched += 1;
      record({ symbol, side, action, client_order_id: cid, status: 'already_dispatched', state: existing.state });
      continue;
    }

    // ── exactly one submit through the existing gateway/paper path ─────────────
    const decisionId = item?.decision_source?.decision_id ?? item?.decision_id ?? null;
    const intentId   = item?.decision_source?.intent_id   ?? item?.intent_id   ?? null;
    const orderReq = {
      client_order_id: cid, symbol, qty, side, action,
      order_action: orderAction, order_type: orderType, time_in_force: tif,
      run_id: runId, intent_id: intentId, decision_id: decisionId, asset_type: item?.asset_type ?? null,
      price_usd:       item?.price_usd       ?? null,
      stop_loss_pct:   item?.stop_loss_pct   ?? null,
      take_profit_pct: item?.take_profit_pct ?? null,
      ...(orderType === ORDER_TYPES.LIMIT ? { limit_price: limitPrice } : {}),
    };

    let result;
    try {
      result = await submit(orderReq, ctx);
    } catch (e) {
      summary.errored += 1;
      record({ symbol, side, action, client_order_id: cid, status: 'error', reason: e?.message ?? String(e) });
      continue;
    }

    if (result && result.blocked_by_startup_gate === true) {
      summary.blocked_by_gate += 1;
      record({ symbol, side, action, client_order_id: cid, status: 'blocked_by_gate', gate: result.gate ?? null });
      continue;
    }

    const state = result?.state ?? null;
    if (state === 'submitted') {
      summary.submitted += 1;
      record({ symbol, side, action, client_order_id: cid, status: 'submitted', state, broker_order_id: result.broker_order_id ?? null });
    } else if (state === 'rejected') {
      summary.rejected += 1;
      record({ symbol, side, action, client_order_id: cid, status: 'rejected', state });
    } else if (state === 'pending_submit' || state === 'submit_unknown') {
      summary.submit_uncertain += 1;
      record({ symbol, side, action, client_order_id: cid, status: 'submit_uncertain', state });
    } else {
      // Defensive: any other persisted state is surfaced, not silently counted as success.
      summary.submit_uncertain += 1;
      record({ symbol, side, action, client_order_id: cid, status: 'submit_uncertain', state });
    }
  }

  return summary;
}
