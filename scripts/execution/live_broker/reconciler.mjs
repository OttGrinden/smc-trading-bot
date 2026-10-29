/**
 * Reconciler — recovery / reconciliation of uncertain & inconsistent records
 * (Phase 1, Unit 6).
 *
 * SCOPE (Unit 6 ONLY): a FOCUSED worker that resolves records the FillPoller
 * cannot, against broker truth, using ONLY legal contract transitions:
 *
 *   candidates = listNonTerminal() filtered to:
 *     state ∈ { pending_submit, submit_unknown, reconcile_hold }  OR  reconcile_flag != null
 *
 *   per candidate → broker.getOrderByClientId(client_order_id):
 *     adoption states (pending_submit / submit_unknown / reconcile_hold)
 *       ├─ found ....... adopt to the NEAREST LEGAL live state (fills stay the poller's job)
 *       └─ not found ... fail-closed flag 'unresolved_not_found'  (NO resubmit — see below)
 *     flagged live records (submitted / acknowledged / partially_filled / …)
 *       ├─ found + cleanly resolvable . clear the reconcile_flag (state unchanged; poller resumes)
 *       └─ otherwise .................. keep the flag, escalate (fail-closed)
 *
 * RESUBMIT DECISION (deliberate): this unit does NOT resubmit. The OrderGateway
 * treats pending_submit / submit_unknown as a NO-OP and never resubmits, so there is
 * no clean existing mechanism; adding one here would be a new submit path (out of
 * scope) or a gateway refactor (out of scope). Safety over completeness: a
 * pending_submit / submit_unknown that the broker does not know is flagged
 * 'unresolved_not_found' and escalated — never resubmitted.
 *
 * This worker is NOT: a second general poller, a submit/cancel/replace path, a
 * portfolio/cash/PnL mutator, a positions reconciler, or any runtime/scan.mjs wiring.
 *
 * Repo-compatibility (documented, same safety semantics):
 *   - reuses fill_poller.mapBrokerStatus (no second mapping world)
 *   - adoption brings a record into the live lane (preferring the universally legal
 *     `submitted` re-entry) and lets the FillPoller apply fills + terminalize — the
 *     reconciler never applies fill deltas and never terminalizes to `filled`
 *     (avoids stranding fills behind a settled state)
 *   - if broker truth implies a contract-illegal target with no legal alternative,
 *     the record is held fail-closed (the contract is never bent / no new edge)
 */

import * as store         from './order_store.mjs';
import { canTransitionTo } from '../order_state.mjs';
import { ORDER_STATES }    from '../schemas.mjs';
import { mapBrokerStatus } from './fill_poller.mjs';

const EPS = 1e-9;

// States whose uncertainty the reconciler resolves by adopting broker truth.
const ADOPTION_STATES = new Set([
  ORDER_STATES.PENDING_SUBMIT, ORDER_STATES.SUBMIT_UNKNOWN, ORDER_STATES.RECONCILE_HOLD,
]);

// Terminal broker truths that carry NO fills → safe to terminalize directly if legal.
const NO_FILL_TERMINALS = new Set([ORDER_STATES.REJECTED, ORDER_STATES.CANCELLED, ORDER_STATES.EXPIRED]);

// Terminal states → set terminal_at when reached.
const TERMINAL = new Set([
  ORDER_STATES.FILLED, ORDER_STATES.REJECTED, ORDER_STATES.CANCELLED,
  ORDER_STATES.REPLACED, ORDER_STATES.EXPIRED,
]);

function nowIso() { return new Date().toISOString(); }
function emit(cid, type, extra = {}) { store.appendEvent(cid, { type, ...extra }); }

/**
 * pickAdoptTarget — the nearest LEGAL state to adopt for a found order.
 * Active / fill-bearing broker truth → the universally legal `submitted` re-entry
 * (the FillPoller then advances + applies fills). No-fill terminals → direct if legal.
 * Returns null when no legal target exists (→ fail-closed).
 */
function pickAdoptTarget(rec, target) {
  if (target == null) return null;
  if (NO_FILL_TERMINALS.has(target)) return canTransitionTo(rec, target) ? target : null;
  if (canTransitionTo(rec, ORDER_STATES.SUBMITTED)) return ORDER_STATES.SUBMITTED;
  if (canTransitionTo(rec, target))                 return target;
  return null;
}

/**
 * reconcileOnce — one conservative recovery/reconciliation pass.
 *
 * @param {object} ctx — { broker (req: adapter exposing getOrderByClientId) }
 * @returns {Promise<object>} summary counts
 * @throws  {Error} on missing broker, or a corrupt store record (fail-closed, propagated)
 */
export async function reconcileOnce(ctx = {}) {
  const broker = ctx.broker;
  if (!broker || typeof broker.getOrderByClientId !== 'function') {
    throw new Error('Reconciler.reconcileOnce: ctx.broker must implement getOrderByClientId');
  }

  const summary = { scanned: 0, resolved: 0, adopted: 0, not_found: 0, escalated: 0, errored: 0 };

  const records = store.listNonTerminal();   // throws on corrupt = fail-closed (propagate)
  for (const rec of records) {
    const isCandidate = ADOPTION_STATES.has(rec.state) || rec.reconcile_flag != null;
    if (!isCandidate) continue;               // clean, pollable orders remain the FillPoller's job

    summary.scanned += 1;
    emit(rec.client_order_id, 'broker_reconcile_started', { state: rec.state, reconcile_flag: rec.reconcile_flag ?? null });

    let view;
    try {
      view = await broker.getOrderByClientId(rec.client_order_id);
    } catch (e) {
      summary.errored += 1;
      emit(rec.client_order_id, 'broker_reconcile_failed', { error_class: e?.error_class ?? null, message: e?.message ?? String(e) });
      continue;                               // never corrupt the record on adapter/network error
    }

    if (ADOPTION_STATES.has(rec.state)) resolveAdoption(rec, view, summary);
    else                                resolveFlag(rec, view, summary);
  }

  return summary;
}

// ─── Adoption path: pending_submit / submit_unknown / reconcile_hold ─────────────
function resolveAdoption(rec, view, summary) {
  const cid = rec.client_order_id;

  if (view == null) {
    // NO resubmit (see module header). Fail-closed flag, keep state.
    summary.not_found += 1;
    summary.escalated += 1;
    if (rec.reconcile_flag !== 'unresolved_not_found') {
      store.upsert({ ...rec, reconcile_flag: 'unresolved_not_found', last_poll_at: nowIso() });
    }
    emit(cid, 'broker_reconcile_not_found', { state: rec.state, broker_order_id: rec.broker_order_id ?? null });
    emit(cid, 'broker_reconcile_unresolved', { reason: 'not_found_no_resubmit', state: rec.state });
    return;
  }

  const raw    = view.broker_status;
  const mapped = mapBrokerStatus(raw);
  const target = pickAdoptTarget(rec, mapped);

  if (target == null) {
    // unknown broker status OR no legal target for this truth → conservatively hold.
    summary.escalated += 1;
    const reason = mapped == null ? 'unknown_broker_status' : 'no_legal_target';
    if (rec.reconcile_flag !== reason) {
      store.upsert({ ...rec, broker_status: raw ?? rec.broker_status, reconcile_flag: reason, last_poll_at: nowIso() });
    }
    emit(cid, 'broker_reconcile_unresolved', { reason, broker_status: raw ?? null, broker_order_id: view.broker_order_id ?? rec.broker_order_id ?? null });
    return;
  }

  const ts   = nowIso();
  const next = {
    ...rec, state: target, broker_status: raw, last_poll_at: ts, reconcile_flag: null,
    events: [...(rec.events ?? []), { type: 'broker_reconcile_adopted', from_state: rec.state, to_state: target, broker_status: raw, ts }],
  };
  if (view.broker_order_id && !rec.broker_order_id) next.broker_order_id = view.broker_order_id;
  if (TERMINAL.has(target)) next.terminal_at = ts;
  store.upsert(next);
  emit(cid, 'broker_reconcile_adopted', { from_state: rec.state, to_state: target, broker_status: raw, broker_order_id: next.broker_order_id ?? null });
  summary.adopted  += 1;
  summary.resolved += 1;
}

// ─── Flag path: a live record carrying a reconcile_flag ──────────────────────────
function resolveFlag(rec, view, summary) {
  const cid  = rec.client_order_id;
  const flag = rec.reconcile_flag;

  if (view == null) {
    summary.not_found += 1;
    summary.escalated += 1;
    emit(cid, 'broker_reconcile_not_found', { state: rec.state, reconcile_flag: flag });
    emit(cid, 'broker_reconcile_unresolved', { reason: 'not_found', reconcile_flag: flag });
    return;
  }

  const raw    = view.broker_status;
  const mapped = mapBrokerStatus(raw);

  let resolvable;
  if (flag === 'filled_qty_regression') {
    // NEVER roll back filled_qty. Only clear once the broker has caught up (no regression now).
    const newFilled   = Number.isFinite(view.filled_qty) ? view.filled_qty : 0;
    const lastApplied = Number.isFinite(rec.last_applied_filled_qty) ? rec.last_applied_filled_qty : 0;
    resolvable = newFilled + EPS >= lastApplied;
  } else {
    // Resolvable once broker truth is known and consistent with the current state
    // (same state, or a legal forward edge). State itself is advanced by the poller.
    resolvable = mapped != null && (mapped === rec.state || canTransitionTo(rec, mapped));
  }

  if (!resolvable) {
    summary.escalated += 1;
    emit(cid, 'broker_reconcile_unresolved', { reason: 'not_resolvable', reconcile_flag: flag, broker_status: raw ?? null });
    return;
  }

  const ts   = nowIso();
  const next = {
    ...rec, reconcile_flag: null, broker_status: raw, last_poll_at: ts,
    events: [...(rec.events ?? []), { type: 'broker_reconcile_resolved', state: rec.state, cleared_flag: flag, broker_status: raw, ts }],
  };
  if (view.broker_order_id && !rec.broker_order_id) next.broker_order_id = view.broker_order_id;
  store.upsert(next);   // clears the flag ONLY; state unchanged → FillPoller resumes normal progression
  emit(cid, 'broker_reconcile_resolved', { state: rec.state, cleared_flag: flag, broker_status: raw, broker_order_id: next.broker_order_id ?? null });
  summary.resolved += 1;
}
