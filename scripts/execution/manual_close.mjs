#!/usr/bin/env node
/**
 * Manual Close — policy-based close for open virtual-portfolio positions.
 *
 * Routes through the full Paper Broker lifecycle:
 *   placeOrder → fillOrder → accounting → save + history + ledger + audit
 *
 * Does NOT bypass portfolio_state.json directly.
 * Does NOT close to 0 when no valid price is available — fails with a clear error.
 *
 * Usage:
 *   node manual_close.mjs --symbol IBM   --side short --reason thesis_quality_fail
 *   node manual_close.mjs --symbol BTC   --side long  --reason no_mark_price_override --price-usd 62500
 *   node manual_close.mjs --symbol AMAT  --side long  --reason direction_flip --price-usd 510.00 --run-id run_2026-06-09_0800
 *
 * Optional time-limited block (default: 30 days from now):
 *   node manual_close.mjs --symbol MRVL --side long --reason thesis_expired --blocked-until 2026-06-30
 *   node manual_close.mjs --symbol MRVL --side long --reason thesis_expired --blocked-until 2026-06-30T15:30:00Z
 *
 *   --blocked-until accepts ISO date (YYYY-MM-DD) or ISO datetime with timezone.
 *   Date-only values are parsed as UTC midnight — for precise expiry use a full ISO datetime with timezone offset.
 *   The date must be in the future; a past value is rejected before any write occurs.
 *   When omitted, default block is 30 days. Use --permanent for an indefinite block.
 *
 * Dry-run (no writes — safe for testing and verification):
 *   node manual_close.mjs --symbol IBM --side short --reason thesis_quality_fail --dry-run
 *
 * Reasons (suggested, not exhaustive):
 *   thesis_quality_fail     — MACD/RSI direction conflict, no catalyst
 *   stop_loss_hit           — price reached SL threshold
 *   direction_flip          — scan reversed direction for this symbol
 *   gegenkatalysator        — concrete counter-event within 48h
 *   no_mark_price_override  — missing scan price, close at explicit --price-usd
 *   manual_override         — other discretionary close
 *
 * Note: operationally, the live portfolio_state.json was temporarily altered
 * during testing on 2026-06-08 and manually restored. Use --dry-run for any
 * verification or testing to avoid side effects on the live state.
 */

import {
  loadOrInit, save, recompute, appendHistory, appendLedger,
  usdToEur, dirFactor, blockSymbol, _setTestPaths,
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

const args = parseArgs(process.argv.slice(2));

const symbol   = args.symbol   ? String(args.symbol).toUpperCase() : null;
const side     = args.side     ? String(args.side).toLowerCase()   : null;
const reason   = args.reason   ? String(args.reason)               : null;
const priceUsd = args.priceUsd ? parseFloat(args.priceUsd)         : null;
const runId    = args.runId    ? String(args.runId) : `manual_${new Date().toISOString().slice(0,16).replace(/[T:]/g,'_')}`;
const dryRun       = args.dryRun   === true || args.dryRun   === 'true';
const permanent    = args.permanent === true || args.permanent === 'true';
const blockedUntil = args.blockedUntil ? String(args.blockedUntil) : null;
const statePath    = args.statePath    ? String(args.statePath)    : null;

const DEFAULT_BLOCK_DAYS = 30;
const effectiveBlockedUntil = permanent
  ? null
  : (blockedUntil ?? new Date(Date.now() + DEFAULT_BLOCK_DAYS * 86_400_000).toISOString().slice(0, 10));

// ─── Validation ───────────────────────────────────────────────────────────────

const errors = [];
if (!symbol)                                    errors.push('--symbol is required');
if (!side || !['long','short'].includes(side))  errors.push('--side must be "long" or "short"');
if (!reason)                                    errors.push('--reason is required');
if (priceUsd != null && (!Number.isFinite(priceUsd) || priceUsd <= 0))
                                                errors.push('--price-usd must be a positive number');

if (blockedUntil != null) {
  const parsed = new Date(blockedUntil);
  if (isNaN(parsed.getTime()))
    errors.push('--blocked-until must be a valid ISO date or datetime (e.g. 2026-06-30 or 2026-06-30T15:30:00Z)');
  else if (parsed <= new Date())
    errors.push('--blocked-until must be a future date — a past or present value would produce an immediately-expired block');
}

if (errors.length) {
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  process.stderr.write(
    'usage: node manual_close.mjs --symbol IBM --side short --reason thesis_quality_fail' +
    ' [--price-usd 281.00] [--run-id run_xxx] [--blocked-until 2026-06-30] [--dry-run]\n'
  );
  process.exit(1);
}

if (dryRun) {
  process.stderr.write(JSON.stringify({ info: 'dry_run_mode', detail: 'no writes will occur' }) + '\n');
}

// Test isolation: --state-path redirects state reads to a scratch file (dry-run only).
if (statePath != null) {
  _setTestPaths({ state: statePath, history: statePath + '.hist.jsonl', ledger: statePath + '.ledger.jsonl' });
}

// ─── Main ────────────────────────────────────────────────────────────────────

const state = loadOrInit();

// 1. Find the matching open position
const posIndex = state.open_positions.findIndex(
  p => p.symbol === symbol && p.side === side
);

if (posIndex === -1) {
  process.stderr.write(JSON.stringify({
    error: 'position_not_found',
    symbol,
    side,
    open_symbols: state.open_positions.map(p => `${p.symbol}|${p.side}`),
  }) + '\n');
  process.exit(1);
}

const pos = state.open_positions[posIndex];

// 2. Determine close price — never silently close to 0
let closePriceUsd = null;

if (priceUsd != null) {
  closePriceUsd = priceUsd;
  process.stderr.write(JSON.stringify({ info: 'manual_close_price_source', source: 'cli_arg', price_usd: closePriceUsd }) + '\n');
} else if (pos.mark_price_usd != null && Number.isFinite(pos.mark_price_usd) && pos.mark_price_usd > 0) {
  closePriceUsd = pos.mark_price_usd;
  process.stderr.write(JSON.stringify({ info: 'manual_close_price_source', source: 'last_mark', price_usd: closePriceUsd }) + '\n');
} else {
  process.stderr.write(JSON.stringify({
    error:   'no_valid_close_price',
    symbol,
    side,
    detail:  'No --price-usd provided and mark_price_usd is missing or invalid. ' +
             'Supply --price-usd to proceed. Refusing to close at 0.',
    mark_price_usd: pos.mark_price_usd ?? null,
  }) + '\n');
  process.exit(1);
}

const closePriceEur    = usdToEur(closePriceUsd);
const grossRealized    = +(dirFactor(side) * pos.quantity * (closePriceEur - pos.entry_price_eur)).toFixed(4);
const realized         = grossRealized;

// 3. Dry-run: compute and report, then exit without any writes
if (dryRun) {
  const stateAfter = {
    equity_nav:  +(state.equity_nav).toFixed(4),   // NAV doesn't change at entry-price close
    cash:        +(state.cash + pos.notional_eur).toFixed(4),
    realized_pnl: +(state.realized_pnl + realized).toFixed(4),
    open_positions_count: state.open_positions.length - 1,
  };
  process.stdout.write(JSON.stringify({
    dry_run:         true,
    status:          'would_close',
    symbol,
    side,
    reason,
    close_price_usd: closePriceUsd,
    close_price_eur: +closePriceEur.toFixed(6),
    entry_price_usd: pos.entry_price_usd,
    realized_pnl_eur: realized,
    block_type:      permanent ? 'permanent' : (blockedUntil != null ? 'explicit_temporary' : `default_${DEFAULT_BLOCK_DAYS}d`),
    blocked_until:   effectiveBlockedUntil,
    state_after:     stateAfter,
    writes_skipped:  ['portfolio_state.json', 'trade_ledger.jsonl', 'portfolio_history.jsonl', 'audit_*.jsonl', 'orders/'],
  }, null, 2) + '\n');
  process.exit(0);
}

// 4. Live path: route through Paper Broker lifecycle
const broker = new PaperBroker();

const intent = {
  symbol,
  side,
  direction:  side === 'long' ? 'LONG' : 'SHORT',
  price_usd:  closePriceUsd,
  intent_id:  `intent_manual_close_${symbol}_${Date.now()}`,
  category:   pos.asset_type ?? 'stock',
  sector:     null,
  change_pct: 0,
  volume_usd: 0,
  rank:       0,
  score:      0,
  risk:       null,
  technical:  null,
};

const decision = {
  decision_id:     `dec_manual_close_${symbol}_${Date.now()}`,
  decided_at:      new Date().toISOString(),
  intent_id:       intent.intent_id,
  symbol,
  side,
  execution_ready: true,
  blocked_reasons: [],
  gate_result:     { gate_passed: true, blocked_reasons: [], placeholder_checks: [], checks: [] },
};

const orderAct = side === 'long' ? 'sell' : 'buy_to_cover';

const order = broker.placeOrder(intent, decision, {
  action:        'close',
  order_action:  orderAct,
  quantity:      pos.quantity,
  notional_eur:  pos.notional_eur,
  close_reason:  reason,
  run_id:        runId,
});

broker.fillOrder(order, closePriceUsd, { reason: `manual_close_${reason}` });

// 5. Accounting
state.realized_pnl        = +(state.realized_pnl + realized).toFixed(4);
state.cumulative_fees_eur = state.cumulative_fees_eur ?? 0;

const summary = state.closed_positions_summary;
summary.count              = (summary.count ?? 0) + 1;
summary.realized_pnl_total = +((summary.realized_pnl_total ?? 0) + realized).toFixed(4);
if (realized >= 0) summary.wins = (summary.wins ?? 0) + 1;
else               summary.losses = (summary.losses ?? 0) + 1;

appendLedger({
  ts:                 new Date().toISOString(),
  event:              'close',
  run_id:             runId,
  order_id:           order.order_id,
  symbol:             pos.symbol,
  side:               pos.side,
  quantity:           pos.quantity,
  entry_price_eur:    pos.entry_price_eur,
  close_price_eur:    +closePriceEur.toFixed(6),
  gross_realized_eur: grossRealized,
  fee_eur:            0,
  realized_pnl_eur:   realized,
  reason,
  entry_run_id:       pos.entry_run_id,
  manual:             true,
});

auditLog('portfolio_position_closed', {
  symbol, side, realized_pnl_eur: realized,
  fee_eur: 0, reason, order_id: order.order_id, run_id: runId, manual: true,
});

// 6. Remove from open positions, recompute, block, save
state.open_positions.splice(posIndex, 1);
state.last_updated_at = new Date().toISOString();
state.last_run_id     = runId;
recompute(state);
// Block the closed symbol+side so the allocator cannot reopen it automatically.
// Only manual closes set a block — SL hits and engine flips do not.
// blockedUntil=null means permanent; a future ISO timestamp means time-limited.
blockSymbol(state, symbol, side, `manual_close: ${reason}`, effectiveBlockedUntil);
save(state);

appendHistory({
  ts:                    new Date().toISOString(),
  run_id:                runId,
  event:                 'manual_close',
  symbol,
  side,
  reason,
  realized_pnl_eur:      realized,
  close_price_usd:       closePriceUsd,
  equity_nav:            state.equity_nav,
  cash:                  state.cash,
  gross_exposure:        state.gross_exposure,
  open_positions_count:  state.open_positions.length,
});

// 7. Output
process.stdout.write(JSON.stringify({
  status:           'closed',
  symbol,
  side,
  reason,
  close_price_usd:  closePriceUsd,
  close_price_eur:  +closePriceEur.toFixed(6),
  entry_price_usd:  pos.entry_price_usd,
  realized_pnl_eur: realized,
  block_type:       permanent ? 'permanent' : (blockedUntil != null ? 'explicit_temporary' : `default_${DEFAULT_BLOCK_DAYS}d`),
  blocked_until:    effectiveBlockedUntil,
  order_id:         order.order_id,
  run_id:           runId,
  portfolio: {
    equity_nav:           state.equity_nav,
    cash:                 state.cash,
    cash_pct:             state.equity_nav > 0 ? +(state.cash / state.equity_nav * 100).toFixed(2) : 0,
    open_positions_count: state.open_positions.length,
    realized_pnl:         state.realized_pnl,
  },
}, null, 2) + '\n');
