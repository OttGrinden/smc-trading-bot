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
                        direction: str) -> tuple:
    """Check 4H candles after BOS timestamp for intraday IDM sweep."""
    post_bos = [c for c in candles_4h
                if isinstance(c.get('timestamp'), (int, float))
                and c['timestamp'] > bos_timestamp]
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
            price_4h   = candles_4h[-1]['close'] if candles_4h else None
            out        = detect_setup(candles, symbol, price_4h)

            # 4H intraday IDM sweep — only for Score-8 (IDM not yet swept on daily)
            if out['score'] == 8 and candles_4h and out.get('bos_timestamp'):
                swept_4h, intact_4h = check_idm_sweep_4h(
                    candles_4h, out['bos_timestamp'],
                    out['idm_level'], out['origin_level'], out['side'],
                )
                if swept_4h and intact_4h:
                    out['idm_swept'] = True
                    out['score']     = 9
                    out['reason']    = 'Score 9 (4H): IDM swept on 4H candle + origin intact'
                    if out['ote_low'] is not None and price_4h is not None:
                        if out['ote_low'] <= price_4h <= out['ote_high']:
                            out['score']  = 10
                            out['reason'] = 'Score 10 (4H): IDM swept on 4H + in OTE'

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
