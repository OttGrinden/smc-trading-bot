/**
 * OrderGateway — submit orchestration (Phase 1, Unit 4).
 *
 * SCOPE (Unit 4 ONLY): turn one order request into exactly one broker submit,
 * fail-closed and idempotent, persisting a pending_submit anchor BEFORE any IO:
 *
 *   validate(orderReq)               ← local validation; failure throws, no store write
 *   → resolve client_order_id        ← explicit, else deterministic + persistable
 *   → makeBrokerOrderRecord(...)
 *   → upsert(pending_submit)         ← idempotency anchor, persisted BEFORE any broker IO
 *   → broker.submitOrder(orderReq)
 *       ├─ 2xx ........................ submitted (broker_order_id assigned)
 *       ├─ duplicate_client_order_id .. getOrderByClientId → adopt | fail-closed submit_unknown
 *       ├─ validation / auth .......... rejected (terminal; no retry)
 *       └─ transient / rate_limit /
 *          broker_internal / unexpected  submit_unknown (NEVER blind-resubmit)
 *
 * Returns the final PERSISTED brokerOrderRecord. Idempotent re-entry for a cid that
 * already has a stored record is a no-op (returns the stored record) — never a 2nd submit.
 *
 * Explicitly NOT in Unit 4: no poller, no reconciler, no cancel, no replace, no
 * listOpenOrders, no startup-recovery loop, no lease/CAS, no engine/CLI/scan.mjs
 * wiring, NO portfolio/cash mutation, no retry orchestrator beyond this single path.
 *
 * Contract note (repo compatibility, documented deviation):
 *   makeBrokerOrderRecord starts a record at `created` (an in-memory DRAFT) and the
 *   contract has no `created → pending_submit` edge (the only anchor edge is
 *   `approved → pending_submit`, BC-04/BC-05). To honor "gateway builds the record
 *   AND persists pending_submit as the anchor" without inventing a new edge, the
 *   freshly built draft is persisted DIRECTLY with state=pending_submit as the very
 *   first store write — this is the initial persisted state, not a transition between
 *   two persisted states, so no ORDER_TRANSITIONS edge is added or bypassed. Every
 *   SUBSEQUENT change (pending_submit → submitted/submit_unknown/rejected) is guarded
 *   by canTransitionTo and is a legal contract edge.
 */

import * as store              from './order_store.mjs';
import { canTransitionTo }     from '../order_state.mjs';
import { ORDER_STATES, ORDER_TYPES, TIME_IN_FORCE, ORDER_ACTIONS, makeBrokerOrderRecord } from '../schemas.mjs';
import { BROKER_ERROR_CLASSES } from './adapters/alpaca_paper_broker.mjs';
import { assertStartupGate }    from './startup_recovery.mjs';

const CID_RE = /^[A-Za-z0-9_-]+$/;   // must match OrderStore's filesystem-safe charset

// States that already represent a live or finished order — never resubmit.
const NO_OP_STATES = new Set([
  // live at broker
  ORDER_STATES.SUBMITTED, ORDER_STATES.ACKNOWLEDGED, ORDER_STATES.PARTIALLY_FILLED,
  ORDER_STATES.CANCEL_PENDING, ORDER_STATES.REPLACE_PENDING,
  // settled / terminal
  ORDER_STATES.FILLED, ORDER_STATES.REJECTED, ORDER_STATES.CANCELLED,
  ORDER_STATES.REPLACED, ORDER_STATES.EXPIRED, ORDER_STATES.BLOCKED,
  ORDER_STATES.FAILED_RECONCILIATION,
  // ambiguous prior attempts — resolution belongs to the (later) recovery/reconciler step
  ORDER_STATES.PENDING_SUBMIT, ORDER_STATES.SUBMIT_UNKNOWN, ORDER_STATES.RECONCILE_HOLD,
]);

function nowIso() { return new Date().toISOString(); }

function errInfo(err) {
  return {
    error_class: err?.error_class ?? 'unexpected_broker_response',
    message:     err?.detail ?? err?.message ?? String(err),
    http_status: err?.http_status ?? null,
  };
}

// ─── Local input validation (mirrors the adapter; fails BEFORE any store write/IO) ──
function validateOrderReq(orderReq) {
  if (orderReq == null || typeof orderReq !== 'object') {
    throw new Error('OrderGateway.submit: orderReq object is required');
  }
  if (typeof orderReq.symbol !== 'string' || !orderReq.symbol) {
    throw new Error('OrderGateway.submit: symbol is required');
  }
  if (!Number.isFinite(orderReq.qty) || orderReq.qty <= 0) {
    throw new Error(`OrderGateway.submit: qty must be a positive finite number (got ${orderReq.qty})`);
  }
  if (!ORDER_ACTIONS.includes(orderReq.order_action)) {
    throw new Error(`OrderGateway.submit: invalid/absent order_action "${orderReq.order_action}"`);
  }
  const orderType = orderReq.order_type ?? ORDER_TYPES.MARKET;
  if (!Object.values(ORDER_TYPES).includes(orderType)) {
    throw new Error(`OrderGateway.submit: invalid order_type "${orderType}"`);
  }
  const tif = orderReq.time_in_force ?? TIME_IN_FORCE.DAY;
  if (!Object.values(TIME_IN_FORCE).includes(tif)) {
    throw new Error(`OrderGateway.submit: invalid time_in_force "${tif}"`);
  }
  if (orderType === ORDER_TYPES.LIMIT && !(Number.isFinite(orderReq.limit_price) && orderReq.limit_price > 0)) {
    throw new Error('OrderGateway.submit: limit order requires limit_price > 0');
  }
  if (orderType === ORDER_TYPES.STOP && !(Number.isFinite(orderReq.stop_price) && orderReq.stop_price > 0)) {
    throw new Error('OrderGateway.submit: stop order requires stop_price > 0');
  }
  return { orderType, tif };
}

// ─── client_order_id: use the explicit one, else build a deterministic, persistable cid ──
function resolveClientOrderId(orderReq, ctx) {
  const explicit = orderReq.client_order_id;
  if (explicit != null) {
    if (typeof explicit !== 'string' || !CID_RE.test(explicit)) {
      throw new Error(`OrderGateway.submit: explicit client_order_id must match ${CID_RE}: ${JSON.stringify(explicit)}`);
    }
    return explicit;
  }
  // Deterministic so a retry of the SAME logical order reuses the SAME cid (idempotency anchor).
  const run_id = orderReq.run_id ?? ctx.run_id;
  const side   = orderReq.side;
  const action = orderReq.order_action;
  const seq    = orderReq.seq ?? ctx.seq;
  if (!run_id || !orderReq.symbol || !side || !action) {
    throw new Error('OrderGateway.submit: cannot build deterministic client_order_id — need run_id, symbol, side, order_action (or pass client_order_id explicitly)');
  }
  const base = `cid_v1_${run_id}_${orderReq.symbol}_${side}_${action}`;
  const cid  = seq != null ? `${base}_${seq}` : base;
  if (!CID_RE.test(cid)) {
    throw new Error(`OrderGateway.submit: derived client_order_id is not store-safe (must match ${CID_RE}): ${cid}`);
  }
  return cid;
}

// Append a lifecycle event to BOTH the per-record history and the central append-only log.
function emit(record, eventType, extra = {}) {
  store.appendEvent(record.client_order_id, { type: eventType, state: record.state, ...extra });
}

// Guarded transition between two PERSISTED states (legal edge required).
function advance(prev, nextState, patch, eventType, extra = {}) {
  if (!canTransitionTo(prev, nextState)) {
    throw new Error(`OrderGateway: illegal transition ${prev.state} → ${nextState} (${prev.client_order_id})`);
  }
  const ts   = nowIso();
  const next = {
    ...prev, ...patch, state: nextState,
    events: [...(prev.events ?? []), { type: eventType, from_state: prev.state, to_state: nextState, ts, ...extra }],
  };
  store.upsert(next);
  emit(next, eventType, { from_state: prev.state, to_state: nextState, ...extra });
  return next;
}

// Resolve the opt-in startup gate. ctx.startupGate may be:
//   - a function → custom/injected gate returning { safe, ... } (used in tests)
//   - an object  → { execConfig (req), broker?, leaseOpts? } → run the real
//                  lease-protected assertStartupGate over the live store
// Fail-closed: any thrown error from an injected function → safe:false.
async function resolveStartupGate(ctx) {
  const sg = ctx.startupGate;
  if (typeof sg === 'function') {
    try {
      const r = await sg();
      return { safe: r?.safe === true, gate: r?.gate ?? r ?? null, exit_code: r?.exit_code };
    } catch (e) {
      return { safe: false, gate: { safe: false, reason: 'gate_error' }, exit_code: 1 };
    }
  }
  const cfg = (sg && typeof sg === 'object') ? sg : {};
  return assertStartupGate({
    broker:     cfg.broker ?? ctx.broker,
    execConfig: cfg.execConfig ?? ctx.execConfig,
    leaseOpts:  cfg.leaseOpts,
  });
}

/**
 * submit — orchestrate one idempotent broker submit for `orderReq`.
 *
 * @param {object} orderReq — { symbol (req), qty (req>0), order_action (req),
 *   order_type?, time_in_force?, limit_price? (req when limit), client_order_id?,
 *   run_id?, side?, asset_type?, intent_id?, decision_id?, action?, seq? }
 * @param {object} ctx      — { broker (req: AlpacaPaperBroker w/ submitOrder+getOrderByClientId),
 *                              run_id?, seq? }
 * @returns {Promise<object>} the final PERSISTED brokerOrderRecord
 * @throws  {Error} on missing broker, local validation failure, or an unbuildable cid
 */
export async function submit(orderReq = {}, ctx = {}) {
  const broker = ctx.broker;
  if (!broker || typeof broker.submitOrder !== 'function' || typeof broker.getOrderByClientId !== 'function') {
    throw new Error('OrderGateway.submit: ctx.broker must implement submitOrder + getOrderByClientId');
  }

  // 0) Opt-in fail-closed startup gate (Unit 10). Default OFF (no ctx.startupGate)
  //    → behavior unchanged, no lease/broker IO. When enabled, NO new order is
  //    validated, anchored, or submitted unless the gate is unambiguously safe.
  //    Runs BEFORE any store write or broker IO so a blocked run leaves no anchor.
  if (ctx.startupGate) {
    const gate = await resolveStartupGate(ctx);
    if (!gate.safe) {
      process.stderr.write(JSON.stringify({
        warn:             'blocked_by_startup_gate',
        symbol:           orderReq?.symbol ?? null,
        client_order_id:  orderReq?.client_order_id ?? null,
        exit_code:        gate.exit_code ?? 2,
        gate:             gate.gate ?? null,
      }) + '\n');
      return { ok: false, blocked_by_startup_gate: true, exit_code: gate.exit_code ?? 2, gate: gate.gate ?? null };
    }
  }

  // 1) Local validation FIRST — a local failure never anchors and never submits.
  const { orderType, tif } = validateOrderReq(orderReq);

  // 2) Resolve the durable idempotency key.
  const cid = resolveClientOrderId(orderReq, ctx);

  // 3) Idempotent re-entry: a stored record for this cid is a no-op (never a 2nd submit).
  const existing = store.get(cid);                       // throws on corrupt = fail-closed
  if (existing && NO_OP_STATES.has(existing.state)) {
    emit(existing, 'broker_submit_noop', { reason: existing.state });
    return existing;
  }

  // 4) Build the broker order record (draft) and persist the pending_submit anchor
  //    BEFORE any broker IO. This first store write IS the anchor (see contract note).
  const draft = makeBrokerOrderRecord(
    { intent_id: orderReq.intent_id ?? null, symbol: orderReq.symbol, side: orderReq.side ?? null, asset_type: orderReq.asset_type ?? null },
    { decision_id: orderReq.decision_id ?? null },
    {
      client_order_id: cid,
      run_id:          orderReq.run_id ?? ctx.run_id ?? null,
      action:          orderReq.action ?? null,
      order_action:    orderReq.order_action,
      qty:             orderReq.qty,
      order_type:      orderType,
      time_in_force:   tif,
      limit_price:     orderType === ORDER_TYPES.LIMIT ? orderReq.limit_price : null,
      stop_price:      orderType === ORDER_TYPES.STOP  ? orderReq.stop_price  : null,
      price_usd:       orderReq.price_usd       ?? null,
      stop_loss_pct:   orderReq.stop_loss_pct   ?? null,
      take_profit_pct: orderReq.take_profit_pct ?? null,
    },
  );

  const anchorTs = nowIso();
  const anchored = {
    ...draft,
    state:               ORDER_STATES.PENDING_SUBMIT,
    anchor_persisted_at: anchorTs,
    attempt_count:       (draft.attempt_count ?? 0) + 1,
    idempotency_status:  'submitting',
    events:              [...(draft.events ?? []), { type: 'broker_submit_anchor_persisted', from_state: draft.state, to_state: ORDER_STATES.PENDING_SUBMIT, ts: anchorTs }],
  };
  store.upsert(anchored);                                // atomic temp+rename (OrderStore)
  emit(anchored, 'broker_submit_anchor_persisted', { from_state: draft.state, to_state: ORDER_STATES.PENDING_SUBMIT });

  // 5) Exactly one submit over the existing AlpacaPaperBroker. The anchor already exists,
  //    so any failure here leaves a recoverable pending_submit/submit_unknown record.
  let view;
  try {
    view = await broker.submitOrder(toOrderReq(anchored));
  } catch (err) {
    return handleSubmitError(anchored, err, broker);
  }

  // 6) Success → submitted.
  return advance(
    anchored, ORDER_STATES.SUBMITTED,
    {
      broker_order_id:    view?.broker_order_id ?? null,
      broker_status:      view?.broker_status ?? null,
      submitted_at:       nowIso(),
      idempotency_status: 'submitted',
    },
    'broker_order_submitted',
    { broker_order_id: view?.broker_order_id ?? null, broker_status: view?.broker_status ?? null },
  );
}

// Build the broker submit request from the persisted record (single source of truth).
function toOrderReq(r) {
  return {
    client_order_id: r.client_order_id,
    symbol:          r.symbol,
    qty:             r.qty,
    order_action:    r.order_action,
    order_type:      r.order_type,
    time_in_force:   r.time_in_force,
    price_usd:       r.price_usd       ?? null,
    stop_loss_pct:   r.stop_loss_pct   ?? null,
    take_profit_pct: r.take_profit_pct ?? null,
    ...(r.order_type === ORDER_TYPES.LIMIT ? { limit_price: r.limit_price } : {}),
    ...(r.order_type === ORDER_TYPES.STOP  ? { stop_price:  r.stop_price  } : {}),
  };
}

// ─── Error handling — every branch starts from the persisted pending_submit anchor ──

async function handleSubmitError(anchored, err, broker) {
  const klass = err?.error_class;

  if (klass === BROKER_ERROR_CLASSES.DUPLICATE_CLIENT_ORDER_ID) {
    return adoptDuplicate(anchored, broker, err);
  }

  // Definitive, non-retryable client/credential failure → rejected (no order created, no retry).
  if (klass === BROKER_ERROR_CLASSES.VALIDATION || klass === BROKER_ERROR_CLASSES.AUTH) {
    return advance(
      anchored, ORDER_STATES.REJECTED,
      { idempotency_status: 'rejected', error: errInfo(err), terminal_at: nowIso() },
      'broker_submit_rejected',
      { error_class: klass },
    );
  }

  // transient_network / rate_limit / broker_internal / unexpected_broker_response / unknown:
  // outcome treated as UNRESOLVED — never blind-resubmit; reconciler resolves later.
  return advance(
    anchored, ORDER_STATES.SUBMIT_UNKNOWN,
    { idempotency_status: 'submit_unknown', error: errInfo(err) },
    'broker_submit_unknown',
    { error_class: klass ?? 'unexpected_broker_response' },
  );
}

async function adoptDuplicate(anchored, broker, dupErr) {
  let view;
  try {
    view = await broker.getOrderByClientId(anchored.client_order_id);
  } catch (e) {
    // Cannot resolve now → unresolved (fail-closed). Reconciler retries later. No resubmit.
    return advance(
      anchored, ORDER_STATES.SUBMIT_UNKNOWN,
      { idempotency_status: 'submit_unknown', error: errInfo(e), reconcile_flag: 'duplicate_resolve_failed' },
      'broker_submit_unknown',
      { phase: 'duplicate_resolve', error_class: e?.error_class },
    );
  }

  if (view && view.broker_order_id) {
    // The order already exists at the broker → adopt it (idempotency upheld, no 2nd submit).
    return advance(
      anchored, ORDER_STATES.SUBMITTED,
      {
        broker_order_id:    view.broker_order_id,
        broker_status:      view.broker_status ?? null,
        submitted_at:       nowIso(),
        idempotency_status: 'adopted',
      },
      'broker_submit_duplicate_adopted',
      { broker_order_id: view.broker_order_id },
    );
  }

  // Divergence: broker reports duplicate yet lookup returns nothing → fail-closed, NOT optimistic.
  // reconcile_hold is unreachable from pending_submit, so record submit_unknown + a flag;
  // escalation to reconcile_hold is the reconciler's job (later step).
  return advance(
    anchored, ORDER_STATES.SUBMIT_UNKNOWN,
    { idempotency_status: 'submit_unknown', error: errInfo(dupErr), reconcile_flag: 'duplicate_but_not_found' },
    'broker_submit_unknown',
    { phase: 'duplicate_resolve', reason: 'duplicate_but_not_found' },
  );
}
