#!/usr/bin/env node
/**
 * Auto Open — fully automatic position open for Claude-researched setups.
 *
 * Looks up the current cache price automatically, derives SL + notional from
 * score, enforces all policies (cash floor, max positions, blocked symbols),
 * and routes through the full Paper Broker lifecycle — no manual price entry needed.
 *
 * Usage:
 *   node auto_open.mjs --symbol SMCI --side long  --score 8 --reason "earnings_beat_aug11"
 *   node auto_open.mjs --symbol SOFI --side short --score 7 --reason "momentum_short_thesis"
 *
 * Optional:
 *   --category    stock | crypto  (default: stock)
 *   --notional-eur <EUR>          override position size (default: score-based)
 *   --dry-run                     no writes
 */

import fs                    from 'node:fs';
import path                  from 'node:path';
import { spawnSync }         from 'node:child_process';
import { fileURLToPath }     from 'node:url';

import {
  loadOrInit, save, recompute, appendHistory, appendLedger,
  usdToEur, EUR_USD_RATE,
} from './portfolio/portfolio_state.mjs';
import { PaperBroker } from './paper_broker.mjs';
import { auditLog }    from './audit_log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '../../trading/cache');

// ─── Structural TP via SMC pivot analysis ────────────────────────────────────
// Calls structural_tp.py; falls back silently to fixed TP on any failure.
// Principle: TP of a LONG = nearest Supply Zone (swing high) above entry
//            TP of a SHORT = nearest Demand Zone (swing low) below entry

function getStructuralTp(sym, side, entryPriceUsd, slPct) {
  const script = path.join(__dirname, '../structural_tp.py');
  if (!fs.existsSync(script)) return null;
  try {
    const result = spawnSync('python', [
      script,
      '--symbol', sym,
      '--side',   side,
      '--entry',  String(entryPriceUsd),
      '--sl-pct', String(slPct),
    ], { encoding: 'utf8', timeout: 6000 });
    if (result.status !== 0 || !result.stdout?.trim()) return null;
    const parsed = JSON.parse(result.stdout.trim());
    if (!parsed.available) return null;
    return parsed; // { available, tp_price_usd, tp_pct, rr, source }
  } catch {
    return null;
  }
}

// ─── Score → execution params (from CLAUDE.md leverage table) ────────────────

const SCORE_PARAMS = {
  10: { sl_pct: 2.0, notional_pct: 0.05, take_profit_pct: 20, breakeven_trigger_pct: 8, trailing_stop_distance_pct: 5 },
  9:  { sl_pct: 2.5, notional_pct: 0.05, take_profit_pct: 20, breakeven_trigger_pct: 8, trailing_stop_distance_pct: 5 },
  8:  { sl_pct: 3.3, notional_pct: 0.05, take_profit_pct: 18, breakeven_trigger_pct: 8, trailing_stop_distance_pct: 5 },
  7:  { sl_pct: 5.0, notional_pct: 0.03, take_profit_pct: null, breakeven_trigger_pct: null },
  6:  { sl_pct: 5.0, notional_pct: 0.03, take_profit_pct: null, breakeven_trigger_pct: null },
};

// ─── CLI parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return args;
}

const args     = parseArgs(process.argv.slice(2));
const symbol   = args.symbol   ? String(args.symbol).toUpperCase() : null;
const side     = args.side     ? String(args.side).toLowerCase()   : null;
const score    = args.score    ? parseInt(args.score, 10)          : null;
const reason   = args.reason   ? String(args.reason)               : null;
const category = args.category ? String(args.category).toLowerCase() : 'stock';
const sector   = args.sector   ? String(args.sector).toLowerCase() : null;
const dryRun   = args.dryRun === true || args.dryRun === 'true';
const notionalOverride = args.notionalEur ? parseFloat(args.notionalEur) : null;
const priceUsdOverride = args.priceUsd   ? parseFloat(args.priceUsd)   : null;
const runId    = `auto_${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '_')}`;

// ─── Validation ───────────────────────────────────────────────────────────────

const errors = [];
if (!symbol)                                              errors.push('--symbol is required');
if (!side || !['long', 'short'].includes(side))           errors.push('--side must be "long" or "short"');
if (score == null || isNaN(score))                        errors.push('--score is required (integer 6–10)');
else if (score < 6 || score > 10)                         errors.push('--score must be 6–10 (below 6 = not tradeable)');
else if (side === 'long' && score < 8)                    errors.push('--score for LONG must be ≥ 8 (LONG min-score policy — requires K=ja catalyst)');
if (side === 'long' && sector === 'ai_infrastructure')    errors.push('LONG ai_infrastructure blocked — sector WR 0%, -134 EUR over 5 trades; use SHORT side or wait for sector recovery');
if (!reason)                                              errors.push('--reason is required');
if (!['stock', 'crypto'].includes(category))              errors.push('--category must be "stock" or "crypto"');

if (errors.length) {
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  process.stderr.write(
    'usage: node auto_open.mjs --symbol SMCI --side long --score 8 --reason "earnings_beat"\n' +
    '       [--category stock|crypto] [--notional-eur 92] [--dry-run]\n'
  );
  process.exit(1);
}

// ─── Price lookup ─────────────────────────────────────────────────────────────

function lookupStockPrice(sym) {
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => f.startsWith('stocks_') && f.endsWith('.json'))
    .sort();
  if (!files.length) return null;
  const latest = path.join(CACHE_DIR, files[files.length - 1]);
  const data   = JSON.parse(fs.readFileSync(latest, 'utf8'));
  const quotes = data.quotes;
  const arr    = Array.isArray(quotes) ? quotes : Object.values(quotes || {});
  const entry  = arr.find(q => q && q.symbol === sym);
  if (!entry) return null;
  return { price_usd: entry.price_usd, source: files[files.length - 1], change_pct: entry.change_pct };
}

function lookupCryptoPrice(sym) {
  // 1) positioning_data.json — mark_price_usd is the most recent live price
  const posCachePath = path.join(CACHE_DIR, 'positioning_data.json');
  if (fs.existsSync(posCachePath)) {
    try {
      const pos    = JSON.parse(fs.readFileSync(posCachePath, 'utf8'));
      const symPos = pos[sym] || pos[sym?.toUpperCase()];
      if (symPos?.mark_price_usd) return { price_usd: symPos.mark_price_usd, source: 'positioning_cache' };
    } catch { /* fall through */ }
  }
  // 2) indicator_cache.json — RSI entry implies a recent price was fetched
  const cachePath = path.join(CACHE_DIR, 'indicator_cache.json');
  if (fs.existsSync(cachePath)) {
    try {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const entry = cache[sym];
      if (entry?.mark_price_usd) return { price_usd: entry.mark_price_usd, source: 'indicator_cache' };
    } catch { /* fall through */ }
  }
  return null;
}

const priceInfo = priceUsdOverride
  ? { price_usd: priceUsdOverride, source: 'price_usd_override' }
  : category === 'stock' ? lookupStockPrice(symbol) : lookupCryptoPrice(symbol);

if (!priceInfo || !priceInfo.price_usd) {
  process.stderr.write(JSON.stringify({
    error:    'price_not_found',
    symbol,
    category,
    detail:   `No cache price found for ${symbol}. Run scan.mjs first or use manual_open.mjs with --price-usd.`,
  }) + '\n');
  process.exit(1);
}

const priceUsd = priceInfo.price_usd;

// ─── Policy lookups ───────────────────────────────────────────────────────────

const state        = loadOrInit();
const nav          = state.equity_nav;
const scoreParams              = SCORE_PARAMS[score];
const stopLossPct              = scoreParams.sl_pct;
const breakevenTriggerPct      = scoreParams.breakeven_trigger_pct;

// Structural TP: try SMC-based level first, fall back to fixed score TP.
// Structural TP is only used when R:R >= 1.5 (enforced inside structural_tp.py).
const structTp = getStructuralTp(symbol, side, priceUsd, stopLossPct);
const takeProfitPct = structTp
  ? +structTp.tp_pct.toFixed(2)
  : scoreParams.take_profit_pct;
const tpSource = structTp
  ? structTp.source
  : 'fixed_score';

// Partial TP: use structural levels when available; fallback keeps single-TP behavior.
const tp1Pct = takeProfitPct;
const tp2Pct = structTp?.tp2_available ? +structTp.tp2_pct.toFixed(2) : null;
const hasPartialTp = tp2Pct != null;
const trailingStopDistancePct  = scoreParams.trailing_stop_distance_pct ?? null;
const thesisValidUntil         = score === 8
  ? new Date(Date.now() + 5 * 24 * 3_600_000).toISOString()
  : null;
const notionalEur              = notionalOverride ?? +(nav * scoreParams.notional_pct).toFixed(2);

// sl_not_before: stocks use yesterday's close as mark → cache lags AH/pre-market.
// Always grant 28h grace for stocks so the SL is evaluated against the real next-day close.
const slNotBefore = category === 'stock'
  ? new Date(Date.now() + 28 * 3_600_000).toISOString()
  : null;

// ─── Policy gates ─────────────────────────────────────────────────────────────

const policyErrors = [];

// Gate 1: Max positions
const MAX_POSITIONS = 5;
if (state.open_positions.length >= MAX_POSITIONS) {
  policyErrors.push(`max_positions_reached: ${state.open_positions.length}/${MAX_POSITIONS} open — close a position first`);
}

// Gate 2: Cash floor (20% NAV)
const CASH_FLOOR_PCT = 0.20;
const cashAfter = state.cash - notionalEur;
if (cashAfter < nav * CASH_FLOOR_PCT) {
  policyErrors.push(
    `cash_floor_violated: cash after open would be ${cashAfter.toFixed(0)} EUR ` +
    `(${(cashAfter / nav * 100).toFixed(1)}%), floor is ${(CASH_FLOOR_PCT * 100)}% of NAV (${(nav * CASH_FLOOR_PCT).toFixed(0)} EUR)`
  );
}

// Gate 3: Blocked symbols
const now = new Date();
const blocked = (state.blocked_symbols || []).find(b =>
  b.symbol === symbol && b.side === side &&
  (b.blocked_until == null || new Date(b.blocked_until) > now)
);
if (blocked) {
  policyErrors.push(`symbol_blocked: ${symbol} ${side} — reason: ${blocked.reason}` +
    (blocked.blocked_until ? ` until ${blocked.blocked_until}` : ' (permanent)'));
}

// Gate 4: Duplicate position
if (state.open_positions.some(p => p.symbol === symbol && p.side === side)) {
  policyErrors.push(`position_already_open: ${symbol} ${side}`);
}

if (policyErrors.length) {
  for (const e of policyErrors) process.stderr.write(JSON.stringify({ error: 'policy_gate_failed', detail: e }) + '\n');
  process.exit(1);
}

// ─── Dry-run ─────────────────────────────────────────────────────────────────

if (dryRun) {
  process.stdout.write(JSON.stringify({
    dry_run:         true,
    status:          'would_open',
    symbol, side, score, reason, category,
    price_usd:       priceUsd,
    price_source:    priceInfo.source,
    entry_price_eur: +usdToEur(priceUsd).toFixed(4),
    notional_eur:    notionalEur,
    stop_loss_pct:   stopLossPct,
    sl_level_usd:    side === 'long'
      ? +(priceUsd * (1 - stopLossPct / 100)).toFixed(4)
      : +(priceUsd * (1 + stopLossPct / 100)).toFixed(4),
    sl_not_before:         slNotBefore,
    take_profit_pct:       takeProfitPct,
    tp_source:             tpSource,
    ...(structTp ? { tp_price_usd: structTp.tp_price_usd, tp_rr: structTp.rr } : {}),
    ...(hasPartialTp ? {
      tp1_pct:          tp1Pct,
      tp2_pct:          tp2Pct,
      tp1_price_usd:    structTp.tp_price_usd,
      tp2_price_usd:    structTp.tp2_price_usd,
      tp1_quantity_pct: 0.5,
      tp2_quantity_pct: 0.5,
      tp1_hit:          false,
      tp2_hit:          false,
      tp1_source:       structTp.source,
      tp2_source:       structTp.tp2_source,
    } : {}),
    breakeven_trigger_pct: breakevenTriggerPct,
    state_after: {
      equity_nav:           nav,
      cash:                 +cashAfter.toFixed(2),
      cash_pct:             +(cashAfter / nav * 100).toFixed(1),
      open_positions_count: state.open_positions.length + 1,
    },
  }, null, 2) + '\n');
  process.exit(0);
}

// ─── Live path ───────────────────────────────────────────────────────────────

const entryPriceEur = +usdToEur(priceUsd).toFixed(8);
const quantity      = +(notionalEur / entryPriceEur).toFixed(8);
const orderAction   = side === 'long' ? 'buy' : 'sell_short';

const broker = new PaperBroker();

const intent = {
  symbol, side,
  direction:  side === 'long' ? 'LONG' : 'SHORT',
  price_usd:  priceUsd,
  intent_id:  `intent_auto_open_${symbol}_${Date.now()}`,
  category:   category === 'stock' ? 'Stock' : 'Crypto',
  sector:     sector,
  change_pct: priceInfo.change_pct ?? 0,
  volume_usd: 0, rank: 0, score, risk: null, technical: null,
};

const decision = {
  decision_id:     `dec_auto_open_${symbol}_${Date.now()}`,
  decided_at:      new Date().toISOString(),
  intent_id:       intent.intent_id,
  symbol, side,
  execution_ready: true,
  blocked_reasons: [],
  gate_result:     { gate_passed: true, blocked_reasons: [], placeholder_checks: [], checks: [] },
};

const order = broker.placeOrder(intent, decision, {
  action: 'open', order_action: orderAction,
  quantity, notional_eur: notionalEur, run_id: runId,
});

broker.fillOrder(order, priceUsd, { reason: `auto_open_${reason}` });

appendLedger({
  ts:              new Date().toISOString(),
  event:           'open',
  run_id:          runId,
  order_id:        order.order_id,
  symbol, side, quantity,
  entry_price_eur: entryPriceEur,
  notional_eur:    notionalEur,
  stop_loss_pct:   stopLossPct,
  reason,
  manual:          false,
  auto_score:      score,
});

auditLog('portfolio_position_auto_opened', {
  symbol, side, score, quantity, entry_price_eur: entryPriceEur,
  notional_eur: notionalEur, reason, order_id: order.order_id, run_id: runId,
});

state.open_positions.push({
  symbol,
  asset_type:         category === 'stock' ? 'stock' : 'crypto',
  side,
  quantity,
  notional_eur:       notionalEur,
  entry_price_usd:    priceUsd,
  entry_price_eur:    entryPriceEur,
  mark_price_usd:     priceUsd,
  mark_price_eur:     entryPriceEur,
  unrealized_pnl_eur: 0,
  stop_loss_pct:      stopLossPct,
  ...(slNotBefore != null ? { sl_not_before: slNotBefore } : {}),
  ...(takeProfitPct != null ? { take_profit_pct: takeProfitPct } : {}),
  tp_source:          tpSource,
  ...(structTp ? { tp_price_usd: structTp.tp_price_usd, tp_rr: structTp.rr } : {}),
  ...(hasPartialTp ? {
    tp1_pct:          tp1Pct,
    tp2_pct:          tp2Pct,
    tp1_price_usd:    structTp.tp_price_usd,
    tp2_price_usd:    structTp.tp2_price_usd,
    tp1_quantity_pct: 0.5,
    tp2_quantity_pct: 0.5,
    tp1_hit:          false,
    tp2_hit:          false,
    tp1_source:       structTp.source,
    tp2_source:       structTp.tp2_source,
  } : {}),
  ...(breakevenTriggerPct != null ? { breakeven_trigger_pct: breakevenTriggerPct, peak_pnl_pct: 0, breakeven_activated: false } : {}),
  ...(trailingStopDistancePct != null ? { trailing_stop_distance_pct: trailingStopDistancePct } : {}),
  ...(thesisValidUntil != null ? { thesis_valid_until: thesisValidUntil, thesis_status: 'active' } : {}),
  leverage:           1,
  entry_timestamp:    new Date().toISOString(),
  entry_run_id:       runId,
  strategy:           'auto_open',
  auto_score:         score,
  thesis:             `${side} ${symbol} — score${score}: ${reason}`,
  decision_source: {
    decision_id:         decision.decision_id,
    intent_id:           intent.intent_id,
    confidence:          score / 10,
    technical_alignment: score >= 9 ? 'confirmed' : score >= 8 ? 'partial' : 'weak',
    risk_tier:           score >= 9 ? 'A' : score >= 7 ? 'B' : 'C',
  },
  order_id:           order.order_id,
});

state.last_updated_at = new Date().toISOString();
state.last_run_id     = runId;
recompute(state);
save(state);

appendHistory({
  ts:                   new Date().toISOString(),
  run_id:               runId,
  event:                'auto_open',
  symbol, side, score, reason,
  entry_price_usd:      priceUsd,
  notional_eur:         notionalEur,
  equity_nav:           state.equity_nav,
  cash:                 state.cash,
  gross_exposure:       state.gross_exposure,
  open_positions_count: state.open_positions.length,
});

process.stdout.write(JSON.stringify({
  status:          'opened',
  symbol, side, score, reason, category,
  price_usd:       priceUsd,
  price_source:    priceInfo.source,
  entry_price_eur: entryPriceEur,
  quantity,
  notional_eur:    notionalEur,
  stop_loss_pct:   stopLossPct,
  sl_level_usd:    side === 'long'
    ? +(priceUsd * (1 - stopLossPct / 100)).toFixed(4)
    : +(priceUsd * (1 + stopLossPct / 100)).toFixed(4),
  sl_not_before:   slNotBefore,
  take_profit_pct: takeProfitPct,
  tp_source:       tpSource,
  ...(structTp ? { tp_price_usd: structTp.tp_price_usd, tp_rr: structTp.rr } : {}),
  ...(hasPartialTp ? {
    tp1_pct:          tp1Pct,
    tp2_pct:          tp2Pct,
    tp1_price_usd:    structTp.tp_price_usd,
    tp2_price_usd:    structTp.tp2_price_usd,
    tp1_quantity_pct: 0.5,
    tp2_quantity_pct: 0.5,
    tp1_hit:          false,
    tp2_hit:          false,
    tp1_source:       structTp.source,
    tp2_source:       structTp.tp2_source,
  } : {}),
  order_id:        order.order_id,
  run_id:          runId,
  portfolio: {
    equity_nav:           state.equity_nav,
    cash:                 state.cash,
    cash_pct:             +(state.cash / state.equity_nav * 100).toFixed(1),
    open_positions_count: state.open_positions.length,
    realized_pnl:         state.realized_pnl,
  },
}, null, 2) + '\n');
