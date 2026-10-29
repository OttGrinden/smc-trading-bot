/**
 * Virtual Portfolio — State Model
 *
 * Persistent EUR-denominated shadow portfolio. NO broker, NO real orders.
 * Accounting is margin-style and deterministic:
 *
 *   committed       = Σ position.notional_eur   (entry capital set aside)
 *   unrealized_pnl  = Σ dir * qty * (mark_eur - entry_eur)
 *   NAV (equity)    = initial_capital + realized_pnl + unrealized_pnl
 *   cash            = initial_capital + realized_pnl - committed
 *   gross_exposure  = Σ |qty * mark_eur|
 *   net_exposure    = Σ dir * qty * mark_eur
 *   leverage_used   = gross_exposure / NAV
 *
 * dir = +1 long, -1 short.
 *
 * USD prices from the scan are converted to EUR with a fixed placeholder rate
 * (EUR_USD_RATE). This is a documented placeholder — no live FX feed in this phase.
 *
 * Usage (module): import { loadOrInit, save, recompute, EUR_USD_RATE } from './portfolio_state.mjs'
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', '..', '..', 'trading');

const PORTFOLIO_DIR  = join(TRADING_DIR, 'execution', 'portfolio');
const STATE_PATH     = join(PORTFOLIO_DIR, 'portfolio_state.json');
const HISTORY_PATH   = join(PORTFOLIO_DIR, 'portfolio_history.jsonl');
const LEDGER_PATH    = join(PORTFOLIO_DIR, 'trade_ledger.jsonl');
const REGISTRY_PATH  = join(TRADING_DIR, 'registry', 'registry.json');

export const PORTFOLIO_PATHS = Object.freeze({
  dir:     PORTFOLIO_DIR,
  state:   STATE_PATH,
  history: HISTORY_PATH,
  ledger:  LEDGER_PATH,
});

export const INITIAL_CAPITAL = 1000;        // EUR — must match portfolio_state.json initial_capital
export const BASE_CURRENCY    = 'EUR';
export const EUR_USD_RATE     = 1.08;       // PLACEHOLDER: USD per 1 EUR. No live FX feed yet.

// ─── FX helper ───────────────────────────────────────────────────────────────

/** Convert a USD price to EUR using the fixed placeholder rate. */
export function usdToEur(priceUsd) {
  if (priceUsd == null || !Number.isFinite(priceUsd)) return null;
  return priceUsd / EUR_USD_RATE;
}

// ─── Test-only path overrides ─────────────────────────────────────────────────
// Used ONLY by regression_smoke.mjs and manual_close.mjs --state-path.
// Production code must never call _setTestPaths.
let _testOverridePaths = null;
export function _setTestPaths(paths)  { _testOverridePaths = paths; }
export function _clearTestPaths()     { _testOverridePaths = null; }

// ─── Init / load / save ──────────────────────────────────────────────────────

export function initPortfolio() {
  return {
    base_currency:    BASE_CURRENCY,
    initial_capital:  INITIAL_CAPITAL,
    cash:             INITIAL_CAPITAL,
    equity_nav:       INITIAL_CAPITAL,
    gross_exposure:   0,
    net_exposure:     0,
    leverage_used:    0,
    realized_pnl:     0,
    unrealized_pnl:   0,
    cumulative_fees_eur: 0,  // total execution fees paid since inception (Phase 3b)
    open_positions:   [],
    blocked_symbols:  [],    // symbol blocks (origin 'manual' | 'stop_loss'): allocator will not reopen these
    last_sl_run_id:   null,  // run_id of the most recent stop_loss_hit close (post-SL cooldown)
    last_sl_at:       null,  // ISO timestamp of the most recent stop_loss_hit close
    deploy_run_id:    null,  // run_id of the current per-run deployment budget (cash policy)
    deploy_run_used_eur: 0,  // filled new-allocation notional consumed in that run (EUR)
    closed_positions_summary: {
      count:      0,
      wins:       0,
      losses:     0,
      realized_pnl_total: 0,
    },
    last_updated_at:  null,
    last_run_id:      null,
    created_at:       new Date().toISOString(),
  };
}

export function loadOrInit() {
  const resolvedPath = _testOverridePaths?.state ?? STATE_PATH;
  if (!existsSync(resolvedPath)) return initPortfolio();
  let state;
  try {
    state = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  } catch (e) {
    // Fail-fast: a corrupt state file must not be silently overwritten
    throw new Error(`portfolio_state.json is corrupt and cannot be parsed: ${e.message}`);
  }
  // Graceful migration: add cumulative_fees_eur if missing (pre-Phase-3b state files)
  if (state.cumulative_fees_eur == null) state.cumulative_fees_eur = 0;
  // Graceful migration: add blocked_symbols if missing (pre-Schritt-2b state files)
  if (!Array.isArray(state.blocked_symbols)) state.blocked_symbols = [];
  // Graceful migration: post-SL policy fields (pre-policy state files)
  if (state.last_sl_run_id === undefined) state.last_sl_run_id = null;
  if (state.last_sl_at === undefined)     state.last_sl_at = null;
  // Graceful migration: cash/allocation policy fields (pre-policy state files)
  if (state.deploy_run_id === undefined)       state.deploy_run_id = null;
  if (state.deploy_run_used_eur === undefined) state.deploy_run_used_eur = 0;
  // Consistency check: persisted initial_capital must match the code constant.
  // If they differ, a prior manual state edit or reset has created a mismatch.
  // Fix: update INITIAL_CAPITAL in this file to match, or pass --initial-capital explicitly.
  if (state.initial_capital !== INITIAL_CAPITAL) {
    throw new Error(
      `initial_capital mismatch: state=${state.initial_capital}, code=${INITIAL_CAPITAL}. ` +
      `Update INITIAL_CAPITAL in portfolio_state.mjs or reset the portfolio with the correct value.`
    );
  }
  return state;
}

export function save(state) {
  const p = _testOverridePaths?.state ?? STATE_PATH;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function appendHistory(event) {
  const p = _testOverridePaths?.history ?? HISTORY_PATH;
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(event) + '\n', 'utf8');
}

export function appendLedger(entry) {
  const p = _testOverridePaths?.ledger ?? LEDGER_PATH;
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
}

// ─── Accounting ──────────────────────────────────────────────────────────────

/** dir factor: +1 long, -1 short */
export function dirFactor(side) {
  return side === 'short' ? -1 : 1;
}

/**
 * positionUnrealized — EUR unrealized PnL for one open position at its mark.
 */
export function positionUnrealized(pos) {
  if (pos.mark_price_eur == null || pos.entry_price_eur == null) return 0;
  return +(dirFactor(pos.side) * pos.quantity * (pos.mark_price_eur - pos.entry_price_eur)).toFixed(4);
}

// ─── Symbol block list ───────────────────────────────────────────────────────
//
// blockSymbol / isBlocked / getActiveBlock / pruneExpiredBlocks manage
// state.blocked_symbols[]. Two origins exist:
//   - 'manual'    — manual closes (manual_close.mjs); permanent or time-limited
//   - 'stop_loss' — engine post-SL policy; always time-limited, same side only
// A 'stop_loss' block must never overwrite an existing 'manual' block —
// that guard lives at the engine call site (portfolio_engine.mjs SL branch).
// The block prevents the allocator from reopening the symbol+side while active.

/**
 * blockSymbol — record a block on state.blocked_symbols.
 *
 * @param {object}      state
 * @param {string}      symbol
 * @param {string}      side          — 'long' | 'short'
 * @param {string}      reason        — human-readable close reason
 * @param {string|null} blockedUntil  — ISO timestamp or null (permanent until manually cleared)
 * @param {string}      origin        — 'manual' (default) | 'stop_loss'
 */
export function blockSymbol(state, symbol, side, reason, blockedUntil = null, origin = 'manual') {
  if (!Array.isArray(state.blocked_symbols)) state.blocked_symbols = [];
  // Replace any existing block for the same symbol+side
  state.blocked_symbols = state.blocked_symbols.filter(b => !(b.symbol === symbol && b.side === side));
  state.blocked_symbols.push({ symbol, side, reason, blocked_at: new Date().toISOString(), blocked_until: blockedUntil, origin });
}

/**
 * getActiveBlock — return the active block entry for symbol+side, or null.
 * A block with blocked_until=null is permanent; with a timestamp it expires at that time.
 * Entries without an origin field (pre-policy state files) are treated as 'manual'.
 */
export function getActiveBlock(state, symbol, side) {
  const block = state.blocked_symbols?.find(b => b.symbol === symbol && b.side === side);
  if (!block) return null;
  if (block.blocked_until == null) return block;
  return new Date(block.blocked_until) > new Date() ? block : null;
}

/**
 * isBlocked — true if symbol+side has an active block.
 */
export function isBlocked(state, symbol, side) {
  return getActiveBlock(state, symbol, side) != null;
}

/**
 * backfillSectors — additively fill `sector` on open positions that lack it,
 * using the registry's stocks.sectors watchlists as the symbol→sector source
 * (same mapping the scanner uses for candidate.sector). This makes the
 * sector_exposure_cap see real cluster exposure on legacy books that predate the
 * sector field.
 *
 * Properties:
 *  - additive: only fills positions whose sector is missing/null
 *  - idempotent: positions that already carry a sector are never touched
 *  - no schema migration, no throw: an unreadable registry or an unmapped symbol
 *    (e.g. crypto, delisted) leaves the position as-is and is reported, not raised
 *
 * @param {object} state
 * @returns {{ filled: string[], unresolved: string[], already: number, registry_ok: boolean }}
 */
export function backfillSectors(state) {
  const result = { filled: [], unresolved: [], already: 0, registry_ok: true };
  let symbolToSector;
  try {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    symbolToSector = new Map();
    for (const [sectorKey, sector] of Object.entries(registry.stocks?.sectors ?? {})) {
      for (const entry of sector.watchlist ?? []) {
        if (!symbolToSector.has(entry.symbol)) symbolToSector.set(entry.symbol, sectorKey);
      }
    }
  } catch {
    result.registry_ok = false;   // registry unavailable → no backfill, no crash
    return result;
  }
  for (const pos of state.open_positions ?? []) {
    if (pos.sector != null) { result.already += 1; continue; }
    const sec = symbolToSector.get(pos.symbol);
    if (sec != null) { pos.sector = sec; result.filled.push(pos.symbol); }
    else             { result.unresolved.push(pos.symbol); }
  }
  return result;
}

/**
 * pruneExpiredBlocks — remove blocks whose blocked_until has passed.
 * Call once per run (before allocation) to keep the list tidy.
 */
export function pruneExpiredBlocks(state) {
  if (!state.blocked_symbols?.length) return;
  const now = new Date();
  state.blocked_symbols = state.blocked_symbols.filter(b => b.blocked_until == null || new Date(b.blocked_until) > now);
}

/**
 * updateThesisFields — operator helper to update position-level thesis metadata.
 *
 * Only the four allowed thesis fields may be updated. The engine never calls this.
 * Caller is responsible for calling save(state) after to persist changes.
 *
 * @param {object} state
 * @param {string} symbol
 * @param {string} side  — 'long' | 'short'
 * @param {object} fields — subset of { thesis_status, thesis_valid_until, catalyst_event_date, thesis_last_reviewed_at }
 * @throws if no matching open position is found or if a disallowed field is supplied
 */
export function updateThesisFields(state, symbol, side, fields) {
  const ALLOWED = new Set(['thesis_status', 'thesis_valid_until', 'catalyst_event_date', 'thesis_last_reviewed_at']);
  const disallowed = Object.keys(fields).filter(k => !ALLOWED.has(k));
  if (disallowed.length > 0) {
    throw new Error(`updateThesisFields: disallowed field(s): ${disallowed.join(', ')}`);
  }
  const pos = state.open_positions?.find(p => p.symbol === symbol && p.side === side);
  if (!pos) {
    throw new Error(`updateThesisFields: no open position found for ${symbol}/${side}`);
  }
  for (const [k, v] of Object.entries(fields)) {
    pos[k] = v;
  }
}

/**
 * recompute — recalculate all aggregate fields from open_positions + realized_pnl.
 * Mutates and returns the state. Deterministic; no I/O.
 */
export function recompute(state) {
  let committed     = 0;
  let unrealized    = 0;
  let grossExposure = 0;
  let netExposure   = 0;

  for (const pos of state.open_positions) {
    pos.unrealized_pnl_eur = positionUnrealized(pos);
    committed     += pos.notional_eur;
    unrealized    += pos.unrealized_pnl_eur;
    if (pos.mark_price_eur != null) {
      const mv = pos.quantity * pos.mark_price_eur;            // current market notional (EUR)
      grossExposure += Math.abs(mv);
      netExposure   += dirFactor(pos.side) * mv;
    }
  }

  state.unrealized_pnl = +unrealized.toFixed(4);
  state.equity_nav     = +(state.initial_capital + state.realized_pnl + unrealized).toFixed(4);
  state.cash           = +(state.initial_capital + state.realized_pnl - committed).toFixed(4);
  state.gross_exposure = +grossExposure.toFixed(4);
  state.net_exposure   = +netExposure.toFixed(4);
  state.leverage_used  = state.equity_nav > 0 ? +(grossExposure / state.equity_nav).toFixed(4) : 0;

  return state;
}
