/**
 * BrokerFillBooking — Unit 28: extended portfolio booking from confirmed broker fills.
 *
 * Successor to the Unit 10.5 FillSync that adds PARTIALLY_FILLED booking via delta
 * accumulation. Shares the `booked_fills[cid]` watermark in portfolio_state.json with
 * fill_sync.mjs — both modules compose safely (the watermark prevents double-booking
 * regardless of which module ran first or last).
 *
 * Booking semantics:
 *   FILLED          + action=open  → full open (or final delta if partials preceded)
 *   PARTIALLY_FILLED + action=open  → delta open: first delta creates position,
 *                                     subsequent deltas update qty + VWAP entry in-place
 *   FILLED          + action=close → full close + realized PnL
 *   PARTIALLY_FILLED + action=close → delta-close: reduces position qty incrementally;
 *                                     final delta (position → 0) removes position + records win/loss
 *
 * Partial-close win/loss tracking: `position.partial_realized_eur` accumulates realized PnL
 * across all close deltas; sign at final close determines cs.wins/cs.losses.
 * cs.count is incremented only once, at final close.
 *
 * Not bookable (never mutate state):
 *   submitted / acknowledged / pending_* / cancelled / rejected / expired / reconcile_hold
 *
 * Idempotency: `state.booked_fills[cid]` watermark tracks booked qty. Delta =
 *   filledQty − bookedQty. A second call with the same record is a disk-safe no-op.
 *
 * Default-Off: `bookBrokerFills` is not called by any existing path (worker_pass.mjs,
 * fill_sync.mjs, paper_exec_layer.mjs). Call it explicitly from soak tooling or a
 * dedicated booking trigger.
 *
 * avg_fill_price in Alpaca records is the cumulative VWAP (all fills so far). The
 * position's entry_price is always updated to reflect the current VWAP — this is the
 * correct cost-basis representation for an incrementally filled order.
 */

import * as store        from './order_store.mjs';
import { ORDER_STATES }  from '../schemas.mjs';
import {
  loadOrInit, save, recompute, appendLedger, usdToEur,
} from '../portfolio/portfolio_state.mjs';
import { auditLog }      from '../audit_log.mjs';

const EPS     = 1e-9;
const QTY_TOL = 1e-6;

function nowIso() { return new Date().toISOString(); }
function dirFactor(side) { return side === 'short' ? -1 : 1; }

const BOOKABLE_STATES = new Set([ORDER_STATES.FILLED, ORDER_STATES.PARTIALLY_FILLED]);

/**
 * bookBrokerFills — one idempotent booking pass over FILLED + PARTIALLY_FILLED records.
 *
 * Reads broker truth from the OrderStore (respects test path overrides), loads and
 * saves portfolio state via the standard path resolution (also respects test overrides).
 * State is written to disk ONLY if at least one new delta was booked.
 *
 * @param {object} opts — { run_id?: string }
 * @returns {object} summary {
 *   scanned, eligible,
 *   booked_open,          — first-fill opens (FILLED or first PARTIALLY_FILLED)
 *   booked_open_delta,    — subsequent partial-fill position updates
 *   booked_close,         — full closes
 *   already_booked,       — delta ≤ EPS (fully idempotent)
 *   skipped,              — logical inconsistencies or unsupported cases
 *   skips: [{cid, reason}]
 * }
 * @throws {Error} only on a corrupt store record (fail-closed, propagated)
 */
export function bookBrokerFills(opts = {}) {
  const runId = opts.run_id ?? null;
  const state = loadOrInit();

  // Lazy-init booked_fills (additive migration; no schema version bump needed)
  if (state.booked_fills == null || typeof state.booked_fills !== 'object') state.booked_fills = {};
  if (!Array.isArray(state.open_positions)) state.open_positions = [];

  const summary = {
    scanned: 0, eligible: 0,
    booked_open: 0, booked_open_delta: 0, booked_close: 0, booked_partial_close: 0,
    already_booked: 0, skipped: 0, skips: [],
  };

  const skip = (cid, reason, symbol) => {
    summary.skipped += 1;
    summary.skips.push({ cid, reason });
    auditLog('broker_fill_booking_skipped', {
      client_order_id: cid, reason, symbol: symbol ?? null, run_id: runId,
    });
  };

  // Deterministic booking order (stable across repeated calls)
  const records = store.listAll()
    .slice()
    .sort((a, b) => String(a.client_order_id).localeCompare(String(b.client_order_id)));

  let mutated = false;

  for (const rec of records) {
    summary.scanned += 1;
    if (!BOOKABLE_STATES.has(rec.state)) continue;
    summary.eligible += 1;

    const cid        = rec.client_order_id;
    const filledQty  = Number.isFinite(rec.filled_qty) ? rec.filled_qty : 0;
    const bookedQty  = Number.isFinite(state.booked_fills[cid]) ? state.booked_fills[cid] : 0;
    const deltaQty   = filledQty - bookedQty;

    // idempotency: nothing new since last booking pass
    if (deltaQty <= EPS) { summary.already_booked += 1; continue; }

    // common guards (fail-closed: skip with reason, never a partial mutation)
    const px = rec.avg_fill_price;
    if (!Number.isFinite(px) || px <= 0)             { skip(cid, 'missing_or_invalid_fill_price', rec.symbol); continue; }
    if (!Number.isFinite(filledQty) || filledQty <= 0){ skip(cid, 'non_positive_filled_qty',       rec.symbol); continue; }
    const side = rec.side;
    if (side !== 'long' && side !== 'short')          { skip(cid, 'unknown_side',                   rec.symbol); continue; }
    const action = rec.action;
    if (action !== 'open' && action !== 'close')      { skip(cid, 'unknown_action',                 rec.symbol); continue; }
    const sym = rec.symbol;
    if (typeof sym !== 'string' || !sym)              { skip(cid, 'missing_symbol',                 rec.symbol); continue; }

    const fillEur   = +usdToEur(px).toFixed(6);
    const isPartial = rec.state === ORDER_STATES.PARTIALLY_FILLED;
    const existing  = state.open_positions.find(p => p.symbol === sym && p.side === side);

    // ── OPEN ─────────────────────────────────────────────────────────────────────
    if (action === 'open') {
      // A different order already holds this symbol+side — refuse (no cross-order averaging)
      if (existing && existing.order_id !== cid) {
        skip(cid, 'open_but_position_exists_different_order', sym); continue;
      }

      if (!existing) {
        // First fill (partial or final): open a new position
        const qty = +filledQty.toFixed(8);
        const pos = {
          symbol:             sym,
          asset_type:         rec.asset_type ?? null,
          side,
          quantity:           qty,
          notional_eur:       +(qty * fillEur).toFixed(4),
          entry_price_usd:    px,
          entry_price_eur:    fillEur,
          mark_price_usd:     px,
          mark_price_eur:     fillEur,
          unrealized_pnl_eur: 0,
          stop_loss_pct:      null,
          leverage:           1,
          entry_timestamp:    rec.terminal_at ?? nowIso(),
          entry_run_id:       rec.run_id ?? runId,
          strategy:           'broker_fill',
          decision_source:    { decision_id: rec.decision_id ?? null, intent_id: rec.intent_id ?? null },
          order_id:           cid,
          broker_order_id:    rec.broker_order_id ?? null,
          booked_from:        'broker_fill',
          mark_source:        'broker_fill',
          ...(isPartial ? { partial_fill: true } : {}),
        };
        state.open_positions.push(pos);
        state.booked_fills[cid] = filledQty;
        mutated = true;
        summary.booked_open += 1;

        appendLedger({
          ts: nowIso(), event: 'open', source: 'broker_fill', run_id: runId,
          order_id: cid, broker_order_id: rec.broker_order_id ?? null,
          symbol: sym, side,
          delta_qty: qty, quantity: qty,
          fill_price_eur: fillEur, notional_eur: pos.notional_eur, fee_eur: 0,
          partial: isPartial,
        });
        auditLog('broker_fill_booked_open', {
          client_order_id: cid, symbol: sym, side, quantity: qty,
          partial: isPartial, notional_eur: pos.notional_eur, fill_price_eur: fillEur, run_id: runId,
        });
        continue;
      }

      // Same-CID incremental fill: update position with new VWAP and cumulative qty.
      // avg_fill_price from Alpaca is always the cumulative VWAP — use it directly as the
      // new entry price. No manual weighted-average computation needed.
      const newQty      = +filledQty.toFixed(8);
      const newEntryEur = fillEur;

      existing.quantity        = newQty;
      existing.entry_price_usd = px;
      existing.entry_price_eur = newEntryEur;
      existing.notional_eur    = +(newQty * newEntryEur).toFixed(4);
      existing.mark_price_usd  = px;
      existing.mark_price_eur  = newEntryEur;
      if (!isPartial) delete existing.partial_fill;  // fully filled: clear partial marker

      state.booked_fills[cid] = filledQty;
      mutated = true;
      summary.booked_open_delta += 1;

      appendLedger({
        ts: nowIso(), event: 'open_delta', source: 'broker_fill', run_id: runId,
        order_id: cid, broker_order_id: rec.broker_order_id ?? null,
        symbol: sym, side,
        delta_qty: +deltaQty.toFixed(8), quantity: newQty,
        vwap_entry_eur: newEntryEur, notional_eur: existing.notional_eur, fee_eur: 0,
        partial: isPartial,
      });
      auditLog('broker_fill_booked_open_delta', {
        client_order_id: cid, symbol: sym, side,
        delta_qty: +deltaQty.toFixed(8), new_qty: newQty,
        vwap_entry_eur: newEntryEur, partial: isPartial, run_id: runId,
      });
      continue;
    }

    // ── CLOSE: delta-based (handles both PARTIALLY_FILLED and FILLED close fills) ─
    if (!existing)                              { skip(cid, 'close_without_open_position', sym); continue; }
    if (!Number.isFinite(existing.entry_price_eur)) { skip(cid, 'open_position_missing_entry', sym); continue; }

    // deltaQty already computed above (filledQty − bookedQty); guard: must not exceed remaining qty
    if (deltaQty > existing.quantity + QTY_TOL) { skip(cid, 'close_would_exceed_position', sym); continue; }

    const closeDelta     = +deltaQty.toFixed(8);
    const deltaRealized  = +(dirFactor(side) * closeDelta * (fillEur - existing.entry_price_eur)).toFixed(4);
    const remainingQty   = +(existing.quantity - closeDelta).toFixed(8);
    const isFullClose    = remainingQty < QTY_TOL;

    // Accumulate total position realized (for correct win/loss determination at final close)
    existing.partial_realized_eur = +((existing.partial_realized_eur ?? 0) + deltaRealized).toFixed(4);

    state.realized_pnl = +(state.realized_pnl + deltaRealized).toFixed(4);
    const cs = state.closed_positions_summary;
    cs.realized_pnl_total = +(cs.realized_pnl_total + deltaRealized).toFixed(4);

    if (isFullClose) {
      // Final close (position reaches zero): record win/loss based on cumulative position PnL
      cs.count += 1;
      if (existing.partial_realized_eur >= 0) cs.wins += 1; else cs.losses += 1;
      state.open_positions = state.open_positions.filter(p => !(p.symbol === sym && p.side === side));
    } else {
      // Partial close: reduce position qty + update notional to remaining entry capital,
      // and update mark to latest fill price.
      // notional_eur must reflect remaining qty so recompute() derives cash correctly.
      existing.quantity     = remainingQty;
      existing.notional_eur = +(remainingQty * existing.entry_price_eur).toFixed(4);
      existing.mark_price_usd = px;
      existing.mark_price_eur = fillEur;
    }

    state.booked_fills[cid] = filledQty;
    mutated = true;
    if (isFullClose) summary.booked_close += 1;
    else             summary.booked_partial_close += 1;

    appendLedger({
      ts: nowIso(), event: isFullClose ? 'close' : 'partial_close', source: 'broker_fill', run_id: runId,
      order_id: cid, broker_order_id: rec.broker_order_id ?? null,
      symbol: sym, side,
      delta_qty: closeDelta, quantity: remainingQty,
      entry_price_eur: existing.entry_price_eur, close_price_eur: +fillEur.toFixed(6),
      delta_realized_eur: deltaRealized, fee_eur: 0, partial: !isFullClose,
      reason: 'broker_fill_close', entry_run_id: existing.entry_run_id ?? null,
    });
    auditLog('broker_fill_booked_close', {
      client_order_id: cid, symbol: sym, side,
      delta_qty: closeDelta, delta_realized_eur: deltaRealized, full_close: isFullClose, run_id: runId,
    });
  }

  if (mutated) {
    recompute(state);
    state.last_updated_at = nowIso();
    if (runId) state.last_run_id = runId;
    save(state);
  }

  return summary;
}
