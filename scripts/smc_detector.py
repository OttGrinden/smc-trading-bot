#!/usr/bin/env python3
"""
smc_detector.py — Smart Money Concepts setup detector

For each of BTC, ETH, BNB, SOL, XRP, TAO:
  Reads trading/cache/ohlcv_daily_{SYMBOL}.json (200 daily bars, oldest-first)
  Reads trading/cache/ohlcv_4h_{SYMBOL}.json    (100 4H bars, oldest-first)
  Detects active bullish/bearish SMC setups

  Scoring:
    8  = BOS confirmed + price above/below EMA(200); IDM not yet swept
    9  = 8  + IDM swept + Origin intact  (daily history OR intraday 4H candle)
    10 = 9  + current 4H close inside OTE zone (0.618–0.786 Fib retracement)

  Key concepts (ICT / Smart Money):
    Pivot     — 5-bar fractal: candle[i] is extreme among 2 neighbors each side
    BOS       — Break of Structure: close crosses most recent swing extreme
    H1        — the pivot level that was broken (BOS anchor)
    IDM       — Inducement: most recent opposite-direction pivot between H1 and BOS
    Origin    — absolute extreme (by wick) before BOS, sets Fib anchor
    IDM sweep — any wick beyond IDM level after IDM formed, before BOS (daily)
                 OR any 4H wick beyond IDM level after BOS timestamp (intraday)
    OTE zone  — 0.618–0.786 retracement of Origin→H1 (optimal pullback entry)

State file: trading/cache/smc_pending_setups.json
  Score-8 setups (IDM not yet swept on daily) are persisted across runs.
  Each 15-min run: 4H candles checked for intraday IDM sweep.
  Invalidation: price breaks origin_low on daily → setup removed.

Exit: always 0 (fail-soft per symbol)
stdout: NDJSON — one compact JSON line per symbol
stderr: warnings + smc_state_summary
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Optional

import pathlib as _pathlib
_BASE = _pathlib.Path(__file__).resolve().parent.parent
CACHE_DIR = str(_BASE / 'trading' / 'cache')

# ── Constants ──────────────────────────────────────────────────────────────────
SMC_SYMBOLS      = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'TAO']
PIVOT_LEN        = 2        # 5-bar fractal: 2 candles on each side
EMA_PERIOD       = 200
OTE_LOW_FIB      = 0.618    # OTE zone lower boundary
OTE_HIGH_FIB     = 0.786    # OTE zone upper boundary
STATE_PATH       = os.path.join(CACHE_DIR, 'smc_pending_setups.json')
SMC_4H_MIN_CANDLES = 10

# ── Sweep-reversal constants (4H path) ────────────────────────────────────────
SWEEP_PIVOT_LEN      = 5    # bars each side for 4H swing identification (wider than daily)
SWEEP_MAX_HISTORY    = 80   # how many 4H bars back to search for swing lows (~13 days)
SWEEP_MAX_BARS_AGO   = 12   # max age of sweep candle: 12 × 4h = 2 days
SWEEP_EMA_PERIOD     = 50   # EMA period on 4H candles for G2 (≈ 8-day moving avg)
#
# G1 for sweep_reversal LONG: pin-bar strength threshold (bullish rejection)
#   close_pos = (close - low) / (high - low): 1 = closed at high
#   0.70 → close in top 30% of range (stronger bullish rejection required).
#   Backtest: 0.70 maximises expectancy (+0.417%/trade, pin_bar=0.70, tp_rr=3.0, hold=24b, confluence=True).
SWEEP_G1_PIN_BAR_THRESHOLD = 0.70
#
# G1 for sweep_reversal SHORT: bearish pin-bar threshold
#   close_pos_bear = (high - close) / (high - low): 1 = closed at low
#   0.70 → close in bottom 30% of range (stronger rejection required for SHORT).
#   Backtest: 0.70 maximises expectancy (+1.005%/trade, confluence=True, hold=72b).
SWEEP_G1_PIN_BAR_THRESHOLD_SHORT = 0.70

# ── Sweep-reversal constants (1H path) ────────────────────────────────────────
# The 1H detector sweeps 4H pivot lows (not daily) — captures intraday structure.
# Primary role: confirm a pending 4H sweep → upgrades score to auto_open threshold.
# Standalone (no 4H pending): max Score 8 = monitoring only.
SWEEP_1H_MAX_BARS_AGO   = 24   # 24 × 1h = 1 day max age
SWEEP_1H_EMA_PERIOD     = 50   # EMA50 on 1H ≈ 2 days
SWEEP_1H_G7_LOOKBACK    = 24   # bars back for TP target on 1H
SWEEP_1H_MIN_CANDLES    = 30   # warmup bars before detector activates


# ── Data loading ───────────────────────────────────────────────────────────────

def load_ohlcv(symbol: str) -> list:
    path = os.path.join(CACHE_DIR, f'ohlcv_daily_{symbol}.json')
    if not os.path.exists(path):
        raise FileNotFoundError(f'ohlcv_daily_{symbol}.json not found')
    with open(path, encoding='utf-8') as fh:
        candles = json.load(fh)
    if not isinstance(candles, list) or len(candles) < EMA_PERIOD:
        raise ValueError(f'need ≥{EMA_PERIOD} candles, got {len(candles)}')
    required = ('open', 'high', 'low', 'close')
    missing  = [k for k in required if k not in candles[0]]
    if missing:
        raise ValueError(f'candles missing fields: {missing}')
    return candles


def load_ohlcv_4h(symbol: str) -> Optional[list]:
    path = os.path.join(CACHE_DIR, f'ohlcv_4h_{symbol}.json')
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding='utf-8') as fh:
            candles = json.load(fh)
        if isinstance(candles, list) and len(candles) >= SMC_4H_MIN_CANDLES:
            return candles
    except Exception:
        pass
    return None


def load_ohlcv_1h(symbol: str) -> Optional[list]:
    path = os.path.join(CACHE_DIR, f'ohlcv_1h_{symbol}.json')
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding='utf-8') as fh:
            candles = json.load(fh)
        if isinstance(candles, list) and len(candles) >= SWEEP_1H_MIN_CANDLES:
            return candles
    except Exception:
        pass
    return None


def load_ohlcv_15m(symbol: str) -> Optional[list]:
    path = os.path.join(CACHE_DIR, f'ohlcv_15m_{symbol}.json')
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding='utf-8') as fh:
            candles = json.load(fh)
        if isinstance(candles, list) and len(candles) >= 10:
            return candles
    except Exception:
        pass
    return None


def synth_live_4h_from_1h(candles_1h: list, candles_4h: list) -> Optional[dict]:
    """
    Synthesize the currently forming (not yet closed) 4H candle from recent 1H bars.

    Infers the 4H window duration from consecutive 4H timestamps — works regardless
    of whether timestamps are in ms or seconds. Returns None if no 1H bars fall
    within the forming 4H window (i.e. the last closed 4H candle is very recent).
    """
    if not candles_1h or not candles_4h or len(candles_4h) < 2:
        return None
    last_4h_ts = candles_4h[-1].get('timestamp')
    prev_4h_ts = candles_4h[-2].get('timestamp')
    if not (isinstance(last_4h_ts, (int, float)) and isinstance(prev_4h_ts, (int, float))):
        return None
    window_dur    = last_4h_ts - prev_4h_ts   # inferred from data (ms or s)
    next_4h_start = last_4h_ts + window_dur
    intra = [c for c in candles_1h
             if isinstance(c.get('timestamp'), (int, float))
             and c['timestamp'] >= next_4h_start]
    if not intra:
        return None
    return {
        'timestamp': next_4h_start,
        'open':    intra[0]['open'],
        'high':    max(c['high'] for c in intra),
        'low':     min(c['low']  for c in intra),
        'close':   intra[-1]['close'],
        'is_live': True,
    }


# ── State management ───────────────────────────────────────────────────────────

def load_pending_state() -> list:
    if not os.path.exists(STATE_PATH):
        return []
    try:
        with open(STATE_PATH, encoding='utf-8') as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_pending_state(setups: list) -> None:
    with open(STATE_PATH, 'w', encoding='utf-8') as fh:
        json.dump(setups, fh, indent=2)


# ── EMA(200) — SMA seed over first `period` candles, then exponential ─────────

def calc_ema(closes: list, period: int = EMA_PERIOD) -> float:
    if len(closes) < period:
        raise ValueError(f'calc_ema: need {period} values, got {len(closes)}')
    k   = 2.0 / (period + 1)
    ema = sum(closes[:period]) / period
    for c in closes[period:]:
        ema = c * k + ema * (1.0 - k)
    return ema


# ── 5-bar fractal pivot detection ─────────────────────────────────────────────

def find_pivots(candles: list, pivot_len: int = PIVOT_LEN) -> tuple:
    n      = len(candles)
    highs  = []
    lows   = []
    offsets = [d for d in range(-pivot_len, pivot_len + 1) if d != 0]

    for i in range(pivot_len, n - pivot_len):
        h = candles[i]['high']
        l = candles[i]['low']
        if all(h > candles[i + d]['high'] for d in offsets):
            highs.append((i, h))
        if all(l < candles[i + d]['low']  for d in offsets):
            lows.append((i, l))

    return highs, lows


# ── BOS detection ─────────────────────────────────────────────────────────────

def find_last_bos(candles: list, pivot_highs: list, pivot_lows: list) -> Optional[dict]:
    n = len(candles)

    bull = None
    for ph_idx, ph_price in reversed(pivot_highs):
        for j in range(ph_idx + 1, n):
            if candles[j]['close'] > ph_price:
                bull = {'direction': 'long',
                        'h1_idx': ph_idx, 'h1_price': ph_price,
                        'bos_idx': j}
                break
        if bull:
            break

    bear = None
    for pl_idx, pl_price in reversed(pivot_lows):
        for j in range(pl_idx + 1, n):
            if candles[j]['close'] < pl_price:
                bear = {'direction': 'short',
                        'h1_idx': pl_idx, 'h1_price': pl_price,
                        'bos_idx': j}
                break
        if bear:
            break

    if bull and bear:
        return bull if bull['bos_idx'] >= bear['bos_idx'] else bear
    return bull or bear


# ── IDM & Origin ──────────────────────────────────────────────────────────────

def find_idm_and_origin(candles: list, bos: dict,
                         pivot_highs: list, pivot_lows: list) -> dict:
    h1_idx    = bos['h1_idx']
    bos_idx   = bos['bos_idx']
    direction = bos['direction']

    if direction == 'long':
        between = [(i, p) for i, p in pivot_lows if h1_idx < i < bos_idx]
        if between:
            idm_idx, idm_price = max(between, key=lambda x: x[0])
        else:
            before = [(i, p) for i, p in pivot_lows if i <= h1_idx]
            if before:
                idm_idx, idm_price = max(before, key=lambda x: x[0])
            else:
                window = candles[:h1_idx + 1]
                idm_idx   = min(range(len(window)), key=lambda i: window[i]['low'])
                idm_price = window[idm_idx]['low']

        pre_bos   = candles[:bos_idx]
        orig_idx  = min(range(len(pre_bos)), key=lambda i: pre_bos[i]['low'])
        orig_price = pre_bos[orig_idx]['low']

    else:
        between = [(i, p) for i, p in pivot_highs if h1_idx < i < bos_idx]
        if between:
            idm_idx, idm_price = max(between, key=lambda x: x[0])
        else:
            before = [(i, p) for i, p in pivot_highs if i <= h1_idx]
            if before:
                idm_idx, idm_price = max(before, key=lambda x: x[0])
            else:
                window = candles[:h1_idx + 1]
                idm_idx   = max(range(len(window)), key=lambda i: window[i]['high'])
                idm_price = window[idm_idx]['high']

        pre_bos   = candles[:bos_idx]
        orig_idx  = max(range(len(pre_bos)), key=lambda i: pre_bos[i]['high'])
        orig_price = pre_bos[orig_idx]['high']

    return {
        'idm_idx':    idm_idx,
        'idm_price':  round(idm_price,  4),
        'orig_idx':   orig_idx,
        'orig_price': round(orig_price, 4),
    }


# ── IDM sweep & Origin-intact check (daily history) ───────────────────────────

def check_idm_sweep(candles: list, bos: dict, idm: dict) -> tuple:
    idm_idx    = idm['idm_idx']
    bos_idx    = bos['bos_idx']
    idm_price  = idm['idm_price']
    orig_price = idm['orig_price']
    direction  = bos['direction']

    window = candles[idm_idx + 1 : bos_idx + 1]
    if not window:
        return False, True

    if direction == 'long':
        idm_swept     = any(c['low']   < idm_price  for c in window)
        origin_intact = all(c['close'] >= orig_price for c in window)
    else:
        idm_swept     = any(c['high']  > idm_price  for c in window)
        origin_intact = all(c['close'] <= orig_price for c in window)

    return idm_swept, origin_intact


# ── IDM sweep check on 4H candles (intraday, post-BOS) ───────────────────────

def check_idm_sweep_4h(candles_4h: list, bos_timestamp: int,
                        idm_price: float, orig_price: float,
                        direction: str,
                        live_4h_candle: Optional[dict] = None) -> tuple:
    """Check 4H candles after BOS timestamp for intraday IDM sweep.

    live_4h_candle: synthesized forming 4H candle from 1H data (may not be closed yet).
    Including it allows the detector to catch IDM sweeps that happen during the
    forming 4H candle — previously these were invisible until the candle closed (~4h later).
    """
    post_bos = [c for c in candles_4h
                if isinstance(c.get('timestamp'), (int, float))
                and c['timestamp'] > bos_timestamp]
    if (live_4h_candle
            and isinstance(live_4h_candle.get('timestamp'), (int, float))
            and live_4h_candle['timestamp'] > bos_timestamp):
        post_bos.append(live_4h_candle)
    if not post_bos:
        return False, True
    if direction == 'long':
        swept  = any(c['low']   < idm_price  for c in post_bos)
        intact = all(c['close'] >= orig_price for c in post_bos)
    else:
        swept  = any(c['high']  > idm_price  for c in post_bos)
        intact = all(c['close'] <= orig_price for c in post_bos)
    return swept, intact


# ── OTE zone ──────────────────────────────────────────────────────────────────

def calc_ote_zone(bos: dict, idm: dict) -> dict:
    direction  = bos['direction']
    h1_price   = bos['h1_price']
    orig_price = idm['orig_price']

    if direction == 'long':
        rng = h1_price - orig_price
        if rng <= 0:
            return {'ote_low': None, 'ote_high': None}
        return {
            'ote_low':  round(orig_price + OTE_LOW_FIB  * rng, 4),
            'ote_high': round(orig_price + OTE_HIGH_FIB * rng, 4),
        }
    else:
        rng = orig_price - h1_price
        if rng <= 0:
            return {'ote_low': None, 'ote_high': None}
        return {
            'ote_low':  round(orig_price - OTE_HIGH_FIB * rng, 4),
            'ote_high': round(orig_price - OTE_LOW_FIB  * rng, 4),
        }


# ── Sweep-reversal detector (4H) ──────────────────────────────────────────────
#
# Detects "liquidity sweep + bullish reversal" on 4H candles — independent of
# the daily BOS direction. Uses DAILY pivot lows as reference levels (not 4H),
# so historically important swing lows (months-old macro levels like August lows)
# are captured. 4H candles then supply the sweep + reversal confirmation.
#
# Reference: joshyattridge/smart-money-concepts + sudheer201/Liquidity-Sweep-Reversal-Systems
#   "A candle's low pierces the swing low AND closes back inside → sweep confirmed.
#    Enter at open of next candle in the reversal direction."

def _ema(closes: list, period: int) -> Optional[float]:
    if len(closes) < period:
        return None
    k   = 2.0 / (period + 1)
    ema = sum(closes[:period]) / period
    for c in closes[period:]:
        ema = c * k + ema * (1.0 - k)
    return ema


def detect_sweep_reversal_4h(
    candles_4h: list,
    daily_pivot_lows: list,   # [(idx, price), ...] from find_pivots(daily_candles)
    daily_ema200: float,
    symbol: str,
) -> Optional[dict]:
    """
    Scan 4H bars for a sell-side liquidity sweep → bullish reversal setup.

    Uses daily pivot lows as the "significant levels" to watch — this captures
    macro swing lows (e.g. August lows months ago) that the 4H fractal would miss.
    Returns a scored result dict or None.
    """
    n = len(candles_4h)
    if n < SWEEP_MAX_BARS_AGO + 4:
        return None
    if not daily_pivot_lows:
        return None

    closes_4h     = [c['close'] for c in candles_4h]
    current_price = closes_4h[-1]
    ema50_4h      = _ema(closes_4h, SWEEP_EMA_PERIOD)

    # Use daily pivot lows as the reference sweep levels (most recent first)
    # Only use lows that are BELOW the current price (potential buy-side IDM targets)
    candidate_levels = sorted(
        [(i, p) for i, p in daily_pivot_lows if p < current_price * 1.05],
        key=lambda x: x[0],
        reverse=True,
    )
    if not candidate_levels:
        return None

    # ── For each daily pivot low, check if a recent 4H candle swept it ────────
    for _d_idx, sl_price in candidate_levels:
        # Scan 4H candles newest-first for a sweep within SWEEP_MAX_BARS_AGO
        for j in range(n - 1, max(0, n - 1 - SWEEP_MAX_BARS_AGO - 1), -1):
            cj = candles_4h[j]

            # Sweep condition:
            #   wick went below daily pivot low AND candle CLOSED back above it
            if cj['low'] >= sl_price or cj['close'] <= sl_price:
                continue

            bars_ago = n - 1 - j

            # ── G3: Liquidity sweep identified (+2) — always satisfied here ──

            # ── G2: 4H EMA50 — price above = bullish intraday bias ────────────
            g2 = ema50_4h is not None and current_price > ema50_4h

            # ── G4: Order Block = last bearish 4H candle at or before sweep ───
            ob_low = ob_high = None
            search_back = max(0, j - 10)
            for k in range(j - 1, search_back, -1):
                ck = candles_4h[k]
                if ck['close'] < ck['open']:      # bearish candle = OB candidate
                    ob_low  = ck['low']
                    ob_high = ck['high']
                    break
            g4 = ob_low is not None

            # ── G5: Current price inside OB zone ─────────────────────────────
            g5 = g4 and (ob_low <= current_price <= ob_high)

            # ── G6: Reversal confirmation — sweep candle closes bullish ───────
            g6 = cj['close'] > cj['open']

            # ── G1: Pin-bar / institutional absorption ────────────────────────
            # Measures how strongly the sweep candle REJECTED the swept level.
            # close_pos = 1.0 → closed at the high (maximum rejection)
            # close_pos = 0.6 → closed in top 40% of range (strong absorption)
            # This replaces "close above prior swing high" which fires too late —
            # a strong bullish sweep candle IS the structural confirmation (BOS
            # equivalent at the swept level).
            candle_range = cj['high'] - cj['low']
            close_pos    = (cj['close'] - cj['low']) / candle_range if candle_range > 0 else 0.0
            g1           = close_pos >= SWEEP_G1_PIN_BAR_THRESHOLD

            # ── G7: R/R ≥ 1:3 ────────────────────────────────────────────────
            # SL = 0.2% below sweep wick
            # TP  = highest high in the 50 bars before the sweep (prior distribution)
            # Backtest: 3.0 threshold maximises expectancy vs 2.0 (+0.417%/trade)
            sl_level  = cj['low'] * 0.998
            sl_dist   = current_price - sl_level
            lb_start  = max(0, j - 50)
            target_price = max(c2['high'] for c2 in candles_4h[lb_start : j]) if j > 0 else current_price
            rr = (target_price - current_price) / sl_dist if sl_dist > 0 else 0.0
            g7 = rr >= 3.0

            score = (
                (2 if g1 else 0) +
                (1 if g2 else 0) +
                2 +                        # G3 always +2
                (2 if g4 else 0) +
                (1 if g5 else 0) +
                (1 if g6 else 0) +
                (1 if g7 else 0)
            )

            # G2 required for auto_open threshold: counter-trend (below EMA50) → cap at 8
            if not g2 and score >= 9:
                score = 8

            if score < 8:
                continue   # below monitoring threshold — skip

            is_live_sweep = cj.get('is_live', False)
            live_suffix   = ' [live 4H forming candle]' if is_live_sweep else ''
            return {
                'symbol':           symbol,
                'score':            score,
                'side':             'long',
                'strategy':         'sweep_reversal_4h',
                'current_price':    round(current_price, 4),
                'daily_close':      round(current_price, 4),
                'sweep_level':      round(sl_price, 4),
                'sweep_wick_low':   round(cj['low'], 4),
                'ob_low':           round(ob_low,  4) if ob_low  else None,
                'ob_high':          round(ob_high, 4) if ob_high else None,
                'sl_level':         round(sl_level, 4),
                'rr':               round(rr, 2),
                'bars_since_sweep': bars_ago,
                'is_live_4h_sweep': is_live_sweep,
                'g1_bos_4h':        g1,
                'g2_ema50_4h':      g2,
                'g3_sweep':         True,
                'g4_ob':            g4,
                'g5_in_ob':         g5,
                'g6_reversal':      g6,
                'g7_rr':            g7,
                'idm_swept':        True,
                'reason':           (
                    f'Score {score} (sweep_reversal_4h): '
                    f'4H sweep of daily pivot {sl_price:.4f} → long | '
                    f'G1={g1} G2={g2} G4={g4} G6={g6} G7={g7} RR={rr:.1f}{live_suffix}'
                ),
            }

    return None


def detect_sweep_reversal_1h(
    candles_1h: list,
    h4_pivot_lows: list,   # [(idx, price), ...] from find_pivots(candles_4h)
    daily_ema200: float,
    symbol: str,
) -> Optional[dict]:
    """
    1H counterpart of detect_sweep_reversal_4h.

    Uses 4H pivot lows as reference sweep levels — captures intraday structural
    demand zones that the daily detector misses.

    Two roles:
      1. Standalone: fires Score 7–8 (monitoring only, no auto_open by itself).
      2. Confluence confirmation: when a 4H sweep is pending_confirmation,
         a 1H sweep in the same direction upgrades it to confirmed (Score 9).
         Handled in main() after this function returns.

    Returns a scored result dict or None.
    """
    n = len(candles_1h)
    if n < SWEEP_1H_MIN_CANDLES + SWEEP_1H_MAX_BARS_AGO:
        return None
    if not h4_pivot_lows:
        return None

    closes_1h     = [c['close'] for c in candles_1h]
    current_price = closes_1h[-1]
    ema50_1h      = _ema(closes_1h, SWEEP_1H_EMA_PERIOD)

    # Only consider 4H pivot lows below current price (potential buy-side levels)
    candidate_levels = sorted(
        [(i, p) for i, p in h4_pivot_lows if p < current_price * 1.03],
        key=lambda x: x[0],
        reverse=True,
    )
    if not candidate_levels:
        return None

    for _h4_idx, sl_price in candidate_levels:
        for j in range(n - 1, max(0, n - 1 - SWEEP_1H_MAX_BARS_AGO - 1), -1):
            cj = candles_1h[j]

            # Sweep condition: wick below 4H pivot low, close back above it
            if cj['low'] >= sl_price or cj['close'] <= sl_price:
                continue

            bars_ago = n - 1 - j

            # ── G2: 1H EMA50 ─────────────────────────────────────────────────
            g2 = ema50_1h is not None and current_price > ema50_1h

            # ── G4: Last bearish 1H candle before sweep = OB ─────────────────
            ob_low = ob_high = None
            for k in range(j - 1, max(0, j - 8), -1):
                ck = candles_1h[k]
                if ck['close'] < ck['open']:
                    ob_low  = ck['low']
                    ob_high = ck['high']
                    break
            g4 = ob_low is not None

            # ── G5: Current price inside OB ───────────────────────────────────
            g5 = g4 and (ob_low <= current_price <= ob_high)

            # ── G6: Sweep candle closes bullish ───────────────────────────────
            g6 = cj['close'] > cj['open']

            # ── G1: Pin-bar strength (same threshold as 4H) ───────────────────
            candle_range = cj['high'] - cj['low']
            close_pos    = (cj['close'] - cj['low']) / candle_range if candle_range > 0 else 0.0
            g1           = close_pos >= SWEEP_G1_PIN_BAR_THRESHOLD

            # ── G7: R/R ≥ 1:3 using 24-bar lookback high ─────────────────────
            sl_level  = cj['low'] * 0.998
            sl_dist   = current_price - sl_level
            lb_start  = max(0, j - SWEEP_1H_G7_LOOKBACK)
            target_price = max(c2['high'] for c2 in candles_1h[lb_start:j]) if j > 0 else current_price
            rr = (target_price - current_price) / sl_dist if sl_dist > 0 else 0.0
            g7 = rr >= 2.0

            score = (
                (2 if g1 else 0) +
                (1 if g2 else 0) +
                2 +                        # G3 always +2
                (2 if g4 else 0) +
                (1 if g5 else 0) +
                (1 if g6 else 0) +
                (1 if g7 else 0)
            )

            if score < 7:
                continue

            return {
                'symbol':             symbol,
                'score':              score,
                'side':               'long',
                'strategy':           'sweep_reversal_1h',
                'current_price':      round(current_price, 4),
                'daily_close':        round(current_price, 4),
                'sweep_level':        round(sl_price, 4),
                'sweep_wick_low':     round(cj['low'], 4),
                'ob_low':             round(ob_low,  4) if ob_low  else None,
                'ob_high':            round(ob_high, 4) if ob_high else None,
                'sl_level':           round(sl_level, 4),
                'rr':                 round(rr, 2),
                'bars_since_sweep':   bars_ago,
                'g1_bos_1h':          g1,
                'g2_ema50_1h':        g2,
                'g3_sweep':           True,
                'g4_ob':              g4,
                'g5_in_ob':           g5,
                'g6_reversal':        g6,
                'g7_rr':              g7,
                'idm_swept':          True,
                'confluence_role':    'standalone',
                'reason':             (
                    f'Score {score} (sweep_reversal_1h): '
                    f'1H sweep of 4H pivot {sl_price:.4f} → long | '
                    f'G1={g1} G2={g2} G4={g4} G6={g6} G7={g7} RR={rr:.1f}'
                ),
            }

    return None


def detect_sweep_reversal_4h_short(
    candles_4h: list,
    daily_pivot_highs: list,   # [(idx, price), ...] from find_pivots(daily_candles)
    daily_ema200: float,
    symbol: str,
) -> Optional[dict]:
    """
    Scan 4H bars for a buy-side liquidity sweep → bearish reversal setup.

    Mirror of detect_sweep_reversal_4h but for SHORT:
    - Uses daily pivot HIGHS as reference (buy-side liquidity above price).
    - Sweep: 4H wick pierces daily pivot high AND closes back below it.
    - Entry in the SHORT direction at current price after confirmation.
    """
    n = len(candles_4h)
    if n < SWEEP_MAX_BARS_AGO + 4:
        return None
    if not daily_pivot_highs:
        return None

    closes_4h     = [c['close'] for c in candles_4h]
    current_price = closes_4h[-1]
    ema50_4h      = _ema(closes_4h, SWEEP_EMA_PERIOD)

    candidate_levels = sorted(
        [(i, p) for i, p in daily_pivot_highs if p > current_price * 0.95],
        key=lambda x: x[0],
        reverse=True,
    )
    if not candidate_levels:
        return None

    for _d_idx, sh_price in candidate_levels:
        for j in range(n - 1, max(0, n - 1 - SWEEP_MAX_BARS_AGO - 1), -1):
            cj = candles_4h[j]

            # Sweep: wick pierced daily pivot high AND closed back below it
            if cj['high'] <= sh_price or cj['close'] >= sh_price:
                continue

            bars_ago = n - 1 - j

            # G2: EMA50 — price below = bearish intraday bias
            g2 = ema50_4h is not None and current_price < ema50_4h

            # G4: Last BULLISH 4H candle before sweep = bearish OB candidate
            ob_low = ob_high = None
            search_back = max(0, j - 10)
            for k in range(j - 1, search_back, -1):
                ck = candles_4h[k]
                if ck['close'] > ck['open']:
                    ob_low  = ck['low']
                    ob_high = ck['high']
                    break
            g4 = ob_low is not None

            # G5: Current price inside OB zone
            g5 = g4 and (ob_low <= current_price <= ob_high)

            # G6: Sweep candle closes BEARISH
            g6 = cj['close'] < cj['open']

            # G1: Bearish pin-bar — close near the LOW of the sweep candle = strong rejection
            # Threshold 0.70 (backtest-calibrated for SHORT; higher than LONG's 0.50)
            candle_range   = cj['high'] - cj['low']
            close_pos_bear = (cj['high'] - cj['close']) / candle_range if candle_range > 0 else 0.0
            g1             = close_pos_bear >= SWEEP_G1_PIN_BAR_THRESHOLD_SHORT

            # G7: R/R ≥ 1:2 (SHORT) — SL above wick, TP = lowest low in prior 50 bars
            sl_level     = cj['high'] * 1.002
            sl_dist      = sl_level - current_price
            lb_start     = max(0, j - 50)
            target_price = min(c2['low'] for c2 in candles_4h[lb_start:j]) if j > 0 else current_price
            rr           = (current_price - target_price) / sl_dist if sl_dist > 0 else 0.0
            g7           = rr >= 2.0

            score = (
                (2 if g1 else 0) +
                (1 if g2 else 0) +
                2 +
                (2 if g4 else 0) +
                (1 if g5 else 0) +
                (1 if g6 else 0) +
                (1 if g7 else 0)
            )

            # G2 required for auto_open threshold: counter-trend (above EMA50) → cap at 8
            if not g2 and score >= 9:
                score = 8

            if score < 8:
                continue

            is_live_sweep = cj.get('is_live', False)
            live_suffix   = ' [live 4H forming candle]' if is_live_sweep else ''
            return {
                'symbol':           symbol,
                'score':            score,
                'side':             'short',
                'strategy':         'sweep_reversal_4h_short',
                'current_price':    round(current_price, 4),
                'daily_close':      round(current_price, 4),
                'sweep_level':      round(sh_price, 4),
                'sweep_wick_high':  round(cj['high'], 4),
                'ob_low':           round(ob_low,  4) if ob_low  else None,
                'ob_high':          round(ob_high, 4) if ob_high else None,
                'sl_level':         round(sl_level, 4),
                'rr':               round(rr, 2),
                'bars_since_sweep': bars_ago,
                'is_live_4h_sweep': is_live_sweep,
                'g1_bos_4h':        g1,
                'g2_ema50_4h':      g2,
                'g3_sweep':         True,
                'g4_ob':            g4,
                'g5_in_ob':         g5,
                'g6_reversal':      g6,
                'g7_rr':            g7,
                'idm_swept':        True,
                'reason':           (
                    f'Score {score} (sweep_reversal_4h_short): '
                    f'4H sweep of daily pivot {sh_price:.4f} → short | '
                    f'G1={g1} G2={g2} G4={g4} G6={g6} G7={g7} RR={rr:.1f}{live_suffix}'
                ),
            }

    return None


def detect_sweep_reversal_1h_short(
    candles_1h: list,
    h4_pivot_highs: list,   # [(idx, price), ...] from find_pivots(candles_4h)
    daily_ema200: float,
    symbol: str,
) -> Optional[dict]:
    """
    1H counterpart of detect_sweep_reversal_4h_short.

    Uses 4H pivot HIGHS as reference levels for bearish sweep detection.
    Two roles: standalone (Score ≤ 8, monitoring) or 4H-short confluence confirmation.
    """
    n = len(candles_1h)
    if n < SWEEP_1H_MIN_CANDLES + SWEEP_1H_MAX_BARS_AGO:
        return None
    if not h4_pivot_highs:
        return None

    closes_1h     = [c['close'] for c in candles_1h]
    current_price = closes_1h[-1]
    ema50_1h      = _ema(closes_1h, SWEEP_1H_EMA_PERIOD)

    candidate_levels = sorted(
        [(i, p) for i, p in h4_pivot_highs if p > current_price * 0.97],
        key=lambda x: x[0],
        reverse=True,
    )
    if not candidate_levels:
        return None

    for _h4_idx, sh_price in candidate_levels:
        for j in range(n - 1, max(0, n - 1 - SWEEP_1H_MAX_BARS_AGO - 1), -1):
            cj = candles_1h[j]

            # Sweep: wick above 4H pivot high, close back below it
            if cj['high'] <= sh_price or cj['close'] >= sh_price:
                continue

            bars_ago = n - 1 - j

            g2 = ema50_1h is not None and current_price < ema50_1h

            ob_low = ob_high = None
            for k in range(j - 1, max(0, j - 8), -1):
                ck = candles_1h[k]
                if ck['close'] > ck['open']:
                    ob_low  = ck['low']
                    ob_high = ck['high']
                    break
            g4 = ob_low is not None

            g5 = g4 and (ob_low <= current_price <= ob_high)
            g6 = cj['close'] < cj['open']

            candle_range   = cj['high'] - cj['low']
            close_pos_bear = (cj['high'] - cj['close']) / candle_range if candle_range > 0 else 0.0
            g1             = close_pos_bear >= SWEEP_G1_PIN_BAR_THRESHOLD_SHORT

            sl_level     = cj['high'] * 1.002
            sl_dist      = sl_level - current_price
            lb_start     = max(0, j - SWEEP_1H_G7_LOOKBACK)
            target_price = min(c2['low'] for c2 in candles_1h[lb_start:j]) if j > 0 else current_price
            rr           = (current_price - target_price) / sl_dist if sl_dist > 0 else 0.0
            g7           = rr >= 2.0

            score = (
                (2 if g1 else 0) +
                (1 if g2 else 0) +
                2 +
                (2 if g4 else 0) +
                (1 if g5 else 0) +
                (1 if g6 else 0) +
                (1 if g7 else 0)
            )

            if score < 7:
                continue

            return {
                'symbol':             symbol,
                'score':              score,
                'side':               'short',
                'strategy':           'sweep_reversal_1h_short',
                'current_price':      round(current_price, 4),
                'daily_close':        round(current_price, 4),
                'sweep_level':        round(sh_price, 4),
                'sweep_wick_high':    round(cj['high'], 4),
                'ob_low':             round(ob_low,  4) if ob_low  else None,
                'ob_high':            round(ob_high, 4) if ob_high else None,
                'sl_level':           round(sl_level, 4),
                'rr':                 round(rr, 2),
                'bars_since_sweep':   bars_ago,
                'g1_bos_1h':          g1,
                'g2_ema50_1h':        g2,
                'g3_sweep':           True,
                'g4_ob':              g4,
                'g5_in_ob':           g5,
                'g6_reversal':        g6,
                'g7_rr':              g7,
                'idm_swept':          True,
                'confluence_role':    'standalone',
                'reason':             (
                    f'Score {score} (sweep_reversal_1h_short): '
                    f'1H sweep of 4H pivot {sh_price:.4f} → short | '
                    f'G1={g1} G2={g2} G4={g4} G6={g6} G7={g7} RR={rr:.1f}'
                ),
            }

    return None


# ── Main setup detector ───────────────────────────────────────────────────────

def detect_setup(candles: list, symbol: str,
                 current_price_4h: Optional[float] = None) -> dict:
    """Full SMC pipeline for one symbol. current_price_4h used for OTE check if available."""
    n             = len(candles)
    daily_price   = candles[-1]['close']
    current_price = current_price_4h if current_price_4h is not None else daily_price
    closes        = [c['close'] for c in candles]

    result = {
        'symbol':            symbol,
        'score':             0,
        'side':              None,
        'current_price':     round(current_price, 4),
        'daily_close':       round(daily_price, 4),
        'ema200':            None,
        'price_vs_ema200':   None,
        'bos_confirmed':     False,
        'h1_level':          None,
        'candles_since_bos': None,
        'bos_timestamp':     None,
        'idm_level':         None,
        'idm_swept':         None,
        'origin_level':      None,
        'origin_intact':     None,
        'ote_low':           None,
        'ote_high':          None,
        'in_ote':            None,
        'reason':            'no_setup',
    }

    # 1. EMA(200)
    ema200 = calc_ema(closes)
    result['ema200']          = round(ema200, 4)
    result['price_vs_ema200'] = round(current_price - ema200, 4)

    # 2. Pivot detection
    pivot_highs, pivot_lows = find_pivots(candles)
    if not pivot_highs or not pivot_lows:
        result['reason'] = 'insufficient_pivots'
        return result

    # 3. BOS
    bos = find_last_bos(candles, pivot_highs, pivot_lows)
    if bos is None:
        result['reason'] = 'no_bos_detected'
        return result

    direction = bos['direction']
    result['bos_confirmed']    = True
    result['side']             = direction
    result['h1_level']         = round(bos['h1_price'], 4)
    result['candles_since_bos'] = n - 1 - bos['bos_idx']
    result['bos_timestamp']    = candles[bos['bos_idx']].get('timestamp')

    # 4. EMA200 alignment
    ema_aligned = (direction == 'long'  and current_price > ema200) or \
                  (direction == 'short' and current_price < ema200)
    if not ema_aligned:
        result['reason'] = (
            f'ema200_not_aligned: {direction} but price={current_price:.2f} '
            f'{"<" if direction == "long" else ">"} ema={ema200:.2f}'
        )
        return result

    # Score 8
    result['score']  = 8
    result['reason'] = 'Score 8: BOS + EMA200 aligned'

    # 5. IDM & Origin
    idm_data = find_idm_and_origin(candles, bos, pivot_highs, pivot_lows)
    result['idm_level']    = idm_data['idm_price']
    result['origin_level'] = idm_data['orig_price']

    # 6. OTE zone (computed here for all Score-8+ setups — used for state storage and 4H check)
    ote = calc_ote_zone(bos, idm_data)
    result['ote_low']  = ote['ote_low']
    result['ote_high'] = ote['ote_high']

    # 7. IDM sweep + Origin intact (daily history)
    idm_swept, origin_intact = check_idm_sweep(candles, bos, idm_data)
    result['idm_swept']    = idm_swept
    result['origin_intact'] = origin_intact

    if not idm_swept:
        result['reason'] = 'Score 8 only: idm_not_swept'
        return result
    if not origin_intact:
        result['reason'] = 'Score 8 only: origin_broken (structure too deep)'
        return result

    # Score 9
    result['score']  = 9
    result['reason'] = 'Score 9: BOS + EMA200 + IDM sweep + origin intact'

    # 8. OTE in-zone check (uses current_price = 4H close if available)
    if ote['ote_low'] is not None:
        in_ote = ote['ote_low'] <= current_price <= ote['ote_high']
        result['in_ote'] = in_ote
        if in_ote:
            result['score']  = 10
            result['reason'] = 'Score 10: BOS + EMA200 + IDM sweep + origin intact + in OTE'

    return result


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    pending_setups = load_pending_state()
    state_changes  = 0
    outputs        = []

    for symbol in SMC_SYMBOLS:
        out: dict = {'symbol': symbol, 'score': 0, 'side': None, 'reason': 'not_run'}
        try:
            candles    = load_ohlcv(symbol)
            candles_4h = load_ohlcv_4h(symbol)
            candles_1h = load_ohlcv_1h(symbol)
            candles_15m = load_ohlcv_15m(symbol)
            price_4h   = candles_4h[-1]['close'] if candles_4h else None

            # Synthesize the currently forming 4H candle from 1H data.
            # This fills the gap: a sweep that occurs during the forming 4H candle
            # (e.g. 06:30 UTC on the 04:00-08:00 candle) would otherwise be invisible
            # until the candle closes up to 4 hours later.
            live_4h       = synth_live_4h_from_1h(candles_1h, candles_4h) if (candles_1h and candles_4h) else None
            candles_4h_ext = candles_4h + [live_4h] if live_4h else candles_4h

            out        = detect_setup(candles, symbol, price_4h)
            pivot_highs, pivot_lows = find_pivots(candles)   # daily pivots for sweep detectors

            # 4H intraday IDM sweep — only for Score-8 (IDM not yet swept on daily)
            if out['score'] == 8 and candles_4h and out.get('bos_timestamp'):
                # Check closed 4H candles only (baseline)
                swept_closed, _ = check_idm_sweep_4h(
                    candles_4h, out['bos_timestamp'],
                    out['idm_level'], out['origin_level'], out['side'],
                )
                # Check again including the forming 4H candle (live_4h)
                swept_4h, intact_4h = check_idm_sweep_4h(
                    candles_4h, out['bos_timestamp'],
                    out['idm_level'], out['origin_level'], out['side'],
                    live_4h_candle=live_4h,
                )
                if swept_4h and intact_4h:
                    out['idm_swept']      = True
                    out['score']          = 9
                    live_triggered        = live_4h is not None and not swept_closed
                    out['is_live_4h_sweep'] = live_triggered
                    suffix = ' [live 4H forming candle — not yet closed]' if live_triggered else ''
                    out['reason'] = f'Score 9 (4H): IDM swept on 4H candle + origin intact{suffix}'
                    if out['ote_low'] is not None and price_4h is not None:
                        if out['ote_low'] <= price_4h <= out['ote_high']:
                            out['score']  = 10
                            out['reason'] = f'Score 10 (4H): IDM swept on 4H + in OTE{suffix}'

            # ── Sweep-reversal path: additional 4H signal (independent of daily BOS) ──
            # Uses daily pivot lows as reference levels so macro lows (months old)
            # are captured. Outputs a SECOND line for the symbol when found.
            #
            # candles_4h_ext includes the forming 4H candle (from 1H) so a sweep that
            # occurs intracandle (before the 4H bar closes) is detected immediately.
            # The pending_confirmation mechanism already handles the live-candle case:
            # a bullish 1H close after the sweep timestamp confirms the signal.
            if candles_4h_ext:
                sweep = detect_sweep_reversal_4h(
                    candles_4h_ext,
                    pivot_lows,
                    out.get('ema200') or 0.0,
                    symbol,
                )
                if sweep is not None:
                    # Find any existing pending sweep for this symbol
                    pending_sweep = next(
                        (s for s in pending_setups
                         if s['symbol'] == symbol
                         and s.get('strategy') == 'sweep_reversal_4h'
                         and s['status'] == 'pending_confirmation'),
                        None,
                    )

                    confluence_confirmed = False
                    if pending_sweep is not None:
                        ref_level = pending_sweep.get('sweep_level', 0)
                        same_lvl  = ref_level > 0 and abs(ref_level - sweep['sweep_level']) / ref_level < 0.005
                        if same_lvl:
                            sig_ts = pending_sweep.get('signal_4h_ts', 0)
                            # Combined mode: first 1H bullish close after the 4H sweep signal.
                            # Faster than waiting for a full 4H bar to close (~1-4h vs ~4h).
                            # Backtest: combined 4H+1H mode with 24b hold = best expectancy (+45.5%).
                            conf_bars = candles_1h if candles_1h else candles_4h
                            conf_bar  = next(
                                (c for c in conf_bars if c['timestamp'] > sig_ts and c['close'] > c['open']),
                                None,
                            )
                            if conf_bar is not None:
                                confluence_confirmed = True
                            elif candles_15m:
                                # 15m early warning: fires before 1H close — monitoring only, NOT an execution trigger.
                                bar_15m = next(
                                    (c for c in candles_15m if c['timestamp'] > sig_ts and c['close'] > c['open']),
                                    None,
                                )
                                if bar_15m is not None:
                                    import sys as _sys
                                    print(json.dumps({
                                        'info':        'smc_15m_early_warning',
                                        'symbol':      symbol,
                                        'side':        'long',
                                        'score':       pending_sweep['score'],
                                        'sweep_level': pending_sweep['sweep_level'],
                                        'bar_15m_ts':  bar_15m['timestamp'],
                                        'bar_15m_close': bar_15m['close'],
                                        'note':        '15m bullish close seen — 1H confirmation still pending',
                                    }), file=_sys.stderr)

                    sweep['confluence_confirmed'] = confluence_confirmed

                    # Clear any stale pending entry for this symbol
                    pending_setups = [
                        s for s in pending_setups
                        if not (s['symbol'] == symbol and s.get('strategy') == 'sweep_reversal_4h')
                    ]

                    if not confluence_confirmed:
                        # Store pending — wait for next 4H bar to confirm
                        pending_setups.append({
                            'symbol':             symbol,
                            'strategy':           'sweep_reversal_4h',
                            'side':               sweep['side'],
                            'score':              sweep['score'],
                            'sweep_level':        sweep['sweep_level'],
                            'signal_4h_ts':       candles_4h[-1]['timestamp'],
                            'confirmation_price': sweep['current_price'],
                            'entry_timestamp':    datetime.now(timezone.utc).isoformat(),
                            'status':             'pending_confirmation',
                        })
                        # Downgrade score: 9 → 8 (monitoring), 8 → 7 (suppressed)
                        sweep['score']  = max(0, sweep['score'] - 1)
                        sweep['reason'] = sweep['reason'] + ' [waiting confluence: next 1H bar must close bullish]'

                    outputs.append(sweep)
                    state_changes += 1
                else:
                    # No sweep signal — clear any stale pending entry
                    pending_setups = [
                        s for s in pending_setups
                        if not (s['symbol'] == symbol and s.get('strategy') == 'sweep_reversal_4h')
                    ]

            # ── 1H sweep-reversal path ────────────────────────────────────────
            # Reference levels: 4H Williams-fractal lows (PIVOT_LEN=2, 5-bar).
            # Two roles:
            #   A) If a 4H sweep is pending_confirmation → 1H sweep confirms it
            #      immediately (replaces "wait for next 4H bar" with structural
            #      1H demand confirmation) → restores original score → auto_open.
            #   B) Standalone (no 4H pending) → Score capped at 8 (monitoring).
            if candles_4h and candles_1h:
                h4_pivot_highs, h4_pivot_lows = find_pivots(candles_4h)   # 4H pivots for 1H detectors
                sweep_1h = detect_sweep_reversal_1h(
                    candles_1h,
                    h4_pivot_lows,
                    out.get('ema200') or 0.0,
                    symbol,
                )
                if sweep_1h is not None:
                    # Find matching pending 4H sweep (same symbol + side)
                    pending_4h = next(
                        (s for s in pending_setups
                         if s['symbol'] == symbol
                         and s.get('strategy') == 'sweep_reversal_4h'
                         and s['status'] == 'pending_confirmation'
                         and s.get('side') == sweep_1h['side']),
                        None,
                    )

                    if pending_4h is not None:
                        # Role A: 1H sweep confirms the pending 4H sweep.
                        # Restore original score on the 4H output already in list.
                        original_score = pending_4h['score']
                        for sig in outputs:
                            if (sig.get('strategy') == 'sweep_reversal_4h'
                                    and sig.get('symbol') == symbol
                                    and sig.get('side') == sweep_1h['side']):
                                sig['score']               = original_score
                                sig['confluence_confirmed'] = True
                                sig['confluence_source']    = 'sweep_reversal_1h'
                                sig['reason']               = sig['reason'].replace(
                                    ' [waiting confluence: next 4H bar must close bullish]',
                                    ' [confluence confirmed by 1H sweep]',
                                )
                                break
                        # Clear from pending — no longer waiting
                        pending_setups = [
                            s for s in pending_setups
                            if not (s['symbol'] == symbol
                                    and s.get('strategy') == 'sweep_reversal_4h')
                        ]
                        sweep_1h['confluence_role']      = '4h_confirmation'
                        sweep_1h['confluence_confirmed'] = True
                        state_changes += 1
                    else:
                        # Role B: standalone — cap score so it cannot auto_open alone
                        sweep_1h['score']              = min(sweep_1h['score'], 8)
                        sweep_1h['confluence_role']    = 'standalone'
                        sweep_1h['confluence_confirmed'] = False
                        if sweep_1h['score'] < 8:
                            sweep_1h = None   # below monitoring threshold → suppress

                    if sweep_1h is not None:
                        outputs.append(sweep_1h)
                        state_changes += 1

            # ── Sweep-reversal SHORT path: 4H bearish sweep ───────────────────
            if candles_4h_ext:
                sweep_short = detect_sweep_reversal_4h_short(
                    candles_4h_ext,
                    pivot_highs,
                    out.get('ema200') or 0.0,
                    symbol,
                )
                if sweep_short is not None:
                    pending_sweep_short = next(
                        (s for s in pending_setups
                         if s['symbol'] == symbol
                         and s.get('strategy') == 'sweep_reversal_4h_short'
                         and s['status'] == 'pending_confirmation'),
                        None,
                    )

                    confluence_confirmed_short = False
                    if pending_sweep_short is not None:
                        ref_level = pending_sweep_short.get('sweep_level', 0)
                        same_lvl  = ref_level > 0 and abs(ref_level - sweep_short['sweep_level']) / ref_level < 0.005
                        if same_lvl:
                            sig_ts    = pending_sweep_short.get('signal_4h_ts', 0)
                            # Combined mode: first 1H bearish close after the 4H sweep signal.
                            conf_bars = candles_1h if candles_1h else candles_4h
                            conf_bar  = next(
                                (c for c in conf_bars if c['timestamp'] > sig_ts and c['close'] < c['open']),
                                None,
                            )
                            if conf_bar is not None:
                                confluence_confirmed_short = True
                            elif candles_15m:
                                bar_15m_s = next(
                                    (c for c in candles_15m if c['timestamp'] > sig_ts and c['close'] < c['open']),
                                    None,
                                )
                                if bar_15m_s is not None:
                                    import sys as _sys
                                    print(json.dumps({
                                        'info':          'smc_15m_early_warning',
                                        'symbol':        symbol,
                                        'side':          'short',
                                        'score':         pending_sweep_short['score'],
                                        'sweep_level':   pending_sweep_short['sweep_level'],
                                        'bar_15m_ts':    bar_15m_s['timestamp'],
                                        'bar_15m_close': bar_15m_s['close'],
                                        'note':          '15m bearish close seen — 1H confirmation still pending',
                                    }), file=_sys.stderr)

                    sweep_short['confluence_confirmed'] = confluence_confirmed_short

                    pending_setups = [
                        s for s in pending_setups
                        if not (s['symbol'] == symbol and s.get('strategy') == 'sweep_reversal_4h_short')
                    ]

                    if not confluence_confirmed_short:
                        pending_setups.append({
                            'symbol':             symbol,
                            'strategy':           'sweep_reversal_4h_short',
                            'side':               'short',
                            'score':              sweep_short['score'],
                            'sweep_level':        sweep_short['sweep_level'],
                            'signal_4h_ts':       candles_4h[-1]['timestamp'],
                            'confirmation_price': sweep_short['current_price'],
                            'entry_timestamp':    datetime.now(timezone.utc).isoformat(),
                            'status':             'pending_confirmation',
                        })
                        sweep_short['score']  = max(0, sweep_short['score'] - 1)
                        sweep_short['reason'] = sweep_short['reason'] + ' [waiting confluence: next 1H bar must close bearish]'

                    outputs.append(sweep_short)
                    state_changes += 1
                else:
                    pending_setups = [
                        s for s in pending_setups
                        if not (s['symbol'] == symbol and s.get('strategy') == 'sweep_reversal_4h_short')
                    ]

            # ── 1H sweep-reversal SHORT path ──────────────────────────────────
            if candles_4h and candles_1h:
                h4_phighs, _ = find_pivots(candles_4h)
                sweep_1h_short = detect_sweep_reversal_1h_short(
                    candles_1h,
                    h4_phighs,
                    out.get('ema200') or 0.0,
                    symbol,
                )
                if sweep_1h_short is not None:
                    pending_4h_short = next(
                        (s for s in pending_setups
                         if s['symbol'] == symbol
                         and s.get('strategy') == 'sweep_reversal_4h_short'
                         and s['status'] == 'pending_confirmation'
                         and s.get('side') == 'short'),
                        None,
                    )

                    if pending_4h_short is not None:
                        original_score_short = pending_4h_short['score']
                        for sig in outputs:
                            if (sig.get('strategy') == 'sweep_reversal_4h_short'
                                    and sig.get('symbol') == symbol
                                    and sig.get('side') == 'short'):
                                sig['score']               = original_score_short
                                sig['confluence_confirmed'] = True
                                sig['confluence_source']    = 'sweep_reversal_1h_short'
                                sig['reason']               = sig['reason'].replace(
                                    ' [waiting confluence: next 4H bar must close bearish]',
                                    ' [confluence confirmed by 1H short sweep]',
                                )
                                break
                        pending_setups = [
                            s for s in pending_setups
                            if not (s['symbol'] == symbol
                                    and s.get('strategy') == 'sweep_reversal_4h_short')
                        ]
                        sweep_1h_short['confluence_role']      = '4h_confirmation'
                        sweep_1h_short['confluence_confirmed'] = True
                        state_changes += 1
                    else:
                        sweep_1h_short['score']              = min(sweep_1h_short['score'], 8)
                        sweep_1h_short['confluence_role']    = 'standalone'
                        sweep_1h_short['confluence_confirmed'] = False
                        if sweep_1h_short['score'] < 8:
                            sweep_1h_short = None

                    if sweep_1h_short is not None:
                        outputs.append(sweep_1h_short)
                        state_changes += 1

            # State: persist Score-8 setups (IDM not yet swept)
            if out['score'] == 8:
                bos_high = out['h1_level']
                already = any(
                    s['symbol'] == symbol
                    and s['side'] == out['side']
                    and s['bos_high'] == bos_high
                    for s in pending_setups
                )
                if not already:
                    pending_setups.append({
                        'symbol':          symbol,
                        'side':            out['side'],
                        'score':           8,
                        'idm_price':       out['idm_level'],
                        'origin_low':      out['origin_level'],
                        'bos_high':        bos_high,
                        'fib_618':         out['ote_low'],
                        'fib_786':         out['ote_high'],
                        'entry_timestamp': datetime.now(timezone.utc).isoformat(),
                        'status':          'watching',
                    })
                    state_changes += 1

            # Validate existing pending setups — origin broken = invalidate
            daily_close = candles[-1]['close']
            for s in pending_setups:
                if s['symbol'] != symbol or s['status'] != 'watching':
                    continue
                if s['side'] == 'long'  and daily_close < s['origin_low']:
                    s['status'] = 'invalid'
                    state_changes += 1
                elif s['side'] == 'short' and daily_close > s['origin_low']:
                    s['status'] = 'invalid'
                    state_changes += 1

        except FileNotFoundError as exc:
            out['reason'] = 'ohlcv_file_missing'
            print(json.dumps({'warning': f'{symbol}: {exc}'}), file=sys.stderr)
        except Exception as exc:
            out['reason'] = f'error: {exc}'
            print(json.dumps({'warning': f'{symbol}: {exc}'}), file=sys.stderr)

        outputs.append(out)

    # Persist active setups only
    active = [s for s in pending_setups if s['status'] != 'invalid']
    save_pending_state(active)

    print(json.dumps({
        'info':          'smc_state_summary',
        'pending':       len(active),
        'state_changes': state_changes,
    }), file=sys.stderr)

    for out in outputs:
        print(json.dumps(out))
        sys.stdout.flush()


if __name__ == '__main__':
    main()
