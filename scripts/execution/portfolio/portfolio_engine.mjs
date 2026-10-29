#!/usr/bin/env node
/**
 * Virtual Portfolio — Engine (lifecycle orchestrator)
 *
 * Consumes approved shadow decisions + the current scan output, then:
 *   0. completes any pending partial fills from the previous run
 *   1. loads or initializes the EUR-denominated portfolio
 *   2. marks open positions with the best available current price
 *   3. applies deterministic exit/maintenance rules
 *   4. allocates new positions from approved decisions
 *   5. recomputes NAV / exposure / PnL
 *   6. persists state + appends history + ledger
 *
 * NO broker, NO real orders, NO external order submission.
 *
 * Phase 3b — execution realism:
 *   Pass realismConfig (from parseRealismConfig) in opts to enable slippage,
 *   fees, and partial fills. Omit (or pass null) for the pre-3b immediate-full-fill
 *   behavior — fully backward compatible.
 *
 * Usage (module):
 *   import { runPortfolio } from './portfolio_engine.mjs'
 *
 * Usage (CLI):
 *   node portfolio_engine.mjs [--run-log <path>] [--decisions <path>] [--leverage <cap>]
 *
 * Output (stdout): JSON portfolio summary
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname }             from 'path';
import { fileURLToPath }             from 'url';

import {
  loadOrInit, save, recompute, appendHistory, appendLedger,
  usdToEur, dirFactor, positionUnrealized, PORTFOLIO_PATHS,
  pruneExpiredBlocks, blockSymbol, getActiveBlock, backfillSectors,
} from './portfolio_state.mjs';
import { allocate, ALLOC_RULES } from './allocation_engine.mjs';
import { buildDecisions }        from '../decision_engine.mjs';
import { auditLog }              from '../audit_log.mjs';
import { EXECUTION_MODES, ORDER_STATES } from '../schemas.mjs';
import { PaperBroker }           from '../paper_broker.mjs';
import { realismEnabled }        from '../realism_config.mjs';
import { alertSlProximity, alertTakeProfitHit, alertBreakevenActivated, alertBreakevenHit } from '../../notify.mjs';

const LOGS_DIR = 'C:\\Users\\rapha\\.claude\\trading\\logs';

// Read the most recent btc_mark_price_usd from portfolio history for benchmark delta.
function readLastBtcMarkPrice() {
  try {
    const raw   = readFileSync(PORTFOLIO_PATHS.history, 'utf8').trim();
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.btc_mark_price_usd != null) return entry.btc_mark_price_usd;
      } catch { /* skip malformed lines */ }
    }
  } catch { /* history may not exist yet */ }
  return null;
}

// Explicit buy/sell semantics derived from (action, side).
function orderAction(action, side) {
  if (action === 'open') return side === 'long' ? 'buy' : 'sell_short';
  return side === 'long' ? 'sell' : 'buy_to_cover';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build symbol → { price_usd, source, fetched_at } map.
 * Quelle 1: Scan-Kandidaten (haben IMMER Vorrang — werden nie überschrieben).
 * Quelle 2: runOutput.portfolio_marks (Problem #2-Fix) — nur ergänzend für
 *           Symbole, die nicht im Top-20-Kandidatenfilter sind.
 */
function buildPriceMap(runOutput) {
  const map = {};
  for (const c of [...(runOutput.long_candidates ?? []), ...(runOutput.short_candidates ?? [])]) {
    if (c.price_usd != null && Number.isFinite(c.price_usd)) {
      map[c.symbol] = { price_usd: c.price_usd, source: 'scan_candidate', fetched_at: runOutput.run_at ?? null };
    }
  }
  for (const [sym, m] of Object.entries(runOutput.portfolio_marks ?? {})) {
    if (map[sym] === undefined && m?.available === true && Number.isFinite(m.price_usd)) {
      map[sym] = { price_usd: m.price_usd, source: m.source ?? 'portfolio_marks', fetched_at: m.fetched_at ?? null };
    }
  }
  return map;
}

/** Build a set of "symbol|side" that are currently approved. */
function buildApprovedSet(decisions) {
  const set = new Map();
  for (const d of decisions) {
    if (d.decision.execution_ready) set.set(`${d.intent.symbol}|${d.intent.side}`, d);
  }
  return set;
}

/**
 * closePosition — realize PnL for a position being closed, net of fees.
 * Called ONLY after the simulated exit order has filled.
 *
 * @param {object} state        — portfolio state (mutated in place)
 * @param {object} pos          — open position being closed
 * @param {number} closePriceEur — effective close price in EUR (already slippage-adjusted)
 * @param {string} reason       — exit reason
 * @param {string} runId
 * @param {string|null} orderId
 * @param {number} feeEur       — fee charged on this exit (0 if realism off)
 */
function closePosition(state, pos, closePriceEur, reason, runId, orderId, feeEur = 0) {
  const grossRealized = dirFactor(pos.side) * pos.quantity * (closePriceEur - pos.entry_price_eur);
  const realized      = +(grossRealized - feeEur).toFixed(4);

  state.realized_pnl        = +(state.realized_pnl + realized).toFixed(4);
  state.cumulative_fees_eur = +((state.cumulative_fees_eur ?? 0) + feeEur).toFixed(6);

  const summary = state.closed_positions_summary;
  summary.count              += 1;
  summary.realized_pnl_total  = +(summary.realized_pnl_total + realized).toFixed(4);
  if (realized >= 0) summary.wins += 1; else summary.losses += 1;

  appendLedger({
    ts:               new Date().toISOString(),
    event:            'close',
    run_id:           runId,
    order_id:         orderId,
    symbol:           pos.symbol,
    side:             pos.side,
    quantity:         pos.quantity,
    entry_price_eur:  pos.entry_price_eur,
    close_price_eur:  +closePriceEur.toFixed(6),
    gross_realized_eur: +(grossRealized).toFixed(4),
    fee_eur:          +feeEur.toFixed(6),
    realized_pnl_eur: realized,
    reason,
    entry_run_id:     pos.entry_run_id,
  });
  auditLog('portfolio_position_closed', {
    symbol: pos.symbol, side: pos.side, realized_pnl_eur: realized,
    fee_eur: feeEur, reason, order_id: orderId, run_id: runId,
  });

  return { realized, reason, order_id: orderId, fee_eur: feeEur };
}

/** Build a synthetic intent+decision for an exit order (no scan decision exists for exits). */
function buildExitIntentDecision(pos, markPriceUsd, reason, runId) {
  const intent = {
    intent_id:  `exit_${pos.symbol}_${pos.side}_${runId ?? 'na'}_${Date.now()}`,
    symbol:     pos.symbol,
    side:       pos.side,
    asset_type: pos.asset_type,
    price_usd:  markPriceUsd,
    risk:       { stop_loss_pct: pos.stop_loss_pct ?? null, suggested_position_pct: null },
  };
  const decision = {
    decision_id:     `exitdec_${pos.symbol}_${Date.now()}`,
    execution_ready: true,
    blocked_reasons: [],
    exit_reason:     reason,
  };
  return { intent, decision };
}

/**
 * executeExit — close a position THROUGH the simulated order lifecycle.
 * Portfolio PnL is realized only if the exit order fills.
 * Fees (if realism enabled) are extracted from the filled order and passed to closePosition.
 *
 * @returns {object|null} — close result, or null if the order was rejected (no mutation)
 */
function executeExit(broker, state, pos, markPriceUsd, reason, runId, stats, realismConfig) {
  const { intent, decision } = buildExitIntentDecision(pos, markPriceUsd, reason, runId);
  const order = broker.placeOrder(intent, decision, {
    action:       'close',
    order_action: orderAction('close', pos.side),
    quantity:     pos.quantity,
    close_reason: reason,
    run_id:       runId,
  });
  stats.created += 1;

  const filled = broker.fillOrder(order, markPriceUsd, { reason, quantity: pos.quantity }, realismConfig);

  if (filled.state !== ORDER_STATES.FILLED) {
    stats.rejected += 1;
    return null;   // exit order rejected → DO NOT mutate the portfolio
  }
  stats.filled += 1;
  if (filled.fee_eur > 0) stats.fees_eur_this_run = +((stats.fees_eur_this_run ?? 0) + filled.fee_eur).toFixed(6);
  if (filled.realism_details?.slippage_amount_eur > 0) {
    stats.slippage_cost_eur_this_run = +((stats.slippage_cost_eur_this_run ?? 0) + filled.realism_details.slippage_amount_eur).toFixed(6);
  }

  const closeEur = usdToEur(filled.filled_price_usd);
  return closePosition(state, pos, closeEur, reason, runId, filled.order_id, filled.fee_eur ?? 0);
}

/**
 * executeOpen — open a position THROUGH the simulated order lifecycle.
 * Supports both full fills and partial fills (when realism + partial_fill_mode='on').
 *
 * Full fill:    position is opened with full quantity.
 * Partial fill: position is opened with fraction qty; partial_order_id is set on the
 *               position so the engine can complete the fill on the next run.
 *
 * Entry prices are updated to the EFFECTIVE fill price (slippage-adjusted) so that
 * future unrealized PnL correctly reflects the true entry cost.
 *
 * Fees on open are deducted from state.realized_pnl (reduces cash and NAV immediately).
 *
 * @returns {boolean} — true if position opened (full or partial), false if rejected
 */
function executeOpen(broker, state, pos, runId, stats, realismConfig) {
  const src = pos._source;   // { intent, decision } attached by allocation engine
  delete pos._source;        // never persist the raw source on the position

  const order = broker.placeOrder(src.intent, src.decision, {
    action:        'open',
    order_action:  orderAction('open', pos.side),
    quantity:      pos.quantity,
    notional_eur:  pos.notional_eur,
    run_id:        runId,
  });
  stats.created += 1;

  const filled = broker.fillOrder(
    order,
    pos.entry_price_usd,
    { reason: 'paper_immediate_fill', quantity: pos.quantity },
    realismConfig,
  );

  // Rejected: position NOT opened
  if (filled.state === ORDER_STATES.REJECTED) {
    stats.rejected += 1;
    return false;
  }

  // ── Update entry prices to effective fill price (slippage-adjusted) ────────
  // Both full and partial fills use the effective price for all accounting.
  const effectiveEntryUsd = filled.filled_price_usd;
  const effectiveEntryEur = +usdToEur(effectiveEntryUsd).toFixed(6);
  if (effectiveEntryUsd !== pos.entry_price_usd) {
    pos.entry_price_usd  = effectiveEntryUsd;
    pos.entry_price_eur  = effectiveEntryEur;
    pos.mark_price_usd   = effectiveEntryUsd;
    pos.mark_price_eur   = effectiveEntryEur;
  }

  // ── Partial fill path ─────────────────────────────────────────────────────
  if (filled.state === ORDER_STATES.PARTIALLY_FILLED) {
    stats.partially_filled = (stats.partially_filled ?? 0) + 1;

    // Open position with partial quantity only
    pos.quantity          = filled.filled_quantity;
    pos.notional_eur      = +(pos.quantity * effectiveEntryEur).toFixed(4);
    pos.partial_order_id  = filled.order_id;       // marks position as pending completion
    pos.remaining_quantity = filled.remaining_quantity;
    pos.order_id          = filled.order_id;
    pos.unrealized_pnl_eur = 0;

    // Fee deducted on first cycle (charged on full ordered quantity)
    const feeEur = filled.fee_eur ?? 0;
    if (feeEur > 0) {
      state.realized_pnl        = +(state.realized_pnl - feeEur).toFixed(4);
      state.cumulative_fees_eur = +((state.cumulative_fees_eur ?? 0) + feeEur).toFixed(6);
      stats.fees_eur_this_run   = +((stats.fees_eur_this_run ?? 0) + feeEur).toFixed(6);
    }
    if (filled.realism_details?.slippage_amount_eur > 0) {
      stats.slippage_cost_eur_this_run = +((stats.slippage_cost_eur_this_run ?? 0) + filled.realism_details.slippage_amount_eur).toFixed(6);
    }

    state.open_positions.push(pos);

    appendLedger({
      ts:              new Date().toISOString(),
      event:           'open_partial',
      run_id:          runId,
      order_id:        filled.order_id,
      symbol:          pos.symbol,
      side:            pos.side,
      quantity:        pos.quantity,
      ordered_quantity: filled.ordered_quantity,
      remaining_quantity: filled.remaining_quantity,
      entry_price_eur: pos.entry_price_eur,
      notional_eur:    pos.notional_eur,
      fee_eur:         feeEur,
      strategy:        pos.strategy,
    });
    auditLog('portfolio_position_opened_partial', {
      symbol: pos.symbol, side: pos.side, notional_eur: pos.notional_eur,
      partial_order_id: filled.order_id, fill_qty: pos.quantity,
      remaining_qty: filled.remaining_quantity, fee_eur: feeEur, run_id: runId,
    });
    return true;
  }

  // ── Full fill path ────────────────────────────────────────────────────────
  stats.filled += 1;

  pos.notional_eur      = +(pos.quantity * effectiveEntryEur).toFixed(4);
  pos.order_id          = filled.order_id;
  pos.unrealized_pnl_eur = 0;

  // Fee deducted immediately from realized_pnl (reduces cash + NAV)
  const feeEur = filled.fee_eur ?? 0;
  if (feeEur > 0) {
    state.realized_pnl        = +(state.realized_pnl - feeEur).toFixed(4);
    state.cumulative_fees_eur = +((state.cumulative_fees_eur ?? 0) + feeEur).toFixed(6);
    stats.fees_eur_this_run   = +((stats.fees_eur_this_run ?? 0) + feeEur).toFixed(6);
  }
  if (filled.realism_details?.slippage_amount_eur > 0) {
    stats.slippage_cost_eur_this_run = +((stats.slippage_cost_eur_this_run ?? 0) + filled.realism_details.slippage_amount_eur).toFixed(6);
  }

  state.open_positions.push(pos);

  appendLedger({
    ts:              new Date().toISOString(),
    event:           'open',
    run_id:          runId,
    order_id:        filled.order_id,
    symbol:          pos.symbol,
    side:            pos.side,
    quantity:        pos.quantity,
    entry_price_eur: pos.entry_price_eur,
    notional_eur:    pos.notional_eur,
    fee_eur:         feeEur,
    strategy:        pos.strategy,
  });

  auditLog('portfolio_position_opened', {
    symbol: pos.symbol, side: pos.side, notional_eur: pos.notional_eur,
    fee_eur: feeEur, order_id: filled.order_id, run_id: runId,
  });
  return true;
}

/**
 * completePartialFills — Step 0 of the run cycle.
 * For each open position with a pending partial order, attempt to fill the remainder.
 * Uses the SAME effective price as the original fill (no re-slippage, no re-fee).
 * This step runs BEFORE marking and exit rules so the full quantity is available.
 */
function completePartialFills(broker, state, stats) {
  for (const pos of state.open_positions) {
    if (!pos.partial_order_id) continue;

    const partialOrder = broker.getOrder(pos.partial_order_id);
    if (!partialOrder || partialOrder.state !== ORDER_STATES.PARTIALLY_FILLED) continue;

    // Use original effective fill price for the second cycle (deterministic, stored on order)
    const completionPriceUsd = partialOrder.filled_price_usd;

    // Pass null for realismConfig — no re-slippage, no re-fee on completion
    const filled = broker.fillOrder(
      partialOrder,
      completionPriceUsd,
      { reason: 'partial_fill_complete' },
      null,
    );

    if (filled.state === ORDER_STATES.FILLED) {
      const completionQty = filled.ordered_quantity - pos.quantity;
      stats.filled += 1;

      // Update position to full quantity
      pos.quantity          = +(pos.quantity + completionQty).toFixed(8);
      pos.notional_eur      = +(pos.quantity * pos.entry_price_eur).toFixed(4);
      delete pos.partial_order_id;
      delete pos.remaining_quantity;

      appendLedger({
        ts:               new Date().toISOString(),
        event:            'partial_fill_completed',
        order_id:         filled.order_id,
        symbol:           pos.symbol,
        side:             pos.side,
        completion_qty:   completionQty,
        total_qty:        pos.quantity,
        fill_price_eur:   usdToEur(completionPriceUsd),
      });
      auditLog('portfolio_partial_fill_completed', {
        symbol:         pos.symbol, order_id: filled.order_id,
        completion_qty: completionQty, total_qty: pos.quantity,
      });
    }
    // If fill failed: leave pos.partial_order_id intact for next run
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * runPortfolio — execute one portfolio cycle.
 *
 * @param {object}      runOutput    — parsed research_run output (candidates + meta)
 * @param {object[]}    decisions    — [{ intent, decision }] from buildDecisions
 * @param {object}      opts         — { leverageCap?, runId?, realismConfig? }
 * @returns {object}                 — portfolio summary
 */
export function runPortfolio(runOutput, decisions, opts = {}) {
  const runId             = opts.runId ?? runOutput.run_id ?? null;
  const leverageCap       = opts.leverageCap ?? ALLOC_RULES.DEFAULT_LEVERAGE_CAP;
  const realismCfg        = opts.realismConfig ?? null;
  const symbolsFilter     = opts.symbolsFilter ?? null;
  const positionOverrides = opts.positionOverrides ?? {};
  // Post-SL policy: same-side block duration in hours (0 disables); run-cooldown opt-in.
  const postSlBlockHours  = Number.isFinite(opts.postSlBlockHours) ? opts.postSlBlockHours : 48;
  const postSlCooldown    = opts.postSlCooldown === true;
  // Cash/allocation policy: hard reserve floor + per-run deployment cap.
  // Fail-fast on invalid config — silent clamping would hide a policy violation.
  const minCashReservePct   = opts.minCashReservePct   ?? ALLOC_RULES.DEFAULT_MIN_CASH_RESERVE_PCT;
  const maxRunDeploymentPct = opts.maxRunDeploymentPct ?? ALLOC_RULES.DEFAULT_MAX_RUN_DEPLOYMENT_PCT;
  if (!(Number.isFinite(minCashReservePct) && minCashReservePct >= 0 && minCashReservePct < 1)) {
    throw new Error(`invalid minCashReservePct=${minCashReservePct} — allowed range [0, 1); 0 disables the reserve`);
  }
  if (!(Number.isFinite(maxRunDeploymentPct) && maxRunDeploymentPct > 0)) {
    throw new Error(`invalid maxRunDeploymentPct=${maxRunDeploymentPct} — must be > 0; values >= 1.0 disable the cap`);
  }
  // Portfolio-aware hard gates: sector exposure cap + aggregate risk budget.
  // Fail-fast on invalid config — silent clamping would hide a policy violation.
  const sectorExposureCap   = opts.sectorExposureCap   ?? ALLOC_RULES.DEFAULT_SECTOR_EXPOSURE_CAP;
  const portfolioRiskBudget = opts.portfolioRiskBudget ?? ALLOC_RULES.DEFAULT_PORTFOLIO_RISK_BUDGET;
  if (!(Number.isFinite(sectorExposureCap) && sectorExposureCap > 0)) {
    throw new Error(`invalid sectorExposureCap=${sectorExposureCap} — must be > 0; values >= 1.0 disable the cap`);
  }
  if (!(Number.isFinite(portfolioRiskBudget) && portfolioRiskBudget > 0)) {
    throw new Error(`invalid portfolioRiskBudget=${portfolioRiskBudget} — must be > 0; values >= 1.0 disable the budget`);
  }
  // Conviction override (opt-in): reduced cash floor for full-conviction (★★★★★)
  // candidates only. Fail-fast on invalid config — the override must be a REDUCED
  // floor (≤ normal reserve), never a higher one, and within [0, 1).
  const convictionOverride = opts.convictionOverride === true;
  const convictionOverrideReservePct = opts.convictionOverrideReservePct ?? ALLOC_RULES.DEFAULT_CONVICTION_OVERRIDE_RESERVE_PCT;
  if (convictionOverride) {
    if (!(Number.isFinite(convictionOverrideReservePct) && convictionOverrideReservePct >= 0 && convictionOverrideReservePct < 1)) {
      throw new Error(`invalid convictionOverrideReservePct=${convictionOverrideReservePct} — allowed range [0, 1)`);
    }
    if (convictionOverrideReservePct > minCashReservePct) {
      throw new Error(`convictionOverrideReservePct=${convictionOverrideReservePct} must not exceed minCashReservePct=${minCashReservePct} — the override is a REDUCED floor, never a higher one`);
    }
  }
  const priceMap     = buildPriceMap(runOutput);
  const approvedSet  = buildApprovedSet(decisions);

  const state   = loadOrInit();
  const closed  = [];
  const held    = [];
  const broker  = new PaperBroker();

  const orderStats = {
    created:                 0,
    filled:                  0,
    rejected:                0,
    cancelled:               0,
    partially_filled:        0,
    fees_eur_this_run:       0,
    slippage_cost_eur_this_run: 0,
  };
  const unmatched      = [];   // positions not found in current scan (data issue, NOT an exit signal)
  const unranked       = [];   // positions in scan but outside current top candidates (re-ranking, NOT an exit signal)

  auditLog('portfolio_run_started', {
    run_id:         runId,
    open_positions: state.open_positions.length,
    realism_mode:   realismCfg?.realism_mode ?? 'off',
  });

  // ── Step 0: complete any pending partial fills + prune expired blocks ───────
  completePartialFills(broker, state, orderStats);
  pruneExpiredBlocks(state);
  // Additively backfill `sector` on legacy positions so sector_exposure_cap sees
  // real cluster exposure this run (idempotent, no throw).
  const sectorBackfill = backfillSectors(state);
  if (sectorBackfill.filled.length > 0 || !sectorBackfill.registry_ok) {
    auditLog('sector_backfill', {
      run_id: runId, filled: sectorBackfill.filled,
      unresolved: sectorBackfill.unresolved, registry_ok: sectorBackfill.registry_ok,
    });
  }
  recompute(state);

  // ── Step 1+2: mark existing positions + apply exit rules (via order lifecycle) ──
  const survivors = [];
  for (const pos of state.open_positions) {
    const markEntry = priceMap[pos.symbol];
    const curUsd    = markEntry?.price_usd;

    // No usable price this run → NOT an exit signal, but never silent (Problem #2-Fix):
    //   'mark_failed'       — portfolio_marks hat es versucht und explizit gemeldet
    //   'missing_from_scan' — keine Marks-Info vorhanden (Legacy-Run-Log / State unlesbar)
    // Retain the last valid mark, flag the position, keep it open.
    if (curUsd == null) {
      const markInfo   = runOutput.portfolio_marks?.[pos.symbol];
      const markFailed = markInfo != null && markInfo.available === false;
      pos.mark_status  = markFailed ? 'mark_failed' : 'missing_from_scan';
      unmatched.push({
        symbol:        pos.symbol,
        side:          pos.side,
        last_mark_usd: pos.mark_price_usd ?? pos.entry_price_usd ?? null,
        reason:        markFailed ? (markInfo.reason ?? 'mark_failed') : 'no_marks_data',
      });
      auditLog(markFailed ? 'position_mark_failed' : 'position_unmatched_no_scan_price', {
        symbol:        pos.symbol,
        side:          pos.side,
        last_mark_usd: pos.mark_price_usd ?? null,
        reason:        markFailed ? (markInfo.reason ?? null) : 'no_marks_data',
        run_id:        runId,
      });
      process.stderr.write(JSON.stringify({
        warn:          markFailed ? 'position_mark_failed' : 'position_unmatched',
        symbol:        pos.symbol,
        side:          pos.side,
        last_mark_usd: pos.mark_price_usd ?? pos.entry_price_usd ?? null,
        reason:        markFailed ? (markInfo.reason ?? null) : 'no_marks_data',
        detail:        'no fresh price this run — position held, SL check NOT possible',
      }) + '\n');
      survivors.push(pos);
      continue;
    }

    // Price available (candidate or portfolio_mark) — clear stale flags
    delete pos.mark_status;
    delete pos.approval_status;

    // Update mark + traceability metadata (Problem #2-Fix)
    pos.mark_price_usd      = curUsd;
    pos.mark_price_eur      = +usdToEur(curUsd).toFixed(6);
    pos.mark_source         = markEntry.source;
    pos.mark_updated_at     = new Date().toISOString();
    pos.unrealized_pnl_eur  = positionUnrealized(pos);

    // Track peak PnL for trailing/breakeven stop (opt-in via breakeven_trigger_pct)
    if (pos.breakeven_trigger_pct != null) {
      const curPnlPct = dirFactor(pos.side) * ((pos.mark_price_eur - pos.entry_price_eur) / pos.entry_price_eur) * 100;
      if (pos.peak_pnl_pct == null || curPnlPct > pos.peak_pnl_pct) {
        pos.peak_pnl_pct = +curPnlPct.toFixed(4);
      }
    }

    // Age + unrealised-gain flags (used below for aged_profit_review)
    const posAgeDays   = pos.entry_timestamp != null
      ? Math.floor((Date.now() - new Date(pos.entry_timestamp).getTime()) / 86_400_000)
      : null;
    const posPnlPct    = pos.notional_eur > 0
      ? (pos.unrealized_pnl_eur / pos.notional_eur) * 100
      : 0;
    const isAgedProfit = posAgeDays != null
      && posAgeDays >= ALLOC_RULES.AGED_PROFIT_REVIEW_MIN_DAYS
      && posPnlPct  >= ALLOC_RULES.AGED_PROFIT_REVIEW_MIN_PNL_PCT;

    // SL-proximity alert: warn when position is within 1% of its stop-loss trigger.
    // This is informational only — no exit, no state change. Logged on stderr so
    // downstream hooks (Task Scheduler, notification script) can pick it up.
    if (pos.stop_loss_pct != null) {
      const pnlPct = dirFactor(pos.side) * ((pos.mark_price_eur - pos.entry_price_eur) / pos.entry_price_eur) * 100;
      const distToSl = pos.stop_loss_pct + pnlPct;  // > 0 = headroom remaining, ≤ 0 = breached
      if (distToSl > 0 && distToSl <= 1.0) {
        process.stderr.write(JSON.stringify({
          warn:              'sl_proximity_alert',
          symbol:            pos.symbol,
          side:              pos.side,
          pnl_pct:           +pnlPct.toFixed(2),
          stop_loss_pct:     pos.stop_loss_pct,
          distance_to_sl_pct: +distToSl.toFixed(2),
          mark_usd:          curUsd,
          detail:            `position within ${distToSl.toFixed(2)}% of stop-loss trigger — monitor closely`,
        }) + '\n');
        auditLog('sl_proximity_alert', {
          symbol: pos.symbol, side: pos.side, pnl_pct: +pnlPct.toFixed(2),
          stop_loss_pct: pos.stop_loss_pct, distance_to_sl_pct: +distToSl.toFixed(2),
          mark_usd: curUsd, run_id: runId,
        });
        alertSlProximity({
          symbol: pos.symbol, side: pos.side,
          distPct: +distToSl.toFixed(2), pnlPct: +pnlPct.toFixed(2), markUsd: curUsd,
        });
      }
    }

    // Stop-loss (daily-close mark based — documented limitation)
    // sl_not_before: grace window for manual opens at AH/pre-market prices.
    // The stocks_cache mark lags the real open price until the next close is fetched.
    // During the grace window the SL exit is suppressed; the proximity alert still fires.
    const slGraceActive = pos.sl_not_before != null && Date.now() < new Date(pos.sl_not_before).getTime();
    if (slGraceActive) {
      process.stderr.write(JSON.stringify({
        info:          'sl_check_deferred',
        symbol:        pos.symbol,
        side:          pos.side,
        sl_not_before: pos.sl_not_before,
        detail:        'SL exit suppressed — grace window active (AH/pre-market open)',
      }) + '\n');
    }
    if (!slGraceActive && pos.stop_loss_pct != null) {
      const pnlPct = dirFactor(pos.side) * ((pos.mark_price_eur - pos.entry_price_eur) / pos.entry_price_eur) * 100;
      if (pnlPct <= -pos.stop_loss_pct) {
        const r = executeExit(broker, state, pos, curUsd, 'stop_loss_hit', runId, orderStats, realismCfg);
        if (r) {
          closed.push({ symbol: pos.symbol, side: pos.side, pnl_pct: +pnlPct.toFixed(2), ...r });
          // ── Post-SL policy: cooldown marker + time-limited same-side block ──
          // Only after a FILLED exit (r non-null). A rejected exit order leaves
          // the position open and must not trigger the policy.
          state.last_sl_run_id = runId;
          state.last_sl_at     = new Date().toISOString();
          if (postSlBlockHours > 0) {
            // Never degrade an existing manual block to a time-limited SL block.
            const existing = getActiveBlock(state, pos.symbol, pos.side);
            if (!existing || existing.origin === 'stop_loss') {
              const blockedUntil = new Date(Date.now() + postSlBlockHours * 3_600_000).toISOString();
              blockSymbol(state, pos.symbol, pos.side, 'post_sl: stop_loss_hit', blockedUntil, 'stop_loss');
              auditLog('post_sl_block_set', {
                symbol: pos.symbol, side: pos.side, blocked_until: blockedUntil,
                block_hours: postSlBlockHours, order_id: r.order_id, run_id: runId,
              });
            }
          }
        } else {
          survivors.push(pos);
        }
        continue;
      }
    }

    // Breakeven/Trailing Stop (opt-in — only when pos.breakeven_trigger_pct is set)
    // Activates once peak PnL hits the trigger; then:
    //   - pure breakeven (trailing_stop_distance_pct=null): exit when PnL ≤ 0
    //   - trailing stop (trailing_stop_distance_pct=N):     exit when PnL ≤ peak - N
    if (pos.breakeven_trigger_pct != null) {
      const curPnlPct = dirFactor(pos.side) * ((pos.mark_price_eur - pos.entry_price_eur) / pos.entry_price_eur) * 100;
      const peak      = pos.peak_pnl_pct ?? 0;

      if (!pos.breakeven_activated && peak >= pos.breakeven_trigger_pct) {
        pos.breakeven_activated = true;
        process.stderr.write(JSON.stringify({
          info:              'breakeven_activated',
          symbol:            pos.symbol, side: pos.side,
          peak_pnl_pct:      +peak.toFixed(2),
          trigger_pct:       pos.breakeven_trigger_pct,
          trailing_distance: pos.trailing_stop_distance_pct ?? null,
        }) + '\n');
        auditLog('breakeven_activated', {
          symbol: pos.symbol, side: pos.side, peak_pnl_pct: +peak.toFixed(2),
          trigger_pct: pos.breakeven_trigger_pct,
          trailing_distance: pos.trailing_stop_distance_pct ?? null,
          run_id: runId,
        });
        alertBreakevenActivated({
          symbol: pos.symbol, side: pos.side,
          peakPct: +peak.toFixed(2), triggerPct: pos.breakeven_trigger_pct,
        });
      }

      if (pos.breakeven_activated) {
        const isTrailing     = pos.trailing_stop_distance_pct != null;
        const exitThreshold  = isTrailing ? peak - pos.trailing_stop_distance_pct : 0;
        if (curPnlPct <= exitThreshold) {
          const exitReason = isTrailing ? 'trailing_stop_hit' : 'breakeven_stop_hit';
          const r = executeExit(broker, state, pos, curUsd, exitReason, runId, orderStats, realismCfg);
          if (r) {
            closed.push({ symbol: pos.symbol, side: pos.side, pnl_pct: +curPnlPct.toFixed(2), ...r });
            auditLog(exitReason, {
              symbol: pos.symbol, side: pos.side, pnl_pct: +curPnlPct.toFixed(2),
              peak_pnl_pct: +peak.toFixed(2), exit_threshold: +exitThreshold.toFixed(2),
              mark_usd: curUsd, run_id: runId,
            });
            process.stderr.write(JSON.stringify({
              info:           exitReason,
              symbol:         pos.symbol, side: pos.side,
              pnl_pct:        +curPnlPct.toFixed(2),
              peak_pnl_pct:   +peak.toFixed(2),
              exit_threshold: +exitThreshold.toFixed(2),
              mark_usd:       curUsd,
            }) + '\n');
            alertBreakevenHit({
              symbol: pos.symbol, side: pos.side,
              pnlPct: +curPnlPct.toFixed(2), peakPct: +peak.toFixed(2), trailing: isTrailing,
            });
          } else {
            survivors.push(pos);
          }
          continue;
        }
      }
    }

    // Partial TP1/TP2 (opt-in — only when pos.tp1_pct is set; fail-soft: any error falls back to single-TP)
    // TP1: close 50% of position, move SL to breakeven.
    // TP2: close remaining 50% (only after tp1_hit=true).
    // Positions without tp1_pct use the existing single take_profit_pct path below.
    let partialTpHandled = false;
    if (pos.tp1_pct != null) {
      try {
        const pnlPct = dirFactor(pos.side) * ((pos.mark_price_eur - pos.entry_price_eur) / pos.entry_price_eur) * 100;

        // ── TP2 check (only after TP1 already hit) ────────────────────────────
        if (pos.tp1_hit === true && pos.tp2_hit !== true && pos.tp2_pct != null) {
          if (pnlPct >= pos.tp2_pct) {
            // Close remaining quantity (tp2_quantity_pct fraction of original; pos.quantity is already the remainder)
            const r = executeExit(broker, state, pos, curUsd, 'partial_tp2_hit', runId, orderStats, realismCfg);
            if (r) {
              pos.tp2_hit = true;
              closed.push({ symbol: pos.symbol, side: pos.side, pnl_pct: +pnlPct.toFixed(2), tp_level: 'tp2', ...r });
              auditLog('partial_tp2_hit', {
                symbol: pos.symbol, side: pos.side, pnl_pct: +pnlPct.toFixed(2),
                tp2_pct: pos.tp2_pct, mark_usd: curUsd, run_id: runId,
              });
              process.stderr.write(JSON.stringify({
                info:    'partial_tp2_hit',
                symbol:  pos.symbol, side: pos.side,
                pnl_pct: +pnlPct.toFixed(2), tp2_pct: pos.tp2_pct, mark_usd: curUsd,
              }) + '\n');
              alertTakeProfitHit({ symbol: pos.symbol, side: pos.side, pnlPct: +pnlPct.toFixed(2), tpPct: pos.tp2_pct });
            } else {
              survivors.push(pos);
            }
            partialTpHandled = true;
          }
        }

        // ── TP1 check (fires first; tp2 check above will not run in same iteration) ──
        if (!partialTpHandled && pos.tp1_hit !== true) {
          if (pnlPct >= pos.tp1_pct) {
            // Close tp1_quantity_pct (50%) of position via partial close helper
            const closeQtyFraction = pos.tp1_quantity_pct ?? 0.5;
            const partialQty       = +(pos.quantity * closeQtyFraction).toFixed(8);
            const remainQty        = +(pos.quantity - partialQty).toFixed(8);

            // Build a synthetic intent+decision for this partial exit
            const { intent: pi, decision: pd } = buildExitIntentDecision(pos, curUsd, 'partial_tp1_hit', runId);
            const partialOrder = broker.placeOrder(pi, pd, {
              action:       'close',
              order_action: orderAction('close', pos.side),
              quantity:     partialQty,
              close_reason: 'partial_tp1_hit',
              run_id:       runId,
            });
            orderStats.created += 1;
            const filledPartial = broker.fillOrder(partialOrder, curUsd, { reason: 'partial_tp1_hit', quantity: partialQty }, realismCfg);

            if (filledPartial.state === ORDER_STATES.FILLED) {
              orderStats.filled += 1;
              if (filledPartial.fee_eur > 0) orderStats.fees_eur_this_run = +((orderStats.fees_eur_this_run ?? 0) + filledPartial.fee_eur).toFixed(6);

              const closeEur       = usdToEur(filledPartial.filled_price_usd);
              const grossRealized  = dirFactor(pos.side) * partialQty * (closeEur - pos.entry_price_eur);
              const feeEur         = filledPartial.fee_eur ?? 0;
              const realized       = +(grossRealized - feeEur).toFixed(4);

              state.realized_pnl        = +(state.realized_pnl + realized).toFixed(4);
              state.cumulative_fees_eur = +((state.cumulative_fees_eur ?? 0) + feeEur).toFixed(6);
              state.closed_positions_summary.count += 1;
              state.closed_positions_summary.realized_pnl_total = +(state.closed_positions_summary.realized_pnl_total + realized).toFixed(4);
              if (realized >= 0) state.closed_positions_summary.wins += 1;
              else                state.closed_positions_summary.losses += 1;

              appendLedger({
                ts:                 new Date().toISOString(),
                event:              'partial_close',
                run_id:             runId,
                order_id:           filledPartial.order_id,
                symbol:             pos.symbol,
                side:               pos.side,
                quantity:           partialQty,
                entry_price_eur:    pos.entry_price_eur,
                close_price_eur:    +closeEur.toFixed(6),
                gross_realized_eur: +grossRealized.toFixed(4),
                fee_eur:            +feeEur.toFixed(6),
                realized_pnl_eur:   realized,
                reason:             'partial_tp1_hit',
                tp_level:           'tp1',
                entry_run_id:       pos.entry_run_id,
              });
              auditLog('partial_tp1_hit', {
                symbol: pos.symbol, side: pos.side, pnl_pct: +pnlPct.toFixed(2),
                tp1_pct: pos.tp1_pct, closed_qty: partialQty, remain_qty: remainQty,
                mark_usd: curUsd, run_id: runId,
              });

              // Mutate position: reduce quantity, move SL to breakeven
              pos.quantity     = remainQty;
              pos.notional_eur = +(remainQty * pos.entry_price_eur).toFixed(4);
              pos.tp1_hit      = true;

              // Move SL to breakeven (entry price)
              pos.stop_loss_pct       = 0;    // 0% from entry = breakeven
              pos.stop_loss_price_eur = pos.entry_price_eur;

              process.stderr.write(JSON.stringify({
                info:        'partial_tp1_hit',
                symbol:      pos.symbol, side: pos.side,
                pnl_pct:     +pnlPct.toFixed(2), tp1_pct: pos.tp1_pct,
                closed_qty:  partialQty, remain_qty: remainQty,
                sl_moved_to: 'breakeven', mark_usd: curUsd,
              }) + '\n');
              alertTakeProfitHit({ symbol: pos.symbol, side: pos.side, pnlPct: +pnlPct.toFixed(2), tpPct: pos.tp1_pct });

              // Position survives with reduced quantity; NOT closed
              survivors.push(pos);
              partialTpHandled = true;
            } else {
              orderStats.rejected += 1;
              // Partial order rejected — fall through to normal single-TP path
            }
          }
        }
      } catch (partialTpErr) {
        // Fail-soft: log error and fall through to single-TP path
        process.stderr.write(JSON.stringify({
          warn:   'partial_tp_logic_error',
          symbol: pos.symbol, side: pos.side,
          detail: String(partialTpErr?.message ?? partialTpErr),
        }) + '\n');
      }
    }
    if (partialTpHandled) continue;

    // Take-profit (opt-in — only fires when pos.take_profit_pct is set)
    // Also acts as fallback for positions where partial TP failed (fail-soft).
    if (pos.take_profit_pct != null && pos.take_profit_pct > 0) {
      const pnlPct = dirFactor(pos.side) * ((pos.mark_price_eur - pos.entry_price_eur) / pos.entry_price_eur) * 100;
      if (pnlPct >= pos.take_profit_pct) {
        const r = executeExit(broker, state, pos, curUsd, 'take_profit_hit', runId, orderStats, realismCfg);
        if (r) {
          closed.push({ symbol: pos.symbol, side: pos.side, pnl_pct: +pnlPct.toFixed(2), ...r });
          auditLog('take_profit_hit', {
            symbol: pos.symbol, side: pos.side, pnl_pct: +pnlPct.toFixed(2),
            take_profit_pct: pos.take_profit_pct, mark_usd: curUsd, run_id: runId,
          });
          process.stderr.write(JSON.stringify({
            info:            'take_profit_hit',
            symbol:          pos.symbol, side: pos.side,
            pnl_pct:         +pnlPct.toFixed(2),
            take_profit_pct: pos.take_profit_pct,
            mark_usd:        curUsd,
          }) + '\n');
          alertTakeProfitHit({
            symbol: pos.symbol, side: pos.side,
            pnlPct: +pnlPct.toFixed(2), tpPct: pos.take_profit_pct,
          });
        } else {
          survivors.push(pos);
        }
        continue;
      }
    }

    // ── Hold/exit decision for existing Swing Trading positions ─────────────────
    // Ranking and approvedSet are used ONLY for new entries (Step 4).
    // For existing positions, only TWO exits apply (Schritt 4):
    //   1. stop_loss_hit    (handled above — price-based, unchanged)
    //   2. manual close     (executed outside the engine via manual_close.mjs)
    //
    // Technical signals (RSI, MACD, confidence drift) are informational only.
    // direction_flip is NO LONGER an automatic exit for any existing position.
    // A confirmed or partial opposite-side signal results in direction_watch (HOLD + flag).
    // Falling out of today's top candidates or dropping in daily score is NOT an exit.
    const sameSide  = approvedSet.has(`${pos.symbol}|${pos.side}`);
    const oppKey    = `${pos.symbol}|${pos.side === 'long' ? 'short' : 'long'}`;
    const oppEntry  = approvedSet.get(oppKey);   // { intent, decision } or undefined
    const oppSide   = oppEntry != null;
    const oppAlignment = oppEntry?.intent?.technical_alignment ?? null;

    if (sameSide) {
      // Still an approved entry on the same side — hold normally.
      held.push(pos.symbol);
      survivors.push(pos);
    } else if (oppSide) {
      // Opposite-side signal present — any alignment strength (confirmed, partial, neutral).
      // Schritt 4: technical signals alone do not trigger automatic exits for swing positions.
      // Log the alignment strength for operator observability; no exit, no PnL change.
      const noteKey = oppAlignment === 'confirmed'
        ? 'opposite_signal_confirmed'
        : `opposite_signal_${oppAlignment ?? 'unknown'}`;
      pos.approval_status = 'direction_watch';
      unranked.push({ symbol: pos.symbol, side: pos.side, mark_usd: curUsd, note: noteKey });
      auditLog('position_held_direction_watch', { symbol: pos.symbol, side: pos.side, opp_alignment: oppAlignment, mark_usd: curUsd, run_id: runId });
      process.stderr.write(JSON.stringify({
        info:          'position_held_direction_watch',
        symbol:        pos.symbol, side: pos.side, mark_usd: curUsd,
        opp_alignment: oppAlignment,
        detail:        'technical signal informational only — position held for swing, flagged direction_watch',
      }) + '\n');
      survivors.push(pos);
    } else {
      // Not in today's top candidates at all — pure re-ranking. NOT an exit signal.
      // Aged-profit-review: position >21 days with >5% unrealised gain on notional
      // → flag for manual profit-take consideration. No auto-close — operator decides.
      if (isAgedProfit) {
        pos.approval_status = 'aged_profit_review';
        pos.days_open       = posAgeDays;
        unranked.push({ symbol: pos.symbol, side: pos.side, mark_usd: curUsd, note: 'aged_profit_review' });
        auditLog('position_aged_profit_review', {
          symbol: pos.symbol, side: pos.side, days_open: posAgeDays,
          pnl_pct: +posPnlPct.toFixed(2), mark_usd: curUsd, run_id: runId,
        });
        process.stderr.write(JSON.stringify({
          info:      'position_aged_profit_review',
          symbol:    pos.symbol, side: pos.side,
          days_open: posAgeDays, pnl_pct: +posPnlPct.toFixed(2), mark_usd: curUsd,
          detail:    'position >21 days with >5% gain — consider manual profit-take',
        }) + '\n');
      } else {
        pos.approval_status = 'not_in_top_candidates';
        unranked.push({ symbol: pos.symbol, side: pos.side, mark_usd: curUsd });
        auditLog('position_held_not_in_top_candidates', { symbol: pos.symbol, side: pos.side, mark_usd: curUsd, run_id: runId });
        process.stderr.write(JSON.stringify({
          info:   'position_held_outside_candidates',
          symbol: pos.symbol, side: pos.side, mark_usd: curUsd,
          detail: 'not in current top candidates — position held, no exit triggered',
        }) + '\n');
      }
      survivors.push(pos);
    }
  }
  state.open_positions = survivors;
  recompute(state);

  // ── Stale-Mark-Eskalation (Problem #2-Fix): Mark älter als 24h = SL-Blindflug ──
  // Fail-soft hält den Run am Leben; diese Warnung verhindert, dass ein dauerhaft
  // fehlschlagendes Symbol unbemerkt bleibt.
  const MARK_STALE_MS = 24 * 3_600_000;
  for (const pos of state.open_positions) {
    const ageMs = pos.mark_updated_at != null
      ? Date.now() - new Date(pos.mark_updated_at).getTime()
      : null;
    if ((ageMs === null && pos.mark_status != null) || (ageMs !== null && ageMs > MARK_STALE_MS)) {
      const ageHours = ageMs !== null ? +(ageMs / 3_600_000).toFixed(1) : null;
      auditLog('position_mark_stale', {
        symbol: pos.symbol, side: pos.side, mark_age_hours: ageHours,
        mark_status: pos.mark_status ?? null, run_id: runId,
      });
      process.stderr.write(JSON.stringify({
        warn:           'position_mark_stale',
        symbol:         pos.symbol,
        side:           pos.side,
        mark_age_hours: ageHours,
        detail:         'mark older than 24h (or never set) — stop-loss monitoring is effectively blind for this position',
      }) + '\n');
    }
  }

  // ── Step 4: allocate new positions, each routed through the order lifecycle ──
  // ── Cash/allocation policy: per-run deployment budget (per run_id, persistent) ──
  // Budget survives multiple engine invocations against the same run_id; resets
  // on run change. runId=null → cap skipped (no budget attribution possible).
  let runBudgetEur = null;
  let runCapEur    = null;
  if (maxRunDeploymentPct < 1.0 && runId != null) {
    if (state.deploy_run_id !== runId) {
      state.deploy_run_id       = runId;
      state.deploy_run_used_eur = 0;
    }
    runCapEur    = +(maxRunDeploymentPct * state.equity_nav).toFixed(4);
    runBudgetEur = Math.max(0, +(runCapEur - (state.deploy_run_used_eur ?? 0)).toFixed(4));
  }

  const approved = decisions.filter(d => d.decision.execution_ready);
  const { newPositions, skipped, leverageCapUsed } = allocate(state, approved, {
    leverageCap, runId, symbolsFilter, positionOverrides, postSlCooldown,
    minCashReservePct, runBudgetEur,
    sectorExposureCap, portfolioRiskBudget,
    convictionSizing: opts.convictionSizing === true,
    convictionOverride, convictionOverrideReservePct,
    takeProfitPct: Number.isFinite(opts.takeProfitPct) && opts.takeProfitPct > 0
      ? opts.takeProfitPct : null,
  });

  const opened = [];
  for (const pos of newPositions) {
    const ok = executeOpen(broker, state, pos, runId, orderStats, realismCfg);
    if (ok) opened.push(pos);
  }

  // Post-SL cooldown audit trail (allocate() is pure — the engine emits the event)
  const postSlCooldownApplied = skipped.some(s => s.reason === 'post_sl_cooldown');
  if (postSlCooldownApplied) {
    auditLog('post_sl_cooldown_active', {
      run_id:     runId,
      last_sl_at: state.last_sl_at,
      suppressed: skipped.filter(s => s.reason === 'post_sl_cooldown').length,
    });
  }

  // Budget accounting: only actually FILLED notional consumes the run budget.
  // Rejected orders are not in `opened`; partial fills count their cycle-1 notional.
  const deployedEur = +opened.reduce((s, p) => s + (p.notional_eur ?? 0), 0).toFixed(4);
  if (runBudgetEur !== null && deployedEur > 0) {
    state.deploy_run_used_eur = +((state.deploy_run_used_eur ?? 0) + deployedEur).toFixed(4);
  }
  const capSkips = skipped.filter(s => s.reason === 'run_deployment_cap').length;
  if (capSkips > 0) {
    auditLog('run_deployment_cap_reached', {
      run_id: runId, cap_eur: runCapEur,
      used_eur: state.deploy_run_used_eur ?? 0, suppressed: capSkips,
    });
  }

  // ── Portfolio-aware hard-gate observability ─────────────────────────────────
  // Recompute final sector exposure + portfolio at-risk from the persisted state
  // (single source of truth, includes positions opened this run). Legacy-tolerant:
  // positions without sector / stop_loss_pct contribute 0.
  const sectorExposureEur = {};
  let portfolioAtRiskEur = 0;
  for (const p of state.open_positions) {
    const sec = p.sector ?? null;
    if (sec != null) sectorExposureEur[sec] = +((sectorExposureEur[sec] ?? 0) + (p.notional_eur ?? 0)).toFixed(2);
    // Mirror the allocator's no-SL policy: unbounded positions are charged at the
    // conservative RISK_UNKNOWN_SL_PCT, never as 0 risk.
    const slForRisk = (p.stop_loss_pct != null && p.stop_loss_pct > 0)
      ? p.stop_loss_pct
      : ALLOC_RULES.RISK_UNKNOWN_SL_PCT;
    portfolioAtRiskEur += (p.notional_eur ?? 0) * (slForRisk / 100);
  }
  portfolioAtRiskEur = +portfolioAtRiskEur.toFixed(4);
  const portfolioAtRiskPct = state.equity_nav > 0 ? +((portfolioAtRiskEur / state.equity_nav) * 100).toFixed(2) : 0;

  const sectorCapSkips  = skipped.filter(s => s.reason === 'sector_exposure_cap').length;
  const riskBudgetSkips = skipped.filter(s => s.reason === 'portfolio_risk_budget').length;
  const sectorCapClamps  = opened.filter(p => p.sizing_constraint === 'sector_exposure_cap').length;
  const riskBudgetClamps = opened.filter(p => p.sizing_constraint === 'portfolio_risk_budget').length;
  if (sectorCapSkips > 0 || sectorCapClamps > 0) {
    auditLog('sector_exposure_cap_reached', {
      run_id: runId, cap_pct: sectorExposureCap,
      cap_eur: +(sectorExposureCap * state.equity_nav).toFixed(4),
      sector_exposure_eur: sectorExposureEur,
      skipped: sectorCapSkips, clamped: sectorCapClamps,
    });
  }
  if (riskBudgetSkips > 0 || riskBudgetClamps > 0) {
    auditLog('portfolio_risk_budget_reached', {
      run_id: runId, budget_pct: portfolioRiskBudget,
      budget_eur: +(portfolioRiskBudget * state.equity_nav).toFixed(4),
      portfolio_at_risk_eur: portfolioAtRiskEur, portfolio_at_risk_pct: portfolioAtRiskPct,
      skipped: riskBudgetSkips, clamped: riskBudgetClamps,
    });
  }

  // ── Conviction-override observability ───────────────────────────────────────
  // Count positions where the ★★★★★ override was actually load-bearing (drew cash
  // below the normal reserve floor). Eligible-but-not-needed opens are NOT counted.
  const convictionOverrideAppliedCount = opened.filter(p => p.conviction_override_applied === true).length;
  if (convictionOverride && convictionOverrideAppliedCount > 0) {
    auditLog('conviction_override_used', {
      run_id:             runId,
      reserve_pct:        convictionOverrideReservePct,
      normal_reserve_pct: minCashReservePct,
      applied:            convictionOverrideAppliedCount,
      symbols:            opened.filter(p => p.conviction_override_applied === true).map(p => p.symbol),
    });
  }

  // ── Step 5: recompute + persist ──
  recompute(state);
  state.last_updated_at = new Date().toISOString();
  state.last_run_id     = runId;
  save(state);

  // ── Step 6: history event ──
  const historyEvent = {
    ts:               state.last_updated_at,
    run_id:           runId,
    equity_nav:       state.equity_nav,
    cash:             state.cash,
    realized_pnl:     state.realized_pnl,
    unrealized_pnl:   state.unrealized_pnl,
    gross_exposure:   state.gross_exposure,
    net_exposure:     state.net_exposure,
    leverage_used:    state.leverage_used,
    open_count:       state.open_positions.length,
    opened:           opened.map(p => p.symbol),
    closed:           closed.map(c => ({ symbol: c.symbol, reason: c.reason, realized: c.realized })),
    unmatched:        unmatched.map(u => u.symbol),
    unranked:         unranked.map(u => u.symbol),
    order_stats:      orderStats,
    cash_pct:         state.equity_nav > 0 ? +((state.cash / state.equity_nav) * 100).toFixed(2) : 0,
    cumulative_fees_eur: state.cumulative_fees_eur ?? 0,
    realism_mode:     realismCfg?.realism_mode ?? 'off',
    post_sl_cooldown_applied: postSlCooldownApplied,
    deployed_eur:        deployedEur,
    deploy_run_used_eur: state.deploy_run_used_eur ?? 0,
    conviction_override_applied: convictionOverrideAppliedCount,
    sector_exposure_eur:    sectorExposureEur,
    portfolio_at_risk_eur:  portfolioAtRiskEur,
    portfolio_at_risk_pct:  portfolioAtRiskPct,
    benchmark_pct:      (() => {
      const btcNow  = runOutput?.btc_positioning?.mark_price_usd ?? null;
      const btcPrev = readLastBtcMarkPrice();
      return (btcNow != null && btcPrev != null && btcPrev > 0)
        ? +((btcNow - btcPrev) / btcPrev * 100).toFixed(4)
        : null;
    })(),
    btc_mark_price_usd: runOutput?.btc_positioning?.mark_price_usd ?? null,
  };
  appendHistory(historyEvent);
  auditLog('portfolio_run_completed', {
    run_id: runId, equity_nav: state.equity_nav,
    open:   state.open_positions.length, order_stats: orderStats,
    cumulative_fees_eur: state.cumulative_fees_eur,
  });

  // Committed capital = sum of notional_eur (= cash-effective reserved capital in this model).
  // Informational leveraged notional = sum of notional_eur * leverage (metadata, not cash-effective).
  const committedCapitalEur = +state.open_positions
    .reduce((sum, p) => sum + (p.notional_eur ?? 0), 0).toFixed(2);
  const infoLeveragedNotionalEur = +state.open_positions
    .reduce((sum, p) => sum + (p.notional_eur ?? 0) * (p.leverage ?? 1), 0).toFixed(2);

  return {
    mode:                'virtual_portfolio',
    run_id:              runId,
    base_currency:       state.base_currency,
    equity_nav:          state.equity_nav,
    cash:                state.cash,
    cash_pct:            historyEvent.cash_pct,
    realized_pnl:        state.realized_pnl,
    unrealized_pnl:      state.unrealized_pnl,
    gross_exposure:      state.gross_exposure,         // = committed_capital_eur (kept for compat)
    net_exposure:        state.net_exposure,
    leverage_used:       state.leverage_used,          // gross_exposure / NAV ratio
    leverage_cap:        leverageCapUsed,
    committed_capital_eur:                committedCapitalEur,
    informational_leveraged_notional_eur: infoLeveragedNotionalEur,
    cumulative_fees_eur: state.cumulative_fees_eur ?? 0,
    open_positions:      state.open_positions.map(p => ({
      symbol:             p.symbol,
      side:               p.side,
      notional_eur:       p.notional_eur,
      unrealized_pnl_eur: p.unrealized_pnl_eur,
      stop_loss_pct:      p.stop_loss_pct ?? null,
      leverage:           p.leverage ?? 1,
      strategy:           p.strategy,
      partial_order_id:   p.partial_order_id ?? null,
      mark_status:        p.mark_status ?? null,        // null = current; 'mark_failed' / 'missing_from_scan' = not priced this run
      mark_source:        p.mark_source ?? null,        // 'scan_candidate' | 'stocks_cache' | 'crypto_scan_cache' | 'mexc_ticker'
      mark_updated_at:    p.mark_updated_at ?? null,    // timestamp of last successful mark (stale > 24h triggers warning)
      approval_status:    p.approval_status ?? null,   // null = in top candidates; 'not_in_top_candidates' | 'aged_profit_review' = held outside ranking; 'direction_watch' = opposite signal present
      days_open:          p.days_open ?? null,          // set when approval_status='aged_profit_review'; null otherwise
      // ── Scan-time catalyst context (Schritt 3, read-only) ────────────────────
      k_at_entry:             p.k_at_entry ?? null,
      catalyst_recognized_at: p.catalyst_recognized_at ?? null,
      catalyst_age_days:      p.catalyst_recognized_at != null
        ? Math.floor((Date.now() - new Date(p.catalyst_recognized_at).getTime()) / 86_400_000)
        : null,
      // ── Position-level thesis fields (Schritt 3, operator-managed) ───────────
      // thesis_status, thesis_valid_until, catalyst_event_date, thesis_last_reviewed_at
      // are never mutated by the engine. thesis_expired and thesis_attention are
      // derived here for observability only — they are NOT persisted.
      thesis_status:           p.thesis_status ?? null,
      thesis_valid_until:      p.thesis_valid_until ?? null,
      catalyst_event_date:     p.catalyst_event_date ?? null,
      thesis_last_reviewed_at: p.thesis_last_reviewed_at ?? null,
      thesis_expired:          p.thesis_valid_until != null
        ? new Date(p.thesis_valid_until) < new Date()
        : false,
      thesis_attention:        (p.thesis_valid_until != null && new Date(p.thesis_valid_until) < new Date() && (p.thesis_status ?? 'active') === 'active')
        ? 'watch'
        : null,
    })),
    unmatched_positions:  unmatched,                   // held open but not priced this run (data issue, not exit)
    unranked_positions:   unranked,                    // held open but outside current top candidates (re-ranking, not exit)
    new_allocations:     opened.map(p => ({
      symbol:    p.symbol,
      side:      p.side,
      notional_eur: p.notional_eur,
      order_id:  p.order_id,
      partial:   !!p.partial_order_id,
      sizing_constraint: p.sizing_constraint ?? null,
      conviction_override_applied: p.conviction_override_applied === true,
    })),
    closed_this_run:     closed,
    skipped_allocations: skipped,
    post_sl_cooldown_applied: postSlCooldownApplied,
    cash_reserve_pct:        minCashReservePct,
    cash_reserve_eur:        +(minCashReservePct * state.equity_nav).toFixed(4),
    run_deployment_cap_pct:  maxRunDeploymentPct < 1.0 ? maxRunDeploymentPct : null,
    run_deployment_cap_eur:  runCapEur,
    deploy_run_used_eur:     state.deploy_run_used_eur ?? 0,
    // Conviction override (null reserve_pct = override disabled)
    conviction_override_enabled:     convictionOverride,
    conviction_override_reserve_pct: convictionOverride ? convictionOverrideReservePct : null,
    conviction_override_reserve_eur: convictionOverride ? +(convictionOverrideReservePct * state.equity_nav).toFixed(4) : null,
    conviction_override_applied:     convictionOverrideAppliedCount,
    // Portfolio-aware hard gates (null pct = disabled via >= 1.0)
    sector_exposure_cap_pct:   sectorExposureCap   < 1.0 ? sectorExposureCap   : null,
    sector_exposure_cap_eur:   sectorExposureCap   < 1.0 ? +(sectorExposureCap * state.equity_nav).toFixed(4) : null,
    sector_exposure_eur:       sectorExposureEur,
    portfolio_risk_budget_pct: portfolioRiskBudget < 1.0 ? portfolioRiskBudget : null,
    portfolio_risk_budget_eur: portfolioRiskBudget < 1.0 ? +(portfolioRiskBudget * state.equity_nav).toFixed(4) : null,
    portfolio_at_risk_eur:     portfolioAtRiskEur,
    portfolio_at_risk_pct:     portfolioAtRiskPct,
    sector_cap_skips:          sectorCapSkips,
    risk_budget_skips:         riskBudgetSkips,
    risk_unknown_skips:        skipped.filter(s => s.reason === 'risk_unknown').length,
    sector_backfill:           sectorBackfill,
    closed_summary:      state.closed_positions_summary,
    order_stats:         orderStats,
    state_file:          PORTFOLIO_PATHS.state,
    history_file:        PORTFOLIO_PATHS.history,
    ledger_file:         PORTFOLIO_PATHS.ledger,
    orders_dir:          'C:\\Users\\rapha\\.claude\\trading\\execution\\orders',
    order_events_file:   'C:\\Users\\rapha\\.claude\\trading\\execution\\orders\\order_events.jsonl',
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const args        = process.argv.slice(2);
  const runLogFlag  = args.indexOf('--run-log');
  const decFlag     = args.indexOf('--decisions');
  const levFlag     = args.indexOf('--leverage');

  let runOutput;
  if (runLogFlag !== -1 && args[runLogFlag + 1]) {
    runOutput = JSON.parse(readFileSync(args[runLogFlag + 1], 'utf8'));
  } else {
    const files = readdirSync(LOGS_DIR)
      .filter(f => f.startsWith('run_') && f.endsWith('.json'))
      .sort().reverse();
    if (!files.length) {
      process.stderr.write(JSON.stringify({ error: 'no_run_log_found' }) + '\n');
      process.exit(1);
    }
    runOutput = JSON.parse(readFileSync(join(LOGS_DIR, files[0]), 'utf8'));
  }

  let decisions;
  if (decFlag !== -1 && args[decFlag + 1]) {
    decisions = JSON.parse(readFileSync(args[decFlag + 1], 'utf8'));
  } else {
    decisions = buildDecisions(runOutput, {}, EXECUTION_MODES.SHADOW);
  }

  const leverageCap = levFlag !== -1 && args[levFlag + 1]
    ? parseFloat(args[levFlag + 1])
    : ALLOC_RULES.DEFAULT_LEVERAGE_CAP;

  // Post-SL policy flags
  const postSlCooldown   = args.includes('--post-sl-cooldown');
  const blockHoursFlag   = args.indexOf('--post-sl-block-hours');
  const blockHoursRaw    = blockHoursFlag !== -1 && args[blockHoursFlag + 1] ? parseFloat(args[blockHoursFlag + 1]) : NaN;
  const postSlBlockHours = Number.isFinite(blockHoursRaw) ? blockHoursRaw : undefined;

  // Cash/allocation policy flags
  const reserveFlag = args.indexOf('--min-cash-reserve-pct');
  const reserveRaw  = reserveFlag !== -1 && args[reserveFlag + 1] ? parseFloat(args[reserveFlag + 1]) : NaN;
  const capFlag     = args.indexOf('--max-run-deployment-pct');
  const capRaw      = capFlag !== -1 && args[capFlag + 1] ? parseFloat(args[capFlag + 1]) : NaN;

  // Portfolio-aware hard-gate flags
  const sectorFlag  = args.indexOf('--sector-exposure-cap');
  const sectorRaw   = sectorFlag !== -1 && args[sectorFlag + 1] ? parseFloat(args[sectorFlag + 1]) : NaN;
  const riskFlag    = args.indexOf('--portfolio-risk-budget');
  const riskRaw     = riskFlag !== -1 && args[riskFlag + 1] ? parseFloat(args[riskFlag + 1]) : NaN;
  const convictionSizing = args.includes('--conviction-sizing');

  // Conviction-override flags (reduced cash floor for ★★★★★ candidates only)
  const convictionOverride = args.includes('--conviction-override');
  const convOvFlag  = args.indexOf('--conviction-override-reserve-pct');
  const convOvRaw   = convOvFlag !== -1 && args[convOvFlag + 1] ? parseFloat(args[convOvFlag + 1]) : NaN;

  try {
    const summary = runPortfolio(runOutput, decisions, {
      leverageCap, runId: runOutput.run_id, postSlCooldown, convictionSizing, convictionOverride,
      ...(postSlBlockHours !== undefined ? { postSlBlockHours } : {}),
      ...(Number.isFinite(reserveRaw) ? { minCashReservePct: reserveRaw } : {}),
      ...(Number.isFinite(capRaw)     ? { maxRunDeploymentPct: capRaw }   : {}),
      ...(Number.isFinite(sectorRaw)  ? { sectorExposureCap: sectorRaw }  : {}),
      ...(Number.isFinite(riskRaw)    ? { portfolioRiskBudget: riskRaw }  : {}),
      ...(Number.isFinite(convOvRaw)  ? { convictionOverrideReservePct: convOvRaw } : {}),
    });
    process.stderr.write(JSON.stringify({ info: 'portfolio_complete', run_id: summary.run_id, nav: summary.equity_nav, open: summary.open_positions.length }) + '\n');
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'portfolio_engine_failed', detail: e.message }) + '\n');
    process.exit(1);
  }
}
