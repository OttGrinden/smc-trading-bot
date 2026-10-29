#!/usr/bin/env node
/**
 * portfolio_analytics.mjs — Trading Performance Analytics
 *
 * Reads trade_ledger.jsonl + portfolio_state.json and produces a full
 * breakdown: win rate, expectancy, by side / sector / reason / score.
 *
 * Usage:
 *   node portfolio_analytics.mjs
 *   node portfolio_analytics.mjs --since 2026-07-01
 *   node portfolio_analytics.mjs --json
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath }           from 'url';
import { dirname, join }           from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const BASE       = join(__dirname, '../trading');
const LEDGER     = join(BASE, 'execution/portfolio/trade_ledger.jsonl');
const STATE      = join(BASE, 'execution/portfolio/portfolio_state.json');
const REGISTRY   = join(__dirname, '../trading/registry/registry.json');

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const get = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : null; };
  return {
    since:  get('--since') ? new Date(get('--since')) : null,
    json:   argv.includes('--json'),
  };
}

// ─── Sector map from registry ─────────────────────────────────────────────────

function buildSectorMap(regPath) {
  if (!existsSync(regPath)) return {};
  const reg     = JSON.parse(readFileSync(regPath, 'utf8'));
  const map     = {};
  const sectors = reg.stocks?.sectors ?? {};
  for (const [key, def] of Object.entries(sectors)) {
    for (const sym of def.watchlist ?? []) map[sym.symbol] = key;
  }
  for (const sym of reg.crypto?.watchlist ?? []) map[sym.symbol] = 'crypto';
  return map;
}

// ─── Skip heuristic for test / infra noise ────────────────────────────────────

const SKIP_REASONS = new Set([
  'smoke_test_dry_run', 'smoke_test_check_no_mark',
  'test_cleanup', 'test_position_accidentally_opened',
]);
const SKIP_REASON_PFXS = ['mechanical_fill_'];
const SKIP_STRATEGIES  = new Set(['test_strategy', 'undefined', undefined]);

function skipClose(c) {
  if (SKIP_REASONS.has(c.reason))                            return true;
  if (SKIP_REASON_PFXS.some(p => c.reason?.startsWith(p)))  return true;
  return false;
}
function skipOpen(o) {
  return SKIP_STRATEGIES.has(o.strategy);
}

// ─── Match opens → closes ─────────────────────────────────────────────────────

function buildTrades(lines, sectorMap, since) {
  const opens  = lines.filter(l => l.event === 'open'  && !skipOpen(l));
  const closes = lines.filter(l => l.event === 'close' && !skipClose(l));

  // Index opens by (run_id, symbol, side) for fast lookup
  const openIdx = new Map();
  for (const o of opens) {
    const key = `${o.run_id}|${o.symbol}|${o.side}`;
    openIdx.set(key, o);
  }

  const trades = [];
  for (const c of closes) {
    if (since && new Date(c.ts) < since) continue;

    // Match by entry_run_id (preferred) or fallback: nearest prior open
    let open = openIdx.get(`${c.entry_run_id}|${c.symbol}|${c.side}`);
    if (!open) {
      // Fallback: last open before close ts for this symbol+side
      open = opens
        .filter(o => o.symbol === c.symbol && o.side === c.side && o.ts <= c.ts)
        .at(-1);
    }
    if (!open) continue;

    const holdMs   = new Date(c.ts) - new Date(open.ts ?? c.ts);
    const holdDays = +(holdMs / 86_400_000).toFixed(1);
    const pnl      = c.realized_pnl_eur ?? 0;
    const notional = open.notional_eur ?? c.notional_eur ?? null;
    const pnlPct   = notional && notional > 0 ? +(pnl / notional * 100).toFixed(2) : null;

    trades.push({
      symbol:    c.symbol,
      side:      c.side,
      sector:    sectorMap[c.symbol] ?? 'unknown',
      pnl,
      pnlPct,
      notional,
      reason:    c.reason,
      strategy:  open.strategy ?? null,
      auto_score: open.auto_score ?? null,
      stop_loss_pct: open.stop_loss_pct ?? null,
      opened_at:  open.ts,
      closed_at:  c.ts,
      holdDays,
      entry_eur:  open.entry_price_eur,
      close_eur:  c.close_price_eur,
    });
  }
  return trades;
}

// ─── Metrics helpers ──────────────────────────────────────────────────────────

function metrics(trades) {
  if (!trades.length) return { n: 0, wins: 0, losses: 0, wr: 0, totalPnl: 0, exp: 0, avgHold: 0 };
  const real    = trades.filter(t => t.pnl !== 0);   // exclude 0-pnl no_mark entries
  const wins    = real.filter(t => t.pnl > 0);
  const losses  = real.filter(t => t.pnl < 0);
  const totalPnl = +trades.reduce((s, t) => s + t.pnl, 0).toFixed(2);
  const avgHold  = real.length
    ? +(real.reduce((s, t) => s + t.holdDays, 0) / real.length).toFixed(1)
    : 0;
  return {
    n:        real.length,
    wins:     wins.length,
    losses:   losses.length,
    wr:       real.length ? +(wins.length / real.length * 100).toFixed(1) : 0,
    totalPnl,
    exp:      real.length ? +(totalPnl / real.length).toFixed(2) : 0,
    avgHold,
    avgWin:   wins.length   ? +(wins.reduce((s,t)=>s+t.pnl,0) / wins.length).toFixed(2) : 0,
    avgLoss:  losses.length ? +(losses.reduce((s,t)=>s+t.pnl,0) / losses.length).toFixed(2) : 0,
  };
}

function groupBy(trades, key) {
  const groups = {};
  for (const t of trades) {
    const k = t[key] ?? 'unknown';
    (groups[k] = groups[k] ?? []).push(t);
  }
  return groups;
}

// ─── Reason bucketing ─────────────────────────────────────────────────────────

function bucketReason(reason) {
  if (!reason)                                    return 'unknown';
  if (reason === 'stop_loss_hit')                 return 'stop_loss_hit';
  if (reason === 'take_profit_hit')               return 'take_profit_hit';
  if (reason === 'breakeven_stop_hit')            return 'breakeven_stop';
  if (reason === 'trailing_stop_hit')             return 'trailing_stop';
  if (reason === 'no_mark_price')                 return 'no_mark_price';
  if (reason.startsWith('profit_take'))           return 'profit_take';
  if (reason.startsWith('thesis_invalid'))        return 'thesis_invalidated';
  if (reason.startsWith('thesis_expired'))        return 'thesis_expired';
  if (reason.startsWith('sl_proximity'))          return 'sl_proximity_manual';
  if (reason.startsWith('entry_quality'))         return 'entry_quality_fail';
  if (reason.startsWith('de-risk'))               return 'de-risk';
  if (reason === 'direction_flip')                return 'direction_flip';
  return 'other_manual';
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const W = 62;
const line  = (s = '') => s.padEnd(W);
const bar   = '═'.repeat(W);
const sep   = '─'.repeat(W);
const sign  = v => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
const pct   = v => v >= 0 ? `+${v.toFixed(1)}%` : `${v.toFixed(1)}%`;

function printSection(title, rows) {
  console.log(`\n  [ ${title} ]`);
  for (const r of rows) console.log(`  ${r}`);
}

function tableRow(cols, widths) {
  return cols.map((c, i) => String(c ?? '—').padEnd(widths[i])).join(' ');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const args      = parseArgs(argv);
  const sectorMap = buildSectorMap(REGISTRY);

  if (!existsSync(LEDGER)) {
    console.error('trade_ledger.jsonl not found:', LEDGER);
    process.exit(1);
  }

  const lines = readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const trades = buildTrades(lines, sectorMap, args.since);

  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;

  if (args.json) {
    const m = metrics(trades);
    console.log(JSON.stringify({ generated_at: new Date().toISOString(), ...m, trades }, null, 2));
    return;
  }

  // ── Header ─────────────────────────────────────────────────────────────────
  const m = metrics(trades);
  const sinceStr = args.since ? ` (since ${args.since.toISOString().slice(0,10)})` : '';
  console.log('\n' + bar);
  console.log(`  Portfolio Analytics — ${new Date().toISOString().slice(0,10)}${sinceStr}`);
  console.log(bar);
  console.log(`  Trades: ${m.n}  |  Wins: ${m.wins}  |  Losses: ${m.losses}  |  WR: ${m.wr}%`);
  console.log(`  Total PnL: ${sign(m.totalPnl)} EUR  |  Expectancy: ${sign(m.exp)} EUR/trade`);
  console.log(`  Avg Hold: ${m.avgHold}d  |  Avg Win: ${sign(m.avgWin)} EUR  |  Avg Loss: ${sign(m.avgLoss)} EUR`);
  console.log(bar);

  // ── NAV + Open Positions ──────────────────────────────────────────────────
  if (state) {
    const open = state.open_positions ?? [];
    const nav  = state.equity_nav ?? 0;
    const cash = state.cash ?? 0;
    printSection('Portfolio Status', [
      `NAV: ${nav.toFixed(2)} EUR  |  Cash: ${cash.toFixed(2)} EUR (${(cash/nav*100).toFixed(1)}%)  |  Open: ${open.length}`,
    ]);
    if (open.length) {
      const colW = [8, 6, 9, 10, 9];
      console.log('  ' + tableRow(['Symbol', 'Side', 'Notional', 'Unr. PnL', 'PnL %'], colW));
      console.log('  ' + sep);
      for (const p of open) {
        const upnl = p.unrealized_pnl_eur ?? 0;
        const upct = p.notional_eur > 0 ? upnl / p.notional_eur * 100 : 0;
        console.log('  ' + tableRow([
          p.symbol, p.side.toUpperCase(),
          `${p.notional_eur?.toFixed(0)} EUR`,
          `${sign(upnl)} EUR`,
          pct(upct),
        ], colW));
      }
    }
  }

  // ── By Side ───────────────────────────────────────────────────────────────
  const bySide = groupBy(trades, 'side');
  printSection('By Side', Object.entries(bySide).map(([side, ts]) => {
    const mm = metrics(ts);
    return `${side.toUpperCase().padEnd(6)} : ${String(mm.n).padStart(2)} trades · WR ${String(mm.wr+'%').padStart(5)} · Exp ${sign(mm.exp).padStart(8)} EUR · Total ${sign(mm.totalPnl).padStart(8)} EUR`;
  }));

  // ── By Close Reason (bucketed) ────────────────────────────────────────────
  const bucketedTrades = trades.map(t => ({ ...t, bucket: bucketReason(t.reason) }));
  const byReason = groupBy(bucketedTrades, 'bucket');
  const reasonRows = Object.entries(byReason)
    .map(([r, ts]) => {
      const mm = metrics(ts);
      const total = ts.reduce((s, t) => s + t.pnl, 0);
      return { label: r, n: mm.n, total, avg: mm.n > 0 ? total / mm.n : 0 };
    })
    .sort((a, b) => a.total - b.total);
  printSection('By Close Reason', reasonRows.map(r =>
    `${r.label.padEnd(22)} : ${String(r.n).padStart(2)} trades · Total ${sign(r.total).padStart(8)} EUR · Avg ${sign(r.avg).padStart(7)} EUR`
  ));

  // ── By Sector ─────────────────────────────────────────────────────────────
  const bySector = groupBy(trades, 'sector');
  const sectorRows = Object.entries(bySector)
    .map(([s, ts]) => ({ label: s, ...metrics(ts) }))
    .sort((a, b) => a.totalPnl - b.totalPnl);
  printSection('By Sector', sectorRows.map(r =>
    `${r.label.padEnd(24)} : ${String(r.n).padStart(2)} trades · WR ${String(r.wr+'%').padStart(5)} · Total ${sign(r.totalPnl).padStart(8)} EUR`
  ));

  // ── SL Stats ──────────────────────────────────────────────────────────────
  const slTrades = trades.filter(t => t.reason === 'stop_loss_hit');
  if (slTrades.length) {
    const slPnl   = slTrades.reduce((s, t) => s + t.pnl, 0);
    const allLoss = trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const slShare = allLoss !== 0 ? (slPnl / allLoss * 100).toFixed(1) : '—';
    printSection('SL Drain Analysis', [
      `SL hits: ${slTrades.length}/${m.n} (${(slTrades.length/m.n*100).toFixed(1)}% of trades)`,
      `SL losses: ${sign(slPnl)} EUR  |  ${slShare}% of all losses  |  Avg: ${sign(slPnl/slTrades.length)} EUR/hit`,
      (() => {
        const withSl = slTrades.filter(t => t.stop_loss_pct > 0);
        const avgSl  = withSl.length ? (withSl.reduce((s,t)=>s+t.stop_loss_pct,0)/withSl.length).toFixed(1)+'%' : 'n/a (old ledger)';
        const avgHld = (slTrades.reduce((s,t)=>s+t.holdDays,0)/slTrades.length).toFixed(1);
        return `Avg SL %: ${avgSl}  |  Avg hold at SL: ${avgHld}d`;
      })(),
    ]);
  }

  // ── Top 5 Winners / Losers ────────────────────────────────────────────────
  const sorted = [...trades].filter(t => t.pnl !== 0).sort((a, b) => b.pnl - a.pnl);
  const top5W  = sorted.slice(0, 5);
  const top5L  = sorted.slice(-5).reverse();

  const tradeRow = (t, i) => {
    const holdStr = t.holdDays >= 1 ? `${t.holdDays}d` : `${(t.holdDays*24).toFixed(0)}h`;
    return `${String(i+1).padStart(2)}. ${t.symbol.padEnd(6)} ${t.side.toUpperCase().padEnd(6)} ${sign(t.pnl).padStart(8)} EUR  ${holdStr.padStart(5)}  ${t.reason?.slice(0,30) ?? '—'}`;
  };
  printSection('Top 5 Winners',  top5W.map(tradeRow));
  printSection('Top 5 Losers',   top5L.map(tradeRow));

  // ── P&L Distribution ──────────────────────────────────────────────────────
  const buckets = { '<-30': 0, '-30..-10': 0, '-10..0': 0, '0..10': 0, '10..30': 0, '>30': 0 };
  for (const t of trades.filter(t => t.pnl !== 0)) {
    if      (t.pnl <  -30) buckets['<-30']++;
    else if (t.pnl <  -10) buckets['-30..-10']++;
    else if (t.pnl <    0) buckets['-10..0']++;
    else if (t.pnl <   10) buckets['0..10']++;
    else if (t.pnl <   30) buckets['10..30']++;
    else                   buckets['>30']++;
  }
  const maxCount = Math.max(...Object.values(buckets));
  printSection('P&L Distribution (EUR)', Object.entries(buckets).map(([range, cnt]) => {
    const bar2 = '█'.repeat(Math.round(cnt / (maxCount || 1) * 20));
    return `${range.padEnd(10)} ${bar2.padEnd(21)} ${cnt}`;
  }));

  console.log('\n' + bar + '\n');
}

main(process.argv.slice(2));
