/**
 * Virtual Portfolio — Allocation Engine
 *
 * Deterministic capital allocation across APPROVED shadow decisions.
 * Pure functions, no I/O. Same input → same output, always.
 *
 * Rules (v1, conservative):
 *   - consume only approved decisions (decision.execution_ready === true)
 *   - MAX_OPEN_POSITIONS open at once
 *   - MAX_PCT_PER_POSITION of NAV per new position
 *   - MAX_GROSS_LEVERAGE cap on gross_exposure / NAV (default 1.0 = no leverage)
 *   - no duplicate symbol exposure (skip symbols already open)
 *   - rank by: confidence desc → indicator freshness asc → alignment → symbol asc
 *   - if a new position would be smaller than MIN_PCT_PER_POSITION of NAV, skip it
 *   - if nothing qualifies, keep cash
 *
 * Leverage: configurable via leverageCap argument but HARD-CAPPED at MAX_LEVERAGE_HARD_CAP.
 * Default leverageCap = 1.0 (disabled). Any value above the hard cap is clamped.
 *
 * Usage (module): import { allocate, ALLOC_RULES } from './allocation_engine.mjs'
 */

import { usdToEur, dirFactor, getActiveBlock } from './portfolio_state.mjs';

export const ALLOC_RULES = Object.freeze({
  MAX_OPEN_POSITIONS:    5,
  MAX_PCT_PER_POSITION:  0.05,   // 5% of NAV — overridable via positionOverrides (matches auto_open.mjs score table)
  MIN_PCT_PER_POSITION:  0.05,   // 5% of NAV — below this, skip (all-or-nothing: full 5% or skip)
  DEFAULT_LEVERAGE_CAP:  1.0,    // no leverage by default
  MAX_LEVERAGE_HARD_CAP: 2.0,    // absolute ceiling for gross-exposure cap; per-position leverage metadata is not capped here
  // Cash/allocation policy (entry-side only — never touches existing positions):
  DEFAULT_MIN_CASH_RESERVE_PCT:   0.20,  // hard cash floor as fraction of NAV; 0 disables
  DEFAULT_MAX_RUN_DEPLOYMENT_PCT: 0.25,  // max NEW notional per run_id as fraction of NAV; >= 1.0 disables
  // Conviction override (opt-in): a reduced cash floor that applies ONLY to
  // full-conviction (★★★★★) candidates. Lets a genuinely "absolutely sure"
  // setup draw cash below the normal reserve. Every other gate stays in force.
  DEFAULT_CONVICTION_OVERRIDE_RESERVE_PCT: 0.10,  // reduced floor for qualifying candidates
  // Portfolio-aware hard gates (entry-side only — never touches existing positions):
  DEFAULT_SECTOR_EXPOSURE_CAP:    0.40,  // max committed notional per sector as fraction of NAV; >= 1.0 disables
  DEFAULT_PORTFOLIO_RISK_BUDGET:  0.06,  // max NAV at risk (Σ notional_eur * stop_loss_pct/100); >= 1.0 disables
  RISK_UNKNOWN_SL_PCT:            20,    // conservative SL% assumed for risk accounting when a position has no usable stop loss (= max plausible stop per risk_engine bounds)
  // Aged-profit review (observability flag only — no auto-close):
  AGED_PROFIT_REVIEW_MIN_DAYS:    21,   // position must be open at least this many calendar days
  AGED_PROFIT_REVIEW_MIN_PNL_PCT:  5,   // unrealised gain on notional (%) must meet or exceed this
});

// Conviction-based risk sizing (opt-in via opts.convictionSizing).
// Deterministic score→risk_pct bands: a higher conviction score permits a larger
// per-trade risk budget (fraction of NAV at risk), never a larger raw size directly.
// Notional is then derived from risk_pct and the stop-loss distance, and capped by
// MAX_PCT_PER_POSITION. Bands mirror the 0.2…1.0 confidence_score_normalized scale
// (★…★★★★★). The aggregate portfolio_risk_budget remains the hard ceiling above this.
export const CONVICTION_RISK_BANDS = Object.freeze([
  { min_score: 1.0,  risk_pct: 0.020 },  // ★★★★★
  { min_score: 0.8,  risk_pct: 0.015 },  // ★★★★
  { min_score: 0.6,  risk_pct: 0.010 },  // ★★★
  { min_score: 0.4,  risk_pct: 0.0075 }, // ★★
  { min_score: 0.0,  risk_pct: 0.005 },  // ★ / fallback
]);

// Full-conviction threshold: the normalized confidence at which a candidate is a
// true ★★★★★ setup (R=LOW + K=ja + T=ja + RSI✓=ja → computeConfidenceScore=1.0).
// This is the SOLE gate that makes a candidate eligible for the conviction override.
// Because K=ja only arises from verified catalyst research, the override is
// structurally inert until that research has been fed into the decision engine.
export const CONVICTION_FULL_THRESHOLD = 1.0;

/** convictionRiskPct — deterministic score→risk_pct lookup (first band whose min_score is met). */
export function convictionRiskPct(score) {
  const s = Number.isFinite(score) ? score : 0;
  for (const band of CONVICTION_RISK_BANDS) {
    if (s >= band.min_score) return band.risk_pct;
  }
  return CONVICTION_RISK_BANDS[CONVICTION_RISK_BANDS.length - 1].risk_pct;
}

const ALIGNMENT_RANK = { confirmed: 0, partial: 1, neutral: 2, unavailable: 3, conflicted: 4 };

/**
 * rankApproved — deterministic ordering of approved intents.
 */
export function rankApproved(approved) {
  return [...approved].sort((a, b) => {
    const ai = a.intent, bi = b.intent;
    // 1. confidence desc
    const conf = (bi.confidence_score_normalized ?? 0) - (ai.confidence_score_normalized ?? 0);
    if (conf !== 0) return conf;
    // 2. fresher indicators first (lower age)
    const aAge = ai.technical?.age_minutes ?? Infinity;
    const bAge = bi.technical?.age_minutes ?? Infinity;
    if (aAge !== bAge) return aAge - bAge;
    // 3. better alignment first
    const al = (ALIGNMENT_RANK[ai.technical_alignment] ?? 9) - (ALIGNMENT_RANK[bi.technical_alignment] ?? 9);
    if (al !== 0) return al;
    // 4. symbol asc (stable, deterministic tiebreak)
    return ai.symbol < bi.symbol ? -1 : ai.symbol > bi.symbol ? 1 : 0;
  });
}

/**
 * allocate — decide which approved candidates open as new positions.
 *
 * @param {object}   state          — current portfolio state (already marked/recomputed)
 * @param {object[]} approved       — [{ intent, decision }] with execution_ready=true
 * @param {object}   opts           — { leverageCap?: number, runId: string }
 * @returns {{ newPositions: object[], skipped: object[] }}
 */
export function allocate(state, approved, opts = {}) {
  const leverageCap = Math.min(
    opts.leverageCap ?? ALLOC_RULES.DEFAULT_LEVERAGE_CAP,
    ALLOC_RULES.MAX_LEVERAGE_HARD_CAP,
  );
  const runId = opts.runId ?? null;

  // Optional: restrict allocation to an explicit symbol set.
  // Set<string> | null — when non-null, any candidate not in the set is skipped.
  const symbolsFilter = opts.symbolsFilter instanceof Set ? opts.symbolsFilter : null;

  // Optional: per-symbol sizing overrides.
  // { [symbol]: { target_position_pct?: number, leverage?: number, stop_loss_pct?: number } }
  // target_position_pct and stop_loss_pct use the same unit as their defaults (fraction / percent).
  // stop_loss_pct: if value < 1 it is treated as a fraction and converted to percent (0.03 → 3).
  // leverage: stored as metadata only — cash is still reduced by notional (no true margin model).
  const positionOverrides = (opts.positionOverrides != null && typeof opts.positionOverrides === 'object')
    ? opts.positionOverrides
    : {};

  const openSymbols = new Set(state.open_positions.map(p => p.symbol));
  const ranked      = rankApproved(approved);

  // Post-SL run-level cooldown (opt-in): suppress ALL new allocations in the
  // run in which a stop_loss_hit fired. Applies to every engine invocation
  // against the same run_id. runId=null never triggers (null-guard).
  if (opts.postSlCooldown === true && runId != null && state.last_sl_run_id === runId) {
    return {
      newPositions:    [],
      skipped:         ranked.map(item => ({ symbol: item.intent.symbol, reason: 'post_sl_cooldown' })),
      leverageCapUsed: leverageCap,
    };
  }

  const newPositions = [];
  const skipped      = [];

  // Mutable working copies of the constraints
  let openCount     = state.open_positions.length;
  let cash          = state.cash;
  let grossExposure = state.gross_exposure;
  const nav         = state.equity_nav;
  const grossCap    = nav * leverageCap;

  // ── Cash/allocation policy (entry-side only) ────────────────────────────────
  // Hard cash floor: only cash above reservePct × NAV may be consumed.
  const reservePct = opts.minCashReservePct ?? ALLOC_RULES.DEFAULT_MIN_CASH_RESERVE_PCT;
  const reserveEur = reservePct > 0 ? +(reservePct * nav).toFixed(4) : 0;

  // ── Conviction override (opt-in) ────────────────────────────────────────────
  // When enabled, a candidate whose confidence_score_normalized reaches
  // CONVICTION_FULL_THRESHOLD (a true ★★★★★ setup) may consume cash down to the
  // REDUCED override floor instead of the normal reserve. Non-qualifying
  // candidates always see the full reserveEur. No other gate is relaxed —
  // sector cap, risk budget, run-deployment cap, max_open and blocks all apply
  // unchanged. Disabled by default (override off → effReserveEur == reserveEur).
  const convictionOverride = opts.convictionOverride === true;
  const convReservePct = opts.convictionOverrideReservePct ?? ALLOC_RULES.DEFAULT_CONVICTION_OVERRIDE_RESERVE_PCT;
  const convReserveEur = convReservePct > 0 ? +(convReservePct * nav).toFixed(4) : 0;
  // Per-run deployment budget (EUR), computed by the engine per run_id.
  // null = no cap (cap disabled or runId unavailable). Decremented per accepted position.
  let runBudget = (opts.runBudgetEur != null && Number.isFinite(opts.runBudgetEur))
    ? opts.runBudgetEur
    : null;

  // ── Portfolio-aware hard gates (entry-side only) ────────────────────────────
  // sector_exposure_cap   — max sectorCap × NAV committed notional per sector.
  // portfolio_risk_budget — max riskBudget × NAV at risk, where one position's
  //   risk = notional_eur × stop_loss_pct / 100, aggregated over open + new
  //   positions. Both track positions opened earlier in THIS run (cumulative).
  // Disabled when the fraction is >= 1.0 (room = Infinity → never binds).
  // Legacy-tolerant: positions without `sector` are NOT attributed to any named
  // sector; positions without stop_loss_pct contribute 0 risk.
  const sectorCap     = opts.sectorExposureCap   ?? ALLOC_RULES.DEFAULT_SECTOR_EXPOSURE_CAP;
  const riskBudget    = opts.portfolioRiskBudget ?? ALLOC_RULES.DEFAULT_PORTFOLIO_RISK_BUDGET;
  // Conviction-based, stop-loss-derived sizing (opt-in). When off, the legacy
  // target_position_pct sizing is used (fully backward compatible).
  const convictionSizing = opts.convictionSizing === true;
  const sectorCapOn   = sectorCap  < 1.0;
  const riskBudgetOn  = riskBudget < 1.0;
  const sectorCapEur  = sectorCapOn  ? +(sectorCap  * nav).toFixed(4) : Infinity;
  const riskBudgetEur = riskBudgetOn ? +(riskBudget * nav).toFixed(4) : Infinity;

  // Running per-sector committed notional (EUR) from existing open positions.
  const sectorExposure = {};
  for (const p of state.open_positions) {
    const sec = p.sector ?? null;
    if (sec == null) continue;   // legacy/unsectored: not counted against a named sector
    sectorExposure[sec] = +((sectorExposure[sec] ?? 0) + (p.notional_eur ?? 0)).toFixed(4);
  }
  // Running portfolio at-risk (EUR) from existing open positions.
  // No-stop-loss policy: a position whose risk cannot be measured is NOT treated
  // as 0 risk (that would understate exposure and let new entries through too
  // easily). It is charged conservatively at RISK_UNKNOWN_SL_PCT so unbounded
  // legacy/manual positions consume the budget (fail-closed).
  let portfolioAtRisk = 0;
  for (const p of state.open_positions) {
    const slForRisk = (p.stop_loss_pct != null && p.stop_loss_pct > 0)
      ? p.stop_loss_pct
      : ALLOC_RULES.RISK_UNKNOWN_SL_PCT;
    portfolioAtRisk += (p.notional_eur ?? 0) * (slForRisk / 100);
  }
  portfolioAtRisk = +portfolioAtRisk.toFixed(4);

  for (const item of ranked) {
    const intent = item.intent;
    const symbol = intent.symbol;

    // Rule: symbols filter (explicit allow-list)
    if (symbolsFilter !== null && !symbolsFilter.has(symbol)) {
      skipped.push({ symbol, reason: 'not_in_symbols_filter' });
      continue;
    }
    // Rule: max open positions
    if (openCount >= ALLOC_RULES.MAX_OPEN_POSITIONS) {
      skipped.push({ symbol, reason: 'max_open_positions_reached' });
      continue;
    }
    // Rule: no duplicate symbol
    if (openSymbols.has(symbol)) {
      skipped.push({ symbol, reason: 'symbol_already_open' });
      continue;
    }
    // Rule: block list — do not reopen a manually closed or post-SL-locked symbol+side.
    // Skip reason is derived from the block origin (missing origin = legacy manual block).
    const activeBlock = getActiveBlock(state, symbol, intent.side);
    if (activeBlock) {
      skipped.push({
        symbol,
        reason: activeBlock.origin === 'stop_loss' ? 'post_sl_symbol_blocked' : 'manual_close_blocked',
      });
      continue;
    }
    // Need a mark price to size and track
    const priceEur = usdToEur(intent.price_usd);
    if (priceEur == null || priceEur <= 0) {
      skipped.push({ symbol, reason: 'no_price_for_sizing' });
      continue;
    }

    // Per-symbol overrides (all optional — fall back to engine defaults)
    const ov = positionOverrides[symbol] ?? {};
    // target_position_pct: fraction of NAV — overrides MAX_PCT_PER_POSITION
    const targetPct = ov.target_position_pct != null
      ? ov.target_position_pct
      : ALLOC_RULES.MAX_PCT_PER_POSITION;
    // leverage: metadata only — does NOT change how cash is reduced
    const posLeverage = ov.leverage != null ? ov.leverage : leverageCap;
    // stop_loss_pct: if fraction (<1) convert to percent; else use as-is
    const overrideSlPct = ov.stop_loss_pct != null
      ? (ov.stop_loss_pct < 1 ? +(ov.stop_loss_pct * 100).toFixed(4) : ov.stop_loss_pct)
      : null;

    // Target margin = targetPct of NAV, clamped by reserve-adjusted cash, gross
    // capacity and the per-run deployment budget.
    // NOTE: cash is reduced by the full margin (= notionalEur here).
    // Leverage is stored as metadata — it does NOT reduce the cash cost.
    // stop_loss_pct this position will carry (override wins, else risk default).
    const posSlPct = overrideSlPct ?? (intent.risk?.stop_loss_pct ?? null);
    const posSector = intent.sector ?? null;

    // No-stop-loss policy (fail-closed): a new entry whose risk cannot be bounded
    // (no usable stop loss) is not sized at all — a missing SL must never make a
    // fresh approval easier. Triggers when the risk budget is active OR when
    // conviction sizing is on (which derives notional FROM the stop-loss distance
    // and therefore strictly requires a valid SL). Skipped with an explicit
    // machine-readable reason for manual review.
    if ((riskBudgetOn || convictionSizing) && (posSlPct == null || posSlPct <= 0)) {
      skipped.push({ symbol, reason: 'risk_unknown' });
      continue;
    }

    // Target notional:
    //  - conviction sizing ON  → risk_eur (= convictionRiskPct(score) × NAV) divided
    //    by the stop-loss distance, capped by MAX_PCT/override (tiny SL cannot blow
    //    up the size). Higher conviction ⇒ larger risk_pct ⇒ larger size; larger SL
    //    ⇒ smaller size. SL is guaranteed valid here (guard above).
    //  - conviction sizing OFF → legacy target_position_pct × NAV (unchanged).
    let targetNotional, sizedBy, riskPctAtEntry = null;
    if (convictionSizing) {
      riskPctAtEntry      = convictionRiskPct(intent.confidence_score_normalized);
      const riskEur       = riskPctAtEntry * nav;
      const slBasedNotional = riskEur / (posSlPct / 100);
      targetNotional      = Math.min(slBasedNotional, targetPct * nav);
      sizedBy             = 'conviction_risk';
    } else {
      targetNotional      = targetPct * nav;
      sizedBy             = 'target_pct';
    }
    // Conviction override: this candidate qualifies only if the override is on
    // AND it is a true full-conviction (★★★★★) setup. Qualifying candidates use
    // the reduced floor; all others use the normal reserve.
    const qualifiesConviction = convictionOverride
      && (intent.confidence_score_normalized ?? 0) >= CONVICTION_FULL_THRESHOLD;
    const effReserveEur       = qualifiesConviction ? convReserveEur : reserveEur;

    const grossRoom      = Math.max(0, grossCap - grossExposure);
    const availableCashNormal = Math.max(0, cash - reserveEur);     // capacity under the NORMAL floor
    const availableCash  = Math.max(0, cash - effReserveEur);
    const budgetRoom     = runBudget === null ? Infinity : Math.max(0, runBudget);
    // sector_exposure_cap: remaining notional room for this position's sector.
    // Infinity when disabled or the position has no named sector (legacy-tolerant).
    const sectorRoom     = (sectorCapOn && posSector != null)
      ? Math.max(0, +(sectorCapEur - (sectorExposure[posSector] ?? 0)).toFixed(4))
      : Infinity;
    // portfolio_risk_budget: remaining at-risk budget translated into a notional
    // ceiling via this position's stop_loss_pct. Infinity when disabled or the
    // position carries no usable stop loss (cannot bound its risk contribution).
    const riskRoom       = (riskBudgetOn && posSlPct != null && posSlPct > 0)
      ? +(Math.max(0, +(riskBudgetEur - portfolioAtRisk).toFixed(4)) / (posSlPct / 100)).toFixed(4)
      : Infinity;
    const notionalEur    = +Math.min(targetNotional, availableCash, grossRoom, budgetRoom, sectorRoom, riskRoom).toFixed(4);

    const minNotional = +(ALLOC_RULES.MIN_PCT_PER_POSITION * nav).toFixed(4);
    if (notionalEur < minNotional) {
      // Attribution rule (deterministic): the smallest binding clamp wins.
      // Tie-break precedence (highest first):
      //   sector_exposure_cap → portfolio_risk_budget → run_deployment_cap →
      //   cash_reserve_floor → insufficient_capacity
      // Portfolio-aware gates rank above cash/budget clamps so klumpen-/risk-
      // driven skips are never mislabelled as a cash problem. cash_reserve_floor
      // applies only when UNRESERVED cash would have sufficed (i.e. the reserve
      // itself was the binding factor).
      let reason = 'insufficient_capacity';
      const smallest = Math.min(availableCash, grossRoom, budgetRoom, sectorRoom, riskRoom);
      if (sectorRoom <= smallest && sectorRoom < minNotional) {
        reason = 'sector_exposure_cap';
      } else if (riskRoom <= smallest && riskRoom < minNotional) {
        reason = 'portfolio_risk_budget';
      } else if (runBudget !== null && budgetRoom <= smallest && budgetRoom < minNotional) {
        reason = 'run_deployment_cap';
      } else if (effReserveEur > 0 && availableCash <= smallest && availableCash < minNotional && cash >= minNotional) {
        reason = 'cash_reserve_floor';
      }
      skipped.push({ symbol, reason, notional_eur: notionalEur });
      continue;
    }

    // sizing_constraint: which clamp shrank the position below target size.
    // null = full target size. Same precedence as the attribution rule above.
    let sizingConstraint = null;
    if (notionalEur + 0.00005 < targetNotional) {
      const minRoom = Math.min(availableCash, grossRoom, budgetRoom, sectorRoom, riskRoom);
      if (sectorRoom <= minRoom) {
        sizingConstraint = 'sector_exposure_cap';
      } else if (riskRoom <= minRoom) {
        sizingConstraint = 'portfolio_risk_budget';
      } else if (runBudget !== null && budgetRoom <= minRoom) {
        sizingConstraint = 'run_deployment_cap';
      } else if (availableCash <= minRoom) {
        sizingConstraint = effReserveEur > 0 ? 'cash_reserve_floor' : 'cash';
      } else {
        sizingConstraint = 'gross_room';
      }
    }

    // Conviction override was load-bearing iff a qualifying ★★★★★ candidate
    // opened a position larger than the NORMAL reserve floor would have allowed.
    // (qualifying but well within the normal floor → override changed nothing → false.)
    const convictionOverrideApplied = qualifiesConviction
      && notionalEur > availableCashNormal + 0.00005;

    const quantity = +(notionalEur / priceEur).toFixed(8);

    const position = {
      symbol,
      asset_type:      intent.asset_type,
      side:            intent.side,
      quantity,
      notional_eur:    notionalEur,        // = margin (cash cost); NOT leveraged notional
      entry_price_usd: intent.price_usd,
      entry_price_eur: +priceEur.toFixed(6),
      mark_price_usd:  intent.price_usd,
      mark_price_eur:  +priceEur.toFixed(6),
      unrealized_pnl_eur: 0,
      stop_loss_pct:   posSlPct,
      take_profit_pct: opts.takeProfitPct ?? null,  // opt-in; null = no auto take-profit
      sector:          posSector,          // additive: enables sector_exposure_cap; legacy positions may lack it
      sized_by:        sizedBy,            // 'conviction_risk' | 'target_pct'
      risk_pct_at_entry: riskPctAtEntry,   // per-trade risk budget used for sizing (null when target_pct sizing)
      sizing_constraint: sizingConstraint, // which clamp shrank the position (null = full size)
      conviction_override_applied: convictionOverrideApplied, // true = ★★★★★ override drew cash below the normal floor
      leverage:        posLeverage,        // metadata only — see note above
      entry_timestamp: new Date().toISOString(),
      entry_run_id:    runId,
      strategy:        intent.strategy ?? 'unknown',
      thesis:          `${intent.side} ${symbol} — ${intent.strategy ?? 'unknown'}, conf=${intent.confidence_score_normalized}`,
      decision_source: {
        decision_id:     item.decision.decision_id,
        intent_id:       intent.intent_id,
        confidence:      intent.confidence_score_normalized,
        technical_alignment: intent.technical_alignment,
        risk_tier:       intent.risk_tier,
      },
      // ── Scan-time catalyst context (Schritt 3) ────────────────────────────────
      // Set once at open from the entry intent. Read-only after position is created.
      // k_at_entry reflects the 48h K-Regel result at the moment of entry decision.
      // catalyst_recognized_at records when that assessment was made in the scan run.
      k_at_entry:             intent.katalysator ?? null,
      catalyst_recognized_at: intent.intent_created_at ?? null,
      // ── Position-level thesis fields (Schritt 3) ─────────────────────────────
      // Operator-managed. Never mutated automatically by the engine.
      // thesis_valid_until and catalyst_event_date can be set via updateThesisFields().
      thesis_status:          'active',
      thesis_valid_until:     null,
      catalyst_event_date:    null,
      thesis_last_reviewed_at: null,
      // Non-persisted: full {intent, decision} for routing through PaperBroker.
      // The portfolio engine strips this before saving state.
      _source: item,
    };

    newPositions.push(position);
    openSymbols.add(symbol);
    openCount     += 1;
    cash          -= notionalEur;
    grossExposure += Math.abs(quantity * priceEur);
    if (runBudget !== null) runBudget = +(runBudget - notionalEur).toFixed(4);
    // Advance portfolio-aware aggregates so later candidates in this run see the
    // freshly committed sector exposure and at-risk amount (cumulative within run).
    if (posSector != null) {
      sectorExposure[posSector] = +((sectorExposure[posSector] ?? 0) + notionalEur).toFixed(4);
    }
    if (posSlPct != null && posSlPct > 0) {
      portfolioAtRisk = +(portfolioAtRisk + notionalEur * (posSlPct / 100)).toFixed(4);
    }
  }

  return { newPositions, skipped, leverageCapUsed: leverageCap };
}
