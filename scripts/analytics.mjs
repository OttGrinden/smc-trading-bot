#!/usr/bin/env node
/**
 * analytics.mjs — Portfolio Performance Analytics
 *
 * Computes Sharpe, Sortino, Max Drawdown, Profit Factor, Win Rate
 * from portfolio_history.jsonl and trade_ledger.jsonl.
 *
 * Usage (CLI):   node analytics.mjs
 * Usage (module): import { computeAnalytics } from './analytics.mjs'
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath }            from 'url';
import { dirname, join, resolve }   from 'path';

const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const HISTORY_PATH = join(TRADING_DIR, 'execution', 'portfolio', 'portfolio_history.jsonl');
const LEDGER_PATH  = join(TRADING_DIR, 'execution', 'portfolio', 'trade_ledger.jsonl');
const RISK_FREE    = 0;  // simplified: 0% risk-free rate for Sharpe

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim().split('\n').filter(Boolean)
    .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr, mu) {
  if (arr.length < 2) return 0;
  const m = mu ?? mean(arr);
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// ─── Core computation ─────────────────────────────────────────────────────────

export function computeAnalytics() {
  // ── NAV history ──────────────────────────────────────────────────────────
  const history = readJsonl(HISTORY_PATH).filter(e => e.equity_nav != null && e.ts);

  if (history.length < 2) {
    return { error: 'insufficient_history', entries: history.length };
  }

  // Filter to entries at/after portfolio creation (skip early test/dev runs)
  let portfolioCreatedAt = null;
  try {
    const state = JSON.parse(readFileSync(
      join(TRADING_DIR, 'execution', 'portfolio', 'portfolio_state.json'), 'utf8'
    ));
    portfolioCreatedAt = state.created_at ?? null;
  } catch { /* best-effort */ }

  const productionHistory = portfolioCreatedAt
    ? history.filter(e => e.ts >= portfolioCreatedAt)
    : history;

  if (productionHistory.length < 2) {
    return { error: 'insufficient_history', entries: productionHistory.length };
  }

  // One NAV per calendar day (last entry of each day)
  const byDay = new Map();
  for (const e of productionHistory) {
    byDay.set(e.ts.slice(0, 10), e.equity_nav);
  }
  const days    = [...byDay.keys()].sort();
  const navSeries = days.map(d => byDay.get(d));

  const startNav = navSeries[0];
  const endNav   = navSeries[navSeries.length - 1];
  const startDate = days[0];
  const endDate   = days[days.length - 1];
  const totalDays = Math.round((new Date(endDate) - new Date(startDate)) / 86_400_000);

  // Total return
  const totalReturnPct = +((endNav - startNav) / startNav * 100).toFixed(2);

  // Daily returns
  const dailyReturns = [];
  for (let i = 1; i < navSeries.length; i++) {
    dailyReturns.push((navSeries[i] - navSeries[i - 1]) / navSeries[i - 1]);
  }

  const mu  = mean(dailyReturns);
  const sig = stdDev(dailyReturns, mu);

  const annFactor = Math.sqrt(252);
  const sharpe    = sig > 0 ? +((mu - RISK_FREE) / sig * annFactor).toFixed(3) : null;

  // Sortino — downside std uses ALL periods in denominator (standard convention)
  const downsideReturns = dailyReturns.filter(r => r < 0);
  const downsideVariance = dailyReturns.reduce((a, b) => a + Math.min(b, 0) ** 2, 0) / dailyReturns.length;
  const downsideStd      = Math.sqrt(downsideVariance);
  const sortino          = downsideStd > 0 ? +((mu - RISK_FREE) / downsideStd * annFactor).toFixed(3) : null;

  // Max Drawdown
  let peak = navSeries[0];
  let maxDrawdownPct = 0;
  for (const nav of navSeries) {
    if (nav > peak) peak = nav;
    const dd = (nav - peak) / peak * 100;
    if (dd < maxDrawdownPct) maxDrawdownPct = dd;
  }
  maxDrawdownPct = +maxDrawdownPct.toFixed(2);

  // ── Trade ledger ──────────────────────────────────────────────────────────
  // Filter to production closes only: exclude test/setup/smoke artifacts
  const NON_PROD_REASONS = ['smoke_test', 'dry_run', 'test_cleanup', 'mechanical_fill_no_policy_basis', 'no_mark_price'];
  const allCloses = readJsonl(LEDGER_PATH).filter(e => e.event === 'close' && e.realized_pnl_eur != null);
  const closes    = allCloses.filter(e => {
    const r = e.reason ?? '';
    if (NON_PROD_REASONS.some(bad => r.includes(bad))) return false;
    return true;
  });
  const wins   = closes.filter(e => e.realized_pnl_eur > 0);
  const losses = closes.filter(e => e.realized_pnl_eur < 0);

  const grossWins   = wins.reduce((a, e) => a + e.realized_pnl_eur, 0);
  const grossLosses = Math.abs(losses.reduce((a, e) => a + e.realized_pnl_eur, 0));
  const profitFactor = grossLosses > 0 ? +(grossWins / grossLosses).toFixed(2) : null;

  // ── Portfolio state summary ───────────────────────────────────────────────
  // Use closed_positions_summary from state as the authoritative win/loss count
  let closedSummary = null;
  try {
    const state = JSON.parse(readFileSync(
      join(TRADING_DIR, 'execution', 'portfolio', 'portfolio_state.json'), 'utf8'
    ));
    closedSummary = state.closed_positions_summary ?? null;
  } catch { /* best-effort */ }

  const stateWins   = closedSummary?.wins   ?? null;
  const stateLosses = closedSummary?.losses  ?? null;
  const stateTotal  = closedSummary?.count   ?? null;
  const winRate     = (stateWins != null && stateTotal != null && stateTotal > 0)
    ? +(stateWins / stateTotal * 100).toFixed(1)
    : (closes.length > 0 ? +(wins.length / closes.length * 100).toFixed(1) : null);

  return {
    period:           { start: startDate, end: endDate, calendar_days: totalDays },
    nav:              { start: startNav, end: endNav, total_return_pct: totalReturnPct },
    sharpe,
    sortino,
    max_drawdown_pct: maxDrawdownPct,
    profit_factor:    profitFactor,
    win_rate_pct:     winRate,
    trades:           { total: stateTotal ?? closes.length, wins: stateWins ?? wins.length, losses: stateLosses ?? losses.length },
    gross_wins_eur:   +grossWins.toFixed(2),
    gross_losses_eur: +grossLosses.toFixed(2),
    closed_summary:   closedSummary,
    daily_returns:    { count: dailyReturns.length, mean_pct: +(mu * 100).toFixed(4), std_pct: +(sig * 100).toFixed(4) },
  };
}

// ─── CLI output ───────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const a = computeAnalytics();

  if (a.error) {
    process.stderr.write(`analytics error: ${a.error} (entries: ${a.entries})\n`);
    process.exit(1);
  }

  const sign = v => v >= 0 ? '+' : '';
  const fmt  = (v, d = 2) => v != null ? v.toFixed(d) : 'n/a';

  process.stdout.write('\n=== Portfolio Performance Analytics ===\n');
  process.stdout.write(`Period:          ${a.period.start} → ${a.period.end} (${a.period.calendar_days} days)\n`);
  process.stdout.write(`NAV:             EUR ${fmt(a.nav.start)} → EUR ${fmt(a.nav.end)} (${sign(a.nav.total_return_pct)}${fmt(a.nav.total_return_pct)}%)\n`);
  process.stdout.write('\n');
  process.stdout.write(`Sharpe Ratio:    ${fmt(a.sharpe, 3)}  (annualized, rf=0)\n`);
  process.stdout.write(`Sortino Ratio:   ${fmt(a.sortino, 3)}  (annualized)\n`);
  process.stdout.write(`Max Drawdown:    ${fmt(a.max_drawdown_pct)}%\n`);
  process.stdout.write(`Profit Factor:   ${fmt(a.profit_factor, 2)}\n`);
  process.stdout.write(`Win Rate:        ${fmt(a.win_rate_pct, 1)}%  (${a.trades.wins}W · ${a.trades.losses}L · ${a.trades.total} closed)\n`);
  process.stdout.write('\n');
  process.stdout.write(`Daily returns:   mean ${sign(a.daily_returns.mean_pct)}${fmt(a.daily_returns.mean_pct, 4)}% · σ ${fmt(a.daily_returns.std_pct, 4)}%\n`);
  process.stdout.write(`Gross P&L:       wins EUR +${fmt(a.gross_wins_eur)} · losses EUR -${fmt(a.gross_losses_eur)}\n`);

  if (a.closed_summary) {
    const cs = a.closed_summary;
    process.stdout.write(`Closed positions: ${cs.count} total · ${cs.wins} wins · ${cs.losses} losses · EUR ${sign(cs.realized_pnl_total)}${fmt(cs.realized_pnl_total)} realized\n`);
  }
  process.stdout.write('=======================================\n');
}
