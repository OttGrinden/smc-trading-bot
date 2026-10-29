/**
 * BrokerFillReconcile — Unit 29: read-only reconciliation of broker fills vs. local portfolio.
 *
 * Compares confirmed broker fill state (OrderStore records) against local portfolio bookings
 * (booked_fills watermark + open_positions) and produces a structured report:
 *
 *   reconciled  — record and portfolio are consistent (fill qty matches booking, position state correct)
 *   mismatch    — clear inconsistency that requires operator attention or a booking pass
 *   unresolved  — ambiguous state (orphan bookings, unknown action) that cannot be auto-resolved
 *
 * ZERO writes. ZERO mutations. Purely read-only.
 *
 * Checks performed (in order):
 *   1. Non-bookable record with existing booking → mismatch:booking_on_non_bookable_state
 *   2. Broker filled_qty > booked_qty            → mismatch:fill_not_yet_booked
 *   3. booked_qty > broker filled_qty            → mismatch:overbooked (indicates bug)
 *   4. FILLED + open + fully booked:
 *        position not found + no close record    → mismatch:open_position_not_found
 *        position qty > booked_qty               → mismatch:position_qty_exceeds_booked
 *   5. FILLED + close + fully booked:
 *        position still exists                   → mismatch:position_not_closed
 *   6. booked_fills entry without store record   → unresolved:orphan_booking
 *
 * Injectable for offline tests:
 *   opts._listAll(...)   — replaces store.listAll
 *   opts._loadState(...) — replaces portfolio_state.loadOrInit
 */

import * as store        from './order_store.mjs';
import { ORDER_STATES }  from '../schemas.mjs';
import { loadOrInit }    from '../portfolio/portfolio_state.mjs';

const EPS     = 1e-9;
const QTY_TOL = 1e-6;

const BOOKABLE_STATES = new Set([ORDER_STATES.FILLED, ORDER_STATES.PARTIALLY_FILLED]);

/**
 * reconcileBrokerFills — compare broker fill state against local portfolio bookings.
 *
 * @param {object} opts
 * @param {Function} [opts._listAll]    — injectable: replaces store.listAll (no args)
 * @param {Function} [opts._loadState]  — injectable: replaces loadOrInit (no args)
 * @returns {object} report {
 *   generated_at, scanned_records, positions_checked,
 *   reconciled_count, mismatch_count, unresolved_count,
 *   reconciled: [...], mismatch: [...], unresolved: [...]
 * }
 * @throws {Error} on corrupt store or state (fail-closed, propagated)
 */
export function reconcileBrokerFills(opts = {}) {
  const doListAll   = typeof opts._listAll   === 'function' ? opts._listAll   : () => store.listAll();
  const doLoadState = typeof opts._loadState === 'function' ? opts._loadState : loadOrInit;

  let records, state;
  try { records = doListAll(); }
  catch (e) { throw new Error(`reconcileBrokerFills: store read failed (fail-closed): ${e.message}`); }
  try { state = doLoadState(); }
  catch (e) { throw new Error(`reconcileBrokerFills: state read failed (fail-closed): ${e.message}`); }

  const bookedFills = (state.booked_fills != null && typeof state.booked_fills === 'object')
    ? state.booked_fills : {};
  const positions   = Array.isArray(state.open_positions) ? state.open_positions : [];

  const reconciled = [];
  const mismatch   = [];
  const unresolved = [];
  let positionsChecked = 0;

  const seenCids = new Set();

  for (const rec of records) {
    const cid = rec.client_order_id;
    if (typeof cid !== 'string' || !cid) continue;
    seenCids.add(cid);

    const sym       = rec.symbol ?? null;
    const side      = rec.side ?? null;
    const action    = rec.action ?? null;
    const brokerQty = Number.isFinite(rec.filled_qty) ? rec.filled_qty : 0;
    const bookedQty = Number.isFinite(bookedFills[cid]) ? bookedFills[cid] : 0;
    const recState  = rec.state;

    // ── Non-bookable records ────────────────────────────────────────────────────
    if (!BOOKABLE_STATES.has(recState)) {
      if (bookedQty > EPS) {
        // Booking exists for a record that is no longer bookable (shouldn't happen)
        mismatch.push({
          cid, symbol: sym, side, action, rec_state: recState,
          reason: 'booking_on_non_bookable_state',
          booked_qty: bookedQty,
          detail: `booked ${bookedQty} but record state "${recState}" is not bookable`,
        });
      }
      continue;
    }

    // ── Fill-quantity alignment ─────────────────────────────────────────────────
    const lag = brokerQty - bookedQty;

    if (lag > EPS) {
      // Broker has filled more than we have booked → run bookBrokerFills to catch up
      mismatch.push({
        cid, symbol: sym, side, action, rec_state: recState,
        reason: 'fill_not_yet_booked',
        broker_filled_qty: brokerQty, booked_qty: bookedQty,
        unfilled_delta: +(lag).toFixed(8),
        detail: `broker fill ${brokerQty} is ahead of local booking ${bookedQty}`,
      });
      continue;
    }

    if (-lag > EPS) {
      // We booked MORE than broker confirms — indicates a bug in booking logic
      mismatch.push({
        cid, symbol: sym, side, action, rec_state: recState,
        reason: 'overbooked',
        broker_filled_qty: brokerQty, booked_qty: bookedQty,
        detail: `local booking ${bookedQty} exceeds broker fill ${brokerQty}`,
      });
      continue;
    }

    // bookedQty === brokerQty (within EPS)
    if (bookedQty <= EPS) {
      // Nothing filled, nothing booked: consistent pre-fill state
      reconciled.push({ cid, symbol: sym, side, action, rec_state: recState,
        booked_qty: 0, note: 'no_fill_yet' });
      continue;
    }

    // ── Position consistency for terminal FILLED records ────────────────────────
    if (recState === ORDER_STATES.FILLED) {
      positionsChecked += 1;

      if (action === 'open') {
        const pos = positions.find(p => p.symbol === sym && p.side === side && p.order_id === cid);

        if (!pos) {
          // Position not found: acceptable only if a close record has been booked for this symbol+side
          const hasBookedClose = records.some(r =>
            r.symbol === sym && r.side === side && r.action === 'close' &&
            BOOKABLE_STATES.has(r.state) &&
            (Number.isFinite(bookedFills[r.client_order_id]) && bookedFills[r.client_order_id] > EPS)
          );
          if (!hasBookedClose) {
            mismatch.push({ cid, symbol: sym, side, action, rec_state: recState,
              reason: 'open_position_not_found', booked_qty: bookedQty,
              detail: 'fully booked open but no position found and no close record present' });
            continue;
          }
          reconciled.push({ cid, symbol: sym, side, action, rec_state: recState,
            booked_qty: bookedQty, note: 'position_subsequently_closed' });
          continue;
        }

        // Position exists; its qty should be ≤ booked_qty (close fills may have reduced it)
        if (pos.quantity > bookedQty + QTY_TOL) {
          mismatch.push({ cid, symbol: sym, side, action, rec_state: recState,
            reason: 'position_qty_exceeds_booked', booked_qty: bookedQty, actual_qty: pos.quantity,
            detail: `position qty ${pos.quantity} exceeds booked open qty ${bookedQty}` });
          continue;
        }
        reconciled.push({ cid, symbol: sym, side, action, rec_state: recState,
          booked_qty: bookedQty, actual_position_qty: pos.quantity, note: 'ok' });
        continue;
      }

      if (action === 'close') {
        const pos = positions.find(p => p.symbol === sym && p.side === side);
        if (pos) {
          // Fully booked close but position still exists
          mismatch.push({ cid, symbol: sym, side, action, rec_state: recState,
            reason: 'position_not_closed', booked_qty: bookedQty, actual_qty: pos.quantity,
            detail: 'fully booked close but position still exists' });
          continue;
        }
        reconciled.push({ cid, symbol: sym, side, action, rec_state: recState,
          booked_qty: bookedQty, note: 'position_closed' });
        continue;
      }
    }

    // ── PARTIALLY_FILLED with aligned bookings: intermediate, reconciled ────────
    if (recState === ORDER_STATES.PARTIALLY_FILLED) {
      positionsChecked += 1;
      reconciled.push({ cid, symbol: sym, side, action, rec_state: recState,
        booked_qty: bookedQty, broker_filled_qty: brokerQty, note: 'partial_fill_in_progress' });
      continue;
    }

    // Unknown action / state combination
    unresolved.push({ cid, symbol: sym, side, action, rec_state: recState,
      reason: 'unrecognized_record', detail: `state="${recState}" action="${action}" not handled` });
  }

  // ── Orphan bookings: booked_fills entry with no corresponding OrderStore record ─
  for (const [cid, bookedQty] of Object.entries(bookedFills)) {
    if (!seenCids.has(cid) && Number.isFinite(bookedQty) && bookedQty > EPS) {
      unresolved.push({ cid, booked_qty: bookedQty, reason: 'orphan_booking',
        detail: 'record not in OrderStore but booking remains (record may have been cleaned up)' });
    }
  }

  return {
    generated_at:      new Date().toISOString(),
    scanned_records:   records.length,
    positions_checked: positionsChecked,
    reconciled_count:  reconciled.length,
    mismatch_count:    mismatch.length,
    unresolved_count:  unresolved.length,
    reconciled,
    mismatch,
    unresolved,
  };
}
