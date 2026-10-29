/**
 * Risk Engine
 *
 * Deterministic validation of TradeIntents before the execution gate.
 * Each check is an independent function returning a RiskCheckResult.
 * Checks marked placeholder=true always pass but are logged for auditability.
 *
 * Thresholds are tunable constants — change here, not in logic.
 *
 * Usage (module): import { runAllChecks } from './risk_engine.mjs'
 */

import { makeRiskCheck, makeGateResult } from './schemas.mjs';

// ─── Thresholds ──────────────────────────────────────────────────────────────

const MAX_PRICE_AGE_MINUTES     = 120;   // reject if scan data is older than 2h
const MAX_INDICATOR_AGE_MINUTES = 90;    // reject if RSI/MACD is older than 90 min
const MAX_STOP_LOSS_PCT         = 20;    // reject absurdly wide stop losses
const MIN_STOP_LOSS_PCT         = 0.5;  // reject near-zero stop losses
const MAX_POSITION_PCT          = 10;   // reject oversized positions
const MIN_POSITION_PCT          = 0.1;  // reject dust positions

// ─── Individual checks ───────────────────────────────────────────────────────

function checkStalePriceData(intent) {
  const age = intent.data_freshness?.price_age_minutes;
  if (age == null) return makeRiskCheck('stale_price_data', false, 'price_age_minutes missing from data_freshness');
  if (age > MAX_PRICE_AGE_MINUTES) {
    return makeRiskCheck('stale_price_data', false, `price data is ${age}min old (max ${MAX_PRICE_AGE_MINUTES}min)`);
  }
  return makeRiskCheck('stale_price_data', true);
}

function checkStaleIndicatorData(intent) {
  if (!intent.technical?.available) {
    return makeRiskCheck('stale_indicator_data', false, `technical data unavailable: reason=${intent.technical?.reason ?? 'unknown'}`);
  }
  const age = intent.technical?.age_minutes;
  if (age == null) return makeRiskCheck('stale_indicator_data', false, 'indicator age_minutes missing');
  if (age > MAX_INDICATOR_AGE_MINUTES) {
    return makeRiskCheck('stale_indicator_data', false, `indicator data is ${age}min old (max ${MAX_INDICATOR_AGE_MINUTES}min)`);
  }
  return makeRiskCheck('stale_indicator_data', true);
}

function checkStaleNewsData(intent) {
  // Placeholder: news timestamp not yet machine-tracked.
  // When news_age_hours is available, enforce a 48h limit.
  const age = intent.data_freshness?.news_age_hours;
  if (age == null) {
    return makeRiskCheck('stale_news_data', true, null, /* placeholder */ true);
  }
  if (age > 48) {
    return makeRiskCheck('stale_news_data', false, `news data is ${age}h old (max 48h)`);
  }
  return makeRiskCheck('stale_news_data', true);
}

function checkMissingTimestamps(intent) {
  const required = ['signal_timestamp', 'intent_created_at'];
  const missing  = required.filter(k => !intent[k]);
  if (missing.length > 0) {
    return makeRiskCheck('missing_timestamps', false, `missing required timestamps: ${missing.join(', ')}`);
  }
  return makeRiskCheck('missing_timestamps', true);
}

function checkTechnicalConflict(intent) {
  const alignment = intent.technical_alignment;

  // UNAVAILABLE is already hard-blocked by checkStaleIndicatorData — avoid double-gating
  if (alignment === 'unavailable') {
    return makeRiskCheck('technical_conflict', true, 'unavailable — deferred to stale_indicator_data check', true);
  }

  if (alignment === 'conflicted') {
    // Swing Trading: risk tier A (LOW) with full indicator conflict → warning, not hard block.
    // Rationale: a strong catalyst in a LOW-risk setup can override short-term technical noise.
    // Tiers B/C/D retain the hard block — elevated risk leaves no room for technical uncertainty.
    if (intent.risk_tier === 'A') {
      return makeRiskCheck(
        'technical_conflict', true,
        `swing_warning: both indicators conflict with ${intent.side} direction (tier A — catalyst may override)`,
        true,
      );
    }
    return makeRiskCheck(
      'technical_conflict', false,
      `technical indicators conflict with ${intent.side} direction (risk_tier ${intent.risk_tier ?? 'unknown'})`,
    );
  }

  return makeRiskCheck('technical_conflict', true);
}

function checkUnsupportedAssetType(intent) {
  const supported = ['stock', 'crypto'];
  if (!supported.includes(intent.asset_type)) {
    return makeRiskCheck('unsupported_asset_type', false, `asset_type '${intent.asset_type}' is not supported for execution`);
  }
  return makeRiskCheck('unsupported_asset_type', true);
}

function checkStopLoss(intent) {
  const sl = intent.risk?.stop_loss_pct;
  if (sl == null) return makeRiskCheck('invalid_stop_loss', false, 'stop_loss_pct is missing');
  if (sl < MIN_STOP_LOSS_PCT) return makeRiskCheck('invalid_stop_loss', false, `stop_loss_pct ${sl}% is below minimum ${MIN_STOP_LOSS_PCT}%`);
  if (sl > MAX_STOP_LOSS_PCT) return makeRiskCheck('invalid_stop_loss', false, `stop_loss_pct ${sl}% exceeds maximum ${MAX_STOP_LOSS_PCT}%`);
  return makeRiskCheck('invalid_stop_loss', true);
}

function checkPositionSize(intent) {
  const pos = intent.risk?.suggested_position_pct;
  if (pos == null) return makeRiskCheck('invalid_position_size', false, 'suggested_position_pct is missing');
  if (pos < MIN_POSITION_PCT) return makeRiskCheck('invalid_position_size', false, `position ${pos}% below minimum ${MIN_POSITION_PCT}%`);
  if (pos > MAX_POSITION_PCT) return makeRiskCheck('invalid_position_size', false, `position ${pos}% exceeds maximum ${MAX_POSITION_PCT}%`);
  return makeRiskCheck('invalid_position_size', true);
}

function checkExtremeRisk(intent) {
  if (intent.risk_tier === 'D') {
    return makeRiskCheck('extreme_risk', false, 'risk_tier D (EXTREME) is never execution-eligible');
  }
  return makeRiskCheck('extreme_risk', true);
}

// ─── Placeholder checks (structure is real; data sources not yet wired) ─────

function checkPortfolioRiskLimit(intent) {
  // PLACEHOLDER: requires live account value and current positions.
  // When live: reject if this trade would push total portfolio risk > X%.
  return makeRiskCheck('portfolio_risk_limit', true, null, /* placeholder */ true);
}

function checkDuplicatePosition(intent) {
  // PLACEHOLDER: requires live position list from broker.
  // When live: reject if symbol already has an open position in same direction.
  return makeRiskCheck('duplicate_position', true, null, /* placeholder */ true);
}

function checkMarketSession(intent) {
  // PLACEHOLDER: requires market hours lookup per asset type / exchange.
  // When live: reject if market is closed or pre/post hours without explicit approval.
  return makeRiskCheck('market_session', true, null, /* placeholder */ true);
}

function checkLiquiditySpread(intent) {
  // PLACEHOLDER: requires live bid/ask spread from broker quote.
  // When live: reject if spread exceeds a threshold fraction of stop loss.
  return makeRiskCheck('liquidity_spread', true, null, /* placeholder */ true);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * runAllChecks — run every risk check against a TradeIntent.
 * Returns a GateResult with pass/fail and all individual check results.
 *
 * @param {object} intent — TradeIntent (from decision_engine)
 * @returns {GateResult}
 */
export function runAllChecks(intent) {
  const checks = [
    checkExtremeRisk(intent),
    checkUnsupportedAssetType(intent),
    checkMissingTimestamps(intent),
    checkStalePriceData(intent),
    checkStaleIndicatorData(intent),
    checkStaleNewsData(intent),
    checkTechnicalConflict(intent),
    checkStopLoss(intent),
    checkPositionSize(intent),
    // Placeholders — always pass but are logged
    checkPortfolioRiskLimit(intent),
    checkDuplicatePosition(intent),
    checkMarketSession(intent),
    checkLiquiditySpread(intent),
  ];

  return makeGateResult(checks);
}

/**
 * runCheck — run a single named check (for targeted re-validation).
 */
export function runCheck(checkName, intent) {
  const map = {
    stale_price_data:      () => checkStalePriceData(intent),
    stale_indicator_data:  () => checkStaleIndicatorData(intent),
    stale_news_data:       () => checkStaleNewsData(intent),
    missing_timestamps:    () => checkMissingTimestamps(intent),
    technical_conflict:    () => checkTechnicalConflict(intent),
    unsupported_asset_type:() => checkUnsupportedAssetType(intent),
    invalid_stop_loss:     () => checkStopLoss(intent),
    invalid_position_size: () => checkPositionSize(intent),
    extreme_risk:          () => checkExtremeRisk(intent),
    portfolio_risk_limit:  () => checkPortfolioRiskLimit(intent),
    duplicate_position:    () => checkDuplicatePosition(intent),
    market_session:        () => checkMarketSession(intent),
    liquidity_spread:      () => checkLiquiditySpread(intent),
  };

  const fn = map[checkName];
  if (!fn) throw new Error(`Unknown risk check: ${checkName}`);
  return fn();
}
