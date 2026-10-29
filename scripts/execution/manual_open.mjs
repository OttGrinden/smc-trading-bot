#!/usr/bin/env node
/**
 * Manual Open — policy-validated open for virtual-portfolio positions.
 *
 * Routes through the full Paper Broker lifecycle:
 *   placeOrder → fillOrder → accounting → save + history + ledger + audit
 *
 * Does NOT bypass portfolio_state.json directly.
 * --price-usd is required (no guessing for entry price).
 *
 * Usage:
 *   node manual_open.mjs --symbol MRVL --side long  --reason policy_add --price-usd 288.85
 *   node manual_open.mjs --symbol NBIS --side short --reason policy_add --price-usd 218.00
 *
 * Dry-run (no writes):
 *   node manual_open.mjs --symbol MRVL --side long --reason policy_add --price-usd 288.85 --dry-run
 *
 * Optional:
 *   --notional-eur <EUR>    override position size (default: 25% of current NAV)
 *   --stop-loss-pct <pct>   override stop loss % (default: 8 for long, 5 for short)
 *   --run-id <id>
 */

import {
  loadOrInit, save, recompute, appendHistory, appendLedger,
  usdToEur, EUR_USD_RATE,
} from './portfolio/portfolio_state.mjs';
import { PaperBroker }  from './paper_broker.mjs';
import { auditLog }     from './audit_log.mjs';

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

const args      = parseArgs(process.argv.slice(2));
const symbol    = args.symbol      ? String(args.symbol).toUpperCase()  : null;
const side      = args.side        ? String(args.side).toLowerCase()    : null;
const reason    = args.reason      ? String(args.reason)                : null;
const priceUsd  = args.priceUsd    ? parseFloat(args.priceUsd)          : null;
const dryRun    = args.dryRun === true || args.dryRun === 'true';
const runId     = args.runId       ? String(args.runId) : `manual_${new Date().toISOString().slice(0,16).replace(/[T:]/g,'_')}`;
const notionalOverride      = args.notionalEur             ? parseFloat(args.notionalEur)             : null;
const slOverride            = args.stopLossPct             ? parseFloat(args.stopLossPct)             : null;
const slNotBeforeHours      = args.slNotBeforeHours        ? parseFloat(args.slNotBeforeHours)        : null;
const takeProfitPct         = args.takeProfitPct           ? parseFloat(args.takeProfitPct)           : null;
const breakevenTriggerPct   = args.breakevenTriggerPct     ? parseFloat(args.breakevenTriggerPct)     : null;
const trailingStopDistPct   = args.trailingStopDistancePct ? parseFloat(args.trailingStopDistancePct) : null;

// ─── Validation ───────────────────────────────────────────────────────────────

const errors = [];
if (!symbol)                                    errors.push('--symbol is required');
if (!side || !['long','short'].includes(side))  errors.push('--side must be "long" or "short"');
if (!reason)                                    errors.push('--reason is required');
if (priceUsd == null)                           errors.push('--price-usd is required');
else if (!Number.isFinite(priceUsd) || priceUsd <= 0)
                                                errors.push('--price-usd must be a positive number');

if (errors.length) {
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  process.stderr.write(
    'usage: node manual_open.mjs --symbol MRVL --side long --reason policy_add --price-usd 288.85' +
    ' [--notional-eur 496] [--stop-loss-pct 8] [--sl-not-before-hours 24] [--run-id run_xxx] [--dry-run]\n'
  );
  process.exit(1);
}

if (dryRun) {
  process.stderr.write(JSON.stringify({ info: 'dry_run_mode', detail: 'no writes will occur' }) + '\n');
}

// ─── Mark-price divergence warning ───────────────────────────────────────────
// Stocks use the last cache close as mark. If entry_price >> last close (AH/pre-market),
// the next scan will overwrite mark with the old close → SL may trigger immediately.
// Use --sl-not-before-hours 24 to protect against this when opening at AH/pre-market prices.
if (slNotBeforeHours == null && side === 'long') {
  process.stderr.write(JSON.stringify({
    warn: 'mark_divergence_risk',
    detail: 'Stocks are marked at last close from stocks_cache. If --price-usd uses an AH/pre-market price ' +
            'that is above the last known close, the next scan may immediately trigger the SL. ' +
            'Add --sl-not-before-hours 24 to defer SL evaluation until the cache refreshes.',
  }) + '\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

const state = loadOrInit();

// Guard: duplicate position
if (state.open_positions.some(p => p.symbol === symbol && p.side === side)) {
  process.stderr.write(JSON.stringify({
    error: 'position_already_open',
    symbol, side,
    detail: 'A position with the same symbol and side is already open. Close it first.',
  }) + '\n');
  process.exit(1);
}

const nav          = state.equity_nav;
const notionalEur  = notionalOverride ?? +(nav * 0.25).toFixed(4);
const stopLossPct  = slOverride ?? (side === 'long' ? 8 : 5);
const slNotBefore  = slNotBeforeHours != null
  ? new Date(Date.now() + slNotBeforeHours * 3_600_000).toISOString()
  : null;
const entryPriceEur = +usdToEur(priceUsd).toFixed(8);
const quantity      = +(notionalEur / entryPriceEur).toFixed(8);
const orderAction   = side === 'long' ? 'buy' : 'sell_short';

// ─── Dry-run ─────────────────────────────────────────────────────────────────

if (dryRun) {
  const cashAfter = +(state.cash - notionalEur).toFixed(4);
  process.stdout.write(JSON.stringify({
    dry_run:         true,
    status:          'would_open',
    symbol, side, reason,
    entry_price_usd: priceUsd,
    entry_price_eur: entryPriceEur,
    quantity,
    notional_eur:    notionalEur,
    stop_loss_pct:   stopLossPct,
    sl_level_usd:    side === 'long'
      ? +(priceUsd * (1 - stopLossPct / 100)).toFixed(4)
      : +(priceUsd * (1 + stopLossPct / 100)).toFixed(4),
    sl_not_before:   slNotBefore,
    take_profit_pct: takeProfitPct,
    state_after: {
      equity_nav:           nav,
      cash:                 cashAfter,
      cash_pct:             nav > 0 ? +(cashAfter / nav * 100).toFixed(2) : 0,
      open_positions_count: state.open_positions.length + 1,
    },
    writes_skipped: ['portfolio_state.json', 'trade_ledger.jsonl', 'portfolio_history.jsonl', 'audit_*.jsonl', 'orders/'],
  }, null, 2) + '\n');
  process.exit(0);
}

// ─── Live path ───────────────────────────────────────────────────────────────

const broker = new PaperBroker();

const intent = {
  symbol, side,
  direction:  side === 'long' ? 'LONG' : 'SHORT',
  price_usd:  priceUsd,
  intent_id:  `intent_manual_open_${symbol}_${Date.now()}`,
  category:   'stock',
  sector:     null,
  change_pct: 0, volume_usd: 0, rank: 0, score: 0, risk: null, technical: null,
};

const decision = {
  decision_id:     `dec_manual_open_${symbol}_${Date.now()}`,
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

broker.fillOrder(order, priceUsd, { reason: `manual_open_${reason}` });

// Append open ledger entry
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
  manual:          true,
});

auditLog('portfolio_position_opened', {
  symbol, side, quantity, entry_price_eur: entryPriceEur,
  notional_eur: notionalEur, reason, order_id: order.order_id, run_id: runId, manual: true,
});

// Add to open positions
state.open_positions.push({
  symbol,
  asset_type:       'stock',
  side,
  quantity,
  notional_eur:     notionalEur,
  entry_price_usd:  priceUsd,
  entry_price_eur:  entryPriceEur,
  mark_price_usd:   priceUsd,
  mark_price_eur:   entryPriceEur,
  unrealized_pnl_eur: 0,
  stop_loss_pct:    stopLossPct,
  ...(slNotBefore != null ? { sl_not_before: slNotBefore } : {}),
  ...(takeProfitPct != null ? { take_profit_pct: takeProfitPct } : {}),
  ...(breakevenTriggerPct != null ? {
    breakeven_trigger_pct:       breakevenTriggerPct,
    ...(trailingStopDistPct != null ? { trailing_stop_distance_pct: trailingStopDistPct } : {}),
    peak_pnl_pct:        0,
    breakeven_activated: false,
  } : {}),
  leverage:         1,
  entry_timestamp:  new Date().toISOString(),
  entry_run_id:     runId,
  strategy:         'manual_open',
  thesis:           `${side} ${symbol} — ${reason}`,
  decision_source: {
    decision_id:         decision.decision_id,
    intent_id:           intent.intent_id,
    confidence:          0.8,
    technical_alignment: 'partial',
    risk_tier:           'A',
  },
  order_id: order.order_id,
});

state.last_updated_at = new Date().toISOString();
state.last_run_id     = runId;
recompute(state);
save(state);

appendHistory({
  ts:                    new Date().toISOString(),
  run_id:                runId,
  event:                 'manual_open',
  symbol, side, reason,
  entry_price_usd:       priceUsd,
  notional_eur:          notionalEur,
  equity_nav:            state.equity_nav,
  cash:                  state.cash,
  gross_exposure:        state.gross_exposure,
  open_positions_count:  state.open_positions.length,
});

process.stdout.write(JSON.stringify({
  status:          'opened',
  symbol, side, reason,
  entry_price_usd: priceUsd,
  entry_price_eur: entryPriceEur,
  quantity,
  notional_eur:    notionalEur,
  stop_loss_pct:   stopLossPct,
  sl_level_usd:    side === 'long'
    ? +(priceUsd * (1 - stopLossPct / 100)).toFixed(4)
    : +(priceUsd * (1 + stopLossPct / 100)).toFixed(4),
  sl_not_before:   slNotBefore,
  take_profit_pct: takeProfitPct,
  order_id:        order.order_id,
  run_id:          runId,
  portfolio: {
    equity_nav:           state.equity_nav,
    cash:                 state.cash,
    cash_pct:             state.equity_nav > 0 ? +(state.cash / state.equity_nav * 100).toFixed(2) : 0,
    open_positions_count: state.open_positions.length,
    realized_pnl:         state.realized_pnl,
  },
}, null, 2) + '\n');
