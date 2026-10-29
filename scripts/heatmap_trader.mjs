#!/usr/bin/env node
/**
 * heatmap_trader.mjs — Auto-execution from liq_heatmap signals.
 *
 * Paper mode (default): routes through auto_open.mjs → PaperBroker (no real orders)
 * Live mode (--live):   routes LIMIT orders to Bitunix via BitunixBroker (requires API keys)
 *
 * LONG signal (all required):
 *   1. squeeze_potential === 'short_squeeze_zones_detected'
 *   2. buy_sell_ratio >= LONG_BS_MIN (1.15)
 *   3. nearest_buy_wall within ENTRY_NEAR_PCT (1.5%) below current price
 *   4. nearest_buy_wall.notional_usd >= MIN_WALL_USD ($3M)
 *
 * Score: 8 → SL 3.3%, notional 5% NAV, breakeven+trailing enforced by auto_open
 *
 * Usage:
 *   node heatmap_trader.mjs              # paper, auto-execute on signals
 *   node heatmap_trader.mjs --dry-run    # detect signals only, no execution
 *   node heatmap_trader.mjs --live       # LIVE Bitunix LIMIT orders (paper guard active)
 */

import { readFileSync, existsSync }        from 'fs';
import { join, dirname }                   from 'path';
import { fileURLToPath }                   from 'url';
import { spawnSync }                       from 'child_process';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR   = join(__dirname, '../trading/cache');
const HEATMAP_PATH = join(CACHE_DIR, 'liq_heatmap.json');

// ─── Config ──────────────────────────────────────────────────────────────────

const HEATMAP_SYMBOLS  = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB'];
const LONG_BS_MIN      = 1.15;        // min buy/sell ratio for LONG signal
const ENTRY_NEAR_PCT   = 1.5;         // buy wall must be within 1.5% below price
const MIN_WALL_USD     = 3_000_000;   // min wall notional $3M
const HEATMAP_SCORE    = 8;           // technical signal → score 8, SL 3.3%, 5% NAV
const HEATMAP_REASON   = 'heatmap_short_squeeze';
const MAX_HEATMAP_AGE_MIN = 16;       // reject stale cache (>16 min old)

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIVE    = args.includes('--live');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(obj)  { process.stderr.write(JSON.stringify(obj) + '\n'); }
function cacheAgeMin(isoStr) {
  if (!isoStr) return Infinity;
  return (Date.now() - new Date(isoStr).getTime()) / 60000;
}

// ─── Read heatmap cache ───────────────────────────────────────────────────────

if (!existsSync(HEATMAP_PATH)) {
  log({ error: 'heatmap_trader_skip', reason: 'liq_heatmap.json missing' });
  process.exit(0);
}

let heatmap;
try {
  heatmap = JSON.parse(readFileSync(HEATMAP_PATH, 'utf8'));
} catch (e) {
  log({ error: 'heatmap_trader_skip', reason: 'parse_error', detail: e.message });
  process.exit(0);
}

// ─── Signal detection ────────────────────────────────────────────────────────

const signals = [];

for (const sym of HEATMAP_SYMBOLS) {
  const entry = heatmap[sym];
  if (!entry) {
    log({ info: 'heatmap_trader_no_data', symbol: sym }); continue;
  }

  const ageMin = cacheAgeMin(entry.updated_at);
  if (ageMin > MAX_HEATMAP_AGE_MIN) {
    log({ warn: 'heatmap_trader_stale', symbol: sym, age_min: Math.round(ageMin) }); continue;
  }

  const wall = entry.nearest_buy_wall;

  // LONG signal conditions
  const hasSqueeze = entry.squeeze_potential === 'short_squeeze_zones_detected';
  const hasRatio   = entry.buy_sell_ratio >= LONG_BS_MIN;
  const hasWall    = wall != null
    && wall.pct_away >= -ENTRY_NEAR_PCT     // within ENTRY_NEAR_PCT% below price
    && wall.notional_usd >= MIN_WALL_USD;

  if (!hasSqueeze || !hasRatio || !hasWall) {
    log({
      info:    'heatmap_trader_no_signal',
      symbol:  sym,
      ratio:   entry.buy_sell_ratio,
      squeeze: entry.squeeze_potential,
      wall_pct: wall?.pct_away ?? null,
      wall_usd: wall ? Math.round(wall.notional_usd / 1e6 * 10) / 10 + 'M' : null,
      reasons: [
        !hasSqueeze && 'no_squeeze',
        !hasRatio   && `ratio_${entry.buy_sell_ratio}<${LONG_BS_MIN}`,
        !hasWall    && (wall ? `wall_far_${wall.pct_away}%_or_small` : 'no_wall'),
      ].filter(Boolean),
    });
    continue;
  }

  signals.push({
    symbol:       sym,
    side:         'long',
    score:        HEATMAP_SCORE,
    reason:       HEATMAP_REASON,
    current_price: entry.current_price,
    limit_price:  wall.price,        // buy wall = limit entry level
    buy_sell_ratio: entry.buy_sell_ratio,
    wall_notional_usd: wall.notional_usd,
    wall_pct_away:     wall.pct_away,
    squeeze:      entry.squeeze_potential,
    heatmap_age_min: Math.round(ageMin),
  });

  log({
    info:        'heatmap_trader_signal',
    symbol:      sym,
    side:        'long',
    price:       entry.current_price,
    limit_price: wall.price,
    wall_pct:    wall.pct_away,
    wall_usd:    Math.round(wall.notional_usd / 1e6 * 10) / 10 + 'M',
    bs_ratio:    entry.buy_sell_ratio,
  });
}

log({ info: 'heatmap_trader_signals_total', count: signals.length, dry_run: DRY_RUN, live: LIVE });

// ─── Execution ────────────────────────────────────────────────────────────────

if (DRY_RUN || signals.length === 0) {
  if (DRY_RUN) console.log(`[heatmap_trader] dry-run — ${signals.length} signal(s), no execution`);
  process.exit(0);
}

const autoOpenPath = join(__dirname, 'execution', 'auto_open.mjs');

if (!LIVE) {
  // ── Paper mode: delegate to auto_open.mjs ───────────────────────────────────
  let opened = 0; let blocked = 0;

  for (const sig of signals) {
    log({ info: 'heatmap_trader_paper_open', symbol: sig.symbol, limit_price: sig.limit_price, ratio: sig.buy_sell_ratio });

    const result = spawnSync(process.execPath, [
      autoOpenPath,
      '--symbol',    sig.symbol,
      '--side',      sig.side,
      '--score',     String(sig.score),
      '--reason',    sig.reason,
      '--category',  'crypto',
      '--price-usd', String(sig.current_price),
    ], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 30_000 });

    if (result.error || result.status !== 0) {
      blocked++;
      log({ warn: 'heatmap_trader_open_blocked', symbol: sig.symbol, exit: result.status ?? null, error: result.error?.message ?? null });
    } else {
      opened++;
      log({ info: 'heatmap_trader_open_done', symbol: sig.symbol });
    }
  }

  console.log(`[heatmap_trader] paper — ${opened} opened, ${blocked} blocked`);

} else {
  // ── Live mode: LIMIT orders via BitunixBroker ────────────────────────────────
  // LIVE mode guard: set HEATMAP_LIVE_ENABLED=1 in env to unlock
  if (process.env.HEATMAP_LIVE_ENABLED !== '1') {
    console.log('[heatmap_trader] LIVE mode requested but HEATMAP_LIVE_ENABLED≠1 — aborting. Set env var to unlock.');
    log({ warn: 'heatmap_trader_live_guard', reason: 'HEATMAP_LIVE_ENABLED not set' });
    process.exit(0);
  }

  const apiKey    = process.env.BITUNIX_API_KEY;
  const secretKey = process.env.BITUNIX_SECRET_KEY;
  if (!apiKey || !secretKey) {
    console.log('[heatmap_trader] LIVE mode requires BITUNIX_API_KEY + BITUNIX_SECRET_KEY in env');
    process.exit(1);
  }

  const { BitunixBroker } = await import('./execution/live_broker/adapters/bitunix_broker.mjs');
  const { loadOrInit, usdToEur } = await import('./execution/portfolio/portfolio_state.mjs');
  const { dispatchApproved }     = await import('./execution/live_broker/order_dispatch.mjs');

  const broker    = new BitunixBroker({ apiKey, secretKey });
  const state     = loadOrInit();
  const nav       = state.equity_nav;
  const NOTIONAL_PCT = 0.05;   // 5% NAV per signal (score=8)
  const SL_PCT       = 3.3;
  const EUR_USD      = 1.08;   // fallback; portfolio_state.mjs exports EUR_USD_RATE

  let opened = 0; let blocked = 0;
  const runId = `heatmap_${Date.now()}`;

  for (const sig of signals) {
    // Policy: max positions
    if (state.open_positions.length + opened >= 5) {
      log({ warn: 'heatmap_trader_live_blocked', symbol: sig.symbol, reason: 'max_positions' }); blocked++; continue;
    }
    // Policy: duplicate
    if (state.open_positions.some(p => p.symbol === sig.symbol && p.side === sig.side)) {
      log({ warn: 'heatmap_trader_live_blocked', symbol: sig.symbol, reason: 'duplicate' }); blocked++; continue;
    }
    // Policy: blocked symbol
    const now = new Date();
    const isBlocked = (state.blocked_symbols || []).find(b =>
      b.symbol === sig.symbol && b.side === sig.side &&
      (b.blocked_until == null || new Date(b.blocked_until) > now)
    );
    if (isBlocked) {
      log({ warn: 'heatmap_trader_live_blocked', symbol: sig.symbol, reason: 'blocked_symbol' }); blocked++; continue;
    }
    // Policy: cash floor
    const notionalEur  = +(nav * NOTIONAL_PCT).toFixed(2);
    const cashAfter    = state.cash - notionalEur;
    if (cashAfter < nav * 0.20) {
      log({ warn: 'heatmap_trader_live_blocked', symbol: sig.symbol, reason: 'cash_floor', cash_after: cashAfter }); blocked++; continue;
    }

    const notionalUsd  = notionalEur * EUR_USD;
    const qty          = +(notionalUsd / sig.limit_price).toFixed(6);

    log({
      info:        'heatmap_trader_live_submit',
      symbol:      sig.symbol,
      limit_price: sig.limit_price,
      qty,
      notional_usd: Math.round(notionalUsd),
    });

    try {
      const summary = await dispatchApproved([{
        symbol:      sig.symbol,
        side:        sig.side,
        action:      'open',
        quantity:    qty,
        order_type:  'limit',
        limit_price: sig.limit_price,
        run_id:      runId,
        price_usd:   sig.limit_price,
        stop_loss_pct:   SL_PCT,
      }], { broker, run_id: runId });

      if (summary.submitted > 0) {
        opened++;
        log({ info: 'heatmap_trader_live_done', symbol: sig.symbol, ...summary.results[0] });
      } else {
        blocked++;
        log({ warn: 'heatmap_trader_live_not_submitted', symbol: sig.symbol, summary });
      }
    } catch (e) {
      blocked++;
      log({ error: 'heatmap_trader_live_error', symbol: sig.symbol, detail: e.message });
    }
  }

  console.log(`[heatmap_trader] LIVE — ${opened} limit orders submitted, ${blocked} blocked`);
}
