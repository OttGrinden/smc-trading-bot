/**
 * Paper Broker Stub
 *
 * Implements the same interface shape as a future real broker adapter.
 * NO external connections. Orders are persisted to the local filesystem.
 *
 * Interface (matches future live broker adapter):
 *   getQuote(symbol)                              → stub price snapshot
 *   getPositions()                                → list of open positions
 *   getAccount()                                  → account summary
 *   placeOrder(intent, decision, opts)            → create + persist a paper order
 *   fillOrder(order, fillPriceUsd, opts, cfg)     → drive order to filled/partially_filled
 *   cancelOrder(orderId)                          → transition to cancel_pending → cancelled
 *   getOrder(orderId)                             → load order from file
 *
 * fillOrder — execution realism (Phase 3b):
 *   Pass a realismConfig (from parseRealismConfig) as the 4th argument to activate
 *   slippage, fees, and partial fills. Omit (or pass null) for the original
 *   immediate-full-fill behavior — backward compatible.
 *
 * Orders are stored as individual JSON files:
 *   trading/execution/orders/{order_id}.json
 *
 * Usage (module): import { PaperBroker } from './paper_broker.mjs'
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { join }                from 'path';
import { makePaperOrder, ORDER_STATES }          from './schemas.mjs';
import { transition }                            from './order_state.mjs';
import { auditLog }                              from './audit_log.mjs';
import { realismEnabled }                        from './realism_config.mjs';
import { buildFillDetails }                      from './fill_model.mjs';
import { EUR_USD_RATE }                          from './portfolio/portfolio_state.mjs';

const ORDERS_DIR        = 'C:\\Users\\rapha\\.claude\\trading\\execution\\orders';
const ORDER_EVENTS_LOG  = join(ORDERS_DIR, 'order_events.jsonl');

// Stub account — replace with real account object when live
const STUB_ACCOUNT = Object.freeze({
  account_id:       'paper_account_001',
  broker:           'paper',
  mode:             'paper',
  currency:         'USD',
  cash_available:   10_000,
  total_value:      10_000,
  buying_power:     10_000,
  positions_value:  0,
  timestamp:        null,       // filled at call time
});

// ─── Persistence helpers ─────────────────────────────────────────────────────

function orderPath(orderId) {
  return join(ORDERS_DIR, `${orderId}.json`);
}

function saveOrder(order) {
  mkdirSync(ORDERS_DIR, { recursive: true });
  writeFileSync(orderPath(order.order_id), JSON.stringify(order, null, 2) + '\n', 'utf8');
}

function loadOrder(orderId) {
  const path = orderPath(orderId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Append-only consolidated lifecycle log across all orders
function appendOrderEvent(entry) {
  mkdirSync(ORDERS_DIR, { recursive: true });
  appendFileSync(ORDER_EVENTS_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}

// ─── PaperBroker ─────────────────────────────────────────────────────────────

export class PaperBroker {
  constructor() {
    this.mode = 'paper';
  }

  /**
   * getQuote — return a stub price snapshot.
   * When live: fetches real-time bid/ask from broker.
   */
  getQuote(symbol) {
    const quote = {
      symbol,
      price:     null,
      bid:       null,   // PLACEHOLDER — requires live feed
      ask:       null,
      spread:    null,
      timestamp: new Date().toISOString(),
      source:    'paper_stub',
    };
    process.stderr.write(JSON.stringify({ info: 'paper_broker_get_quote', symbol, source: 'stub' }) + '\n');
    return quote;
  }

  /**
   * getPositions — return current open positions derived from non-terminal order files.
   * When live: fetches from broker's position API.
   */
  getPositions() {
    try {
      const files  = readdirSync(ORDERS_DIR).filter(f => f.endsWith('.json'));
      const orders = files.map(f => JSON.parse(readFileSync(join(ORDERS_DIR, f), 'utf8')));
      return orders
        .filter(o => o.state === ORDER_STATES.FILLED || o.state === ORDER_STATES.PARTIALLY_FILLED)
        .map(o => ({
          symbol:   o.symbol,
          side:     o.side,
          quantity: o.quantity,
          mode:     o.mode,
          order_id: o.order_id,
        }));
    } catch {
      return [];
    }
  }

  /**
   * getAccount — return account summary.
   * When live: fetches from broker's account API.
   */
  getAccount() {
    return { ...STUB_ACCOUNT, timestamp: new Date().toISOString() };
  }

  /**
   * placeOrder — create and persist a paper order.
   * Does NOT submit to any real broker.
   *
   * @param {object} intent    — TradeIntent (from decision_engine)
   * @param {object} decision  — ExecutionDecision (approved gate result)
   * @param {object} opts      — { action, order_action, quantity, notional_eur, close_reason, run_id }
   * @returns {object}         — paper order (state=approved)
   */
  placeOrder(intent, decision, opts = {}) {
    if (!decision.execution_ready) {
      throw new Error(`placeOrder called on blocked intent: ${intent.intent_id} — ${decision.blocked_reasons.join(', ')}`);
    }

    const order = makePaperOrder(intent, decision);

    if (opts.action)        order.action        = opts.action;
    if (opts.order_action)  order.order_action  = opts.order_action;
    if (opts.quantity != null)     order.quantity     = opts.quantity;
    if (opts.notional_eur != null) order.notional_eur = opts.notional_eur;
    if (opts.close_reason)  order.close_reason  = opts.close_reason;
    if (opts.run_id)        order.run_id        = opts.run_id;

    // Phase 3b: initialize fill-tracking fields on every order (populated by fillOrder)
    order.ordered_quantity   = opts.quantity ?? null;
    order.filled_quantity    = 0;
    order.remaining_quantity = opts.quantity ?? null;
    order.fee_eur            = 0;
    order.realism_details    = null;

    transition(order, ORDER_STATES.VALIDATED, { reason: 'paper_auto_validate' });
    transition(order, ORDER_STATES.APPROVED,  { reason: 'paper_auto_approve' });

    saveOrder(order);

    auditLog('paper_order_created', {
      order_id:     order.order_id,
      symbol:       order.symbol,
      side:         order.side,
      action:       order.action ?? null,
      order_action: order.order_action ?? null,
      intent_id:    intent.intent_id,
      decision_id:  decision.decision_id,
    });
    appendOrderEvent({
      event:        'paper_order_created',
      order_id:     order.order_id,
      symbol:       order.symbol,
      side:         order.side,
      action:       order.action ?? null,
      run_id:       order.run_id ?? null,
    });

    process.stderr.write(JSON.stringify({
      info:       'paper_order_created',
      order_id:   order.order_id,
      symbol:     order.symbol,
      side:       order.side,
      action:     order.action ?? null,
      state:      order.state,
    }) + '\n');

    return order;
  }

  /**
   * fillOrder — drive an APPROVED or PARTIALLY_FILLED order toward FILLED.
   *
   * ── Without realism (realismConfig=null or realism_mode='off') ──────────────
   *   Identical to pre-Phase-3b behavior:
   *   approved → sent → acknowledged → filled (immediate, full, no cost)
   *   Rejection path: invalid fillPriceUsd → sent → rejected (no portfolio mutation).
   *
   * ── With realism (realism_mode='on') ────────────────────────────────────────
   *   Slippage: effective fill price = refPrice × (1 ± slippage_bps/10 000)
   *     buy/buy_to_cover → price worsens UPWARD
   *     sell/sell_short  → price worsens DOWNWARD
   *
   *   Fee: charged on gross notional of the FULL ordered quantity at the reference
   *   price. Applied on the FIRST fill cycle only. Fee = max(notional×bps, min_eur).
   *
   *   Partial fills (partial_fill_mode='on', max_fill_fraction_per_cycle < 1.0):
   *     First call (order.state=approved):
   *       fills fraction → approved → sent → acknowledged → partially_filled
   *       order.filled_quantity   = ordered_qty × fraction
   *       order.remaining_quantity = ordered_qty × (1 − fraction)
   *       fee charged on full ordered_qty (not just fraction)
   *     Second call (order.state=partially_filled):
   *       completes fill → partially_filled → filled
   *       order.filled_quantity   = ordered_qty
   *       order.remaining_quantity = 0
   *       NO additional fee (already charged on cycle 1)
   *       NO slippage re-applied (uses effective_price from cycle 1)
   *
   * @param {object}      order        — order from placeOrder (state=approved or partially_filled)
   * @param {number}      fillPriceUsd — reference fill price in USD
   * @param {object}      opts         — { quantity?, reason? }
   * @param {object|null} realismConfig — from parseRealismConfig(), or null for legacy behavior
   * @returns {object}                 — order (state=filled, partially_filled, or rejected)
   */
  fillOrder(order, fillPriceUsd, opts = {}, realismConfig = null) {
    const isApproved  = order.state === ORDER_STATES.APPROVED;
    const isPartial   = order.state === ORDER_STATES.PARTIALLY_FILLED;

    if (!isApproved && !isPartial) {
      throw new Error(
        `fillOrder requires an approved or partially_filled order, ` +
        `got state=${order.state} (order_id=${order.order_id})`
      );
    }

    // ── Rejection path: invalid fill price ────────────────────────────────────
    // Check before any transitions so state remains clean.
    if (fillPriceUsd == null || !Number.isFinite(fillPriceUsd) || fillPriceUsd <= 0) {
      if (isApproved) {
        transition(order, ORDER_STATES.SENT,     { reason: opts.reason ?? 'paper_route' });
        transition(order, ORDER_STATES.REJECTED,  { reason: 'invalid_fill_price', fill_price_usd: fillPriceUsd ?? null });
      }
      // partially_filled orders with invalid price are left as-is (no transition)
      saveOrder(order);
      auditLog('paper_order_rejected', { order_id: order.order_id, symbol: order.symbol, reason: 'invalid_fill_price' });
      appendOrderEvent({ event: 'paper_order_rejected', order_id: order.order_id, symbol: order.symbol, reason: 'invalid_fill_price', run_id: order.run_id ?? null });
      return order;
    }

    const now          = new Date().toISOString();
    const realism      = realismEnabled(realismConfig);
    const orderedQty   = opts.quantity ?? order.ordered_quantity ?? order.quantity;
    const orderAction  = order.order_action ?? 'buy';

    // ── SECOND CYCLE: complete a partial fill ─────────────────────────────────
    // Effective price is already stored on the order from cycle 1 (no re-slippage, no re-fee).
    if (isPartial) {
      const completionQty      = order.remaining_quantity ?? 0;
      const effectivePriceUsd  = order.filled_price_usd ?? fillPriceUsd;

      order.filled_quantity    = +(order.ordered_quantity ?? orderedQty);
      order.remaining_quantity = 0;

      order.fills.push({
        ts:            now,
        price_usd:     effectivePriceUsd,
        quantity:      completionQty,
        model:         'deterministic_partial',
        cycle:         2,
        fee_eur:       0,   // fee charged on cycle 1 only
      });

      transition(order, ORDER_STATES.FILLED, {
        reason:           'partial_fill_cycle_2_complete',
        completion_qty:   completionQty,
        fill_price_usd:   effectivePriceUsd,
      });

      saveOrder(order);
      auditLog('paper_order_filled', {
        order_id:        order.order_id, symbol: order.symbol, side: order.side,
        action:          order.action ?? null, fill_price_usd: effectivePriceUsd,
        quantity:        completionQty, cycle: 2, partial_completion: true,
      });
      appendOrderEvent({
        event:           'paper_order_filled',
        order_id:        order.order_id, symbol: order.symbol, side: order.side,
        action:          order.action ?? null, fill_price_usd: effectivePriceUsd,
        quantity:        completionQty, run_id: order.run_id ?? null, cycle: 2,
      });
      return order;
    }

    // ── FIRST CYCLE (state=approved) ──────────────────────────────────────────

    // Build execution costs (slippage + fee) when realism is active.
    let effectivePriceUsd = fillPriceUsd;
    let fillDetails       = null;

    if (realism) {
      fillDetails       = buildFillDetails(fillPriceUsd, orderedQty, orderAction, realismConfig, EUR_USD_RATE);
      effectivePriceUsd = fillDetails.effective_fill_price_usd;
      order.fee_eur     = fillDetails.fee_eur;
      order.realism_details = fillDetails;
    }

    // Determine fill quantity: partial or full.
    const fraction  = (realism && realismConfig.partial_fill_mode === 'on')
      ? realismConfig.max_fill_fraction_per_cycle
      : 1.0;
    const isFirstPartial = fraction < 1.0;

    const fillQty      = isFirstPartial ? +( orderedQty * fraction ).toFixed(8) : orderedQty;
    const remainingQty = isFirstPartial ? +( orderedQty - fillQty  ).toFixed(8) : 0;

    // Store fill-tracking fields
    order.ordered_quantity   = orderedQty;
    order.filled_quantity    = fillQty;
    order.remaining_quantity = remainingQty;

    transition(order, ORDER_STATES.SENT,         { reason: opts.reason ?? 'paper_route' });
    transition(order, ORDER_STATES.ACKNOWLEDGED, { reason: 'paper_ack' });

    order.filled_price_usd = effectivePriceUsd;
    order.filled_at        = now;

    const fillRecord = {
      ts:            now,
      price_usd:     effectivePriceUsd,
      quantity:      fillQty,
      model:         isFirstPartial ? 'deterministic_partial' : 'deterministic_immediate',
      ...(isFirstPartial ? { cycle: 1, fill_fraction: fraction } : {}),
      ...(fillDetails   ? { fee_eur: fillDetails.fee_eur, slippage_amount_eur: fillDetails.slippage_amount_eur } : {}),
    };
    order.fills.push(fillRecord);

    // ── Partial fill: transition to partially_filled ──────────────────────────
    if (isFirstPartial) {
      transition(order, ORDER_STATES.PARTIALLY_FILLED, {
        reason:          'partial_fill_cycle_1',
        fill_qty:        fillQty,
        remaining_qty:   remainingQty,
        fill_fraction:   fraction,
        fill_price_usd:  effectivePriceUsd,
        ...(fillDetails  ? { fee_eur: fillDetails.fee_eur } : {}),
      });

      saveOrder(order);
      auditLog('paper_order_partial_fill', {
        order_id:       order.order_id, symbol: order.symbol, side: order.side,
        action:         order.action ?? null, fill_price_usd: effectivePriceUsd,
        fill_qty:       fillQty, remaining_qty: remainingQty, fill_fraction: fraction,
        fee_eur:        fillDetails?.fee_eur ?? 0,
      });
      appendOrderEvent({
        event:          'paper_order_partial_fill',
        order_id:       order.order_id, symbol: order.symbol, side: order.side,
        action:         order.action ?? null, fill_price_usd: effectivePriceUsd,
        fill_qty:       fillQty, remaining_qty: remainingQty,
        run_id:         order.run_id ?? null,
      });

      process.stderr.write(JSON.stringify({
        info:          'paper_order_partially_filled',
        order_id:      order.order_id, symbol: order.symbol,
        fill_qty:      fillQty, remaining_qty: remainingQty,
      }) + '\n');

      return order;
    }

    // ── Full fill: transition to filled ───────────────────────────────────────
    transition(order, ORDER_STATES.FILLED, {
      reason:          'paper_immediate_fill',
      fill_price_usd:  effectivePriceUsd,
      quantity:        fillQty,
      ...(fillDetails  ? { fee_eur: fillDetails.fee_eur, slippage_amount_eur: fillDetails.slippage_amount_eur } : {}),
    });

    saveOrder(order);
    auditLog('paper_order_filled', {
      order_id:         order.order_id, symbol: order.symbol, side: order.side,
      action:           order.action ?? null, fill_price_usd: effectivePriceUsd, quantity: fillQty,
      ...(fillDetails   ? { fee_eur: fillDetails.fee_eur, slippage_amount_eur: fillDetails.slippage_amount_eur } : {}),
    });
    appendOrderEvent({
      event:            'paper_order_filled',
      order_id:         order.order_id, symbol: order.symbol, side: order.side,
      action:           order.action ?? null, fill_price_usd: effectivePriceUsd, quantity: fillQty,
      run_id:           order.run_id ?? null,
    });

    return order;
  }

  /**
   * cancelOrder — request cancellation of a paper order.
   *
   * @param {string} orderId
   * @returns {object|null} — updated order, or null if not found
   */
  cancelOrder(orderId) {
    const order = loadOrder(orderId);
    if (!order) return null;

    if (order.state === ORDER_STATES.FILLED || order.state === ORDER_STATES.CANCELLED) {
      throw new Error(`Cannot cancel order in terminal state: ${order.state} (order_id=${orderId})`);
    }

    transition(order, ORDER_STATES.CANCEL_PENDING, { reason: 'manual_cancel' });
    transition(order, ORDER_STATES.CANCELLED,      { reason: 'paper_immediate_cancel' });
    saveOrder(order);

    return order;
  }

  /**
   * getOrder — load a paper order by ID.
   *
   * @param {string} orderId
   * @returns {object|null}
   */
  getOrder(orderId) {
    return loadOrder(orderId);
  }

  /**
   * partialClose — compute PnL for a fractional close of a position.
   *
   * Does NOT write to portfolio state (portfolio_engine.mjs handles that).
   * Does NOT transition any order (caller uses placeOrder+fillOrder for the actual fill).
   * This is a pure calculation helper used for observability and ledger preparation.
   *
   * @param {object} position             — open position object (from portfolio_state)
   * @param {number} closeQuantityFraction — fraction of position.quantity to close (0 < x <= 1)
   * @param {number} markPriceUsd         — current mark price in USD
   * @param {string} reason               — 'partial_tp1_hit' | 'partial_tp2_hit' | other
   * @returns {object}                    — partial-close result (NO state mutation)
   *   {
   *     symbol, side, reason,
   *     close_quantity, remain_quantity,
   *     entry_price_eur, close_price_usd, close_price_eur,
   *     gross_realized_eur, realized_pnl_eur,
   *     notional_closed_eur, notional_remain_eur,
   *   }
   */
  partialClose(position, closeQuantityFraction, markPriceUsd, reason) {
    if (closeQuantityFraction <= 0 || closeQuantityFraction > 1) {
      throw new Error(`partialClose: closeQuantityFraction must be in (0, 1], got ${closeQuantityFraction}`);
    }
    if (!Number.isFinite(markPriceUsd) || markPriceUsd <= 0) {
      throw new Error(`partialClose: markPriceUsd must be a positive finite number, got ${markPriceUsd}`);
    }

    const closePriceEur   = markPriceUsd / EUR_USD_RATE;
    const closeQty        = +(position.quantity * closeQuantityFraction).toFixed(8);
    const remainQty       = +(position.quantity - closeQty).toFixed(8);
    const dirF            = position.side === 'long' ? 1 : -1;
    const grossRealized   = +(dirF * closeQty * (closePriceEur - position.entry_price_eur)).toFixed(4);
    const notionalClosed  = +(closeQty   * position.entry_price_eur).toFixed(4);
    const notionalRemain  = +(remainQty  * position.entry_price_eur).toFixed(4);

    process.stderr.write(JSON.stringify({
      info:           'paper_broker_partial_close_calc',
      symbol:         position.symbol,
      side:           position.side,
      reason,
      close_quantity: closeQty,
      remain_quantity: remainQty,
      gross_realized_eur: grossRealized,
      mark_usd:       markPriceUsd,
    }) + '\n');

    return {
      symbol:              position.symbol,
      side:                position.side,
      reason,
      close_quantity:      closeQty,
      remain_quantity:     remainQty,
      entry_price_eur:     position.entry_price_eur,
      close_price_usd:     markPriceUsd,
      close_price_eur:     +closePriceEur.toFixed(6),
      gross_realized_eur:  grossRealized,
      realized_pnl_eur:    grossRealized,   // no fee in this helper; caller adds fee if needed
      notional_closed_eur: notionalClosed,
      notional_remain_eur: notionalRemain,
    };
  }
}
