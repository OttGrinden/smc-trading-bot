#!/usr/bin/env node
/**
 * thesis_expiry_check.mjs — Auto-close positions based on 4 exit triggers.
 *
 * Runs as softStep in scan.mjs after full enrichment + portfolio marks are current.
 *
 * Trigger 1 — Thesis expiry (existing):
 *   thesis_valid_until exceeded AND |pnl_pct| < 4%
 *   Block: 14 days
 *
 * Trigger 2 — Stagnation:
 *   Position open > 21 days AND |pnl_pct| < 3%
 *   Block: 14 days
 *
 * Trigger 3 — RSI exhaustion (momentum played out, take profit):
 *   SHORT: RSI_daily < 40 AND pnl_pct > 0 AND days_open >= 2
 *   LONG:  RSI_daily > 70 AND pnl_pct > 0 AND days_open >= 2
 *   Block: 7 days (momentum can reverse quickly)
 *
 * Trigger 4 — Direction-flip (scan gives opposing signal):
 *   Open SHORT → symbol appears in long_candidates with ceiling >= 7
 *   Open LONG  → symbol appears in short_candidates with ceiling >= 7
 *   Block: 21 days
 *
 * All auto-closes route through manual_close.mjs (full PaperBroker lifecycle).
 * Significant losses (|pnl_pct| >= 5%) are always left to the SL engine.
 */

import { spawnSync }            from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath }        from 'url';
import { readdirSync, readFileSync } from 'fs';
import { loadOrInit }           from './execution/portfolio/portfolio_state.mjs';
import { readIndicatorCache }   from './indicator_cache.mjs';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const __dirname      = dirname(fileURLToPath(import.meta.url));
const CLOSE_SCRIPT   = join(__dirname, 'execution/manual_close.mjs');
const LOGS_DIR       = join(TRADING_DIR, 'logs');

// Thresholds
const STAGNANT_THRESHOLD   = 4;   // |pnl_pct| < 4% for thesis-expiry trigger
const STAGNATION_DAYS      = 21;  // days open before stagnation check fires
const STAGNATION_PCT       = 3;   // |pnl_pct| < 3% = stagnant
const RSI_SHORT_EXHAUSTION = 40;  // SHORT: close when RSI drops below this (momentum exhausted)
const RSI_LONG_EXHAUSTION  = 70;  // LONG:  close when RSI rises above this (momentum exhausted)
const RSI_MIN_DAYS_OPEN    = 2;   // don't fire RSI exhaustion before 2 days open
const FLIP_CEILING_MIN     = 7;   // score_bounds.ceiling threshold for direction-flip trigger
const SL_SAFETY_THRESHOLD  = 5;   // |pnl_pct| >= 5% → leave to SL engine, never auto-close

function isoInDays(n) {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

function calcPnlPct(pos) {
  const entry = pos.entry_price_usd;
  const mark  = pos.mark_price_usd;
  if (!entry || !mark) return null;
  return pos.side === 'long'
    ? (mark - entry) / entry * 100
    : (entry - mark) / entry * 100;
}

function daysOpen(pos) {
  return (Date.now() - new Date(pos.entry_timestamp).getTime()) / 86_400_000;
}

function doClose(pos, reason, blockedUntilDate) {
  const result = spawnSync(process.execPath, [
    CLOSE_SCRIPT,
    '--symbol',       pos.symbol,
    '--side',         pos.side,
    '--reason',       reason,
    '--blocked-until', blockedUntilDate,
  ], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 30_000 });
  return result.status === 0;
}

// Load latest scan run for direction-flip check
function loadLatestRun() {
  try {
    const files = readdirSync(LOGS_DIR)
      .filter(f => f.startsWith('run_') && f.endsWith('.json'))
      .sort().reverse();
    if (!files.length) return null;
    return JSON.parse(readFileSync(join(LOGS_DIR, files[0]), 'utf8'));
  } catch { return null; }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const state     = loadOrInit();
const now       = new Date();
const latestRun = loadLatestRun();

// Build direction-flip lookup: symbol → { long: ceiling, short: ceiling }
const flipMap = new Map();
if (latestRun) {
  for (const c of latestRun.long_candidates  ?? []) flipMap.set(c.symbol, { ...(flipMap.get(c.symbol) ?? {}), long:  c.score_bounds?.ceiling ?? 0 });
  for (const c of latestRun.short_candidates ?? []) flipMap.set(c.symbol, { ...(flipMap.get(c.symbol) ?? {}), short: c.score_bounds?.ceiling ?? 0 });
}

let checked = 0, closed = 0, skipped = 0;

for (const pos of state.open_positions) {
  const pnlPct  = calcPnlPct(pos);
  const days    = daysOpen(pos);
  const daysStr = +days.toFixed(1);

  if (pnlPct === null) { skipped++; continue; }

  // Safety: positions with large moves (profit or loss) belong to SL engine or manual decision
  if (Math.abs(pnlPct) >= SL_SAFETY_THRESHOLD) {
    skipped++;
    continue;
  }

  checked++;

  // ── Trigger 1: Thesis expiry ─────────────────────────────────────────────
  if (pos.thesis_valid_until &&
      (pos.thesis_status ?? 'active') === 'active' &&
      new Date(pos.thesis_valid_until) < now &&
      Math.abs(pnlPct) < STAGNANT_THRESHOLD) {

    const ok = doClose(pos, 'thesis_expired_stagnant', isoInDays(14));
    if (ok) {
      closed++;
      process.stderr.write(JSON.stringify({ info: 'auto_exit', trigger: 'thesis_expiry', symbol: pos.symbol, side: pos.side, pnl_pct: +pnlPct.toFixed(2), days_held: daysStr }) + '\n');
      continue;
    } else { skipped++; continue; }
  }

  // ── Trigger 2: Stagnation ────────────────────────────────────────────────
  if (days >= STAGNATION_DAYS && Math.abs(pnlPct) < STAGNATION_PCT) {
    const ok = doClose(pos, `stagnation_${daysStr}d_pnl${pnlPct.toFixed(1)}pct`, isoInDays(14));
    if (ok) {
      closed++;
      process.stderr.write(JSON.stringify({ info: 'auto_exit', trigger: 'stagnation', symbol: pos.symbol, side: pos.side, pnl_pct: +pnlPct.toFixed(2), days_held: daysStr }) + '\n');
      continue;
    } else { skipped++; continue; }
  }

  // ── Trigger 3: RSI exhaustion ────────────────────────────────────────────
  if (days >= RSI_MIN_DAYS_OPEN && pnlPct > 0) {
    const ind = readIndicatorCache(pos.symbol, 120); // 2h max age
    if (ind.available && ind.rsi != null) {
      const rsiExhausted =
        (pos.side === 'short' && ind.rsi < RSI_SHORT_EXHAUSTION) ||
        (pos.side === 'long'  && ind.rsi > RSI_LONG_EXHAUSTION);

      if (rsiExhausted) {
        const ok = doClose(pos, `rsi_exhaustion_rsi${ind.rsi.toFixed(1)}_pnl${pnlPct.toFixed(1)}pct`, isoInDays(7));
        if (ok) {
          closed++;
          process.stderr.write(JSON.stringify({ info: 'auto_exit', trigger: 'rsi_exhaustion', symbol: pos.symbol, side: pos.side, rsi: +ind.rsi.toFixed(1), pnl_pct: +pnlPct.toFixed(2), days_held: daysStr }) + '\n');
          continue;
        } else { skipped++; continue; }
      }
    }
  }

  // ── Trigger 4: Direction-flip ────────────────────────────────────────────
  if (latestRun) {
    const flipEntry  = flipMap.get(pos.symbol);
    const opposingSide = pos.side === 'short' ? 'long' : 'short';
    const ceiling    = flipEntry?.[opposingSide] ?? 0;

    if (ceiling >= FLIP_CEILING_MIN) {
      const ok = doClose(pos, `direction_flip_opposing_${opposingSide}_ceiling${ceiling}`, isoInDays(21));
      if (ok) {
        closed++;
        process.stderr.write(JSON.stringify({ info: 'auto_exit', trigger: 'direction_flip', symbol: pos.symbol, side: pos.side, opposing: opposingSide, ceiling, pnl_pct: +pnlPct.toFixed(2), days_held: daysStr }) + '\n');
        continue;
      } else { skipped++; continue; }
    }
  }

  // No trigger fired — HOLD
  skipped++;
}

process.stderr.write(JSON.stringify({
  info: 'thesis_expiry_done', checked, closed, skipped,
}) + '\n');
