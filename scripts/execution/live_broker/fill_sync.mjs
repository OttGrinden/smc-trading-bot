/**
 * FillSync — book reconciled broker fills into the virtual portfolio (Phase 1, Unit 10.5).
 *
 * THE MISSING BRIDGE: the FillPoller/Reconciler advance BrokerOrderRecords to FILLED
 * and persist fills ON THE RECORD ONLY ("ABSOLUTELY no portfolio / cash / PnL / position
 * mutation"). This unit is the smallest safe reader that turns a fully FILLED record into
 * a consistent local portfolio state change — exactly once, idempotently.
 *
 *   for rec in OrderStore.listAll() where rec.state === FILLED:
 *     unbooked = rec.filled_qty − state.booked_fills[cid]
 *     if unbooked ≤ EPS                         → already booked (no-op)
 *     action='open'  + no existing position     → open position  (qty=filled_qty, entry=avg_fill_price→EUR)
 *     action='close' + matching open position   → close position (realize PnL at avg_fill_price→EUR)
 *     anything else / any inconsistency          → FAIL-CLOSED skip (+reason, +audit, NO mutation)
 *
 * SCOPE (Unit 10.5 ONLY) — deliberately tiny and additive:
 *   - reads broker truth from the existing OrderStore; never mutates an order record
 *   - books ONLY fully FILLED orders (partially_filled / non-terminal / cancelled /
 *     rejected / expired are skipped — never booked)
 *   - fresh opens only (no averaging into an existing symbol+side)
 *   - full closes only (close qty must match the open position qty)
 *   - idempotency watermark `state.booked_fills[client_order_id]` lives IN portfolio_state.json
 *     (atomic with the positions it guards); lazily initialised, no schema migration
 *
 * EXPLICITLY NOT in this unit: decision→order dispatch (10.6), autonomous loop (10.7),
 * account-based sizing/risk (10.8), broker-backed stop/bracket (10.9), live adapter,
 * fee/slippage modelling (Alpaca paper has no commission → fee_eur = 0), partial-fill
 * booking, position averaging, partial closes, and ANY modification of the poller,
 * reconciler, gateway, schemas, or the synchronous sim engine path.
 *
 * Safety: a corrupt store record propagates (fail-closed, same as the poller). Logical
 * inconsistencies are skipped with a reason and audited — never a partial mutation.
 */

import * as store        from './order_store.mjs';
import { ORDER_STATES }  from '../schemas.mjs';
import {
  loadOrInit, save, recompute, appendLedger, usdToEur,
} from '../portfolio/portfolio_state.mjs';
import { auditLog }      from '../audit_log.mjs';

const EPS     = 1e-9;
const QTY_TOL = 1e-6;   // close-qty match tolerance (positions carry up to 8 dp)

function nowIso() { return new Date().toISOString(); }

/** dir factor: +1 long, -1 short (local copy — no cross-module coupling). */
function dirFactor(side) { return side === 'short' ? -1 : 1; }

/**
 * syncFillsToPortfolio — one idempotent booking pass over FILLED broker records.
 *
 * Loads + saves portfolio state via the standard path resolution (respects test
 * overrides), reads order records via the OrderStore (respects its test override).
 * State is written to disk ONLY if at least one fill was booked.
 *
 * @param {object} opts — { run_id?: string }
 * @returns {object} summary { scanned, eligible, booked_open, booked_close,
 *                             already_booked, skipped, skips:[{cid,reason}] }
 * @throws {Error} only on a corrupt store record (fail-closed, propagated)
 */
export function syncFillsToPortfolio(opts = {}) {
  const runId = opts.run_id ?? null;
  const state = loadOrInit();
  if (state.booked_fills == null || typeof state.booked_fills !== 'object') state.booked_fills = {};
  if (!Array.isArray(state.open_positions)) state.open_positions = [];

  const summary = {
    scanned: 0, eligible: 0, booked_open: 0, booked_close: 0,
    already_booked: 0, skipped: 0, skips: [],
  };

  // Deterministic order so a batch books in a stable sequence.
  const records = store.listAll()   // throws on corrupt = fail-closed (propagate)
    .slice()
    .sort((a, b) => String(a.client_order_id).localeCompare(String(b.client_order_id)));

  let mutated = false;

  const skip = (cid, reason, symbol) => {
    summary.skipped += 1;
    summary.skips.push({ cid, reason });
    auditLog('portfolio_fill_book_skipped', { client_order_id: cid, reason, symbol: symbol ?? null, run_id: runId });
  };

  for (const rec of records) {
    summary.scanned += 1;

    // Only fully FILLED orders are bookable. Everything else is left untouched.
    if (rec.state !== ORDER_STATES.FILLED) continue;
    summary.eligible += 1;

    const cid       = rec.client_order_id;
    const filledQty = Number.isFinite(rec.filled_qty) ? rec.filled_qty : 0;
    const bookedQty = Number.isFinite(state.booked_fills[cid]) ? state.booked_fills[cid] : 0;

    // ── idempotency: already fully booked → no-op ──────────────────────────────
    if (filledQty - bookedQty <= EPS) { summary.already_booked += 1; continue; }

    // ── guards (fail-closed: skip + reason, never a partial mutation) ──────────
    const px = rec.avg_fill_price;
    if (!Number.isFinite(px) || px <= 0)        { skip(cid, 'missing_or_invalid_fill_price', rec.symbol); continue; }
    if (!Number.isFinite(filledQty) || filledQty <= 0) { skip(cid, 'non_positive_filled_qty', rec.symbol); continue; }
    const side = rec.side;
    if (side !== 'long' && side !== 'short')    { skip(cid, 'unknown_side', rec.symbol); continue; }
    const action = rec.action;
    if (action !== 'open' && action !== 'close'){ skip(cid, 'unknown_action', rec.symbol); continue; }
    const sym = rec.symbol;
    if (typeof sym !== 'string' || !sym)        { skip(cid, 'missing_symbol', rec.symbol); continue; }

    const fillEur  = +usdToEur(px).toFixed(6);
    const existing = state.open_positions.find(p => p.symbol === sym && p.side === side);

    // ── OPEN: fresh opens only ─────────────────────────────────────────────────
    if (action === 'open') {
      if (existing) { skip(cid, 'open_but_position_exists', sym); continue; }

      const qty = +filledQty.toFixed(8);
      const pos = {
        symbol:           sym,
        asset_type:       rec.asset_type ?? null,
        side,
        quantity:         qty,
        notional_eur:     +(qty * fillEur).toFixed(4),
        entry_price_usd:  px,
        entry_price_eur:  fillEur,
        mark_price_usd:   px,
        mark_price_eur:   fillEur,
        unrealized_pnl_eur: 0,
        stop_loss_pct:    null,          // broker record carries no SL; risk policy treats null fail-closed (10.8)
        leverage:         1,
        entry_timestamp:  rec.terminal_at ?? nowIso(),
        entry_run_id:     rec.run_id ?? runId,
        strategy:         'broker_fill',
        decision_source:  { decision_id: rec.decision_id ?? null, intent_id: rec.intent_id ?? null },
        order_id:         cid,
        broker_order_id:  rec.broker_order_id ?? null,
        booked_from:      'broker_fill',  // distinguishes live-booked from sim positions
        mark_source:      'broker_fill',
      };
      state.open_positions.push(pos);
      state.booked_fills[cid] = filledQty;
      mutated = true;
      summary.booked_open += 1;

      appendLedger({
        ts: nowIso(), event: 'open', source: 'broker_fill', run_id: runId,
        order_id: cid, broker_order_id: rec.broker_order_id ?? null,
        symbol: sym, side, quantity: qty,
        entry_price_eur: fillEur, notional_eur: pos.notional_eur, fee_eur: 0,
      });
      auditLog('portfolio_fill_booked_open', {
        client_order_id: cid, symbol: sym, side, quantity: qty,
        notional_eur: pos.notional_eur, entry_price_eur: fillEur, run_id: runId,
      });
      continue;
    }

    // ── CLOSE: full closes only (qty must match the open position) ─────────────
    if (!existing) { skip(cid, 'close_without_open_position', sym); continue; }
    if (Math.abs(existing.quantity - filledQty) > QTY_TOL) { skip(cid, 'close_qty_mismatch', sym); continue; }
    if (!Number.isFinite(existing.entry_price_eur))        { skip(cid, 'open_position_missing_entry', sym); continue; }

    const grossRealized = dirFactor(side) * existing.quantity * (fillEur - existing.entry_price_eur);
    const realized      = +grossRealized.toFixed(4);   // fee_eur = 0 (Alpaca paper)

    state.realized_pnl = +(state.realized_pnl + realized).toFixed(4);
    const cs = state.closed_positions_summary;
    cs.count += 1;
    cs.realized_pnl_total = +(cs.realized_pnl_total + realized).toFixed(4);
    if (realized >= 0) cs.wins += 1; else cs.losses += 1;

    state.open_positions = state.open_positions.filter(p => !(p.symbol === sym && p.side === side));
    state.booked_fills[cid] = filledQty;
    mutated = true;
    summary.booked_close += 1;

    appendLedger({
      ts: nowIso(), event: 'close', source: 'broker_fill', run_id: runId,
      order_id: cid, broker_order_id: rec.broker_order_id ?? null,
      symbol: sym, side, quantity: existing.quantity,
      entry_price_eur: existing.entry_price_eur, close_price_eur: +fillEur.toFixed(6),
      gross_realized_eur: +grossRealized.toFixed(4), fee_eur: 0, realized_pnl_eur: realized,
      reason: 'broker_fill_close', entry_run_id: existing.entry_run_id ?? null,
    });
    auditLog('portfolio_fill_booked_close', {
      client_order_id: cid, symbol: sym, side, realized_pnl_eur: realized, run_id: runId,
    });
  }

  // Persist ONLY when something was booked → an idempotent re-run is a true disk no-op.
  if (mutated) {
    recompute(state);
    state.last_updated_at = nowIso();
    if (runId) state.last_run_id = runId;
    save(state);
  }

  return summary;
}
