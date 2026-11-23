#!/usr/bin/env node
/**
 * scalp_open.mjs — Open OB-Scalp positions (strategy: "ob_scalp").
 *
 * Separate from auto_open.mjs: dedicated 2-slot limit, no thesis_reviewer,
 * tiny TPs (0.15–0.20%), 2h max-hold thesis window, 3% NAV per trade.
 *
 * Usage:
 *   node scalp_open.mjs --symbol BTC --score 9 --sl-pct 0.22 --tp-pct 0.15
 *                       --reason "ob_scalp sweep62499.9000 pin..." [--dry-run]
 */

import fs            from 'node:fs';
import path          from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadOrInit, save, recompute, appendHistory, appendLedger,
  usdToEur, isBlocked,
} from './portfolio/portfolio_state.mjs';
import { PaperBroker } from './paper_broker.mjs';
import { auditLog }    from './audit_log.mjs';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR  = path.join(__dirname, '../../trading/cache');

const MAX_SCALP_POSITIONS  = 2;
const SCALP_NOTIONAL_PCT   = 0.03;   // 3% NAV margin per trade
const SCALP_LEVERAGE       = 30;     // Backtest-validiert: 0% Ruin-Risiko, avg 11.932 EUR/2yr auf 5000 EUR
const SCALP_MAX_HOLD_HOURS = 2;

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

const args   = parseArgs(process.argv.slice(2));
const symbol = args.symbol ? String(args.symbol).toUpperCase() : null;
const score  = args.score  ? parseInt(args.score, 10) : null;
const slPct  = args.slPct  ? parseFloat(args.slPct)  : null;
const tpPct  = args.tpPct  ? parseFloat(args.tpPct)  : null;
const reason = args.reason ? String(args.reason)      : null;
const dryRun = args.dryRun === true || args.dryRun === 'true';
const runId  = `scalp_${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '_')}`;

if (!symbol || score == null || slPct == null || tpPct == null || !reason) {
  process.stderr.write('error: --symbol, --score, --sl-pct, --tp-pct, --reason are required\n');
  process.exit(1);
}

// ─── Price lookup ─────────────────────────────────────────────────────────────

function lookupCryptoPrice(sym) {
  // 1. liq_heatmap.json — same source as mark_to_market, ensures entry/mark price consistency
  const hmPath = path.join(CACHE_DIR, 'liq_heatmap.json');
  if (fs.existsSync(hmPath)) {
    try {
      const hm    = JSON.parse(fs.readFileSync(hmPath, 'utf8'));
      const symHm = hm[sym] || hm[sym?.toUpperCase()];
      if (symHm?.current_price) return { price_usd: symHm.current_price, source: 'liq_heatmap_cache' };
    } catch {}
  }
  // 2. positioning_data.json fallback (BTC/ETH only have mark_price_usd here)
  const posPath = path.join(CACHE_DIR, 'positioning_data.json');
  if (fs.existsSync(posPath)) {
    try {
      const pos    = JSON.parse(fs.readFileSync(posPath, 'utf8'));
      const symPos = pos[sym] || pos[sym?.toUpperCase()];
      if (symPos?.mark_price_usd) return { price_usd: symPos.mark_price_usd, source: 'positioning_cache' };
    } catch {}
  }
  return null;
}

const priceInfo = lookupCryptoPrice(symbol);
if (!priceInfo?.price_usd) {
  process.stderr.write(JSON.stringify({ error: 'scalp_price_not_found', symbol }) + '\n');
  process.exit(1);
}
const priceUsd = priceInfo.price_usd;

// ─── Policy gates ─────────────────────────────────────────────────────────────

const state              = loadOrInit();
const nav                = state.equity_nav;
const marginEur          = +(nav * SCALP_NOTIONAL_PCT).toFixed(2);        // cash committed
const notionalEur        = +(marginEur * SCALP_LEVERAGE).toFixed(2);      // leveraged notional for PnL

const policyErrors = [];

// Gate 1: Max scalp positions (2 — independent of swing 5-slot limit)
const openScalps = state.open_positions.filter(p => p.strategy === 'ob_scalp');
if (openScalps.length >= MAX_SCALP_POSITIONS) {
  policyErrors.push(
    `max_scalp_positions: ${openScalps.length}/${MAX_SCALP_POSITIONS} scalp positions open`
  );
}

// Gate 2: Cash floor (20% NAV) — only margin is deducted from cash
const cashAfter = state.cash - marginEur;
if (cashAfter < nav * 0.20) {
  policyErrors.push(
    `cash_floor_violated: cash after open would be ${cashAfter.toFixed(0)} EUR ` +
    `(floor: ${(nav * 0.20).toFixed(0)} EUR)`
  );
}

// Gate 3: No duplicate scalp for same symbol (any side)
if (state.open_positions.some(p => p.symbol === symbol && p.strategy === 'ob_scalp')) {
  policyErrors.push(`scalp_already_open: ${symbol} already has an ob_scalp position`);
}

// Gate 4: Symbol blocked (manual close / stop_loss block)
if (isBlocked(state, symbol, 'long')) {
  policyErrors.push(`symbol_blocked: ${symbol} long is blocked`);
}

if (policyErrors.length) {
  for (const e of policyErrors)
    process.stderr.write(JSON.stringify({ error: 'scalp_policy_gate_failed', detail: e }) + '\n');
  process.exit(1);
}

// ─── Dry-run ─────────────────────────────────────────────────────────────────

if (dryRun) {
  process.stdout.write(JSON.stringify({
    dry_run: true, status: 'would_open',
    symbol, score, price_usd: priceUsd, notional_eur: notionalEur, sl_pct: slPct, tp_pct: tpPct,
  }, null, 2) + '\n');
  process.exit(0);
}

// ─── Position sizing ──────────────────────────────────────────────────────────

const entryPriceEur    = +usdToEur(priceUsd).toFixed(8);
const quantity         = +(notionalEur / entryPriceEur).toFixed(8);  // based on leveraged notional
const slLevelUsd       = +(priceUsd * (1 - slPct / 100)).toFixed(6);
const tpLevelUsd       = +(priceUsd * (1 + tpPct / 100)).toFixed(6);
const thesisValidUntil = new Date(Date.now() + SCALP_MAX_HOLD_HOURS * 3_600_000).toISOString();
const sector           = `crypto_${symbol.toLowerCase()}`;

// ─── Open position ────────────────────────────────────────────────────────────

const broker = new PaperBroker();

const intent = {
  symbol, side: 'long', direction: 'LONG',
  price_usd: priceUsd,
  intent_id: `intent_scalp_${symbol}_${Date.now()}`,
  category: 'Crypto',
  sector,
  change_pct: 0, volume_usd: 0, rank: 0, score, risk: null, technical: null,
};

const decision = {
  decision_id:     `dec_scalp_${symbol}_${Date.now()}`,
  decided_at:      new Date().toISOString(),
  intent_id:       intent.intent_id,
  symbol, side:    'long',
  execution_ready: true,
  blocked_reasons: [],
  gate_result:     { gate_passed: true, blocked_reasons: [], checks: [] },
};

const order = broker.placeOrder(intent, decision, {
  action: 'open', order_action: 'buy',
  quantity, notional_eur: notionalEur, run_id: runId,
});

broker.fillOrder(order, priceUsd, { reason: `scalp_open_${reason}` });

appendLedger({
  ts:                    new Date().toISOString(),
  event:                 'open',
  run_id:                runId,
  order_id:              order.order_id,
  symbol, side:          'long', quantity,
  entry_price_eur:       entryPriceEur,
  margin_eur:            marginEur,
  notional_eur:          notionalEur,
  leverage:              SCALP_LEVERAGE,
  stop_loss_pct:         slPct,
  reason,
  manual:                false,
  auto_score:            score,
  strategy:              'ob_scalp',
});

auditLog('scalp_position_opened', {
  symbol, score, quantity, entry_price_eur: entryPriceEur,
  notional_eur: notionalEur, reason, order_id: order.order_id, run_id: runId,
});

state.open_positions.push({
  symbol,
  asset_type:          'crypto',
  side:                'long',
  quantity,
  notional_eur:        notionalEur,
  entry_price_usd:     priceUsd,
  entry_price_eur:     entryPriceEur,
  mark_price_usd:      priceUsd,
  mark_price_eur:      entryPriceEur,
  unrealized_pnl_eur:  0,
  stop_loss_pct:       slPct,
  stop_loss_price_eur: +usdToEur(slLevelUsd).toFixed(8),
  take_profit_pct:     tpPct,
  tp_source:           'ob_scalp_fixed',
  tp_price_usd:        tpLevelUsd,
  thesis_valid_until:  thesisValidUntil,
  thesis_status:       'active',
  leverage:            SCALP_LEVERAGE,
  margin_eur:          marginEur,
  entry_timestamp:     new Date().toISOString(),
  entry_run_id:        runId,
  strategy:            'ob_scalp',
  auto_score:          score,
  thesis:              `long ${symbol} — ob_scalp score${score}: ${reason}`,
  decision_source: {
    decision_id:         decision.decision_id,
    intent_id:           intent.intent_id,
    confidence:          score / 10,
    technical_alignment: 'confirmed',
    risk_tier:           'scalp',
  },
  order_id:            order.order_id,
  sector,
});

state.last_updated_at = new Date().toISOString();
state.last_run_id     = runId;
recompute(state);
save(state);

appendHistory({
  ts:                   new Date().toISOString(),
  run_id:               runId,
  event:                'scalp_open',
  symbol, side:         'long', score, reason,
  entry_price_usd:      priceUsd,
  notional_eur:         notionalEur,
  strategy:             'ob_scalp',
  equity_nav:           state.equity_nav,
  cash:                 state.cash,
  open_positions_count: state.open_positions.length,
});

process.stdout.write(JSON.stringify({
  status:              'opened',
  symbol, side:        'long', score, reason,
  strategy:            'ob_scalp',
  leverage:            SCALP_LEVERAGE,
  price_usd:           priceUsd,
  entry_price_eur:     entryPriceEur,
  quantity,
  margin_eur:          marginEur,
  notional_eur:        notionalEur,
  stop_loss_pct:       slPct,
  sl_level_usd:        slLevelUsd,
  take_profit_pct:     tpPct,
  tp_level_usd:        tpLevelUsd,
  thesis_valid_until:  thesisValidUntil,
  order_id:            order.order_id,
  run_id:              runId,
  portfolio: {
    equity_nav:           state.equity_nav,
    cash:                 state.cash,
    cash_pct:             +(state.cash / state.equity_nav * 100).toFixed(1),
    open_positions_count: state.open_positions.length,
    scalp_positions:      openScalps.length + 1,
  },
}, null, 2) + '\n');
