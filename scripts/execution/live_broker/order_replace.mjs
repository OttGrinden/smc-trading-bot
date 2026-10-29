/**
 * OrderReplace — replace as CANCEL-AND-RECREATE only (Phase 1, Unit 9b).
 *
 * There is NO broker-native replace here. `replace_pending`/`replaced` are NEVER set.
 * A replace is modelled as: cancel the old order, wait until it is LOCALLY terminal
 * (`cancelled`), then submit a brand-new order. The two phases are driven across
 * SEPARATE invocations (no loop, no scheduler, no blocking wait):
 *
 *   requestReplace(oldCid, newOrderReq, ctx={broker}):
 *     load old (corrupt → throw, fail-closed)
 *     ├─ not found ........................ { ok:false, old_not_found }
 *     ├─ replaced_by_cid set ≠ newCid ..... { ok:false, replace_cid_mismatch }   (fail-closed)
 *     ├─ filled / partially_filled ........ { ok:false, aborted_old_filled }      (recreate would double)
 *     ├─ reconcile_hold/submit_unknown/
 *     │   pending_submit (uncertain) ...... { ok:false, blocked_uncertain_state } (recover first)
 *     ├─ CANCELLED (terminal confirmed) ... RECREATE: exactly one gateway.submit of the
 *     │                                     new order (idempotent) → { ok:true, recreated }
 *     ├─ settled-but-not-cancelled
 *     │   (rejected/expired/replaced/…) ... { ok:false, old_terminal_not_cancelled }
 *     ├─ cancel_pending ................... record linkage, AWAIT → { ok:true, awaiting_cancel }
 *     └─ submitted / acknowledged ......... record linkage + requestCancel(old), AWAIT
 *                                           → { ok:true, awaiting_cancel }  (NO recreate yet)
 *
 * RECREATE GATE (critical, fail-closed): the new order is submitted ONLY when the old
 * order's LOCAL state is exactly `cancelled`. Never on cancel_pending, reconcile_hold,
 * submit_unknown, or any non-terminal/uncertain state — so a double position can never
 * be created. Idempotent: a new record that already exists is never submitted twice.
 *
 * Additive: reuses the existing OrderGateway.submit (new order) and order_cancel
 * .requestCancel (old order). NO new states/edges; `replaces_cid`/`replaced_by_cid`
 * are metadata only. NOT in scope: native replace, polling, lease, scan.mjs wiring,
 * portfolio mutation.
 */

import * as store            from './order_store.mjs';
import { SETTLED_STATES }    from './order_store.mjs';
import { ORDER_STATES }      from '../schemas.mjs';
import { submit as gatewaySubmit } from './order_gateway.mjs';
import { requestCancel }     from './order_cancel.mjs';

// Old order already (partially) executed → recreating would double the position.
const ABORT_FILLED   = new Set([ORDER_STATES.FILLED, ORDER_STATES.PARTIALLY_FILLED]);
// Uncertain — must be recovered (reconciler) before any replace action.
const UNCERTAIN       = new Set([ORDER_STATES.RECONCILE_HOLD, ORDER_STATES.SUBMIT_UNKNOWN, ORDER_STATES.PENDING_SUBMIT]);
// Live + cancelable → drive the cancel leg (cycle A).
const LIVE_CANCELABLE = new Set([ORDER_STATES.SUBMITTED, ORDER_STATES.ACKNOWLEDGED]);

function emit(cid, type, extra = {}) { store.appendEvent(cid, { type, ...extra }); }

// Metadata-only annotation (no state transition); re-reads the persisted record first.
function annotate(cid, patch, eventType, extra = {}) {
  const rec = store.get(cid);
  if (rec == null) return null;
  store.upsert({ ...rec, ...patch });
  emit(cid, eventType, extra);
  return rec;
}

function isSettledNotCancelled(state) {
  return SETTLED_STATES.has(state)
    && state !== ORDER_STATES.CANCELLED
    && state !== ORDER_STATES.FILLED;   // filled handled earlier (ABORT_FILLED)
}

/**
 * requestReplace — cancel-and-recreate one order across two invocations.
 *
 * @param {string} oldCid       — client_order_id of the order being replaced
 * @param {object} newOrderReq  — gateway submit request for the NEW order; MUST carry an
 *                                 explicit client_order_id (deterministic replace linkage)
 * @param {object} ctx          — { broker (req: cancelOrder + submitOrder + getOrderByClientId) }
 * @returns {Promise<{ok:boolean, outcome:string, old_cid:string, new_cid:string|null, old_state:string|null, new_state?:string|null}>}
 * @throws  {Error} on missing broker, bad args, or a corrupt store record (fail-closed)
 */
export async function requestReplace(oldCid, newOrderReq = {}, ctx = {}) {
  const broker = ctx.broker;
  if (!broker || typeof broker.cancelOrder !== 'function'
      || typeof broker.submitOrder !== 'function' || typeof broker.getOrderByClientId !== 'function') {
    throw new Error('requestReplace: ctx.broker must implement cancelOrder + submitOrder + getOrderByClientId');
  }
  if (typeof oldCid !== 'string' || !oldCid) {
    throw new Error('requestReplace: oldCid (string) is required');
  }
  const newCid = newOrderReq?.client_order_id;
  if (typeof newCid !== 'string' || !newCid) {
    throw new Error('requestReplace: newOrderReq.client_order_id is required (explicit, deterministic replace linkage)');
  }
  if (newCid === oldCid) {
    throw new Error('requestReplace: newOrderReq.client_order_id must differ from oldCid');
  }

  const oldRec = store.get(oldCid);   // throws on corrupt = fail-closed
  if (oldRec == null) {
    return { ok: false, outcome: 'old_not_found', old_cid: oldCid, new_cid: null, old_state: null };
  }

  // Idempotent-retry linkage guard: a different new cid than already linked = fail-closed.
  if (oldRec.replaced_by_cid != null && oldRec.replaced_by_cid !== newCid) {
    return { ok: false, outcome: 'replace_cid_mismatch', old_cid: oldCid, new_cid: oldRec.replaced_by_cid, old_state: oldRec.state };
  }

  // ── Abort: old already (partially) executed — never recreate (would double) ───
  if (ABORT_FILLED.has(oldRec.state)) {
    emit(oldCid, 'broker_replace_aborted', { reason: 'old_filled', state: oldRec.state });
    return { ok: false, outcome: 'aborted_old_filled', old_cid: oldCid, new_cid: null, old_state: oldRec.state };
  }

  // ── Fail-closed: uncertain states must be recovered before any replace action ──
  if (UNCERTAIN.has(oldRec.state)) {
    emit(oldCid, 'broker_replace_blocked', { reason: 'uncertain_state', state: oldRec.state });
    return { ok: false, outcome: 'blocked_uncertain_state', old_cid: oldCid, new_cid: null, old_state: oldRec.state };
  }

  // ── RECREATE GATE: only when the old order is terminally CANCELLED ─────────────
  if (oldRec.state === ORDER_STATES.CANCELLED) {
    if (oldRec.replaced_by_cid !== newCid) {
      annotate(oldCid, { replaced_by_cid: newCid }, 'broker_replace_link', { new_cid: newCid });
    }
    // Idempotent: never submit the new order twice.
    if (!store.exists(newCid)) {
      const sub = await gatewaySubmit({ ...newOrderReq, replaces_cid: oldCid }, ctx);
      // Gate-aware recreate: the new-order submit can be fail-closed blocked by the
      // opt-in startup gate inside order_gateway.submit. Surface it EXPLICITLY instead
      // of falsely reporting "recreated". No record was anchored; the old order stays
      // cancelled and keeps its replaced_by_cid intent, so a later retry (gate safe)
      // recreates exactly once. Idempotency + recreate-gate remain strict.
      if (sub && sub.blocked_by_startup_gate === true) {
        emit(oldCid, 'broker_replace_recreate_blocked', { new_cid: newCid, phase: 'recreate' });
        return {
          ok: false, outcome: 'recreate_blocked_by_gate', blocked_by_startup_gate: true,
          phase: 'recreate', old_cid: oldCid, new_cid: newCid, new_client_order_id: newCid,
          old_state: oldRec.state, new_state: null, gate: sub.gate ?? null,
        };
      }
      annotate(newCid, { replaces_cid: oldCid }, 'broker_replace_recreated_link', { old_cid: oldCid });
    }
    const newRec = store.get(newCid);
    emit(oldCid, 'broker_replace_recreated', { new_cid: newCid, new_state: newRec?.state ?? null });
    return { ok: true, outcome: 'recreated', old_cid: oldCid, new_cid: newCid, new_client_order_id: newCid, old_state: oldRec.state, new_state: newRec?.state ?? null };
  }

  // ── Old terminal but NOT cancelled → cancel-and-recreate does not apply ───────
  if (isSettledNotCancelled(oldRec.state)) {
    emit(oldCid, 'broker_replace_blocked', { reason: 'old_terminal_not_cancelled', state: oldRec.state });
    return { ok: false, outcome: 'old_terminal_not_cancelled', old_cid: oldCid, new_cid: null, old_state: oldRec.state };
  }

  // ── Cycle A: record linkage intent, ensure the cancel leg is underway, AWAIT ──
  if (oldRec.replaced_by_cid !== newCid) {
    annotate(oldCid, { replaced_by_cid: newCid }, 'broker_replace_link', { new_cid: newCid });
  }
  if (oldRec.state === ORDER_STATES.CANCEL_PENDING) {
    emit(oldCid, 'broker_replace_awaiting_cancel', { state: oldRec.state });
    return { ok: true, outcome: 'awaiting_cancel', old_cid: oldCid, new_cid: newCid, old_state: oldRec.state };
  }
  if (LIVE_CANCELABLE.has(oldRec.state)) {
    const c     = await requestCancel(oldCid, ctx);
    const after = store.get(oldCid);
    emit(oldCid, 'broker_replace_awaiting_cancel', { cancel_outcome: c.outcome, state: after?.state ?? null });
    return { ok: true, outcome: 'awaiting_cancel', old_cid: oldCid, new_cid: newCid, old_state: after?.state ?? null, cancel_outcome: c.outcome };
  }

  // ── Any other state (created/validated/approved/sent/blocked) → fail-closed ───
  emit(oldCid, 'broker_replace_blocked', { reason: 'unhandled_state', state: oldRec.state });
  return { ok: false, outcome: 'blocked_unhandled_state', old_cid: oldCid, new_cid: null, old_state: oldRec.state };
}
