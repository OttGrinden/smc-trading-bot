#!/usr/bin/env node
/**
 * macro_trader.mjs — Automated Macro Signal Trader (always PAPER_MODE)
 *
 * Reads macro_signals.json and opens/monitors crypto swing trades when
 * score >= min_score. Position management (SL/TP/hold-day expiry) is
 * handled automatically on every run.
 *
 * Architecture:
 *   1. Freshness-gate on macro_signals.json (4h) — refresh via macro_signal.mjs if stale
 *   2. For each signal with action=TRADE and score >= min_score:
 *        a. Portfolio guards (cash floor, max positions, risk budget, blocked symbols)
 *        b. execute via manual_open.mjs (paper mode)
 *   3. Monitor open macro positions (SL / TP / hold-day expiry)
 *        → close via manual_close.mjs
 *   4. Log all decisions to trading/logs/macro_trade_log.jsonl
 *
 * Usage:
 *   node macro_trader.mjs                  — single run
 *   node macro_trader.mjs --monitor        — loop (interval seconds)
 *   node macro_trader.mjs --interval 1800  — loop interval in seconds (default 1800)
 *   node macro_trader.mjs --min-score 8    — min score to trade (default 8)
 *   node macro_trader.mjs --symbols BTC,ETH
 *   node macro_trader.mjs --dry-run        — simulate, no writes
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { spawnSync }  from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAPER_MODE = true; // hardcoded — never send live orders

const SCRIPTS_DIR    = dirname(fileURLToPath(import.meta.url));
const BASE_DIR       = join(SCRIPTS_DIR, '..');
const SIGNAL_PATH    = join(BASE_DIR, 'trading/cache/macro_signals.json');
const POS_PATH       = join(BASE_DIR, 'trading/cache/positioning_data.json');
const STATE_PATH     = join(BASE_DIR, 'trading/execution/portfolio/portfolio_state.json');
const MACRO_OPEN     = join(BASE_DIR, 'trading/logs/macro_trades_open.json');
const MACRO_LOG      = join(BASE_DIR, 'trading/logs/macro_trade_log.jsonl');

const SIGNAL_MAX_AGE_MS = 4 * 60 * 60 * 1000;  // 4h — daily candles change slowly
const BITUNIX_BASE      = 'https://fapi.bitunix.com';
const FETCH_TIMEOUT_MS  = 15_000;

const MIN_CASH_PCT    = 0.20;  // 20% NAV floor
const RISK_BUDGET_PCT = 0.06;  // 6% NAV total at-risk budget
const MAX_POSITIONS   = 5;

// Position size by score (% of NAV)
const SIZE_BY_SCORE = { 10: 0.07, 9: 0.06, 8: 0.05 };
const MIN_NOTIONAL_EUR = 50;
const MAX_NOTIONAL_EUR = 200;

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  function get(f, d) { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : d; }
  return {
    monitor:  argv.includes('--monitor'),
    dryRun:   argv.includes('--dry-run'),
    interval: parseInt(get('--interval', '1800'), 10),
    minScore: parseInt(get('--min-score', '8'),  10),
    symbols:  get('--symbols', 'BTC,ETH').split(',').map(s => s.trim().toUpperCase()),
  };
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function logDecision(entry) {
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() });
  try { appendFileSync(MACRO_LOG, line + '\n', 'utf8'); } catch { /* best-effort */ }
  process.stderr.write('[macro_trader] ' + line + '\n');
}

// ─── Portfolio State ──────────────────────────────────────────────────────────

function loadPortfolio() {
  if (!existsSync(STATE_PATH)) return null;
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}

// ─── Macro Open Positions ─────────────────────────────────────────────────────

function loadMacroOpen() {
  if (!existsSync(MACRO_OPEN)) return [];
  try { return JSON.parse(readFileSync(MACRO_OPEN, 'utf8')); } catch { return []; }
}

function saveMacroOpen(trades) {
  writeFileSync(MACRO_OPEN, JSON.stringify(trades, null, 2) + '\n', 'utf8');
}

// ─── Signal Freshness ─────────────────────────────────────────────────────────

function loadSignals() {
  if (!existsSync(SIGNAL_PATH)) return null;
  try {
    const data  = JSON.parse(readFileSync(SIGNAL_PATH, 'utf8'));
    const ageMs = Date.now() - new Date(data.generated_at).getTime();
    return { data, ageMs, stale: ageMs > SIGNAL_MAX_AGE_MS };
  } catch { return null; }
}

function refreshSignals(symbols, dryRun) {
  if (dryRun) {
    process.stderr.write('[macro_trader] DRY-RUN: would refresh macro_signals.json\n');
    return true;
  }
  const r = spawnSync(process.execPath, [
    join(SCRIPTS_DIR, 'macro_signal.mjs'),
    '--symbols', symbols.join(','),
    '--quiet',
  ], { timeout: 120_000, maxBuffer: 5 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  return r.status === 0;
}

// ─── Price Fetch (Bitunix funding_rate endpoint — returns markPrice) ──────────

async function fetchMarkPrice(symbol) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${BITUNIX_BASE}/api/v1/futures/market/funding_rate?symbol=${symbol}USDT`;
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const p    = parseFloat(json.data?.markPrice);
    return Number.isFinite(p) ? p : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ─── Position Sizing ──────────────────────────────────────────────────────────

function sizeForScore(score, nav) {
  const pct = SIZE_BY_SCORE[Math.min(score, 10)] ?? 0.05;
  return Math.max(MIN_NOTIONAL_EUR, Math.min(MAX_NOTIONAL_EUR, Math.round(nav * pct)));
}

// ─── Portfolio Guards ─────────────────────────────────────────────────────────

function checkGuards(symbol, direction, notionalEur, slPct, state) {
  if (!state) return { ok: false, reasons: ['portfolio_state_unavailable'] };

  const { cash, equity_nav: nav, open_positions, blocked_symbols = [] } = state;
  const reasons = [];

  // 1. Already open for this symbol (any direction — no stacking)
  if (open_positions.some(p => p.symbol === symbol)) {
    reasons.push(`position_already_open:${symbol}`);
  }

  // 2. Blocked symbols
  const sideKey = direction.toLowerCase();
  const blocked = blocked_symbols.some(b =>
    b.symbol === symbol && b.side === sideKey &&
    (!b.blocked_until || new Date(b.blocked_until) > new Date())
  );
  if (blocked) reasons.push(`symbol_blocked:${symbol}_${sideKey}`);

  // 3. Max positions
  if (open_positions.length >= MAX_POSITIONS) reasons.push('max_positions_reached');

  // 4. Cash floor: cash after entry must remain >= 20% NAV
  const cashAfter = cash - notionalEur;
  const cashFloor = nav * MIN_CASH_PCT;
  if (cashAfter < cashFloor) {
    reasons.push(`cash_floor:have_${cash.toFixed(0)}_after_${cashAfter.toFixed(0)}_floor_${cashFloor.toFixed(0)}`);
  }

  // 5. Risk budget: current + new trade risk <= 6% NAV
  const currentRisk = open_positions.reduce(
    (s, p) => s + (p.notional_eur ?? 0) * ((p.stop_loss_pct ?? 8) / 100), 0
  );
  const newRisk   = notionalEur * (slPct / 100);
  const totalRisk = currentRisk + newRisk;
  const budgetEur = nav * RISK_BUDGET_PCT;
  if (totalRisk > budgetEur) {
    reasons.push(`risk_budget:${totalRisk.toFixed(1)}/${budgetEur.toFixed(1)}`);
  }

  return { ok: reasons.length === 0, reasons };
}

// ─── Execute Open ─────────────────────────────────────────────────────────────

function executeOpen(symbol, direction, priceUsd, notionalEur, slPct, tpPct, score, dryRun, runId) {
  const argv = [
    join(SCRIPTS_DIR, 'execution/manual_open.mjs'),
    '--symbol',        symbol,
    '--side',          direction.toLowerCase(),
    '--reason',        `macro_trader_score${score}`,
    '--price-usd',     String(priceUsd),
    '--notional-eur',  String(notionalEur),
    '--stop-loss-pct', String(slPct),
    '--run-id',        runId,
  ];
  if (tpPct  != null) argv.push('--take-profit-pct',       String(tpPct));
  argv.push('--breakeven-trigger-pct', '5');  // activate breakeven after +5%
  if (dryRun) argv.push('--dry-run');

  const r = spawnSync(process.execPath, argv, {
    timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return { ok: r.status === 0, detail: r.error?.message ?? `exit ${r.status}` };
}

// ─── Execute Close ────────────────────────────────────────────────────────────

function executeClose(symbol, direction, reason, dryRun, runId) {
  const argv = [
    join(SCRIPTS_DIR, 'execution/manual_close.mjs'),
    '--symbol', symbol,
    '--side',   direction.toLowerCase(),
    '--reason', reason,
    '--run-id', runId,
  ];
  if (dryRun) argv.push('--dry-run');

  const r = spawnSync(process.execPath, argv, {
    timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return { ok: r.status === 0, detail: r.error?.message ?? `exit ${r.status}` };
}

// ─── Monitor Open Macro Positions ─────────────────────────────────────────────

async function checkOpenPositions(macroTrades, dryRun, runId) {
  const now = new Date();
  for (const trade of macroTrades) {
    if (trade.status !== 'open') continue;

    // Get current price — try live fetch, fall back to positioning cache
    let price = await fetchMarkPrice(trade.symbol);
    if (price === null) {
      try {
        const posCache = JSON.parse(readFileSync(POS_PATH, 'utf8'));
        price = posCache[trade.symbol]?.mark_price_usd ?? null;
      } catch { /* ignore */ }
    }

    let closeReason = null;

    if (price !== null) {
      const longSL   = trade.direction === 'LONG'  && price <= trade.sl_price;
      const longTP   = trade.direction === 'LONG'  && price >= trade.tp_price;
      const shortSL  = trade.direction === 'SHORT' && price >= trade.sl_price;
      const shortTP  = trade.direction === 'SHORT' && price <= trade.tp_price;
      if (longSL  || shortSL)  closeReason = 'macro_stop_loss_hit';
      else if (longTP || shortTP) closeReason = 'macro_take_profit_hit';
    }

    if (!closeReason && trade.hold_until && now > new Date(trade.hold_until)) {
      closeReason = 'macro_hold_days_expired';
    }

    if (closeReason) {
      const r = executeClose(trade.symbol, trade.direction, closeReason, dryRun, runId);
      logDecision({
        event:     'macro_close',
        symbol:    trade.symbol,
        direction: trade.direction,
        reason:    closeReason,
        price,
        sl_price:  trade.sl_price,
        tp_price:  trade.tp_price,
        ok:        r.ok,
        dry:       dryRun,
      });
      if (r.ok || dryRun) {
        trade.status      = 'closed';
        trade.closed_reason = closeReason;
        trade.closed_at   = now.toISOString();
        trade.close_price = price;
      }
    }
  }
  return macroTrades;
}

// ─── Single Run ───────────────────────────────────────────────────────────────

async function runOnce(args) {
  const runId = `macro_${Date.now()}`;
  process.stderr.write(`\n=== macro_trader run ${runId} (paper=${PAPER_MODE} dry=${args.dryRun} min-score=${args.minScore}) ===\n`);

  // 1. Load or refresh signals
  let sig = loadSignals();
  if (!sig || sig.stale) {
    const ageMin = sig ? Math.round(sig.ageMs / 60_000) : null;
    process.stderr.write(`[macro_trader] signal ${ageMin !== null ? `${ageMin}min old` : 'missing'} — refreshing...\n`);
    const ok = refreshSignals(args.symbols, args.dryRun);
    if (!ok && !args.dryRun) {
      process.stderr.write('[macro_trader] macro_signal.mjs failed — skipping run\n');
      return { skipped: true, reason: 'signal_refresh_failed' };
    }
    sig = loadSignals();
    if (!sig) {
      process.stderr.write('[macro_trader] macro_signals.json missing after refresh — aborting\n');
      return { skipped: true, reason: 'signal_missing' };
    }
  } else {
    process.stderr.write(`[macro_trader] signal fresh (${Math.round(sig.ageMs / 60_000)}min) — using cached\n`);
  }

  const { signals, regime } = sig.data;
  process.stderr.write(`[macro_trader] regime=${regime.toUpperCase()} signals=${signals.length}\n`);

  // 2. Monitor open macro positions
  let macroTrades = loadMacroOpen();
  const openBefore = macroTrades.filter(t => t.status === 'open').length;
  macroTrades = await checkOpenPositions(macroTrades, args.dryRun, runId);
  const openAfter = macroTrades.filter(t => t.status === 'open').length;
  if (openBefore !== openAfter) {
    saveMacroOpen(macroTrades);
    process.stderr.write(`[macro_trader] closed ${openBefore - openAfter} position(s) (SL/TP/hold-day)\n`);
  }

  // 3. Portfolio state
  const state = loadPortfolio();
  const nav   = state?.equity_nav ?? 1000;

  // 4. Try to open new positions for signals
  let openedCount = 0;
  for (const sig of signals) {
    if (!args.symbols.includes(sig.symbol)) continue;

    const infoPrefix = `  ${sig.symbol} ${sig.best_direction} score=${sig.best_score}`;

    if (sig.action === 'WATCHLIST') {
      process.stderr.write(`${infoPrefix}: WATCHLIST — no auto-trade\n`);
      logDecision({ event: 'watchlist', symbol: sig.symbol, direction: sig.best_direction, score: sig.best_score, regime });
      continue;
    }

    if (sig.action !== 'TRADE' || sig.best_score < args.minScore) {
      process.stderr.write(`${infoPrefix}: NO SIGNAL (action=${sig.action})\n`);
      logDecision({ event: 'no_signal', symbol: sig.symbol, score: sig.best_score, action: sig.action });
      continue;
    }

    // Already open macro position for this symbol?
    const alreadyMacro = macroTrades.some(t => t.symbol === sig.symbol && t.status === 'open');
    if (alreadyMacro) {
      process.stderr.write(`${infoPrefix}: macro position already open — skip\n`);
      continue;
    }

    // Get price: positioning cache mark price (most current) or signal close (last daily)
    let priceUsd = null;
    try {
      const posCache = JSON.parse(readFileSync(POS_PATH, 'utf8'));
      priceUsd = posCache[sig.symbol]?.mark_price_usd ?? null;
    } catch { /* ignore */ }
    if (!priceUsd) priceUsd = sig.close;

    if (!priceUsd) {
      process.stderr.write(`${infoPrefix}: no price — skip\n`);
      logDecision({ event: 'skip', reason: 'no_price', symbol: sig.symbol });
      continue;
    }

    const notionalEur = sizeForScore(sig.best_score, nav);
    const slPct       = sig.sl_pct;
    const tpPct       = sig.tp_pct;
    const holdDays    = parseInt((sig.hold_days ?? '4').split('–').pop(), 10);

    // Guards
    const guards = checkGuards(sig.symbol, sig.best_direction, notionalEur, slPct, state);
    if (!guards.ok) {
      process.stderr.write(`${infoPrefix}: guard-blocked → ${guards.reasons.join(', ')}\n`);
      logDecision({ event: 'guard_blocked', symbol: sig.symbol, direction: sig.best_direction, score: sig.best_score, reasons: guards.reasons });
      continue;
    }

    // Execute open
    const dryTag = args.dryRun ? ' [DRY-RUN]' : '';
    process.stderr.write(`${infoPrefix}: OPEN ${sig.best_direction} $${priceUsd} €${notionalEur} SL=${slPct}% TP=${tpPct}%${dryTag}\n`);

    const r = executeOpen(sig.symbol, sig.best_direction, priceUsd, notionalEur, slPct, tpPct, sig.best_score, args.dryRun, runId);

    if (r.ok || args.dryRun) {
      const slPrice = sig.best_direction === 'LONG'
        ? priceUsd * (1 - slPct / 100)
        : priceUsd * (1 + slPct / 100);
      const tpPrice = sig.best_direction === 'LONG'
        ? priceUsd * (1 + tpPct / 100)
        : priceUsd * (1 - tpPct / 100);

      const trade = {
        trade_id:     `macro_${Date.now()}_${sig.symbol}_${sig.best_direction}`,
        symbol:       sig.symbol,
        direction:    sig.best_direction,
        entry_price:  priceUsd,
        sl_pct:       slPct,
        tp_pct:       tpPct,
        sl_price:     +slPrice.toFixed(4),
        tp_price:     +tpPrice.toFixed(4),
        hold_until:   new Date(Date.now() + holdDays * 24 * 60 * 60 * 1000).toISOString(),
        score:        sig.best_score,
        regime,
        notional_eur: notionalEur,
        status:       'open',
        dry:          args.dryRun,
        opened_at:    new Date().toISOString(),
        run_id:       runId,
      };
      macroTrades.push(trade);
      saveMacroOpen(macroTrades);
      openedCount++;

      logDecision({ event: 'trade_opened', ...trade });
      process.stderr.write(`  → SL=$${slPrice.toFixed(2)} TP=$${tpPrice.toFixed(2)} hold=${holdDays}d until=${trade.hold_until.slice(0, 10)}\n`);
    } else {
      process.stderr.write(`  → FAILED: ${r.detail}\n`);
      logDecision({ event: 'trade_failed', symbol: sig.symbol, direction: sig.best_direction, detail: r.detail });
    }
  }

  process.stderr.write(`=== macro_trader done — opened ${openedCount}, macro_open_positions=${macroTrades.filter(t => t.status === 'open').length} ===\n\n`);

  return {
    skipped:   false,
    regime,
    opened:    openedCount,
    macro_open: macroTrades.filter(t => t.status === 'open').length,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(argv) {
  const args = parseArgs(argv);

  process.stdout.write(JSON.stringify({
    info:       'macro_trader_start',
    paper_mode: PAPER_MODE,
    dry_run:    args.dryRun,
    min_score:  args.minScore,
    monitor:    args.monitor,
    symbols:    args.symbols,
  }) + '\n');

  if (args.monitor) {
    process.stderr.write(`[macro_trader] monitor mode — interval ${args.interval}s\n`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await runOnce(args);
      process.stderr.write(`[macro_trader] next run in ${args.interval}s\n`);
      await new Promise(r => setTimeout(r, args.interval * 1_000));
    }
  } else {
    const result = await runOnce(args);
    process.stdout.write(JSON.stringify({ info: 'macro_trader_complete', ...result }) + '\n');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv).catch(e => {
    process.stderr.write(JSON.stringify({ error: 'macro_trader_crash', detail: e.message }) + '\n');
    process.exit(1);
  });
}
