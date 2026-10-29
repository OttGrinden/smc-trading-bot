#!/usr/bin/env python3
"""
structural_tp.py -- SMC-basierter struktureller Take-Profit

Prinzip: TP eines LONGs = naechste Supply Zone (Swing High) ueber Entry
         TP eines SHORTs = naechste Demand Zone (Swing Low) unter Entry

Das ist das SMC-Prinzip: die naechste Long-Zone ist der Profit-Bereich meines SHORTs
und die naechste Short-Zone ist der Profit-Bereich meines LONGs.

Quellen fuer den strukturellen TP (Prioritaet: naeheste gueltige Ebene):
  1. Naechster Swing-Pivot (4H bevorzugt, dann Daily)
  2. 0.618-Fib-Extension des letzten BOS-Legs
  3. Naechste Liq-Wall in Fahrtrichtung

Bedingungen:
  - Mindest-R:R 1.5 (TP >= 1.5 * SL-Distanz)
  - TP maximal 35% vom Entry entfernt (Sanity-Cap)

Aufruf: python structural_tp.py --symbol BTC --side long --entry 80000 [--sl-pct 3.3]

stdout: eine JSON-Zeile
  success:  {"available": true, "tp_price_usd": 83450.0, "tp_pct": 4.31, "rr": 1.31, "source": "swing_high_4h"}
  kein Dat: {"available": false, "reason": "no_ohlcv_data"}
  kein Lv.: {"available": false, "reason": "no_structural_level_found"}

stderr: debug (nur fuer Diagnose)
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
from typing import Optional

# -- Portable Pfade -----------------------------------------------------------
_BASE     = pathlib.Path(__file__).resolve().parent.parent
CACHE_DIR = str(_BASE / 'trading' / 'cache')

# -- Konstanten ---------------------------------------------------------------
MIN_RR       = 1.5   # Mindest-R:R fuer strukturellen TP
MAX_TP_PCT   = 35.0  # absolutes Maximum fuer TP-Distanz in %
PIVOT_LEN_D  = 2     # Daily: 5-Bar-Fraktal
PIVOT_LEN_4H = 3     # 4H: 7-Bar-Fraktal


# -- Pivot-Erkennung (identisch mit level_entry.py) ---------------------------

def find_pivots(candles: list, pivot_len: int) -> tuple:
    n = len(candles)
    highs, lows = [], []
    offsets = [d for d in range(-pivot_len, pivot_len + 1) if d != 0]
    for i in range(pivot_len, n - pivot_len):
        h = candles[i]['high']
        l = candles[i]['low']
        if all(h > candles[i + d]['high'] for d in offsets):
            highs.append((i, h))
        if all(l < candles[i + d]['low'] for d in offsets):
            lows.append((i, l))
    return highs, lows


def find_bos_for_direction(candles: list, highs: list, lows: list,
                            direction: str) -> Optional[dict]:
    n = len(candles)
    if direction == 'long':
        for ph_idx, ph_price in reversed(highs):
            for j in range(ph_idx + 1, n):
                if candles[j]['close'] > ph_price:
                    return {'direction': 'long', 'h1_idx': ph_idx,
                            'h1_price': ph_price, 'bos_idx': j}
    else:
        for pl_idx, pl_price in reversed(lows):
            for j in range(pl_idx + 1, n):
                if candles[j]['close'] < pl_price:
                    return {'direction': 'short', 'h1_idx': pl_idx,
                            'h1_price': pl_price, 'bos_idx': j}
    return None


def find_idm_price(candles: list, bos: dict,
                   highs: list, lows: list) -> float:
    h1_idx    = bos['h1_idx']
    bos_idx   = bos['bos_idx']
    direction = bos['direction']
    if direction == 'long':
        between = [(i, p) for i, p in lows if h1_idx < i < bos_idx]
        if between:
            return max(between, key=lambda x: x[0])[1]
        before = [(i, p) for i, p in lows if i <= h1_idx]
        if before:
            return max(before, key=lambda x: x[0])[1]
        return min(candles[:h1_idx + 1], key=lambda c: c['low'])['low']
    else:
        between = [(i, p) for i, p in highs if h1_idx < i < bos_idx]
        if between:
            return max(between, key=lambda x: x[0])[1]
        before = [(i, p) for i, p in highs if i <= h1_idx]
        if before:
            return max(before, key=lambda x: x[0])[1]
        return max(candles[:h1_idx + 1], key=lambda c: c['high'])['high']


# -- OHLCV laden --------------------------------------------------------------

def load_ohlcv(fname: str, min_candles: int = 10) -> Optional[list]:
    fpath = os.path.join(CACHE_DIR, fname)
    if not os.path.exists(fpath):
        return None
    try:
        with open(fpath, encoding='utf-8') as fh:
            candles = json.load(fh)
        if isinstance(candles, list) and len(candles) >= min_candles:
            return candles
    except Exception:
        pass
    return None


# -- Liq-Heatmap laden --------------------------------------------------------

def load_liq(symbol: str) -> Optional[dict]:
    fpath = os.path.join(CACHE_DIR, 'liq_heatmap.json')
    if not os.path.exists(fpath):
        return None
    try:
        with open(fpath, encoding='utf-8') as fh:
            d = json.load(fh)
        return d.get(symbol.upper())
    except Exception:
        return None


# -- Kern-Logik: strukturellen TP berechnen -----------------------------------

def calc_structural_tp(
    candles_daily: Optional[list],
    candles_4h:    Optional[list],
    entry_price:   float,
    direction:     str,
    liq_sym:       Optional[dict],
    sl_pct:        float = 3.3,
) -> dict:
    """
    Gibt den naechsten strukturellen TP-Level zurueck.

    Kandidaten (alle werden gesammelt, dann wird der naeheste gueltige gewaehlt):
      1. Swing-Pivot  (4H bevorzugt, dann Daily)
      2. 0.618-Fib-Extension des letzten BOS-Legs
      3. Naechste Liq-Wall in Fahrtrichtung

    Bedingungen:
      - TP muss mindestens 1.5 * SL-Distanz vom Entry entfernt sein (min R:R)
      - TP darf hoechstens MAX_TP_PCT % vom Entry entfernt sein
    """

    min_move  = entry_price * (sl_pct / 100) * MIN_RR
    max_move  = entry_price * (MAX_TP_PCT / 100)
    candidates: list[tuple[float, str]] = []

    # 1. Swing-Pivots (4H bevorzugt, dann Daily)
    for candles, tf, pl in [
        (candles_4h,    '4H',    PIVOT_LEN_4H),
        (candles_daily, 'daily', PIVOT_LEN_D),
    ]:
        if not candles:
            continue
        highs, lows = find_pivots(candles, pl)

        if direction == 'long':
            # Naechster Swing-HIGH ueber Entry = Supply Zone
            above = [(p, f'swing_high_{tf}')
                     for _, p in highs
                     if p > entry_price + min_move
                     and p < entry_price + max_move]
            if above:
                candidates.append(min(above, key=lambda x: x[0]))
        else:
            # Naechster Swing-LOW unter Entry = Demand Zone
            below = [(p, f'swing_low_{tf}')
                     for _, p in lows
                     if p < entry_price - min_move
                     and p > entry_price - max_move]
            if below:
                candidates.append(max(below, key=lambda x: x[0]))

    # 2. 0.618-Fib-Extension des letzten BOS-Legs
    for candles, tf, pl in [
        (candles_4h,    '4H',    PIVOT_LEN_4H),
        (candles_daily, 'daily', PIVOT_LEN_D),
    ]:
        if not candles:
            continue
        highs, lows = find_pivots(candles, pl)
        bos = find_bos_for_direction(candles, highs, lows, direction)
        if bos is None:
            continue
        idm = find_idm_price(candles, bos, highs, lows)
        h1  = bos['h1_price']
        leg = abs(h1 - idm)
        if leg < entry_price * 0.005:
            continue  # zu klein, ignorieren

        if direction == 'long':
            ext = h1 + 0.618 * leg
            if entry_price + min_move < ext < entry_price + max_move:
                candidates.append((ext, f'fib_618_ext_{tf}'))
        else:
            ext = h1 - 0.618 * leg
            if entry_price - max_move < ext < entry_price - min_move:
                candidates.append((ext, f'fib_618_ext_{tf}'))

    # 3. Liq-Wall in Fahrtrichtung
    if liq_sym:
        if direction == 'long':
            walls = liq_sym.get('sell_walls', [])
            above = [(w['price'], 'liq_sell_wall')
                     for w in walls
                     if w.get('price', 0) > entry_price + min_move
                     and w.get('price', 0) < entry_price + max_move]
            if above:
                candidates.append(min(above, key=lambda x: x[0]))
        else:
            walls = liq_sym.get('buy_walls', [])
            below = [(w['price'], 'liq_buy_wall')
                     for w in walls
                     if 0 < w.get('price', 0) < entry_price - min_move
                     and w.get('price', 0) > entry_price - max_move]
            if below:
                candidates.append(max(below, key=lambda x: x[0]))

    if not candidates:
        return {'available': False, 'reason': 'no_structural_level_found'}

    # Naehesten gueltigen Kandidaten waehlen
    if direction == 'long':
        # Naeher am Entry = konservativer TP — nimm kleinsten Wert
        tp_price, source = min(candidates, key=lambda x: x[0])
    else:
        # Naeher am Entry = konservativer TP — nimm groessten Wert
        tp_price, source = max(candidates, key=lambda x: x[0])

    tp_pct = abs(tp_price - entry_price) / entry_price * 100
    rr     = tp_pct / sl_pct if sl_pct > 0 else 0

    return {
        'available':    True,
        'tp_price_usd': round(tp_price, 6),
        'tp_pct':       round(tp_pct, 2),
        'rr':           round(rr, 2),
        'source':       source,
    }


def calc_structural_tp2(
    candles_daily: Optional[list],
    candles_4h:    Optional[list],
    tp1_price:     float,
    entry_price:   float,
    direction:     str,
    liq_sym:       Optional[dict],
    sl_pct:        float = 3.3,
) -> dict:
    """
    Gibt den naechsten strukturellen TP2-Level zurueck — der naechste strukturelle
    Level JENSEITS von TP1.

    Identische Logik wie calc_structural_tp, aber mit tp1_price als neuem
    'Entry Floor/Ceiling': Kandidaten muessen jenseits von TP1 liegen.

    Fallback: tp2_available=False wenn kein Level gefunden.
    """
    # Mindestbewegung jenseits TP1: mindestens 1.5x SL-Distanz vom Entry
    # (wiederverwendet fuer Sanity) + muss jenseits TP1 liegen
    min_move  = entry_price * (sl_pct / 100) * MIN_RR
    max_move  = entry_price * (MAX_TP_PCT / 100)
    candidates: list[tuple[float, str]] = []

    # 1. Swing-Pivots jenseits TP1 (Daily bevorzugt, dann 4H fuer weiteren Level)
    for candles, tf, pl in [
        (candles_daily, 'daily', PIVOT_LEN_D),
        (candles_4h,    '4H',    PIVOT_LEN_4H),
    ]:
        if not candles:
            continue
        highs, lows = find_pivots(candles, pl)

        if direction == 'long':
            # Naechster Swing-HIGH ueber TP1 (aber innerhalb MAX_TP_PCT vom Entry)
            above = [(p, f'swing_high_{tf}')
                     for _, p in highs
                     if p > tp1_price
                     and p < entry_price + max_move]
            if above:
                candidates.append(min(above, key=lambda x: x[0]))
        else:
            # Naechster Swing-LOW unter TP1 (aber innerhalb MAX_TP_PCT vom Entry)
            below = [(p, f'swing_low_{tf}')
                     for _, p in lows
                     if p < tp1_price
                     and p > entry_price - max_move]
            if below:
                candidates.append(max(below, key=lambda x: x[0]))

    # 2. 0.618-Fib-Extension — jenseits TP1
    for candles, tf, pl in [
        (candles_daily, 'daily', PIVOT_LEN_D),
        (candles_4h,    '4H',    PIVOT_LEN_4H),
    ]:
        if not candles:
            continue
        highs, lows = find_pivots(candles, pl)
        bos = find_bos_for_direction(candles, highs, lows, direction)
        if bos is None:
            continue
        idm = find_idm_price(candles, bos, highs, lows)
        h1  = bos['h1_price']
        leg = abs(h1 - idm)
        if leg < entry_price * 0.005:
            continue

        if direction == 'long':
            ext = h1 + 0.618 * leg
            if tp1_price < ext < entry_price + max_move:
                candidates.append((ext, f'fib_618_ext_{tf}'))
        else:
            ext = h1 - 0.618 * leg
            if entry_price - max_move < ext < tp1_price:
                candidates.append((ext, f'fib_618_ext_{tf}'))

    # 3. Liq-Wall jenseits TP1
    if liq_sym:
        if direction == 'long':
            walls = liq_sym.get('sell_walls', [])
            above = [(w['price'], 'liq_sell_wall')
                     for w in walls
                     if w.get('price', 0) > tp1_price
                     and w.get('price', 0) < entry_price + max_move]
            if above:
                candidates.append(min(above, key=lambda x: x[0]))
        else:
            walls = liq_sym.get('buy_walls', [])
            below = [(w['price'], 'liq_buy_wall')
                     for w in walls
                     if 0 < w.get('price', 0) < tp1_price
                     and w.get('price', 0) > entry_price - max_move]
            if below:
                candidates.append(max(below, key=lambda x: x[0]))

    if not candidates:
        return {'tp2_available': False, 'tp2_price_usd': None,
                'tp2_pct': None, 'tp2_rr': None, 'tp2_source': None}

    # Naehesten Kandidaten jenseits TP1 waehlen
    if direction == 'long':
        tp2_price, tp2_source = min(candidates, key=lambda x: x[0])
    else:
        tp2_price, tp2_source = max(candidates, key=lambda x: x[0])

    tp2_pct = abs(tp2_price - entry_price) / entry_price * 100
    tp2_rr  = tp2_pct / sl_pct if sl_pct > 0 else 0

    return {
        'tp2_available':    True,
        'tp2_price_usd':    round(tp2_price, 6),
        'tp2_pct':          round(tp2_pct, 2),
        'tp2_rr':           round(tp2_rr, 2),
        'tp2_source':       tp2_source,
    }


# -- Main ---------------------------------------------------------------------

def parse_args(argv: list) -> dict:
    args: dict = {}
    i = 0
    while i < len(argv):
        if argv[i].startswith('--'):
            key = argv[i][2:].replace('-', '_')
            if i + 1 < len(argv) and not argv[i + 1].startswith('--'):
                args[key] = argv[i + 1]
                i += 2
            else:
                args[key] = True
                i += 1
        else:
            i += 1
    return args


def main() -> None:
    args      = parse_args(sys.argv[1:])
    symbol    = str(args.get('symbol', '')).upper()
    side      = str(args.get('side', '')).lower()
    sl_pct    = float(args.get('sl_pct', 3.3))

    try:
        entry_price = float(args.get('entry', 0))
    except (ValueError, TypeError):
        entry_price = 0.0

    if not symbol or side not in ('long', 'short') or entry_price <= 0:
        print(json.dumps({'available': False, 'reason': 'invalid_args'}))
        sys.exit(0)

    # OHLCV laden
    candles_daily = load_ohlcv(f'ohlcv_daily_{symbol}.json', min_candles=20)
    candles_4h    = load_ohlcv(f'ohlcv_4h_{symbol}.json',    min_candles=20)

    if candles_daily is None and candles_4h is None:
        print(json.dumps({'available': False, 'reason': 'no_ohlcv_data',
                          'symbol': symbol}))
        sys.exit(0)

    liq_sym = load_liq(symbol)

    result = calc_structural_tp(
        candles_daily=candles_daily,
        candles_4h=candles_4h,
        entry_price=entry_price,
        direction=side,
        liq_sym=liq_sym,
        sl_pct=sl_pct,
    )
    result['symbol'] = symbol
    result['side']   = side

    # TP2: only attempt when TP1 was found
    if result.get('available'):
        tp2 = calc_structural_tp2(
            candles_daily=candles_daily,
            candles_4h=candles_4h,
            tp1_price=result['tp_price_usd'],
            entry_price=entry_price,
            direction=side,
            liq_sym=liq_sym,
            sl_pct=sl_pct,
        )
        result.update(tp2)
    else:
        result.update({
            'tp2_available': False,
            'tp2_price_usd': None,
            'tp2_pct':       None,
            'tp2_rr':        None,
            'tp2_source':    None,
        })

    print(json.dumps(result))
    sys.exit(0)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'available': False, 'reason': f'crash: {exc}'}))
    sys.exit(0)
