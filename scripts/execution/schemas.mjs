/**
 * Execution Architecture — Shared Schemas
 *
 * Machine-readable structures for the trade execution preparation layer.
 * Plain JS objects with factory functions — no runtime type enforcement.
 *
 * Phase: shadow mode only. No live orders. No broker connections.
 */

// ─── Order lifecycle states ──────────────────────────────────────────────────

export const ORDER_STATES = Object.freeze({
  CREATED:               'created',
  VALIDATED:             'validated',
  BLOCKED:               'blocked',
  APPROVED:              'approved',
  SENT:                  'sent',
  ACKNOWLEDGED:          'acknowledged',
  PARTIALLY_FILLED:      'partially_filled',
  FILLED:                'filled',
  REJECTED:              'rejected',
  CANCEL_PENDING:        'cancel_pending',
  CANCELLED:             'cancelled',
  FAILED_RECONCILIATION: 'failed_reconciliation',
  // ── Phase 1 (Alpaca paper, async write path) — ADDITIVE ONLY ───────────────
  // These extend the contract for the future write-capable broker. They are NOT
  // used by the synchronous sim/PaperBroker path (which keeps 'sent'). No flow
  // logic exists yet — Step 1 only defines the contract.
  PENDING_SUBMIT:        'pending_submit',   // idempotency anchor persisted before any broker IO
  SUBMITTED:             'submitted',        // POST accepted, broker_order_id assigned
  SUBMIT_UNKNOWN:        'submit_unknown',   // submit outcome unclear (timeout/network) — must reconcile
  REPLACE_PENDING:       'replace_pending',  // reserved (cancel-and-recreate; not exercised in Phase 1)
  REPLACED:              'replaced',         // terminal
  EXPIRED:               'expired',          // terminal (broker expired / done_for_day)
  RECONCILE_HOLD:        'reconcile_hold',   // divergence/unknown — order blocked until resolved
});

// Valid transitions: from → allowed next states.
// Phase 1 additions are strictly additive: existing sim edges are preserved
// (created→validated→approved→sent→acknowledged→filled, *→cancel_pending→cancelled).
// New targets only widen existing states; they enable the async broker path and
// are never triggered by the sim path.
export const ORDER_TRANSITIONS = Object.freeze({
  created:               ['validated', 'blocked', 'cancelled'],
  validated:             ['approved', 'blocked', 'cancel_pending'],
  blocked:               [],
  approved:              ['sent', 'cancel_pending', 'pending_submit'],                                  // +pending_submit (live branch)
  sent:                  ['acknowledged', 'rejected', 'cancel_pending'],                                // sim path — unchanged
  acknowledged:          ['partially_filled', 'filled', 'cancel_pending', 'replace_pending', 'expired', 'reconcile_hold'],
  partially_filled:      ['filled', 'cancel_pending', 'replace_pending', 'expired', 'reconcile_hold'],
  filled:                ['failed_reconciliation'],
  rejected:              [],
  cancel_pending:        ['cancelled', 'filled', 'partially_filled', 'reconcile_hold'],                 // +race outcomes
  cancelled:             [],
  failed_reconciliation: [],
  // ── Phase 1 additive states ────────────────────────────────────────────────
  pending_submit:        ['submitted', 'submit_unknown', 'rejected'],
  submitted:             ['acknowledged', 'partially_filled', 'filled', 'rejected', 'expired', 'cancel_pending', 'reconcile_hold'],
  submit_unknown:        ['submitted', 'partially_filled', 'filled', 'cancelled', 'rejected', 'expired', 'pending_submit'],
  replace_pending:       ['replaced', 'filled', 'cancelled', 'reconcile_hold'],
  replaced:              [],
  expired:               [],
  reconcile_hold:        ['submitted', 'acknowledged', 'partially_filled', 'filled', 'cancelled', 'rejected', 'expired'],
});

// ─── Enum-like constants ─────────────────────────────────────────────────────

export const TECHNICAL_ALIGNMENT = Object.freeze({
  CONFIRMED:   'confirmed',    // RSI + MACD both support direction
  PARTIAL:     'partial',      // one indicator confirms, other neutral
  CONFLICTED:  'conflicted',   // indicators oppose direction
  NEUTRAL:     'neutral',      // indicators in mid-range, no signal
  UNAVAILABLE: 'unavailable',  // no technical data in cache
});

export const RISK_TIERS = Object.freeze({
  A: 'A',  // LOW risk — full position size eligible
  B: 'B',  // MEDIUM risk — reduced position size
  C: 'C',  // HIGH risk — minimal size, strict gates
  D: 'D',  // EXTREME risk — never execution-ready
});

export const RISK_LEVEL_TO_TIER = Object.freeze({
  LOW:     'A',
  MEDIUM:  'B',
  HIGH:    'C',
  EXTREME: 'D',
});

export const EXECUTION_MODES = Object.freeze({
  SHADOW: 'shadow',  // observe only, no orders placed
  PAPER:  'paper',   // paper orders to stub broker
  LIVE:   'live',    // real broker — NOT YET SUPPORTED
});

// ─── Factory functions ───────────────────────────────────────────────────────

/**
 * makeRiskCheck — single check result.
 * @param {string}  check       — unique check identifier
 * @param {boolean} passed
 * @param {string|null} reason  — required if failed
 * @param {boolean} placeholder — true = check uses stub data (passes unconditionally)
 */
export function makeRiskCheck(check, passed, reason = null, placeholder = false) {
  return Object.freeze({ check, passed, reason, placeholder });
}

/**
 * makeGateResult — aggregated gate decision from a list of checks.
 * Gate passes only if ALL checks pass.
 */
export function makeGateResult(checks) {
  const blocked_reasons    = checks.filter(c => !c.passed && c.reason).map(c => c.reason);
  const placeholder_checks = checks.filter(c => c.placeholder).map(c => c.check);
  return Object.freeze({
    gate_passed:        blocked_reasons.length === 0,
    blocked_reasons,
    placeholder_checks,
    checks,
  });
}

/**
 * makeTradeIntent — enriched candidate ready for the risk engine.
 * Merges base candidate fields with execution-layer fields.
 */
export function makeTradeIntent(candidate, executionFields) {
  return {
    // Base fields from research_run enriched output
    symbol:     candidate.symbol,
    category:   candidate.category,
    sector:     candidate.sector    ?? null,
    direction:  candidate.direction,
    change_pct: candidate.change_pct,
    price_usd:  candidate.price_usd,
    volume_usd: candidate.volume_usd,
    rank:       candidate.rank,
    score:      candidate.score,
    risk:         candidate.risk,
    technical:    candidate.technical,
    score_bounds: candidate.score_bounds ?? null,
    // Execution layer fields (provided by decision_engine)
    ...executionFields,
  };
}

/**
 * makeExecutionDecision — final approve/block decision.
 */
export function makeExecutionDecision(intentId, symbol, side, gateResult, metadata = {}) {
  return {
    decision_id:     `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    decided_at:      new Date().toISOString(),
    intent_id:       intentId,
    symbol,
    side,
    execution_ready: gateResult.gate_passed,
    blocked_reasons: gateResult.blocked_reasons,
    gate_result:     gateResult,
    ...metadata,
  };
}

// ─── Broker order spec constants (Phase 1, naming frozen) ─────────────────────

export const ORDER_TYPES    = Object.freeze({ MARKET: 'market', LIMIT: 'limit', STOP: 'stop' });
export const TIME_IN_FORCE  = Object.freeze({ DAY: 'day', GTC: 'gtc' });
// Explicit buy/sell semantics — same strings the portfolio engine already emits
// (buy / sell / sell_short / buy_to_cover). Frozen here to prevent synonyms.
export const ORDER_ACTIONS  = Object.freeze(['buy', 'sell', 'sell_short', 'buy_to_cover']);

/**
 * makeBrokerOrderRecord — factory for the async broker-execution record (Phase 1).
 *
 * Pure schema/contract preparation: NO broker IO, NO submit/poll/reconcile logic,
 * NO portfolio mutation. Later steps (gateway/poller/reconciler) drive this record
 * through ORDER_TRANSITIONS. `client_order_id` is the durable idempotency anchor
 * and is REQUIRED (fail-closed). Record starts in state CREATED (local DRAFT);
 * the gateway persists the anchor and sets PENDING_SUBMIT in a later step.
 *
 * @param {object} intent   — TradeIntent (may be partial; opts can override)
 * @param {object} decision — ExecutionDecision (for provenance)
 * @param {object} opts     — { client_order_id (required), run_id, action, order_action,
 *                              qty, order_type, time_in_force, limit_price, stop_price, replaces_cid, ... }
 * @returns {object} broker order record
 * @throws  {Error}  on missing client_order_id or invalid qty/order_type/time_in_force/order_action
 */
export function makeBrokerOrderRecord(intent = {}, decision = {}, opts = {}) {
  const clientOrderId = opts.client_order_id;
  if (!clientOrderId || typeof clientOrderId !== 'string') {
    throw new Error('makeBrokerOrderRecord: client_order_id is required (idempotency anchor)');
  }
  const qty = opts.qty ?? null;
  if (qty != null && (!Number.isFinite(qty) || qty <= 0)) {
    throw new Error(`makeBrokerOrderRecord: qty must be a positive finite number (got ${qty})`);
  }
  const orderType = opts.order_type ?? ORDER_TYPES.MARKET;
  if (!Object.values(ORDER_TYPES).includes(orderType)) {
    throw new Error(`makeBrokerOrderRecord: invalid order_type "${orderType}"`);
  }
  const tif = opts.time_in_force ?? TIME_IN_FORCE.DAY;
  if (!Object.values(TIME_IN_FORCE).includes(tif)) {
    throw new Error(`makeBrokerOrderRecord: invalid time_in_force "${tif}"`);
  }
  if (opts.order_action != null && !ORDER_ACTIONS.includes(opts.order_action)) {
    throw new Error(`makeBrokerOrderRecord: invalid order_action "${opts.order_action}"`);
  }
  const now = new Date().toISOString();
  return {
    schema_version:          1,
    client_order_id:         clientOrderId,   // idempotency anchor (canonical key)
    broker_order_id:         null,
    // provenance
    intent_id:               intent?.intent_id   ?? null,
    decision_id:             decision?.decision_id ?? null,
    run_id:                  opts.run_id ?? null,
    // instrument / order spec
    symbol:                  intent?.symbol     ?? opts.symbol ?? null,
    side:                    intent?.side       ?? opts.side   ?? null,
    action:                  opts.action        ?? null,   // 'open' | 'close'
    order_action:            opts.order_action  ?? null,   // buy | sell | sell_short | buy_to_cover
    asset_type:              intent?.asset_type ?? opts.asset_type ?? null,
    order_type:              orderType,
    time_in_force:           tif,
    limit_price:             opts.limit_price ?? null,
    stop_price:              opts.stop_price ?? null,   // resting stop level (USD); set for order_type 'stop'
    price_usd:               opts.price_usd       ?? null,   // last-known entry price for TPSL calculation
    stop_loss_pct:           opts.stop_loss_pct   ?? null,
    take_profit_pct:         opts.take_profit_pct ?? null,
    // quantities / fills
    qty,
    filled_qty:              0,
    remaining_qty:           qty,
    avg_fill_price:          null,
    fills:                   [],
    last_applied_filled_qty: 0,              // portfolio fill-idempotency basis (delta accounting)
    // lifecycle
    state:                   ORDER_STATES.CREATED,
    broker_status:           null,
    broker:                  'alpaca_paper',
    attempt_count:           0,
    idempotency_status:      'not_submitted',
    // replace linkage (reserved; cancel-and-recreate only in later steps)
    replaces_cid:            opts.replaces_cid ?? null,
    replaced_by_cid:         null,
    // diagnostics
    error:                   null,
    reconcile_flag:          null,
    events:                  [],
    // timestamps
    created_at:              now,
    anchor_persisted_at:     null,
    submitted_at:            null,
    last_poll_at:            null,
    terminal_at:             null,
  };
}

/**
 * makePaperOrder — skeleton order for the paper broker.
 */
export function makePaperOrder(intent, decision) {
  return {
    order_id:      `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    created_at:    new Date().toISOString(),
    state:         ORDER_STATES.CREATED,
    intent_id:     intent.intent_id,
    decision_id:   decision.decision_id,
    symbol:        intent.symbol,
    side:          intent.side,
    asset_type:    intent.asset_type,
    quantity:      null,   // set when account value is known
    limit_price:   intent.price_usd,
    stop_loss_pct: intent.risk?.stop_loss_pct         ?? null,
    position_pct:  intent.risk?.suggested_position_pct ?? null,
    broker:        'paper',
    mode:          EXECUTION_MODES.PAPER,
    fills:         [],
    events:        [],
  };
}
