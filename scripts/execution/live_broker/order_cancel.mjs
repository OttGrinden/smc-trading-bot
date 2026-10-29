/**
 * OrderCancel — controlled, state-based cancel of a live broker order (Phase 1, Unit 9a).
 *
 * SCOPE (9a ONLY): turn a cancel request for ONE local record into at most ONE
 * broker DELETE, idempotent and fail-closed. It NEVER terminalizes the order
 * itself — the existing FillPoller maps the broker truth
 * (pending_cancel→cancel_pending, canceled→cancelled) and sets the terminal state.
 *
 *   requestCancel(cid|record, ctx={broker}):
 *     load record (corrupt → throw, fail-closed)
 *     ├─ no local record .............. no-op  { ok:false, not_found_local }
 *     ├─ cancel_pending ............... no-op  { ok:true,  already_cancel_pending }
 *     ├─ cancelled .................... no-op  { ok:true,  already_cancelled }
 *     ├─ NOT in {submitted,acknowledged,partially_filled}:
 *     │     settled/terminal → { ok:false, not_cancelable_terminal }
 *     │     other (uncertain/pre-live) → { ok:false, not_cancelable_state }
 *     ├─ cancelable but broker_order_id missing → reconcile_hold + flag (fail-closed)
 *     └─ anchor cancel_pending BEFORE the DELETE IO, then broker.cancelOrder:
 *           2xx ........................ stay cancel_pending (poller terminalizes) → ok:true
 *           404 not_found .............. reconcile_hold + 'cancel_not_found'  (fail-closed)
 *           422 validation ............. keep cancel_pending + flag 'cancel_rejected_not_cancelable'
 *                                        (poller fetches truth: filled/cancelled, advances legally)
 *           transient/auth/rate/5xx/… .. reconcile_hold + 'cancel_unknown'    (fail-closed)
 *
 * NOT in scope: replace, recreate, submit, polling, reconciler sweep, portfolio
 * mutation, scheduler/loop, scan.mjs/engine wiring. Cancelable states + transitions
 * are taken from the existing contract — NO new states or edges are introduced.
 */

import * as store               from './order_store.mjs';
import { SETTLED_STATES }        from './order_store.mjs';
import { canTransitionTo }       from '../order_state.mjs';
import { ORDER_STATES }          from '../schemas.mjs';
import { BROKER_ERROR_CLASSES }  from './adapters/alpaca_paper_broker.mjs';

// Only orders that are live at the broker (have a broker_order_id) are cancelable.
const CANCELABLE = new Set([
  ORDER_STATES.SUBMITTED, ORDER_STATES.ACKNOWLEDGED, ORDER_STATES.PARTIALLY_FILLED,
]);

function nowIso() { return new Date().toISOString(); }
function emit(cid, type, extra = {}) { store.appendEvent(cid, { type, ...extra }); }

function errInfo(err) {
  return {
    error_class: err?.error_class ?? 'unexpected_broker_response',
    message:     err?.detail ?? err?.message ?? String(err),
    http_status: err?.http_status ?? null,
  };
}

// Guarded transition between two PERSISTED states (legal contract edge required).
function advance(rec, nextState, patch, eventType, extra = {}) {
  if (!canTransitionTo(rec, nextState)) {
    throw new Error(`order_cancel: illegal transition ${rec.state} → ${nextState} (${rec.client_order_id})`);
  }
  const ts   = nowIso();
  const next = {
    ...rec, ...patch, state: nextState,
    events: [...(rec.events ?? []), { type: eventType, from_state: rec.state, to_state: nextState, ts, ...extra }],
  };
  store.upsert(next);
  emit(next.client_order_id, eventType, { from_state: rec.state, to_state: nextState, ...extra });
  return next;
}

// Set a reconcile_flag WITHOUT a state change (fail-closed; poller resolves truth later).
function flag(rec, reason, extra = {}) {
  const ts   = nowIso();
  const next = {
    ...rec, reconcile_flag: reason, last_poll_at: ts,
    events: [...(rec.events ?? []), { type: 'broker_cancel_flagged', state: rec.state, reason, ts }],
  };
  store.upsert(next);
  emit(next.client_order_id, 'broker_cancel_flagged', { state: rec.state, reason, ...extra });
  return next;
}

/**
 * requestCancel — idempotent, state-based cancel of one local order record.
 *
 * @param {string|object} cidOrRecord — client_order_id, or a record carrying one
 * @param {object} ctx                — { broker (req: adapter exposing cancelOrder) }
 * @returns {Promise<{ok:boolean, outcome:string, cid:string|null, state:string|null}>}
 * @throws  {Error} on missing broker, an unusable cid, or a corrupt store record (fail-closed)
 */
export async function requestCancel(cidOrRecord, ctx = {}) {
  const broker = ctx.broker;
  if (!broker || typeof broker.cancelOrder !== 'function') {
    throw new Error('requestCancel: ctx.broker must implement cancelOrder');
  }
  const cid = typeof cidOrRecord === 'string' ? cidOrRecord : cidOrRecord?.client_order_id;
  if (typeof cid !== 'string' || !cid) {
    throw new Error('requestCancel: a client_order_id (string) or a record carrying one is required');
  }

  const rec = store.get(cid);   // throws on corrupt = fail-closed
  if (rec == null) {
    return { ok: false, outcome: 'not_found_local', cid, state: null };
  }

  // ── Idempotent no-ops ───────────────────────────────────────────────────────
  if (rec.state === ORDER_STATES.CANCEL_PENDING) {
    emit(cid, 'broker_cancel_noop', { reason: 'already_cancel_pending' });
    return { ok: true, outcome: 'already_cancel_pending', cid, state: rec.state };
  }
  if (rec.state === ORDER_STATES.CANCELLED) {
    emit(cid, 'broker_cancel_noop', { reason: 'already_cancelled' });
    return { ok: true, outcome: 'already_cancelled', cid, state: rec.state };
  }

  // ── Not cancelable: terminal/settled or non-live/uncertain → fail-closed, no IO ──
  if (!CANCELABLE.has(rec.state)) {
    const outcome = SETTLED_STATES.has(rec.state) ? 'not_cancelable_terminal' : 'not_cancelable_state';
    emit(cid, 'broker_cancel_refused', { reason: outcome, state: rec.state });
    return { ok: false, outcome, cid, state: rec.state };
  }

  // ── Cancelable state but no broker id → cannot cancel at broker → fail-closed hold ──
  if (!rec.broker_order_id) {
    const held = advance(rec, ORDER_STATES.RECONCILE_HOLD,
      { reconcile_flag: 'cancel_missing_broker_id' }, 'broker_cancel_held', { reason: 'missing_broker_id' });
    return { ok: false, outcome: 'held_missing_broker_id', cid, state: held.state };
  }

  // ── Anchor cancel_pending BEFORE broker IO (crash-safe; mirrors submit anchor) ──
  const anchored = advance(rec, ORDER_STATES.CANCEL_PENDING,
    { idempotency_status: 'cancel_pending' }, 'broker_cancel_pending', {});

  // ── Exactly one DELETE; every failure branch is fail-closed ───────────────────
  try {
    await broker.cancelOrder(anchored.broker_order_id);
  } catch (err) {
    const klass = err?.error_class;

    if (klass === BROKER_ERROR_CLASSES.NOT_FOUND) {
      const held = advance(anchored, ORDER_STATES.RECONCILE_HOLD,
        { reconcile_flag: 'cancel_not_found', error: errInfo(err) }, 'broker_cancel_held', { reason: 'not_found' });
      return { ok: false, outcome: 'held_not_found', cid, state: held.state };
    }

    if (klass === BROKER_ERROR_CLASSES.VALIDATION) {
      // Broker refuses the cancel — almost always because the order already reached a
      // terminal broker state (filled/cancelled). Keep cancel_pending (POLLABLE) + flag;
      // the FillPoller fetches the true status and advances cancel_pending→filled/cancelled.
      const flagged = flag(anchored, 'cancel_rejected_not_cancelable', { error_class: klass });
      return { ok: false, outcome: 'flagged_not_cancelable', cid, state: flagged.state };
    }

    // transient_network / auth / rate_limit / broker_internal / unexpected / unknown:
    // outcome unclear → fail-closed hold, reconciler resolves later.
    const held = advance(anchored, ORDER_STATES.RECONCILE_HOLD,
      { reconcile_flag: 'cancel_unknown', error: errInfo(err) }, 'broker_cancel_held',
      { reason: 'unknown', error_class: klass ?? null });
    return { ok: false, outcome: 'held_unknown', cid, state: held.state };
  }

  // ── Success: DELETE accepted. Stay cancel_pending; FillPoller terminalizes. ────
  emit(cid, 'broker_cancel_requested', { broker_order_id: anchored.broker_order_id });
  return { ok: true, outcome: 'cancel_requested', cid, state: anchored.state };
}
