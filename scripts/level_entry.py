#!/usr/bin/env python3
"""
level_entry.py -- 882/LSOB + Inducement Limit-Order Pfad

Timeframe-Hierarchie (fix):
  Daily + 4H : Strukturbias (HH/HL=LONG, LH/LL=SHORT) + EMA200-Alignment Daily
  4H / 1H    : Entry-Level-Anker -- 882-Fib des gueltigen BOS-Legs (4H bevorzugt)
               + Entry-IDM-Erkennung (1H-Swing nahe 882-Level)
  15m        : Bestaetigung -- LSOB-Sweep (Wick nimmt Level, Close kehrt zurueck)

Bedingungen pro Symbol:
  1. Daily bias = 4H bias (beide muessen aligniert sein)
  2. EMA200 auf Daily ausgerichtet zur Richtung
  3. 882-Fib-Level auf 4H berechnet (Fallback: 1H)
  4. Liq-Cluster <= 0.5 ATR hinter Entry-Level (Pflicht)
  5. Preis < 0.5 ATR vom Level entfernt
  6. Entry-IDM (1H-Swing nahe 882): wenn gefunden -> Sweep Pflicht vor Signal
     Kein IDM nahe Level -> Signal feuert ohne IDM-Gate (Backward-compat)
  7. 15m LSOB-Sweep bestaetigt (Wick jenseits Level, Close kehrt zurueck)
  8. Kein HTF-Strukturbruch (4H/Daily Close verletzt letztes HL/LH)

IDM-State: `idm_pending` -- IDM nahe Level gefunden, Sweep noch ausstehend.
  Wird ueber Runs hinweg persistiert. Sobald Sweep eintrifft -> Signal.

Guards: Max 1 Order/Symbol+Seite - Max 2 Level-Positionen gesamt

stdout: NDJSON -- je Signal eine Zeile mit action="open_level_order"
        Signal enthaelt: idm_price, idm_dist_atr, idm_validated
stderr: Debug-Zeilen + level_entry_summary
Exit:   immer 0 (fail-soft)
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
from datetime import datetime, timezone
from typing import Optional

# -- Pfade (portabel via __file__) ---------------------------------------------
_BASE          = pathlib.Path(__file__).resolve().parent.parent
CACHE_DIR      = str(_BASE / 'trading' / 'cache')
PORTFOLIO_DIR  = str(_BASE / 'trading' / 'execution' / 'portfolio')
AUDIT_DIR      = str(_BASE / 'trading' / 'execution' / 'audit')
SMC_SYMBOLS    = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'TAO']
STATE_PATH     = os.path.join(CACHE_DIR, 'level_entry_state.json')

FIB_882             = 0.882
APPROACH_ATR_FACTOR = 0.5   # Preis innerhalb 0.5 ATR vom Level
LIQ_ATR_FACTOR      = 0.5   # Liq-Cluster innerhalb 0.5 ATR hinter Level
SWEEP_LOOKBACK_15M  = 4     # letzte 4 x 15m = 1h Fenster fuer LSOB-Check
MAX_LEVEL_POSITIONS = 2     # gesamt aktive Level-Positionen
LIQ_MAX_AGE_MIN     = 20
PIVOT_LEN_D         = 2     # Daily: 5-Bar-Fraktal
PIVOT_LEN_HTF       = 3     # 4H/1H: 7-Bar-Fraktal
EMA_PERIOD          = 200

# IDM-spezifische Konstanten
IDM_ZONE_ATR_FACTOR    = 1.0  # IDM muss innerhalb 1.0 ATR des 882-Levels liegen
IDM_LOOKBACK_1H        = 24   # max. 24 x 1H-Bars zurueck fuer Entry-IDM-Suche
IDM_SWEEP_LOOKBACK_15M = 8    # letzte 8 x 15m = 2h fuer IDM-Sweep-Check


# -- Pivot-Erkennung -----------------------------------------------------------

def find_pivots(candles: list, pivot_len: int = 2) -> tuple:
    n       = len(candles)
    highs: list = []
    lows:  list = []
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
    """Neuester BOS in der gegebenen Richtung."""
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


def find_idm_price(candles: list, bos: dict, highs: list, lows: list) -> float:
    """IDM-Preis -- letzter gegensaetzlicher Pivot zwischen H1 und BOS."""
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
        window = candles[:h1_idx + 1]
        return min(window, key=lambda c: c['low'])['low']
    else:
        between = [(i, p) for i, p in highs if h1_idx < i < bos_idx]
        if between:
            return max(between, key=lambda x: x[0])[1]
        before = [(i, p) for i, p in highs if i <= h1_idx]
        if before:
            return max(before, key=lambda x: x[0])[1]
        window = candles[:h1_idx + 1]
        return max(window, key=lambda c: c['high'])['high']


# -- EMA & ATR -----------------------------------------------------------------

def calc_ema(closes: list, period: int = EMA_PERIOD) -> Optional[float]:
    if len(closes) < period:
        return None
    k   = 2.0 / (period + 1)
    ema = sum(closes[:period]) / period
    for c in closes[period:]:
        ema = c * k + ema * (1.0 - k)
    return ema


def calc_atr(candles: list, period: int = 14) -> float:
    trs = []
    for i in range(1, len(candles)):
        h  = candles[i]['high']
        l  = candles[i]['low']
        pc = candles[i - 1]['close']
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if not trs:
        return candles[-1]['close'] * 0.02
    return sum(trs[-period:]) / min(period, len(trs))


# -- Strukturbias (HH/HL oder LH/LL) ------------------------------------------

def detect_bias(candles: list, pivot_len: int = PIVOT_LEN_D) -> Optional[str]:
    highs, lows = find_pivots(candles, pivot_len)
    if len(highs) < 2 or len(lows) < 2:
        return None
    if highs[-1][1] > highs[-2][1] and lows[-1][1] > lows[-2][1]:
        return 'long'
    if highs[-1][1] < highs[-2][1] and lows[-1][1] < lows[-2][1]:
        return 'short'
    return None


# -- 882-Fib-Level des gueltigen BOS-Legs --------------------------------------

def calc_882_level(candles: list, direction: str,
                   pivot_len: int = PIVOT_LEN_HTF) -> Optional[dict]:
    highs, lows = find_pivots(candles, pivot_len)
    bos = find_bos_for_direction(candles, highs, lows, direction)
    if bos is None:
        return None
    idm = find_idm_price(candles, bos, highs, lows)
    h1  = bos['h1_price']
    if direction == 'long':
        if h1 <= idm:
            return None
        fib = round(h1 - FIB_882 * (h1 - idm), 6)
    else:
        if idm <= h1:
            return None
        fib = round(h1 + FIB_882 * (idm - h1), 6)
    return {'fib_882': fib, 'h1': h1, 'idm': idm}


# -- Entry-IDM: 1H-Swing nahe 882-Level ----------------------------------------

def find_entry_idm(candles_1h: list, fib_882: float, direction: str,
                   atr: float, pivot_len: int = 2) -> Optional[dict]:
    """
    Sucht den juengsten 1H-Inducement nahe dem 882-Entry-Level.

    Fuer LONG:  Swing-Low  innerhalb [fib_882 - zone, fib_882 + zone*0.25]
    Fuer SHORT: Swing-High innerhalb [fib_882 - zone*0.25, fib_882 + zone]

    Wenn gefunden und nicht gesweept -> idm_pending (Entry wartet).
    Wenn gefunden und gesweept       -> idm_validated=True (Entry feuert).
    Kein IDM gefunden                -> kein Gate (bestehende Logik greift).
    """
    if not candles_1h:
        return None
    highs, lows  = find_pivots(candles_1h, pivot_len)
    zone         = IDM_ZONE_ATR_FACTOR * atr
    recent_start = max(0, len(candles_1h) - IDM_LOOKBACK_1H)

    if direction == 'long':
        candidates = [
            (i, p) for i, p in lows
            if i >= recent_start
            and (fib_882 - zone) <= p <= (fib_882 + zone * 0.25)
        ]
    else:
        candidates = [
            (i, p) for i, p in highs
            if i >= recent_start
            and (fib_882 - zone * 0.25) <= p <= (fib_882 + zone)
        ]

    if not candidates:
        return None

    idx, price = max(candidates, key=lambda x: x[0])
    return {
        'price':    round(price, 6),
        'idx':      idx,
        'dist':     round(abs(price - fib_882), 6),
        'dist_atr': round(abs(price - fib_882) / atr, 3) if atr > 0 else None,
    }


def check_entry_idm_swept(candles_1h: list, candles_15m: Optional[list],
                           idm: dict, direction: str) -> bool:
    """
    Prueft ob der Entry-IDM gesweept wurde.
    1H post-IDM-Candles + letzte IDM_SWEEP_LOOKBACK_15M 15m-Candles.
    """
    idm_price = idm['price']
    idm_idx   = idm['idx']

    post_idm = candles_1h[idm_idx + 1:]
    if direction == 'long':
        if any(c['low'] < idm_price for c in post_idm):
            return True
    else:
        if any(c['high'] > idm_price for c in post_idm):
            return True

    if candles_15m:
        recent_15m = candles_15m[-IDM_SWEEP_LOOKBACK_15M:]
        if direction == 'long':
            if any(c['low'] < idm_price for c in recent_15m):
                return True
        else:
            if any(c['high'] > idm_price for c in recent_15m):
                return True

    return False


# -- Liq-Cluster-Check ---------------------------------------------------------

def find_liq_cluster(liq_sym: Optional[dict], fib_882: float,
                     direction: str, atr: float) -> Optional[dict]:
    if not liq_sym:
        return None
    half_atr = LIQ_ATR_FACTOR * atr
    if direction == 'long':
        for w in liq_sym.get('buy_walls', []):
            p = w.get('price', 0)
            if (fib_882 - half_atr) <= p <= fib_882:
                return {'price': p, 'notional_usd': w.get('notional_usd', 0),
                        'dist_atr': round(abs(fib_882 - p) / atr, 3)}
    else:
        for w in liq_sym.get('sell_walls', []):
            p = w.get('price', 0)
            if fib_882 <= p <= (fib_882 + half_atr):
                return {'price': p, 'notional_usd': w.get('notional_usd', 0),
                        'dist_atr': round(abs(p - fib_882) / atr, 3)}
    return None


# -- TP-Berechnung -------------------------------------------------------------

def calc_level_tp(liq_sym: Optional[dict], fib_882: float,
                  h1: float, idm: float, direction: str) -> float:
    leg = abs(h1 - idm)
    if direction == 'long':
        ext_tp     = round(h1 + 0.618 * leg, 6)
        sell_walls = [w for w in (liq_sym or {}).get('sell_walls', [])
                      if w.get('price', 0) > fib_882]
        if sell_walls:
            nearest = min(sell_walls, key=lambda w: w['price'])
            if nearest['price'] < ext_tp:
                return round(nearest['price'], 6)
        return ext_tp
    else:
        ext_tp    = round(h1 - 0.618 * leg, 6)
        buy_walls = [w for w in (liq_sym or {}).get('buy_walls', [])
                     if w.get('price', 0) < fib_882]
        if buy_walls:
            nearest = max(buy_walls, key=lambda w: w['price'])
            if nearest['price'] > ext_tp:
                return round(nearest['price'], 6)
        return ext_tp


# -- SL-Berechnung -------------------------------------------------------------

def calc_level_sl(candles_15m: list, fib_882: float,
                  direction: str, atr: float) -> float:
    recent = candles_15m[-SWEEP_LOOKBACK_15M:]
    if direction == 'long':
        sweep_lows = [c['low'] for c in recent if c['low'] < fib_882]
        extreme    = min(sweep_lows) if sweep_lows else fib_882
        return round(extreme - 0.1 * atr, 6)
    else:
        sweep_highs = [c['high'] for c in recent if c['high'] > fib_882]
        extreme     = max(sweep_highs) if sweep_highs else fib_882
        return round(extreme + 0.1 * atr, 6)


# -- 15m LSOB-Sweep-Bestaetigung -----------------------------------------------

def check_lsob_sweep(candles_15m: list, fib_882: float, direction: str) -> bool:
    for c in candles_15m[-SWEEP_LOOKBACK_15M:]:
        if direction == 'long'  and c['low']  < fib_882 < c['close']:
            return True
        if direction == 'short' and c['high'] > fib_882 > c['close']:
            return True
    return False


# -- HTF-Invalidierungs-Check --------------------------------------------------

def is_htf_invalidated(candles_daily: list, candles_4h: list,
                        direction: str) -> bool:
    for candles in (candles_4h, candles_daily):
        highs, lows = find_pivots(candles, PIVOT_LEN_D)
        cur = candles[-1]['close']
        if direction == 'long'  and lows  and cur < lows[-1][1]:
            return True
        if direction == 'short' and highs and cur > highs[-1][1]:
            return True
    return False


# -- State-Datei ---------------------------------------------------------------

def load_state() -> list:
    if not os.path.exists(STATE_PATH):
        return []
    try:
        with open(STATE_PATH, encoding='utf-8') as fh:
            d = json.load(fh)
        return d if isinstance(d, list) else []
    except Exception:
        return []


def save_state(state: list) -> None:
    with open(STATE_PATH, 'w', encoding='utf-8') as fh:
        json.dump(state, fh, indent=2)


# -- Portfolio: aktive Level-Positionen zaehlen --------------------------------

def count_level_positions() -> int:
    try:
        p = os.path.join(PORTFOLIO_DIR, 'portfolio_state.json')
        with open(p, encoding='utf-8') as fh:
            state = json.load(fh)
        return sum(1 for pos in state.get('positions', [])
                   if str(pos.get('reason', '')).startswith('LEVEL_882'))
    except Exception:
        return 0


# -- Audit-Log -----------------------------------------------------------------

def audit(event: dict) -> None:
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    path  = os.path.join(AUDIT_DIR, f'audit_{today}.jsonl')
    try:
        os.makedirs(AUDIT_DIR, exist_ok=True)
        with open(path, 'a', encoding='utf-8') as fh:
            fh.write(json.dumps({**event,
                                  'ts': datetime.now(timezone.utc).isoformat()}) + '\n')
    except Exception:
        pass


# -- OHLCV laden ---------------------------------------------------------------

def load_ohlcv(fname: str, min_candles: int = 10) -> Optional[list]:
    path = os.path.join(CACHE_DIR, fname)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding='utf-8') as fh:
            candles = json.load(fh)
        if isinstance(candles, list) and len(candles) >= min_candles:
            return candles
    except Exception:
        pass
    return None


# -- Main ----------------------------------------------------------------------

def main() -> None:
    # 1. Liq-Heatmap Freshness-Gate (fail-safe)
    liq_path = os.path.join(CACHE_DIR, 'liq_heatmap.json')
    if not os.path.exists(liq_path):
        print(json.dumps({'info': 'level_entry_skip', 'reason': 'liq_missing'}),
              file=sys.stderr)
        sys.exit(0)
    try:
        with open(liq_path, encoding='utf-8') as fh:
            liq_data = json.load(fh)
    except Exception:
        sys.exit(0)

    btc_updated = liq_data.get('BTC', {}).get('updated_at', '')
    if btc_updated:
        try:
            age_min = (datetime.now(timezone.utc) -
                       datetime.fromisoformat(btc_updated.replace('Z', '+00:00'))
                       ).total_seconds() / 60
            if age_min > LIQ_MAX_AGE_MIN:
                print(json.dumps({'info': 'level_entry_skip',
                                  'reason': f'liq_stale_{age_min:.0f}min'}),
                      file=sys.stderr)
                sys.exit(0)
        except Exception:
            pass

    # 2. State + offene Level-Positionen
    state            = load_state()
    open_positions   = count_level_positions()
    signals_this_run = 0
    new_state: list  = []
    state_changes    = 0

    for symbol in SMC_SYMBOLS:
        candles_d   = load_ohlcv(f'ohlcv_daily_{symbol}.json', min_candles=EMA_PERIOD)
        candles_4h  = load_ohlcv(f'ohlcv_4h_{symbol}.json',    min_candles=20)
        candles_1h  = load_ohlcv(f'ohlcv_1h_{symbol}.json',    min_candles=20)
        candles_15m = load_ohlcv(f'ohlcv_15m_{symbol}.json',   min_candles=SWEEP_LOOKBACK_15M)

        if not candles_d or not candles_4h:
            print(json.dumps({'debug': f'{symbol}: daily/4H fehlt'}), file=sys.stderr)
            continue

        # 3. Daily Bias + EMA200
        bias_d = detect_bias(candles_d, PIVOT_LEN_D)
        if bias_d is None:
            print(json.dumps({'debug': f'{symbol}: daily bias ambiguous'}), file=sys.stderr)
            continue

        ema200    = calc_ema([c['close'] for c in candles_d], EMA_PERIOD)
        if ema200 is None:
            continue
        cur_daily = candles_d[-1]['close']
        if not ((bias_d == 'long'  and cur_daily > ema200) or
                (bias_d == 'short' and cur_daily < ema200)):
            print(json.dumps({'debug': f'{symbol}: EMA200 nicht aligned fuer {bias_d}'}),
                  file=sys.stderr)
            continue

        # 4. 4H Bias muss Daily entsprechen
        bias_4h = detect_bias(candles_4h, PIVOT_LEN_HTF)
        if bias_4h != bias_d:
            print(json.dumps({'debug': f'{symbol}: 4H={bias_4h} != Daily={bias_d}'}),
                  file=sys.stderr)
            continue

        direction = bias_d

        # 5. 882-Fib-Level -- 4H bevorzugt, Fallback 1H
        level_info = calc_882_level(candles_4h, direction, PIVOT_LEN_HTF)
        tf_label   = '4H'
        if level_info is None and candles_1h:
            level_info = calc_882_level(candles_1h, direction, PIVOT_LEN_HTF)
            tf_label   = '1H'
        if level_info is None:
            print(json.dumps({'debug': f'{symbol}: kein 882-Level auf 4H/1H'}),
                  file=sys.stderr)
            continue

        fib_882   = level_info['fib_882']
        h1        = level_info['h1']
        idm_htf   = level_info['idm']
        atr_daily = calc_atr(candles_d[-20:], 14)

        cur_price = (candles_15m[-1]['close'] if candles_15m
                     else candles_4h[-1]['close'])

        # 6. Bestehende State-Eintraege validieren / invalidieren
        for s in state:
            if s['symbol'] != symbol:
                new_state.append(s)
                continue
            if s.get('status') not in ('watching', 'idm_pending'):
                new_state.append(s)
                continue
            if is_htf_invalidated(candles_d, candles_4h, s['side']):
                s['status'] = 'invalid'
                state_changes += 1
                audit({'warn': 'level_order_invalidated', 'symbol': symbol,
                       'side': s['side'], 'fib_882': s.get('fib_882')})
                print(json.dumps({'warn': 'level_order_invalidated',
                                   'symbol': symbol, 'side': s['side']}),
                      file=sys.stderr)
            else:
                new_state.append(s)
        state = [s for s in state if s['symbol'] != symbol]

        # 7. Kein Duplikat; bei idm_pending: pruefen ob IDM inzwischen gesweept
        existing = next(
            (s for s in new_state
             if s['symbol'] == symbol and s['side'] == direction
             and s.get('status') in ('watching', 'idm_pending')),
            None
        )
        if existing:
            if existing.get('status') == 'idm_pending' and candles_1h:
                stored_idm = {
                    'price': existing['idm_price'],
                    'idx':   existing.get('idm_idx', 0),
                }
                if check_entry_idm_swept(candles_1h, candles_15m, stored_idm, direction):
                    existing['status']    = 'watching'
                    existing['idm_swept'] = True
                    state_changes += 1
                    print(json.dumps({'info': 'idm_swept_upgraded',
                                       'symbol': symbol, 'side': direction,
                                       'idm_price': stored_idm['price']}),
                          file=sys.stderr)
            continue

        # 8. Liq-Cluster-Pflicht
        liq_sym = liq_data.get(symbol.upper())
        cluster = find_liq_cluster(liq_sym, fib_882, direction, atr_daily)
        if cluster is None:
            audit({'info': 'level_entry_no_liq_fuel', 'symbol': symbol,
                   'direction': direction, 'fib_882': fib_882})
            print(json.dumps({'info': 'level_entry_no_liq_fuel',
                               'symbol': symbol, 'direction': direction}),
                  file=sys.stderr)
            continue

        # 9. Preis-Naehe (< 0.5 ATR vom Level)
        if abs(cur_price - fib_882) >= APPROACH_ATR_FACTOR * atr_daily:
            print(json.dumps({'debug': f'{symbol}: nicht nah genug -- '
                                        f'cur={cur_price:.4f} fib={fib_882:.4f} '
                                        f'dist={abs(cur_price-fib_882):.4f} '
                                        f'0.5atr={0.5*atr_daily:.4f}'}),
                  file=sys.stderr)
            continue

        # 10. Entry-IDM: 1H-Swing nahe 882-Level suchen und Sweep-Status pruefen
        entry_idm     = find_entry_idm(candles_1h, fib_882, direction, atr_daily) if candles_1h else None
        idm_validated = False

        if entry_idm is not None:
            idm_swept = check_entry_idm_swept(candles_1h, candles_15m, entry_idm, direction)
            if not idm_swept:
                # IDM gefunden, noch nicht gesweept -- in State speichern, warten
                print(json.dumps({'info': 'idm_pending',
                                   'symbol': symbol, 'side': direction,
                                   'idm_price': entry_idm['price'],
                                   'idm_dist_atr': entry_idm['dist_atr'],
                                   'note': 'IDM near 882 not yet swept -- watching'}),
                      file=sys.stderr)
                audit({'info': 'idm_pending', 'symbol': symbol, 'side': direction,
                       'fib_882': fib_882, 'idm_price': entry_idm['price']})
                new_state.append({
                    'symbol':      symbol,
                    'side':        direction,
                    'timeframe':   tf_label,
                    'fib_882':     fib_882,
                    'status':      'idm_pending',
                    'idm_price':   entry_idm['price'],
                    'idm_idx':     entry_idm['idx'],
                    'idm_dist_atr': entry_idm['dist_atr'],
                    'placed_ts':   datetime.now(timezone.utc).isoformat(),
                })
                state_changes += 1
                continue
            else:
                idm_validated = True
        # Kein IDM nahe Level -> kein Gate, Signal kann feuern

        # 11. 15m LSOB-Sweep-Bestaetigung
        if not candles_15m:
            print(json.dumps({'debug': f'{symbol}: keine 15m-Daten'}), file=sys.stderr)
            continue
        if not check_lsob_sweep(candles_15m, fib_882, direction):
            print(json.dumps({'debug': f'{symbol}: 15m-Sweep noch nicht bestaetigt'}),
                  file=sys.stderr)
            continue

        # 12. Max-Positionen-Guard
        if open_positions + signals_this_run >= MAX_LEVEL_POSITIONS:
            print(json.dumps({'info': 'level_entry_max_positions', 'symbol': symbol,
                               'active': open_positions + signals_this_run}),
                  file=sys.stderr)
            continue

        # 13. SL / TP berechnen und Signal ausgeben
        sl = calc_level_sl(candles_15m, fib_882, direction, atr_daily)
        tp = calc_level_tp(liq_sym, fib_882, h1, idm_htf, direction)

        idm_label  = '_IDM' if idm_validated else ''
        reason_str = f'LEVEL_882_LSOB{idm_label}_{direction.upper()}_{tf_label}'

        signal = {
            'action':        'open_level_order',
            'symbol':        symbol,
            'side':          direction,
            'fib_882':       fib_882,
            'sl_price':      sl,
            'tp_price':      tp,
            'atr_daily':     round(atr_daily, 6),
            'timeframe':     tf_label,
            'liq_cluster':   cluster,
            'idm_price':     entry_idm['price'] if entry_idm else None,
            'idm_dist_atr':  entry_idm['dist_atr'] if entry_idm else None,
            'idm_validated': idm_validated,
            'reason':        reason_str,
            'score':         8,
        }
        print(json.dumps(signal))
        sys.stdout.flush()

        audit({'info': 'level_order_placed', 'symbol': symbol, 'side': direction,
               'timeframe': tf_label, 'fib_882': fib_882,
               'sl_price': sl, 'tp_price': tp,
               'atr_daily': round(atr_daily, 6),
               'liq_cluster_dist_atr': cluster.get('dist_atr'),
               'idm_validated': idm_validated,
               'idm_price': entry_idm['price'] if entry_idm else None,
               'reason': reason_str})

        new_state.append({
            'symbol':        symbol,
            'side':          direction,
            'timeframe':     tf_label,
            'fib_882':       fib_882,
            'sl_price':      sl,
            'tp_price':      tp,
            'status':        'watching',
            'idm_validated': idm_validated,
            'idm_price':     entry_idm['price'] if entry_idm else None,
            'placed_ts':     datetime.now(timezone.utc).isoformat(),
        })
        signals_this_run += 1
        state_changes    += 1

    # Noch nicht verarbeitete State-Eintraege anderer Symbole uebernehmen
    handled_symbols = set(SMC_SYMBOLS)
    for s in state:
        if s['symbol'] not in handled_symbols:
            new_state.append(s)

    save_state([s for s in new_state if s.get('status') != 'invalid'])

    print(json.dumps({'info': 'level_entry_summary',
                      'signals': signals_this_run,
                      'state_changes': state_changes}),
          file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': 'level_entry_crash', 'detail': str(exc)}),
              file=sys.stderr)
    sys.exit(0)
