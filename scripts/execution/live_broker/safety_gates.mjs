/**
 * Safety Gates — Phase 2 / Units 31–32.
 *
 * Hard dispatch-blockers checked AFTER the startup gate but BEFORE any new
 * order dispatch.  None of the gates block the maintenance cycle (reconcile/
 * poll), fill-sync, or confirmed-fill booking — those always run.
 *
 * All gates are OPT-IN (default off): the caller passes a `safetyGates`
 * object inside ctx; absence or null/undefined is a no-op.
 *
 *   Kill-switch ......... sentinel file OR explicit flag — emergency stop.
 *                         blocks_booking: true  (full halt, including booking)
 *
 *   Session gate ........ NYSE regular-session window check: Mon–Fri 09:30–
 *                         16:00 America/New_York (16:00 is EXCLUSIVE).
 *                         blocks_booking: false (confirmed fills still process
 *                         outside session — only new dispatch is blocked).
 *                         No holiday / half-day logic (Unit 32 scope).
 *
 *   Liquidity gate ...... OHLCV-based market-quality proxy check (Unit 33).
 *                         Checks volume_usd (minimum) and an optional range_pct
 *                         (maximum). range_pct is a PROXY — not a real Bid/Ask
 *                         spread; could be abs(change_pct) or (high−low)/close×100
 *                         depending on what the caller has available. Data is
 *                         injected by the caller — the gate reads no files itself.
 *                         Missing or stale data → fail-closed (block dispatch).
 *                         blocks_booking: false (confirmed fills still process
 *                         regardless of market-quality proxy result).
 *
 *   Max-daily-loss ...... current NAV vs initial_capital threshold (default 5%).
 *                         blocks_booking: true
 *                         (Phase 2 note: uses initial_capital as the baseline;
 *                         a per-session watermark is a natural later extension.)
 *
 * Each gate return carries `blocks_booking: bool` so the caller can decide
 * whether confirmed-fill booking should also be skipped (kill_switch /
 * max_daily_loss) or continue normally (session_gate).
 *
 * Injection API (all optional, for offline tests):
 *   opts.killSwitch._existsSync    — replace existsSync for sentinel-file check
 *   opts.sessionGate._now          — replace () => new Date() for time source
 *   opts.liquidityGate._now        — replace () => new Date() for stale-age check
 *   opts.maxDailyLoss._loadState   — replace loadOrInit for portfolio-state read
 *
 * Fail-closed: a state-read error in maxDailyLoss → safe:false (never fail-open).
 * Missing / null marketData in liquidityGate → safe:false (never fail-open).
 * Gates are checked in order: kill_switch → session_gate → liquidity_gate → max_daily_loss.
 */

import { existsSync }  from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadOrInit }  from '../portfolio/portfolio_state.mjs';

const _dir = dirname(fileURLToPath(import.meta.url));

/** Default sentinel file path (same directory as this module). */
export const DEFAULT_KILL_SWITCH_PATH = join(_dir, 'KILL_SWITCH');

/** Default max-loss fraction of initial_capital (5%). */
export const DEFAULT_MAX_DAILY_LOSS_PCT = 0.05;

// ── Liquidity gate defaults ───────────────────────────────────────────────────
/** Minimum 24h traded volume (USD) for the liquidity gate. */
export const DEFAULT_MIN_VOLUME_USD  = 1_000_000;
/** Maximum range proxy (%) for the liquidity gate — at or above this is blocked (exclusive). */
export const DEFAULT_MAX_RANGE_PCT   = 20;

// ── NYSE session window constants (minutes from midnight ET) ─────────────────
const ET_WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
/** NYSE session open: 09:30 ET, inclusive. */
export const SESSION_OPEN_MINUTES  = 9 * 60 + 30;   // 570
/** NYSE session close: 16:00 ET, exclusive (16:00 itself is outside session). */
export const SESSION_CLOSE_MINUTES = 16 * 60;        // 960

/** Extract weekday (short, en-US) + minutes-from-midnight in America/New_York. */
function toEtParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',  // guarantees 00–23, avoids '24' at midnight in some ICU builds
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  // guard against any platform returning '24' for midnight
  const hh = parseInt(p.hour, 10) % 24;
  return { weekday: p.weekday, minutes: hh * 60 + parseInt(p.minute, 10), timeEt: `${p.hour}:${p.minute}` };
}

/**
 * checkSafetyGates — synchronous, pure (injectable), fail-closed.
 *
 * Returns { safe: true } when all enabled gates pass.
 * Returns { safe: false, reason, details? } on the FIRST gate that fires
 * (kill_switch is checked before max_daily_loss).
 *
 * @param {object} opts
 *   killSwitch?: {
 *     active?:     boolean,           // force-active (tests / programmatic override)
 *     path?:       string,            // sentinel file path; defaults to ./KILL_SWITCH
 *     _existsSync?: (p: string) => boolean  // injectable for tests
 *   }
 *   maxDailyLoss?: {
 *     pct?:        number,            // loss threshold as fraction of initial_capital
 *                                     //   e.g. 0.05 = block when NAV < initial_capital * 0.95
 *                                     //   defaults to DEFAULT_MAX_DAILY_LOSS_PCT
 *     _loadState?: () => object       // injectable for tests
 *   }
 */
export function checkSafetyGates(opts = {}) {
  // ── Kill-switch ────────────────────────────────────────────────────────────
  if (opts.killSwitch != null) {
    const ks       = opts.killSwitch;
    const checkFs  = ks._existsSync ?? existsSync;
    const ksPath   = ks.path ?? DEFAULT_KILL_SWITCH_PATH;
    const active   = ks.active === true || checkFs(ksPath);
    if (active) {
      return { safe: false, reason: 'kill_switch', blocks_booking: true, details: { path: ksPath } };
    }
  }

  // ── Session gate (NYSE regular hours: Mon–Fri 09:30–16:00 ET) ─────────────
  // blocks_booking:false — confirmed fills must still be processed outside session.
  // No holiday / half-day logic in this unit.
  // disabled:true — caller opts out entirely (e.g. 24/7 crypto futures markets).
  if (opts.sessionGate != null) {
    if (opts.sessionGate.disabled !== true) {
      const now     = typeof opts.sessionGate._now === 'function' ? opts.sessionGate._now() : new Date();
      const { weekday, minutes, timeEt } = toEtParts(now);
      if (!ET_WEEKDAYS.has(weekday)) {
        return { safe: false, reason: 'weekend_no_session', blocks_booking: false,
                 details: { weekday, time_et: timeEt } };
      }
      if (minutes < SESSION_OPEN_MINUTES || minutes >= SESSION_CLOSE_MINUTES) {
        return { safe: false, reason: 'outside_session', blocks_booking: false,
                 details: { weekday, time_et: timeEt, minutes,
                            session_open: SESSION_OPEN_MINUTES, session_close: SESSION_CLOSE_MINUTES } };
      }
    }
  }

  // ── Liquidity / market-quality gate (OHLCV-based proxy) ─────────────────────
  // Checks volume_usd and an optional range_pct per symbol in the injected snapshot.
  // range_pct is a PROXY (e.g. abs(change_pct) or (high-low)/close×100) — NOT a real
  // Bid/Ask spread. Stale-age check only runs when opts.liquidityGate.maxAgeMinutes is set.
  // Boundary semantics: volume_usd >= minVolumeUsd passes; range_pct >= maxRangePct blocks.
  // blocks_booking:false — confirmed fills process regardless of market-quality result.
  if (opts.liquidityGate != null) {
    const lg   = opts.liquidityGate;
    const data = lg.marketData;

    // Missing or non-object marketData → fail-closed.
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      return { safe: false, reason: 'missing_market_data', blocks_booking: false };
    }
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return { safe: false, reason: 'missing_market_data', blocks_booking: false };
    }

    const minVol     = Number.isFinite(lg.minVolumeUsd) && lg.minVolumeUsd >= 0
      ? lg.minVolumeUsd : DEFAULT_MIN_VOLUME_USD;
    const maxRange   = Number.isFinite(lg.maxRangePct)  && lg.maxRangePct  >= 0
      ? lg.maxRangePct  : DEFAULT_MAX_RANGE_PCT;
    const checkStale = Number.isFinite(lg.maxAgeMinutes) && lg.maxAgeMinutes > 0;
    const nowTs      = checkStale
      ? (typeof lg._now === 'function' ? lg._now() : new Date())
      : null;

    for (const [symbol, snap] of entries) {
      if (snap == null || typeof snap !== 'object') {
        return { safe: false, reason: 'missing_market_data', blocks_booking: false,
                 details: { symbol } };
      }

      // 1) Stale check (only when maxAgeMinutes configured).
      if (checkStale) {
        const ageMs  = snap.fetched_at ? nowTs - new Date(snap.fetched_at) : Infinity;
        const ageMin = ageMs / 60_000;
        if (ageMin >= lg.maxAgeMinutes) {
          return { safe: false, reason: 'stale_market_data', blocks_booking: false,
                   details: { symbol,
                              age_minutes:     +ageMin.toFixed(2),
                              max_age_minutes: lg.maxAgeMinutes,
                              fetched_at:      snap.fetched_at ?? null } };
        }
      }

      // 2) Volume minimum check (inclusive: volume_usd >= minVolumeUsd passes).
      const vol = snap.volume_usd;
      if (!Number.isFinite(vol) || vol < minVol) {
        return { safe: false, reason: 'volume_below_minimum', blocks_booking: false,
                 details: { symbol,
                            observed_volume_usd: Number.isFinite(vol) ? vol : null,
                            min_volume_usd:      minVol } };
      }

      // 3) Range proxy check (only when range_pct supplied; exclusive: >= maxRangePct blocks).
      if (Number.isFinite(snap.range_pct)) {
        if (snap.range_pct >= maxRange) {
          return { safe: false, reason: 'range_proxy_exceeded', blocks_booking: false,
                   details: { symbol,
                              observed_range_pct: snap.range_pct,
                              max_range_pct:      maxRange } };
        }
      }
    }
  }

  // ── Max-daily-loss (drawdown from initial_capital) ─────────────────────────
  if (opts.maxDailyLoss != null) {
    const mdl        = opts.maxDailyLoss;
    const loadState  = mdl._loadState ?? loadOrInit;
    let state;
    try { state = loadState(); } catch {
      return { safe: false, reason: 'max_daily_loss_state_error', blocks_booking: true };
    }

    const threshold  = Number.isFinite(mdl.pct) && mdl.pct > 0
      ? mdl.pct
      : DEFAULT_MAX_DAILY_LOSS_PCT;
    const { equity_nav, initial_capital } = state ?? {};

    if (Number.isFinite(equity_nav) && Number.isFinite(initial_capital) && initial_capital > 0) {
      const loss_eur = initial_capital - equity_nav;
      const loss_pct = loss_eur / initial_capital;
      if (loss_pct >= threshold) {
        return {
          safe: false,
          reason: 'max_daily_loss_exceeded',
          blocks_booking: true,
          details: {
            equity_nav:     +equity_nav.toFixed(4),
            initial_capital: +initial_capital.toFixed(4),
            loss_eur:       +loss_eur.toFixed(4),
            loss_pct:       +loss_pct.toFixed(6),
            threshold_pct:  threshold,
          },
        };
      }
    }
  }

  return { safe: true };
}
