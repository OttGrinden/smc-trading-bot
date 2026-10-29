#!/usr/bin/env python3
"""
regime_filter.py — Crypto market regime gate (Step 0 in scan.mjs)

Checks two conditions before any SMC trade is allowed:
  1. Fear & Greed Index between FNG_LOW (20) and FNG_HIGH (80)
     — blocks on extreme fear or extreme greed
  2. BTC ATR(14) / current_price >= ATR_MIN_PCT (1.5%)
     — blocks when market is too quiet to trade meaningfully

Exit 0 = GREEN  → scan continues, SMC trades allowed
Exit 1 = RED    → scan aborts cleanly, no trades opened

stdout: single JSON line with full regime details (read by scan.mjs)
stderr: diagnostic messages

OHLCV source : trading/cache/ohlcv_daily_BTC.json
               format: [{timestamp, open, high, low, close, volume}, ...]  oldest-first
F&G API      : https://api.alternative.me/fng/?limit=1&format=json
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
from typing import Optional

import pathlib as _pathlib
_BASE = _pathlib.Path(__file__).resolve().parent.parent
OHLCV_PATH = str(_BASE / 'trading' / 'cache' / 'ohlcv_daily_BTC.json')

# ── File paths ─────────────────────────────────────────────────────────────────
FNG_URL    = 'https://api.alternative.me/fng/?limit=1&format=json'

# ── Thresholds ─────────────────────────────────────────────────────────────────
FNG_LOW     = 20     # below  → extreme fear  → RED
FNG_HIGH    = 80     # above  → extreme greed → RED
ATR_PERIOD  = 14
ATR_MIN_PCT = 0.015  # 1.5% of current price
ATR_WINDOW  = 50     # how many candles to feed into ATR calc (≥ ATR_PERIOD + 1)
FNG_TIMEOUT = 8      # seconds

# ── ATR (Wilder's smoothing, pure Python — no pandas/numpy) ───────────────────

def calc_atr(candles: list, period: int = ATR_PERIOD) -> float:
    """
    Wilder's Average True Range from a list of OHLCV dicts (oldest-first).

    True Range = max(H-L, |H-prev_C|, |L-prev_C|)
    Seed       = simple mean of first `period` TR values
    Smoothing  = (prev_ATR * (period-1) + TR) / period
    """
    if len(candles) < period + 1:
        raise ValueError(
            f'calc_atr needs at least {period + 1} candles, got {len(candles)}'
        )

    # Build True Range series (skips candle[0] — no previous close)
    tr_series: list[float] = []
    for i in range(1, len(candles)):
        high  = float(candles[i]['high'])
        low   = float(candles[i]['low'])
        prev_c = float(candles[i - 1]['close'])
        tr = max(high - low, abs(high - prev_c), abs(low - prev_c))
        tr_series.append(tr)

    # Seed: plain average of first `period` TR values
    atr = sum(tr_series[:period]) / period

    # Wilder's smoothing for all remaining TR values
    for tr in tr_series[period:]:
        atr = (atr * (period - 1) + tr) / period

    return atr


# ── Fear & Greed Index fetch ───────────────────────────────────────────────────

def fetch_fng() -> Optional[dict]:
    """
    Fetch latest Fear & Greed value from alternative.me.
    Returns {'value': int, 'classification': str} or None on any failure.
    If None: caller treats F&G check as skipped (does not block GREEN).
    """
    try:
        req = urllib.request.Request(
            FNG_URL,
            headers={'User-Agent': 'Mozilla/5.0 regime_filter/1.0'},
        )
        with urllib.request.urlopen(req, timeout=FNG_TIMEOUT) as resp:
            raw = json.loads(resp.read().decode('utf-8'))

        entry = raw['data'][0]
        value = int(entry['value'])
        classification = str(entry.get('value_classification', ''))
        return {'value': value, 'classification': classification}

    except Exception as exc:
        _err(f'fng_fetch_failed: {exc}')
        return None


# ── Helpers ────────────────────────────────────────────────────────────────────

def _err(msg: str) -> None:
    print(json.dumps({'warning': msg}), file=sys.stderr)


def _abort(result: dict) -> None:
    """Print result JSON and exit RED (1)."""
    result['regime'] = 'RED'
    print(json.dumps(result))
    sys.exit(1)


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    result: dict = {
        'regime':             'UNKNOWN',
        'btc_price':          None,
        'atr_14':             None,
        'atr_pct':            None,
        'atr_ok':             None,
        'fng_value':          None,
        'fng_classification': None,
        'fng_ok':             None,
        'reason':             None,
    }

    # ── 1. Load BTC OHLCV ──────────────────────────────────────────────────
    if not os.path.exists(OHLCV_PATH):
        result['reason'] = 'ohlcv_file_missing'
        _err(f'OHLCV file not found: {OHLCV_PATH}')
        _abort(result)

    with open(OHLCV_PATH, encoding='utf-8') as fh:
        candles = json.load(fh)

    if not isinstance(candles, list) or len(candles) < ATR_PERIOD + 1:
        result.update({'reason': 'ohlcv_insufficient_data', 'candle_count': len(candles)})
        _err(f'Need ≥{ATR_PERIOD + 1} candles, got {len(candles)}')
        _abort(result)

    latest         = candles[-1]
    btc_price      = float(latest['close'])
    result['btc_price'] = round(btc_price, 2)

    # ── 2. ATR(14) volatility check ────────────────────────────────────────
    window = candles[-ATR_WINDOW:]   # last 50 candles → stable ATR estimate
    try:
        atr     = calc_atr(window, period=ATR_PERIOD)
        atr_pct = atr / btc_price
    except Exception as exc:
        result['reason'] = f'atr_calc_error: {exc}'
        _err(str(exc))
        _abort(result)

    result['atr_14']  = round(atr, 2)
    result['atr_pct'] = round(atr_pct * 100, 3)
    result['atr_ok']  = atr_pct >= ATR_MIN_PCT

    if not result['atr_ok']:
        result['reason'] = (
            f'atr_too_low: {result["atr_pct"]}% < {ATR_MIN_PCT * 100}%'
        )
        _abort(result)

    # ── 3. Fear & Greed check ──────────────────────────────────────────────
    fng = fetch_fng()
    fng_blocks = False

    if fng is None:
        # API unreachable → log warning, do NOT block trading on missing data
        result['fng_ok'] = None
        _err('fng_api_unavailable: skipping F&G gate, continuing as GREEN')
    else:
        result['fng_value']          = fng['value']
        result['fng_classification'] = fng['classification']
        result['fng_ok']             = FNG_LOW <= fng['value'] <= FNG_HIGH
        fng_blocks                   = not result['fng_ok']

        if fng['value'] < FNG_LOW:
            result['reason'] = f'fng_extreme_fear: {fng["value"]} < {FNG_LOW}'
        elif fng['value'] > FNG_HIGH:
            result['reason'] = f'fng_extreme_greed: {fng["value"]} > {FNG_HIGH}'

    if fng_blocks:
        _abort(result)

    # ── GREEN ──────────────────────────────────────────────────────────────
    if result['reason'] is None:
        result['reason'] = 'all_conditions_met'
    result['regime'] = 'GREEN'
    print(json.dumps(result))
    sys.exit(0)


if __name__ == '__main__':
    main()
