/**
 * FillPoller — broker-truth reconciliation of LOCAL records (Phase 1, Unit 5).
 *
 * SCOPE (Unit 5 ONLY): read non-terminal BrokerOrderRecords, ask the broker for
 * their current truth via getOrderByClientId, conservatively map the RAW broker
 * status onto internal ORDER_STATES using ONLY legal contract transitions, and
 * advance fills strictly idempotently AS A DELTA — in the RECORD ONLY.
 *
 *   for record in OrderStore.listNonTerminal():
 *     pollable?  → broker.getOrderByClientId(client_order_id)
 *       ├─ null / not found .......... conservative flag, never hallucinate cancelled
 *       ├─ adapter/network error ..... event only, record NOT mutated
 *       ├─ unknown broker status ..... fail-closed reconcile_flag (no optimistic map)
 *       ├─ illegal target transition . fail-closed reconcile_flag (no state change)
 *       ├─ filled_qty regression ..... fail-closed reconcile_flag (no roll-back)
 *       └─ legal advance / fill delta  persist state + fill delta (idempotent)
 *
 * This is a READER + conservative record updater. It is NOT an orchestrator:
 *   no submit, no resubmit, no cancel, no replace, no listOpenOrders, no global
 *   reconciler sweep, no startup-recovery loop, no scheduler/lease/CAS, and
 *   ABSOLUTELY no portfolio / cash / PnL / position mutation. Fills live only on
 *   the record; booking them into a portfolio is a later phase.
 *
 * Repo-compatibility notes (documented deviations, same safety semantics):
 *   - The existing normalized broker view (alpaca_paper_broker.normalizeBrokerOrder)
 *     carries CUMULATIVE filled_qty + avg_fill_price + RAW status only — no per-fill
 *     execution_id and no fills[]. So the live dedupe basis is the monotone cumulative
 *     filled_qty delta (the contract's documented fallback). An execution_id dedupe
 *     guard is applied additionally IF a view ever carries `execution_id`.
 *   - submit_unknown → acknowledged is NOT a legal edge. Adopting a found order whose
 *     status maps to `acknowledged` from a submit_unknown record uses the legal
 *     `submitted` re-entry instead (a later poll advances submitted → acknowledged).
 *   - Inconsistencies are flagged via reconcile_flag WITHOUT changing state; escalation
 *     to reconcile_hold belongs to the later reconciler, not this poller.
 */

import * as store          from './order_store.mjs';
import { canTransitionTo }  from '../order_state.mjs';
import { ORDER_STATES }     from '../schemas.mjs';

const EPS = 1e-9;

// RAW Alpaca order status → internal state. Unknown / held / stopped → null (conservative).
const STATUS_MAP = Object.freeze({
  pending_new:          ORDER_STATES.SUBMITTED,
  calculated:           ORDER_STATES.SUBMITTED,
  new:                  ORDER_STATES.ACKNOWLEDGED,
  accepted:             ORDER_STATES.ACKNOWLEDGED,
  accepted_for_bidding: ORDER_STATES.ACKNOWLEDGED,
  partially_filled:     ORDER_STATES.PARTIALLY_FILLED,
  filled:               ORDER_STATES.FILLED,
  pending_cancel:       ORDER_STATES.CANCEL_PENDING,
  canceled:             ORDER_STATES.CANCELLED,   // Alpaca spelling
  cancelled:            ORDER_STATES.CANCELLED,
  pending_replace:      ORDER_STATES.REPLACE_PENDING,
  replaced:             ORDER_STATES.REPLACED,
  expired:              ORDER_STATES.EXPIRED,
  done_for_day:         ORDER_STATES.EXPIRED,
  rejected:             ORDER_STATES.REJECTED,
  suspended:            ORDER_STATES.REJECTED,
  // 'stopped', 'held', and any new/unknown status are intentionally NOT mapped.
});

// Records the poller will query at the broker (order is/was live at broker).
const POLLABLE = new Set([
  ORDER_STATES.SUBMITTED, ORDER_STATES.ACKNOWLEDGED, ORDER_STATES.PARTIALLY_FILLED,
  ORDER_STATES.SUBMIT_UNKNOWN, ORDER_STATES.CANCEL_PENDING, ORDER_STATES.REPLACE_PENDING,
]);

// Terminal target states → set terminal_at when reached.
const TERMINAL = new Set([
  ORDER_STATES.FILLED, ORDER_STATES.REJECTED, ORDER_STATES.CANCELLED,
  ORDER_STATES.REPLACED, ORDER_STATES.EXPIRED,
]);

function nowIso() { return new Date().toISOString(); }

/** mapBrokerStatus — pure, conservative RAW→internal mapping (null = do not map). */
export function mapBrokerStatus(raw) {
  if (typeof raw !== 'string') return null;
  return STATUS_MAP[raw.toLowerCase()] ?? null;
}

function emit(cid, type, extra = {}) {
  store.appendEvent(cid, { type, ...extra });   // appendEvent stamps client_order_id + ts
}

// Flag an inconsistency WITHOUT a state change (fail-closed). Writes the flag once;
// repeated identical detections only re-emit an event (no redundant record write).
function flagInconsistent(rec, reason, raw, view, summary) {
  summary.inconsistent += 1;
  if (rec.reconcile_flag !== reason) {
    store.upsert({ ...rec, broker_status: raw ?? rec.broker_status, reconcile_flag: reason, last_poll_at: nowIso() });
  }
  emit(rec.client_order_id, 'broker_poll_inconsistent',
    { reason, broker_status: raw ?? null, broker_order_id: view?.broker_order_id ?? rec.broker_order_id ?? null });
}

/**
 * pollOnce — one conservative reconciliation pass over non-terminal records.
 *
 * @param {object} ctx — { broker (req: adapter exposing getOrderByClientId) }
 * @returns {Promise<object>} summary counts
 * @throws  {Error} on missing broker, or a corrupt store record (fail-closed, propagated)
 */
export async function pollOnce(ctx = {}) {
  const broker = ctx.broker;
  if (!broker || typeof broker.getOrderByClientId !== 'function') {
    throw new Error('FillPoller.pollOnce: ctx.broker must implement getOrderByClientId');
  }

  const summary = {
    scanned: 0, updated: 0, no_change: 0, not_found: 0,
    inconsistent: 0, held: 0, skipped: 0, errored: 0,
  };

  const records = store.listNonTerminal();   // throws on corrupt = fail-closed (propagate)
  for (const rec of records) {
    summary.scanned += 1;

    if (rec.state === ORDER_STATES.RECONCILE_HOLD) {
      summary.held += 1;
      emit(rec.client_order_id, 'broker_poll_seen', { reason: 'reconcile_hold', broker_status: rec.broker_status ?? null });
      continue;
    }
    if (!POLLABLE.has(rec.state)) {           // e.g. pending_submit — resolution belongs to recovery (later)
      summary.skipped += 1;
      emit(rec.client_order_id, 'broker_poll_seen', { reason: `skip_state:${rec.state}` });
      continue;
    }

    let view;
    try {
      view = await broker.getOrderByClientId(rec.client_order_id);
    } catch (e) {
      // Adapter/network error: never corrupt the record. Diagnose only.
      summary.errored += 1;
      emit(rec.client_order_id, 'broker_poll_seen', { phase: 'broker_error', error_class: e?.error_class ?? null, message: e?.message ?? String(e) });
      continue;
    }

    applyPoll(rec, view, summary);
  }

  return summary;
}

function applyPoll(rec, view, summary) {
  const cid = rec.client_order_id;

  // ── not found ──────────────────────────────────────────────────────────────
  if (view == null) {
    summary.not_found += 1;
    emit(cid, 'broker_poll_not_found', { broker_order_id: rec.broker_order_id ?? null, state: rec.state });
    // For an order we believe is live, flag conservatively ONCE (never hallucinate cancelled).
    if (rec.state !== ORDER_STATES.SUBMIT_UNKNOWN && rec.reconcile_flag !== 'broker_not_found') {
      store.upsert({ ...rec, reconcile_flag: 'broker_not_found', last_poll_at: nowIso() });
    }
    return;
  }

  const raw = view.broker_status;
  let target = mapBrokerStatus(raw);

  // unknown / unmapped broker status → fail-closed, do not optimistically map.
  if (target == null) {
    flagInconsistent(rec, 'unknown_broker_status', raw, view, summary);
    return;
  }

  // submit_unknown adoption: acknowledged is not a legal edge from submit_unknown →
  // adopt to the legal `submitted` re-entry (documented deviation).
  if (rec.state === ORDER_STATES.SUBMIT_UNKNOWN && target === ORDER_STATES.ACKNOWLEDGED) {
    target = ORDER_STATES.SUBMITTED;
  }

  // ── fill delta (idempotent) ─────────────────────────────────────────────────
  const newFilled   = Number.isFinite(view.filled_qty) ? view.filled_qty : 0;
  const lastApplied = Number.isFinite(rec.last_applied_filled_qty) ? rec.last_applied_filled_qty : 0;
  const delta       = newFilled - lastApplied;

  if (delta < -EPS) {                          // broker filled_qty went DOWN → never roll back
    flagInconsistent(rec, 'filled_qty_regression', raw, view, summary);
    return;
  }

  // execution_id dedupe guard (defensive; current adapter view has none).
  const execId    = view.execution_id ?? null;
  const execSeen  = execId != null && (rec.fills ?? []).some(f => f.execution_id === execId);
  const fillApplies = !execSeen && delta > EPS;

  // ── state transition legality ───────────────────────────────────────────────
  const stateChanges = target !== rec.state;
  if (stateChanges && !canTransitionTo(rec, target)) {
    flagInconsistent(rec, `illegal_status_transition:${rec.state}->${target}`, raw, view, summary);
    return;
  }

  // ── true no-op: no record write, just an append-only event ──────────────────
  if (!stateChanges && !fillApplies) {
    summary.no_change += 1;
    emit(cid, 'broker_poll_no_change', { broker_status: raw, broker_order_id: view.broker_order_id ?? rec.broker_order_id ?? null });
    return;
  }

  // ── build the single persisted update ───────────────────────────────────────
  const ts = nowIso();
  const next = { ...rec, broker_status: raw, last_poll_at: ts };
  if (view.broker_order_id && !rec.broker_order_id) next.broker_order_id = view.broker_order_id;
  if (rec.reconcile_flag === 'broker_not_found') next.reconcile_flag = null;   // order reappeared → clear stale flag

  if (fillApplies) {
    next.filled_qty             = newFilled;
    next.remaining_qty          = rec.qty != null ? Math.max(0, rec.qty - newFilled) : rec.remaining_qty;
    next.last_applied_filled_qty = newFilled;
    if (Number.isFinite(view.avg_fill_price) && view.avg_fill_price > 0) next.avg_fill_price = view.avg_fill_price;
    next.fills = [...(rec.fills ?? []), {
      delta_qty: delta, cumulative_qty: newFilled,
      avg_fill_price: Number.isFinite(view.avg_fill_price) ? view.avg_fill_price : null,
      execution_id: execId, broker_status: raw, ts,
    }];
  }

  if (stateChanges) {
    next.state  = target;
    next.events = [...(rec.events ?? []), { type: 'broker_status_advanced', from_state: rec.state, to_state: target, broker_status: raw, ts }];
    if (TERMINAL.has(target)) next.terminal_at = ts;
  }

  store.upsert(next);
  summary.updated += 1;

  if (stateChanges) {
    emit(cid, 'broker_status_advanced', { from_state: rec.state, to_state: target, broker_status: raw, broker_order_id: next.broker_order_id ?? null });
  }
  if (fillApplies) {
    emit(cid, 'broker_fill_delta_applied', { delta_qty: delta, cumulative_qty: newFilled, avg_fill_price: next.avg_fill_price ?? null, execution_id: execId });
  }
}
