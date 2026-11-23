#!/usr/bin/env python3
"""
backtest_smc.py — Sliding-window backtest for SMC detectors

Fetches historical OHLCV from Binance public API (no auth needed):
  Daily: 300 bars  (~10 months)
  4H:   1000 bars  (~5.5 months)
  1H:   1000 bars  (~42 days)

Detectors:
  sweep_reversal_4h  — sweeps daily pivot lows, 4H candle detection
  sweep_reversal_1h  — sweeps 4H pivot lows, 1H candle detection
  combined           — 4H pending + 1H confirmation (enter at 1H signal bar)

Usage:
  python scripts/backtest_smc.py                                 # BTC 4H run
  python scripts/backtest_smc.py --symbol ETH --tp-rr 2.5
  python scripts/backtest_smc.py --all-symbols
  python scripts/backtest_smc.py --mode 1h                       # 1H standalone
  python scripts/backtest_smc.py --mode combined                 # 4H+1H confluence
  python scripts/backtest_smc.py --param-sweep                   # full grid search
  python scripts/backtest_smc.py --param-sweep --all-symbols
"""

from __future__ import annotations

import argparse
import bisect
import json
import sys
import urllib.request
from datetime import datetime, timezone
from typing import Optional

# ── Import detector functions from smc_detector.py ───────────────────────────
import pathlib, importlib.util
_HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('smc_detector', _HERE / 'smc_detector.py')
_mod  = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

find_pivots                    = _mod.find_pivots
detect_sweep_reversal_4h       = _mod.detect_sweep_reversal_4h
detect_sweep_reversal_4h_short = _mod.detect_sweep_reversal_4h_short
detect_sweep_reversal_1h       = _mod.detect_sweep_reversal_1h
calc_ema                       = _mod.calc_ema
EMA_PERIOD                     = _mod.EMA_PERIOD

# ── Constants ─────────────────────────────────────────────────────────────────
BINANCE_KLINES = 'https://api.binance.com/api/v3/klines'
ALL_SYMBOLS    = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP']
DEFAULT_SYMBOL = 'BTC'
DAILY_LIMIT    = 300    # ~10 months
H4_LIMIT       = 1000   # ~5.5 months
H1_LIMIT       = 1000   # ~42 days
M15_LIMIT      = 5000   # ~52 days (paginated, 5×1000)
M1_LIMIT       = 130_000  # ~90 days of 1m data (paginated, 130×1000)
WARMUP_DAILY   = 210    # 200 for EMA200 + 10 for pivots
WARMUP_H4      = 60     # bars before first 4H sweep check
WARMUP_H1      = 50     # bars before first 1H sweep check
WARMUP_15M     = 200    # bars before first 15m sweep check
WARMUP_1M      = 1000   # ~16.7h before first 1m check

# ── Parameter sweep grid ──────────────────────────────────────────────────────
PARAM_PIN_BAR   = [0.50, 0.55, 0.60, 0.65, 0.70]
PARAM_TP_RR     = [1.5,  2.0,  2.5,  3.0]
PARAM_MAX_BARS  = [24,   48,   72]
# Confluence filter: require next 4H candle after sweep to also close bullish
# (proxy for heatmap buy-pressure confirmation — buyers follow through)
PARAM_CONFLUENCE = [False, True]

# ── Fetch from Binance ────────────────────────────────────────────────────────

_cache: dict = {}   # {symbol+interval: candles}  — reuse across runs

def fetch_binance_paginated(symbol: str, interval: str, total: int) -> list:
    """Fetch up to `total` bars in chunks of 1000, going backwards in time."""
    key = f'{symbol}_{interval}_paged'
    if key in _cache:
        return _cache[key]
    pair     = symbol.upper() + 'USDT'
    per_page = 1000
    all_raw: list = []
    end_time: Optional[int] = None
    while len(all_raw) < total:
        url = f'{BINANCE_KLINES}?symbol={pair}&interval={interval}&limit={per_page}'
        if end_time is not None:
            url += f'&endTime={end_time}'
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                page = json.loads(r.read())
        except Exception as e:
            print(f'[fetch_error] {symbol} {interval} paged: {e}', file=sys.stderr)
            break
        if not page:
            break
        all_raw = page + all_raw
        end_time = int(page[0][0]) - 1
        if len(page) < per_page:
            break
    candles = [
        {'timestamp': int(row[0]), 'open': float(row[1]), 'high': float(row[2]),
         'low': float(row[3]), 'close': float(row[4]), 'volume': float(row[5])}
        for row in all_raw
    ]
    candles.sort(key=lambda c: c['timestamp'])
    _cache[key] = candles
    return candles


def fetch_binance(symbol: str, interval: str, limit: int) -> list:
    key = f'{symbol}_{interval}'
    if key in _cache:
        return _cache[key]
    pair = symbol.upper() + 'USDT'
    url  = f'{BINANCE_KLINES}?symbol={pair}&interval={interval}&limit={limit}'
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            raw = json.loads(r.read())
    except Exception as e:
        print(f'[fetch_error] {symbol} {interval}: {e}', file=sys.stderr)
        return []
    candles = [
        {'timestamp': row[0], 'open': float(row[1]), 'high': float(row[2]),
         'low': float(row[3]), 'close': float(row[4]), 'volume': float(row[5])}
        for row in raw
    ]
    _cache[key] = candles
    return candles


# ── Exit simulation ───────────────────────────────────────────────────────────

def simulate_exit(candles: list, entry_bar: int, entry: float,
                  sl: float, tp: float, max_bars: int) -> dict:
    """Scan forward; SL wins when both hit on same bar (conservative)."""
    n = len(candles)
    for i in range(entry_bar, min(entry_bar + max_bars, n)):
        c = candles[i]
        sl_hit = c['low']  <= sl
        tp_hit = c['high'] >= tp
        if sl_hit or tp_hit:
            result     = 'sl' if sl_hit else 'tp'
            exit_price = sl if sl_hit else tp
            return {'result': result, 'bars_held': i - entry_bar,
                    'pnl_pct': round((exit_price - entry) / entry * 100, 3)}
    close = candles[min(entry_bar + max_bars - 1, n - 1)]['close']
    return {'result': 'timeout', 'bars_held': max_bars,
            'pnl_pct': round((close - entry) / entry * 100, 3)}


# ── Core sweep backtest ───────────────────────────────────────────────────────

def run_sweep_backtest(
    symbol: str, candles_daily: list, candles_4h: list,
    pin_bar_threshold: float, tp_rr: float, max_bars: int,
    require_confluence: bool = False,
) -> list:
    """
    Sliding-window sweep_reversal_4h backtest.

    pin_bar_threshold  : G1 close_pos cutoff (0.50–0.70)
    tp_rr              : take-profit as multiple of SL distance
    max_bars           : max 4H bars to hold before timeout exit
    require_confluence : True → next candle after sweep must also close bullish
                         (proxy for heatmap buy-pressure confirmation)
    """
    # Temporarily patch the module constant for this run
    _mod.SWEEP_G1_PIN_BAR_THRESHOLD = pin_bar_threshold

    trades         = []
    last_entry_bar = -99

    for j in range(WARMUP_H4, len(candles_4h) - 1):
        if j - last_entry_bar < 12:  # cooldown: no re-entry within same sweep window
            continue

        ts_4h       = candles_4h[j]['timestamp']
        daily_slice = [c for c in candles_daily if c['timestamp'] <= ts_4h]
        if len(daily_slice) < WARMUP_DAILY:
            continue

        _, piv_lows = find_pivots(daily_slice)
        if not piv_lows:
            continue

        h4_slice = candles_4h[:j + 1]
        ema200   = calc_ema([c['close'] for c in daily_slice])

        sig = detect_sweep_reversal_4h(h4_slice, piv_lows, ema200, symbol)
        if sig is None or sig['score'] < 7:
            continue

        # Confluence filter: bar j+1 must close bullish → enter at open of j+2 (no lookahead).
        # In live system: scan sees sweep at bar j, waits 4H for j+1 to close, enters j+2 open.
        if require_confluence:
            confirm_bar = j + 1
            if confirm_bar >= len(candles_4h):
                continue
            if candles_4h[confirm_bar]['close'] <= candles_4h[confirm_bar]['open']:
                continue
            entry_bar = j + 2
        else:
            entry_bar = j + 1

        if entry_bar >= len(candles_4h):
            continue

        entry_price = candles_4h[entry_bar]['open']
        sl_dist     = entry_price - sig['sl_level']
        if sl_dist <= 0:
            continue
        tp = entry_price + sl_dist * tp_rr

        outcome = simulate_exit(candles_4h, entry_bar, entry_price,
                                sig['sl_level'], tp, max_bars)
        trades.append({
            'symbol':       symbol,
            'score':        sig['score'],
            'signal_ts':    datetime.fromtimestamp(ts_4h / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M'),
            'entry_price':  round(entry_price, 4),
            'sl':           round(sig['sl_level'], 4),
            'tp':           round(tp, 4),
            'sweep_level':  sig['sweep_level'],
            'g1_pin':       sig.get('g1_bos_4h', False),
            'g2_ema':       sig.get('g2_ema50_4h', False),
            **outcome,
        })
        last_entry_bar = entry_bar

    return trades


def simulate_exit_short(candles: list, entry_bar: int, entry: float,
                        sl: float, tp: float, max_bars: int) -> dict:
    """Short exit simulation. SL=price rises to sl, TP=price falls to tp."""
    n = len(candles)
    for i in range(entry_bar, min(entry_bar + max_bars, n)):
        c = candles[i]
        sl_hit = c['high'] >= sl   # price goes up = loss for short
        tp_hit = c['low']  <= tp   # price goes down = win for short
        if sl_hit or tp_hit:
            result     = 'sl' if sl_hit else 'tp'
            exit_price = sl if sl_hit else tp
            return {'result': result, 'bars_held': i - entry_bar,
                    'pnl_pct': round((entry - exit_price) / entry * 100, 3)}
    close = candles[min(entry_bar + max_bars - 1, n - 1)]['close']
    return {'result': 'timeout', 'bars_held': max_bars,
            'pnl_pct': round((entry - close) / entry * 100, 3)}


def run_sweep_backtest_short(
    symbol: str, candles_daily: list, candles_4h: list,
    pin_bar_threshold: float, tp_rr: float, max_bars: int,
    require_confluence: bool = False,
) -> list:
    """
    Sliding-window backtest for sweep_reversal_4h_short (bearish mirror).

    Sweeps daily pivot HIGHS on 4H candles → SHORT entry.
    Confluence: require next 4H bar after sweep to close BEARISH before entry.
    Entry at open of bar j+1 (or j+2 with confluence) after sweep candle j.
    SL = 0.2% above sweep wick high; TP via tp_rr × SL distance below entry.
    """
    _mod.SWEEP_G1_PIN_BAR_THRESHOLD = pin_bar_threshold

    trades         = []
    last_entry_bar = -99

    for j in range(WARMUP_H4, len(candles_4h) - 1):
        if j - last_entry_bar < 12:
            continue

        ts_4h       = candles_4h[j]['timestamp']
        daily_slice = [c for c in candles_daily if c['timestamp'] <= ts_4h]
        if len(daily_slice) < WARMUP_DAILY:
            continue

        piv_highs, _ = find_pivots(daily_slice)
        if not piv_highs:
            continue

        h4_slice = candles_4h[:j + 1]
        ema200   = calc_ema([c['close'] for c in daily_slice])

        sig = detect_sweep_reversal_4h_short(h4_slice, piv_highs, ema200, symbol)
        if sig is None or sig['score'] < 7:
            continue

        # Confluence: next 4H bar must close BEARISH → enter at j+2
        if require_confluence:
            confirm_bar = j + 1
            if confirm_bar >= len(candles_4h):
                continue
            if candles_4h[confirm_bar]['close'] >= candles_4h[confirm_bar]['open']:
                continue
            entry_bar = j + 2
        else:
            entry_bar = j + 1

        if entry_bar >= len(candles_4h):
            continue

        entry_price = candles_4h[entry_bar]['open']
        sl_level    = sig['sl_level']       # 0.2% above sweep wick high
        sl_dist     = sl_level - entry_price
        if sl_dist <= 0:
            continue
        tp = entry_price - sl_dist * tp_rr  # target below entry

        outcome = simulate_exit_short(candles_4h, entry_bar, entry_price,
                                      sl_level, tp, max_bars)
        trades.append({
            'symbol':      symbol,
            'score':       sig['score'],
            'signal_ts':   datetime.fromtimestamp(ts_4h / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M'),
            'entry_price': round(entry_price, 4),
            'sl':          round(sl_level, 4),
            'tp':          round(tp, 4),
            'sweep_level': sig['sweep_level'],
            'g1_pin':      sig.get('g1_bos_4h', False),
            'g2_ema':      sig.get('g2_ema50_4h', False),
            **outcome,
        })
        last_entry_bar = entry_bar

    return trades


def run_param_sweep_short(symbols: list) -> None:
    """Grid search for SHORT sweep detector parameters."""
    print('\nFetching data for all symbols…')
    data = {}
    for sym in symbols:
        d = fetch_binance(sym, '1d', DAILY_LIMIT)
        h = fetch_binance(sym, '4h', H4_LIMIT)
        if len(d) >= WARMUP_DAILY + 10 and len(h) >= WARMUP_H4 + 10:
            data[sym] = (d, h)
            print(f'  {sym}: {len(d)}d / {len(h)}h bars')

    results = []
    total   = len(PARAM_PIN_BAR) * len(PARAM_TP_RR) * len(PARAM_MAX_BARS) * len(PARAM_CONFLUENCE)
    done    = 0

    print(f'\nRunning {total} parameter combinations (SHORT)…')

    for pin in PARAM_PIN_BAR:
        for rr in PARAM_TP_RR:
            for mb in PARAM_MAX_BARS:
                for conf in PARAM_CONFLUENCE:
                    all_trades = []
                    for sym, (daily, h4) in data.items():
                        t = run_sweep_backtest_short(sym, daily, h4, pin, rr, mb, conf)
                        all_trades.extend(t)
                    s = trade_stats(all_trades)
                    results.append({
                        'pin_bar': pin, 'tp_rr': rr, 'max_bars': mb, 'confluence': conf,
                        **s,
                    })
                    done += 1
                    if done % 20 == 0:
                        print(f'  {done}/{total}…')

    results.sort(key=lambda r: r['avg_pnl'], reverse=True)

    print(f'\n{"="*72}')
    print(' PARAMETER SWEEP RESULTS (SHORT) — sorted by avg PnL per trade')
    print(f'{"="*72}')
    print(f'  {"pin":>5}  {"rr":>5}  {"hold":>5}  {"conf":>5}  {"n":>5}  {"WR%":>6}  {"avgPnL":>8}  {"expect":>8}')
    print(f'  {"-"*5}  {"-"*5}  {"-"*5}  {"-"*5}  {"-"*5}  {"-"*6}  {"-"*8}  {"-"*8}')

    for r in results[:20]:
        c = 'Y' if r['confluence'] else 'N'
        marker = '  <-- BEST' if r == results[0] else ''
        print(
            f'  {r["pin_bar"]:.2f}  {r["tp_rr"]:.1f}x  {r["max_bars"]:>3}b'
            f'  {c:>5}  {r["n"]:>5}  {r["wr"]:>5.1f}%  {r["avg_pnl"]:>+7.3f}%'
            f'  {r["expectancy"]:>+7.1f}%{marker}'
        )

    best = results[0]
    print(f'\n  Best config: pin_bar={best["pin_bar"]}  tp_rr={best["tp_rr"]}  '
          f'max_bars={best["max_bars"]}  confluence={best["confluence"]}')
    print(f'  Trades={best["n"]}  WR={best["wr"]}%  avgPnL={best["avg_pnl"]:+.3f}%  '
          f'expectancy={best["expectancy"]:+.1f}%')


def run_1h_backtest(
    symbol: str, candles_daily: list, candles_4h: list, candles_1h: list,
    pin_bar_threshold: float, tp_rr: float, max_bars: int,
) -> list:
    """
    Standalone 1H sweep backtest.
    Reference levels: 4H Williams-fractal lows (find_pivots on 4H slice).
    Entry: open of bar j+1 after sweep candle j.
    """
    _mod.SWEEP_G1_PIN_BAR_THRESHOLD = pin_bar_threshold
    trades         = []
    last_entry_bar = -99

    for j in range(WARMUP_H1, len(candles_1h) - 1):
        if j - last_entry_bar < 24:
            continue

        ts_1h       = candles_1h[j]['timestamp']
        h4_slice    = [c for c in candles_4h if c['timestamp'] <= ts_1h]
        daily_slice = [c for c in candles_daily if c['timestamp'] <= ts_1h]
        if len(h4_slice) < 20 or len(daily_slice) < WARMUP_DAILY:
            continue

        _, h4_pivot_lows = find_pivots(h4_slice)
        if not h4_pivot_lows:
            continue

        ema200 = calc_ema([c['close'] for c in daily_slice])
        h1_slice = candles_1h[:j + 1]

        sig = detect_sweep_reversal_1h(h1_slice, h4_pivot_lows, ema200, symbol)
        if sig is None or sig['score'] < 7:
            continue

        entry_bar   = j + 1
        if entry_bar >= len(candles_1h):
            continue

        entry_price = candles_1h[entry_bar]['open']
        sl_dist     = entry_price - sig['sl_level']
        if sl_dist <= 0:
            continue
        tp = entry_price + sl_dist * tp_rr

        outcome = simulate_exit(candles_1h, entry_bar, entry_price,
                                sig['sl_level'], tp, max_bars)
        trades.append({
            'symbol':      symbol,
            'score':       sig['score'],
            'signal_ts':   datetime.fromtimestamp(ts_1h / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M'),
            'entry_price': round(entry_price, 4),
            'sl':          round(sig['sl_level'], 4),
            'tp':          round(tp, 4),
            'sweep_level': sig['sweep_level'],
            'g1_pin':      sig.get('g1_bos_1h', False),
            'g2_ema':      sig.get('g2_ema50_1h', False),
            **outcome,
        })
        last_entry_bar = entry_bar

    return trades


def run_combined_backtest(
    symbol: str, candles_daily: list, candles_4h: list, candles_1h: list,
    pin_bar_threshold: float, tp_rr: float, max_bars_1h: int,
    min_sl_dist: float = 0.0, max_sl_dist: float = 999.0,
    bear_filter: bool = False, score_min: int = 0,
) -> list:
    """
    Combined 4H+1H confluence backtest.

    Flow: 4H sweep fires (pending) → scan 1H for a sweep of a 4H pivot low
    in the same direction → entry at the 1H signal bar's next-bar open.
    This mirrors the live system's confirmation mechanism.
    """
    _mod.SWEEP_G1_PIN_BAR_THRESHOLD = pin_bar_threshold
    trades        = []
    pending_4h_ts: dict = {}   # {symbol: {'ts': int, 'sl': float, 'level': float}}
    last_entry_bar = -99

    # Sort 1H bars chronologically and step through them
    for j in range(WARMUP_H1, len(candles_1h) - 1):
        if j - last_entry_bar < 24:
            continue

        ts_1h       = candles_1h[j]['timestamp']
        h4_slice    = [c for c in candles_4h if c['timestamp'] <= ts_1h]
        daily_slice = [c for c in candles_daily if c['timestamp'] <= ts_1h]
        if len(h4_slice) < 20 or len(daily_slice) < WARMUP_DAILY:
            continue

        _, daily_piv_lows = find_pivots(daily_slice)
        _, h4_piv_lows    = find_pivots(h4_slice)
        ema200            = calc_ema([c['close'] for c in daily_slice])

        # Update 4H pending state
        sig_4h = detect_sweep_reversal_4h(h4_slice, daily_piv_lows, ema200, symbol)
        if sig_4h is not None and sig_4h['score'] >= 8:
            # Store/refresh pending 4H sweep
            pending_4h_ts[symbol] = {
                'ts':    h4_slice[-1]['timestamp'],
                'sl':    sig_4h['sl_level'],
                'level': sig_4h['sweep_level'],
                'score': sig_4h['score'],
            }
        elif symbol in pending_4h_ts:
            # Expire pending if older than 48 1H bars (2 days)
            age_bars = sum(1 for c in candles_1h if c['timestamp'] > pending_4h_ts[symbol]['ts'] and c['timestamp'] <= ts_1h)
            if age_bars > 48:
                del pending_4h_ts[symbol]

        # Check 1H sweep only when 4H is pending
        if symbol not in pending_4h_ts:
            continue

        h1_slice = candles_1h[:j + 1]
        sig_1h   = detect_sweep_reversal_1h(h1_slice, h4_piv_lows, ema200, symbol)
        if sig_1h is None or sig_1h['score'] < 7:
            continue

        # Confirmed: enter at next 1H bar open
        entry_bar   = j + 1
        if entry_bar >= len(candles_1h):
            continue

        entry_price = candles_1h[entry_bar]['open']
        sl_level    = pending_4h_ts[symbol]['sl']   # use 4H SL (wider, safer)
        sl_dist     = entry_price - sl_level
        sl_dist_pct = sl_dist / entry_price * 100
        if sl_dist <= 0 or sl_dist_pct < min_sl_dist or sl_dist_pct > max_sl_dist:
            continue
        if bear_filter and entry_price < ema200:
            continue
        if score_min > 0 and pending_4h_ts[symbol]['score'] < score_min:
            continue
        tp = entry_price + sl_dist * tp_rr

        outcome = simulate_exit(candles_1h, entry_bar, entry_price,
                                sl_level, tp, max_bars_1h)
        trades.append({
            'symbol':      symbol,
            'score':       pending_4h_ts[symbol]['score'],
            'signal_ts':   datetime.fromtimestamp(ts_1h / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M'),
            'entry_price': round(entry_price, 4),
            'sl':          round(sl_level, 4),
            'tp':          round(tp, 4),
            'sweep_level': pending_4h_ts[symbol]['level'],
            'mode':        'combined_4h_1h',
            **outcome,
        })
        del pending_4h_ts[symbol]   # clear pending after entry
        last_entry_bar = entry_bar

    return trades


def run_combined_backtest_15m(
    symbol: str, candles_daily: list, candles_4h: list, candles_15m: list,
    pin_bar_threshold: float, tp_rr: float, max_bars_15m: int,
    min_sl_dist: float = 0.0, max_sl_dist: float = 999.0,
    bear_filter: bool = False, score_min: int = 0,
) -> list:
    """
    Combined 4H+15m confluence backtest.

    Flow: 4H sweep fires (pending) → scan 15m for first bullish close after the
    4H signal → entry at next 15m bar open.
    Comparable to run_combined_backtest() but uses 15m as the entry trigger
    instead of 1H — faster entry, potentially better price vs. more noise.
    """
    _mod.SWEEP_G1_PIN_BAR_THRESHOLD = pin_bar_threshold
    trades          = []
    pending_4h_ts: dict = {}
    last_entry_bar  = -99
    last_h4_end     = -1
    cached_ema200   = 50_000.0  # sane fallback before first daily computation

    # Pre-sorted timestamp lists for O(log n) slice-boundary lookups
    h4_ts_list    = [c['timestamp'] for c in candles_4h]
    daily_ts_list = [c['timestamp'] for c in candles_daily]

    for j in range(WARMUP_15M, len(candles_15m) - 1):
        if j - last_entry_bar < 96:   # min 96 15m bars (~24h) between entries
            continue

        ts_15m  = candles_15m[j]['timestamp']
        h4_end  = bisect.bisect_right(h4_ts_list, ts_15m)
        d_end   = bisect.bisect_right(daily_ts_list, ts_15m)

        if h4_end < 20 or d_end < WARMUP_DAILY:
            continue

        # Recompute 4H detect only when a new 4H bar has appeared (every ~16 15m bars).
        # EMA200 and pivot computation stay O(n_daily) but fire 16× less often.
        if h4_end != last_h4_end:
            last_h4_end   = h4_end
            h4_slice      = candles_4h[:h4_end]
            daily_slice   = candles_daily[:d_end]
            _, daily_piv_lows = find_pivots(daily_slice)
            cached_ema200     = calc_ema([c['close'] for c in daily_slice])

            sig_4h = detect_sweep_reversal_4h(h4_slice, daily_piv_lows, cached_ema200, symbol)
            if sig_4h is not None and sig_4h['score'] >= 8:
                pending_4h_ts[symbol] = {
                    'ts':    h4_slice[-1]['timestamp'],
                    'sl':    sig_4h['sl_level'],
                    'level': sig_4h['sweep_level'],
                    'score': sig_4h['score'],
                }
            elif symbol in pending_4h_ts:
                # O(1) expiry: 192 15m bars × 900 s × 1000 ms = 172 800 000 ms
                if ts_15m - pending_4h_ts[symbol]['ts'] > 172_800_000:
                    del pending_4h_ts[symbol]

        if symbol not in pending_4h_ts:
            continue

        # First 15m bullish close after pending 4H signal timestamp
        if candles_15m[j]['timestamp'] <= pending_4h_ts[symbol]['ts']:
            continue
        if candles_15m[j]['close'] <= candles_15m[j]['open']:
            continue

        # Confirmed: enter at next 15m bar open
        entry_bar   = j + 1
        if entry_bar >= len(candles_15m):
            continue

        entry_price = candles_15m[entry_bar]['open']
        sl_level    = pending_4h_ts[symbol]['sl']
        sl_dist     = entry_price - sl_level
        sl_dist_pct = sl_dist / entry_price * 100
        if sl_dist <= 0 or sl_dist_pct < min_sl_dist or sl_dist_pct > max_sl_dist:
            continue
        if bear_filter and entry_price < cached_ema200:
            continue
        if score_min > 0 and pending_4h_ts[symbol]['score'] < score_min:
            continue
        tp = entry_price + sl_dist * tp_rr

        outcome = simulate_exit(candles_15m, entry_bar, entry_price, sl_level, tp, max_bars_15m)
        trades.append({
            'symbol':      symbol,
            'score':       pending_4h_ts[symbol]['score'],
            'signal_ts':   datetime.fromtimestamp(ts_15m / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M'),
            'entry_price': round(entry_price, 4),
            'sl':          round(sl_level, 4),
            'tp':          round(tp, 4),
            'sweep_level': pending_4h_ts[symbol]['level'],
            'mode':        'combined_4h_15m',
            **outcome,
        })
        del pending_4h_ts[symbol]
        last_entry_bar = entry_bar

    return trades


# ── OB-Retest Scalping (1m entries at 4H Order Block zone) ───────────────────

def run_ob_scalp_backtest(
    symbol: str, candles_daily: list, candles_4h: list, candles_1m: list,
    pin_bar_threshold: float, tp_fixed_pct: float, max_bars_1m: int,
    score_min: int = 9,
) -> list:
    """
    1m OB-retest scalping on 4H IDM signals.

    Flow:
      1. 4H IDM fires → record OB zone [sl_level .. sweep_level*1.01]
      2. Wait until 1m price retraces INTO the OB zone (from above)
      3. First 1m bullish close while in zone → enter at next 1m bar open
      4. TP = entry + tp_fixed_pct%  (fixed small target, e.g. 0.3%)
      5. SL = sl_level * 0.999  (just below OB bottom)
      6. max_bars_1m: timeout in 1m bars (e.g. 30 = 30min)

    Why higher WR than combined-15m:
      - Enters at confirmed institutional support (OB zone, not right after sweep)
      - Very close TP → almost always reached on even a small bounce
      - Skips signals where price never retests OB (goes straight up)
    """
    _mod.SWEEP_G1_PIN_BAR_THRESHOLD = pin_bar_threshold
    trades        = []
    pending_ob: dict = {}
    last_entry_bar  = -99
    last_h4_end     = -1
    cached_ema200   = 50_000.0

    h4_ts_list    = [c['timestamp'] for c in candles_4h]
    daily_ts_list = [c['timestamp'] for c in candles_daily]

    for j in range(WARMUP_1M, len(candles_1m) - 1):
        if j - last_entry_bar < 60:   # 60 1m bars = 1h min between entries
            continue

        ts_1m  = candles_1m[j]['timestamp']
        h4_end = bisect.bisect_right(h4_ts_list, ts_1m)
        d_end  = bisect.bisect_right(daily_ts_list, ts_1m)

        if h4_end < 20 or d_end < WARMUP_DAILY:
            continue

        # Recompute 4H detect only on new 4H bar (every ~240 1m bars)
        if h4_end != last_h4_end:
            last_h4_end   = h4_end
            h4_slice      = candles_4h[:h4_end]
            daily_slice   = candles_daily[:d_end]
            _, daily_piv_lows = find_pivots(daily_slice)
            cached_ema200     = calc_ema([c['close'] for c in daily_slice])

            sig_4h = detect_sweep_reversal_4h(h4_slice, daily_piv_lows, cached_ema200, symbol)
            if sig_4h is not None and sig_4h['score'] >= 8:
                sl    = sig_4h['sl_level']
                sweep = sig_4h['sweep_level']
                pending_ob[symbol] = {
                    'ts':      h4_slice[-1]['timestamp'],
                    'sl':      sl,
                    'level':   sweep,
                    'score':   sig_4h['score'],
                    'ob_top':  sweep * 1.012,   # 1.2% above swept pivot = OB entry zone top
                }
            elif symbol in pending_ob:
                # Expire pending after 72h (no retest → signal stale)
                if ts_1m - pending_ob[symbol]['ts'] > 259_200_000:
                    del pending_ob[symbol]

        if symbol not in pending_ob:
            continue

        ob = pending_ob[symbol]

        if score_min > 0 and ob['score'] < score_min:
            continue

        # Only check bars AFTER the signal fired
        if ts_1m <= ob['ts']:
            continue

        c1m   = candles_1m[j]
        price = c1m['close']

        # Price must be in OB zone (retrace into the institutional support area)
        if not (ob['sl'] <= price <= ob['ob_top']):
            continue

        # 1m bullish confirmation (close > open = rejection of lower prices)
        if c1m['close'] <= c1m['open']:
            continue

        # Optional quality filter: lower wick ≥ body (pin bar / hammer shape)
        body       = c1m['close'] - c1m['open']
        lower_wick = c1m['open'] - c1m['low']
        if body <= 0 or lower_wick < body * 0.5:   # loose pin bar requirement
            continue

        # Enter at next 1m bar open
        entry_bar   = j + 1
        if entry_bar >= len(candles_1m):
            continue

        entry_price = candles_1m[entry_bar]['open']
        sl_price    = ob['sl'] * 0.999             # tiny buffer below OB
        sl_dist     = entry_price - sl_price
        if sl_dist <= 0:
            continue

        sl_dist_pct = sl_dist / entry_price * 100
        # Skip if SL is wider than 3× the TP target (bad R/R)
        if sl_dist_pct > tp_fixed_pct * 3.0:
            continue

        tp = entry_price * (1 + tp_fixed_pct / 100)

        outcome = simulate_exit(candles_1m, entry_bar, entry_price, sl_price, tp, max_bars_1m)
        trades.append({
            'symbol':      symbol,
            'score':       ob['score'],
            'signal_ts':   datetime.fromtimestamp(ts_1m / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M'),
            'entry_price': round(entry_price, 6),
            'sl':          round(sl_price, 6),
            'tp':          round(tp, 6),
            'sl_dist_pct': round(sl_dist_pct, 3),
            'ob_zone':     [round(ob['sl'], 4), round(ob['ob_top'], 4)],
            'mode':        'ob_scalp_4h_1m',
            **outcome,
        })
        del pending_ob[symbol]
        last_entry_bar = entry_bar

    return trades


# ── Summary helpers ───────────────────────────────────────────────────────────

def derive_weekly(candles_daily: list) -> list:
    """Aggregate daily candles into weekly (Mon-Sun) OHLCV bars."""
    from datetime import timedelta
    weeks: dict = {}
    for c in candles_daily:
        dt  = datetime.fromtimestamp(c['timestamp'] / 1000, tz=timezone.utc)
        mon = dt - timedelta(days=dt.weekday())
        key = mon.strftime('%Y-%W')
        if key not in weeks:
            weeks[key] = {
                'timestamp': int(mon.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000),
                'open': c['open'], 'high': c['high'], 'low': c['low'],
                'close': c['close'], 'volume': c['volume'],
            }
        else:
            weeks[key]['high']    = max(weeks[key]['high'], c['high'])
            weeks[key]['low']     = min(weeks[key]['low'],  c['low'])
            weeks[key]['close']   = c['close']
            weeks[key]['volume'] += c['volume']
    return sorted(weeks.values(), key=lambda c: c['timestamp'])


def run_idm_stack_backtest(
    symbol: str, candles_daily: list, candles_4h: list, candles_1h: list,
    candles_15m: list, pin_bar_threshold: float, tp_rr: float, max_bars_15m: int,
    min_sl_dist: float = 0.0, max_sl_dist: float = 999.0,
    bear_filter: bool = False, score_min: int = 0,
) -> list:
    """
    Triple-confirmation IDM stack: 4H IDM → 1H IDM → 15m entry.

    Flow:
     1. 4H sweeps daily pivot (4H IDM pending)
     2. While 4H pending: 1H sweeps 4H pivot (1H IDM pending)
     3. While 1H pending: first 15m bullish close → entry
    """
    _mod.SWEEP_G1_PIN_BAR_THRESHOLD = pin_bar_threshold
    trades          = []
    pending_4h: dict = {}
    pending_1h: dict = {}
    last_entry_bar  = -99

    for j in range(WARMUP_15M, len(candles_15m) - 1):
        if j - last_entry_bar < 96:
            continue

        ts_15m      = candles_15m[j]['timestamp']
        h4_slice    = [c for c in candles_4h    if c['timestamp'] <= ts_15m]
        h1_slice    = [c for c in candles_1h    if c['timestamp'] <= ts_15m]
        daily_slice = [c for c in candles_daily if c['timestamp'] <= ts_15m]
        if len(h4_slice) < 20 or len(daily_slice) < WARMUP_DAILY or len(h1_slice) < WARMUP_H1:
            continue

        _, daily_piv_lows = find_pivots(daily_slice)
        _, h4_piv_lows    = find_pivots(h4_slice)
        ema200            = calc_ema([c['close'] for c in daily_slice])

        # Layer 1: Update 4H pending
        sig_4h = detect_sweep_reversal_4h(h4_slice, daily_piv_lows, ema200, symbol)
        if sig_4h is not None and sig_4h['score'] >= 8:
            pending_4h[symbol] = {
                'ts': h4_slice[-1]['timestamp'], 'sl': sig_4h['sl_level'],
                'level': sig_4h['sweep_level'],  'score': sig_4h['score'],
            }
        elif symbol in pending_4h:
            age = sum(1 for c in candles_15m
                      if pending_4h[symbol]['ts'] < c['timestamp'] <= ts_15m)
            if age > 192:
                del pending_4h[symbol]
                pending_1h.pop(symbol, None)

        if symbol not in pending_4h:
            continue

        # Layer 2: 1H IDM while 4H pending
        sig_1h = detect_sweep_reversal_1h(h1_slice, h4_piv_lows, ema200, symbol)
        if sig_1h is not None and sig_1h['score'] >= 7:
            ts_1h_sig = h1_slice[-1]['timestamp']
            if ts_1h_sig > pending_4h[symbol]['ts']:
                pending_1h[symbol] = {
                    'ts':    ts_1h_sig,
                    'sl':    pending_4h[symbol]['sl'],
                    'score': pending_4h[symbol]['score'],
                }
        elif symbol in pending_1h:
            age = sum(1 for c in candles_15m
                      if pending_1h[symbol]['ts'] < c['timestamp'] <= ts_15m)
            if age > 96:
                del pending_1h[symbol]

        if symbol not in pending_1h:
            continue
        if ts_15m <= pending_1h[symbol]['ts']:
            continue

        # Layer 3: First 15m bullish close
        if candles_15m[j]['close'] <= candles_15m[j]['open']:
            continue

        entry_bar   = j + 1
        if entry_bar >= len(candles_15m):
            continue

        entry_price = candles_15m[entry_bar]['open']
        sl_level    = pending_1h[symbol]['sl']
        sl_dist     = entry_price - sl_level
        sl_dist_pct = sl_dist / entry_price * 100
        if sl_dist <= 0 or sl_dist_pct < min_sl_dist or sl_dist_pct > max_sl_dist:
            continue
        if bear_filter and entry_price < ema200:
            continue
        if score_min > 0 and pending_1h[symbol]['score'] < score_min:
            continue
        tp = entry_price + sl_dist * tp_rr

        outcome = simulate_exit(candles_15m, entry_bar, entry_price, sl_level, tp, max_bars_15m)
        trades.append({
            'symbol':      symbol,
            'score':       pending_1h[symbol]['score'],
            'signal_ts':   datetime.fromtimestamp(ts_15m / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M'),
            'entry_price': round(entry_price, 4),
            'sl':          round(sl_level, 4),
            'tp':          round(tp, 4),
            'sweep_level': pending_4h[symbol]['level'],
            'mode':        'idm_stack_4h+1h+15m',
            **outcome,
        })
        del pending_4h[symbol]
        del pending_1h[symbol]
        last_entry_bar = entry_bar

    return trades


def run_idm_daily_backtest(
    symbol: str, candles_daily: list, candles_4h: list,
    pin_bar_threshold: float, tp_rr: float, max_bars_4h: int,
    min_sl_dist: float = 0.0, max_sl_dist: float = 999.0, score_min: int = 0,
) -> list:
    """
    Daily IDM → 4H entry: daily sweeps weekly pivot, enter at next 4H bar open.

    Uses detect_sweep_reversal_1h with daily/weekly data — same sweep-and-close-back
    pattern one TF higher. Signals are fewer but structurally stronger.
    """
    _mod.SWEEP_G1_PIN_BAR_THRESHOLD = pin_bar_threshold
    weekly          = derive_weekly(candles_daily)
    trades          = []
    last_entry_bar  = -99

    for j in range(WARMUP_H4, len(candles_4h) - 1):
        if j - last_entry_bar < 24:
            continue

        ts_4h        = candles_4h[j]['timestamp']
        daily_slice  = [c for c in candles_daily if c['timestamp'] <= ts_4h]
        weekly_slice = [c for c in weekly        if c['timestamp'] <= ts_4h]
        if len(daily_slice) < WARMUP_DAILY or len(weekly_slice) < 15:
            continue

        _, weekly_piv_lows = find_pivots(weekly_slice)
        if not weekly_piv_lows:
            continue
        ema200 = calc_ema([c['close'] for c in daily_slice])

        sig = detect_sweep_reversal_1h(daily_slice, weekly_piv_lows, ema200, symbol)
        if sig is None or sig['score'] < 7:
            continue

        entry_bar   = j + 1
        if entry_bar >= len(candles_4h):
            continue

        entry_price = candles_4h[entry_bar]['open']
        sl_level    = sig['sl_level']
        sl_dist     = entry_price - sl_level
        sl_dist_pct = sl_dist / entry_price * 100
        if sl_dist <= 0 or sl_dist_pct < min_sl_dist or sl_dist_pct > max_sl_dist:
            continue
        if score_min > 0 and sig['score'] < score_min:
            continue
        tp = entry_price + sl_dist * tp_rr

        outcome = simulate_exit(candles_4h, entry_bar, entry_price, sl_level, tp, max_bars_4h)
        trades.append({
            'symbol':      symbol,
            'score':       sig['score'],
            'signal_ts':   datetime.fromtimestamp(ts_4h / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M'),
            'entry_price': round(entry_price, 4),
            'sl':          round(sl_level, 4),
            'tp':          round(tp, 4),
            'sweep_level': sig['sweep_level'],
            'mode':        'idm_daily_4h_entry',
            **outcome,
        })
        last_entry_bar = entry_bar

    return trades


def trade_stats(trades: list) -> dict:
    if not trades:
        return {'n': 0, 'wr': 0.0, 'avg_pnl': 0.0, 'expectancy': 0.0}
    wins = sum(1 for t in trades if t['result'] == 'tp')
    wr   = wins / len(trades) * 100
    avg  = sum(t['pnl_pct'] for t in trades) / len(trades)
    return {'n': len(trades), 'wr': round(wr, 1), 'avg_pnl': round(avg, 3),
            'expectancy': round(avg * len(trades), 2)}


def print_summary(trades: list, label: str, bar_hours: float = 4.0) -> None:
    if not trades:
        print(f'\n{label}: 0 trades')
        return
    s = trade_stats(trades)
    wins     = sum(1 for t in trades if t['result'] == 'tp')
    losses   = sum(1 for t in trades if t['result'] == 'sl')
    timeouts = sum(1 for t in trades if t['result'] == 'timeout')
    avg_bars = sum(t['bars_held'] for t in trades) / len(trades)
    print(f'\n{"-"*62}')
    print(f' {label}')
    print(f'{"-"*62}')
    print(f'  Trades   : {s["n"]}  (TP:{wins}  SL:{losses}  Timeout:{timeouts})')
    print(f'  Win rate : {s["wr"]}%   (break-even at 2:1 = 33.3%)')
    print(f'  Avg PnL  : {s["avg_pnl"]:+.3f}% per trade')
    print(f'  Avg hold : {avg_bars:.1f} bars ({avg_bars * bar_hours / 24:.1f} days)')
    for sc in sorted(set(t['score'] for t in trades)):
        sub = [t for t in trades if t['score'] == sc]
        sw  = sum(1 for t in sub if t['result'] == 'tp')
        print(f'    Score {sc}: {len(sub)} trades  WR={sw/len(sub)*100:.0f}%  avg={sum(t["pnl_pct"] for t in sub)/len(sub):+.2f}%')
    print()
    print('  Last 8 trades:')
    for t in trades[-8:]:
        mk = 'TP' if t['result'] == 'tp' else ('SL' if t['result'] == 'sl' else '--')
        print(f'    {t["signal_ts"]}  entry={t["entry_price"]}  {mk}  {t["pnl_pct"]:+.2f}%  {t["bars_held"]}bars')


# ── Parameter sweep ───────────────────────────────────────────────────────────

def run_param_sweep(symbols: list) -> None:
    print('\nFetching data for all symbols…')
    data = {}
    for sym in symbols:
        d = fetch_binance(sym, '1d', DAILY_LIMIT)
        h = fetch_binance(sym, '4h', H4_LIMIT)
        if len(d) >= WARMUP_DAILY + 10 and len(h) >= WARMUP_H4 + 10:
            data[sym] = (d, h)
            print(f'  {sym}: {len(d)}d / {len(h)}h bars')

    results = []
    total   = len(PARAM_PIN_BAR) * len(PARAM_TP_RR) * len(PARAM_MAX_BARS) * len(PARAM_CONFLUENCE)
    done    = 0

    print(f'\nRunning {total} parameter combinations…')

    for pin in PARAM_PIN_BAR:
        for rr in PARAM_TP_RR:
            for mb in PARAM_MAX_BARS:
                for conf in PARAM_CONFLUENCE:
                    all_trades = []
                    for sym, (daily, h4) in data.items():
                        t = run_sweep_backtest(sym, daily, h4, pin, rr, mb, conf)
                        all_trades.extend(t)
                    s = trade_stats(all_trades)
                    results.append({
                        'pin_bar': pin, 'tp_rr': rr, 'max_bars': mb, 'confluence': conf,
                        **s,
                    })
                    done += 1
                    if done % 20 == 0:
                        print(f'  {done}/{total}…')

    # Sort by avg_pnl descending (best expectancy)
    results.sort(key=lambda r: r['avg_pnl'], reverse=True)

    print(f'\n{"="*72}')
    print(' PARAMETER SWEEP RESULTS — sorted by avg PnL per trade')
    print(f'{"="*72}')
    print(f'  {"pin":>5}  {"rr":>5}  {"hold":>5}  {"conf":>5}  {"n":>5}  {"WR%":>6}  {"avgPnL":>8}  {"expect":>8}')
    print(f'  {"-"*5}  {"-"*5}  {"-"*5}  {"-"*5}  {"-"*5}  {"-"*6}  {"-"*8}  {"-"*8}')

    for r in results[:20]:
        c = 'Y' if r['confluence'] else 'N'
        marker = '  <-- BEST' if r == results[0] else ''
        print(
            f'  {r["pin_bar"]:.2f}  {r["tp_rr"]:.1f}x  {r["max_bars"]:>3}b'
            f'  {c:>5}  {r["n"]:>5}  {r["wr"]:>5.1f}%  {r["avg_pnl"]:>+7.3f}%'
            f'  {r["expectancy"]:>+7.1f}%{marker}'
        )

    best = results[0]
    print(f'\n  Best config: pin_bar={best["pin_bar"]}  tp_rr={best["tp_rr"]}  '
          f'max_bars={best["max_bars"]}  confluence={best["confluence"]}')
    print(f'  Trades={best["n"]}  WR={best["wr"]}%  avgPnL={best["avg_pnl"]:+.3f}%  '
          f'expectancy={best["expectancy"]:+.1f}%')

    # Apply best config to live smc_detector
    _mod.SWEEP_G1_PIN_BAR_THRESHOLD = best['pin_bar']
    print(f'\n  Applied best pin_bar_threshold={best["pin_bar"]} to live smc_detector module.')
    print(f'  To persist: update SWEEP_G1_PIN_BAR_THRESHOLD in scripts/smc_detector.py')


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fstr(args) -> str:
    """Build compact filter label for print_summary."""
    parts = []
    if getattr(args, 'min_sl_dist', 0): parts.append(f'sl>{args.min_sl_dist:.1f}%')
    if getattr(args, 'max_sl_dist', 999) < 999: parts.append(f'sl<{args.max_sl_dist:.1f}%')
    if getattr(args, 'score_min', 0):    parts.append(f'sc>={args.score_min}')
    if getattr(args, 'bear_filter', False): parts.append('bear')
    return (' ' + ' '.join(parts)) if parts else ''


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--symbol',       default=DEFAULT_SYMBOL)
    ap.add_argument('--all-symbols',  action='store_true')
    ap.add_argument('--tp-rr',        type=float, default=2.0)
    ap.add_argument('--max-bars',     type=int,   default=48)
    ap.add_argument('--pin-bar',      type=float, default=None)
    ap.add_argument('--confluence',   action='store_true',
                    help='4H: require next 4H bar bullish before entry')
    ap.add_argument('--mode',         default='4h',
                    choices=['4h', '4h-short', '1h', 'combined', 'combined-15m',
                             'idm-stack', 'idm-daily', 'ob-scalp'],
                    help='4h=LONG  4h-short=SHORT  1h=1H-only  combined=4H+1H  combined-15m=4H+15m  '
                         'idm-stack=4H+1H+15m triple  idm-daily=daily→4H entry  ob-scalp=1m OB-retest')
    ap.add_argument('--param-sweep',  action='store_true',
                    help='Grid search over parameter combinations (uses --mode)')
    ap.add_argument('--json',         action='store_true')
    ap.add_argument('--bars-daily',   type=int, default=None, help='Override daily bar count (default 300)')
    ap.add_argument('--bars-4h',      type=int, default=None, help='Override 4H bar count (default 1000)')
    ap.add_argument('--bars-1h',      type=int, default=None, help='Override 1H bar count (default 1000)')
    ap.add_argument('--bars-15m',     type=int, default=None, help='Override 15m bar count (default 5000)')
    ap.add_argument('--bars-1m',      type=int, default=None, help='Override 1m bar count for ob-scalp (default 130000 = ~90d)')
    ap.add_argument('--tp-fixed',     type=float, default=0.3,
                    help='Fixed TP percentage for ob-scalp mode (default 0.3%%)')
    ap.add_argument('--year',         action='store_true',
                    help='Shortcut: fetch 1 full year (daily=365, 4h=2200, 1h=8800, 15m=35200)')
    ap.add_argument('--years',        type=int, default=0,
                    help='Fetch N full years (e.g. --years 4 → daily=1460, 4h=8800, 1h=35200, 15m=140800)')
    ap.add_argument('--min-sl-dist',  type=float, default=0.0,
                    help='Skip trades with SL distance < X%% (e.g. 2.5)')
    ap.add_argument('--max-sl-dist',  type=float, default=999.0,
                    help='Skip trades with SL distance > X%% (e.g. 1.5 for tight SL only)')
    ap.add_argument('--score-min',    type=int,   default=0,
                    help='Minimum score to enter (e.g. 9 for score9+ only)')
    ap.add_argument('--bear-filter',  action='store_true',
                    help='Skip LONG entries when entry_price < daily EMA200')
    args = ap.parse_args()

    # --years N / --year shortcut
    if args.years > 0:
        n = args.years
        bars_daily = args.bars_daily or n * 365
        bars_4h    = args.bars_4h    or n * 2200
        bars_1h    = args.bars_1h    or n * 8800
        bars_15m   = args.bars_15m   or n * 35200
    elif args.year:
        bars_daily = args.bars_daily or 365
        bars_4h    = args.bars_4h    or 2200
        bars_1h    = args.bars_1h    or 8800
        bars_15m   = args.bars_15m   or 35200
    else:
        bars_daily = args.bars_daily or DAILY_LIMIT
        bars_4h    = args.bars_4h    or H4_LIMIT
        bars_1h    = args.bars_1h    or H1_LIMIT
        bars_15m   = args.bars_15m   or M15_LIMIT

    symbols = ALL_SYMBOLS if args.all_symbols else [args.symbol.upper()]

    if args.param_sweep:
        if args.mode == '4h-short':
            run_param_sweep_short(symbols)
        else:
            run_param_sweep(symbols)
        return

    needs_1h  = args.mode in ('1h', 'combined', 'idm-stack')
    needs_15m = args.mode in ('combined-15m', 'idm-stack')
    needs_1m  = args.mode == 'ob-scalp'
    bars_1m   = args.bars_1m or M1_LIMIT
    all_trades: list = []

    for sym in symbols:
        print(f'Fetching {sym}…', end=' ', flush=True)
        daily = fetch_binance_paginated(sym, '1d', bars_daily)
        h4    = fetch_binance_paginated(sym, '4h', bars_4h)
        h1    = fetch_binance_paginated(sym, '1h', bars_1h) if needs_1h else []
        m15   = fetch_binance_paginated(sym, '15m', bars_15m) if needs_15m else []
        m1    = fetch_binance_paginated(sym, '1m',  bars_1m)  if needs_1m  else []
        if needs_1m:
            bar_h = 1/60
            print(f'{len(daily)}d / {len(h4)}h4 / {len(m1)}×1m bars')
        elif needs_15m:
            bar_h = 0.25
            if needs_1h:
                print(f'{len(daily)}d / {len(h4)}h4 / {len(h1)}h1 / {len(m15)}×15m bars')
            else:
                print(f'{len(daily)}d / {len(h4)}h4 / {len(m15)}×15m bars')
        elif needs_1h:
            bar_h = 1.0
            print(f'{len(daily)}d / {len(h4)}h4 / {len(h1)}h1 bars')
        else:
            bar_h = 4.0
            print(f'{len(daily)}d / {len(h4)}h4 bars')

        if len(daily) < WARMUP_DAILY + 10 or len(h4) < WARMUP_H4 + 10:
            print(f'  [skip] not enough daily/4H data')
            continue
        if needs_1h and len(h1) < WARMUP_H1 + 10:
            print(f'  [skip] not enough 1H data')
            continue
        if needs_15m and len(m15) < WARMUP_15M + 10:
            print(f'  [skip] not enough 15m data')
            continue
        if needs_1m and len(m1) < WARMUP_1M + 10:
            print(f'  [skip] not enough 1m data')
            continue

        pin = args.pin_bar if args.pin_bar is not None else _mod.SWEEP_G1_PIN_BAR_THRESHOLD

        if args.mode == '4h':
            trades = run_sweep_backtest(sym, daily, h4, pin, args.tp_rr,
                                       args.max_bars, args.confluence)
            conf_label = ' +confluence' if args.confluence else ''
            label = f'{sym}  sweep_reversal_4h  pin={pin:.2f}  R/R={args.tp_rr}:1  hold={args.max_bars}b{conf_label}'
        elif args.mode == '4h-short':
            trades = run_sweep_backtest_short(sym, daily, h4, pin, args.tp_rr,
                                             args.max_bars, args.confluence)
            conf_label = ' +confluence' if args.confluence else ''
            label = f'{sym}  sweep_reversal_4h_short  pin={pin:.2f}  R/R={args.tp_rr}:1  hold={args.max_bars}b{conf_label}'
        elif args.mode == '1h':
            trades = run_1h_backtest(sym, daily, h4, h1, pin, args.tp_rr, args.max_bars)
            label  = f'{sym}  sweep_reversal_1h  pin={pin:.2f}  R/R={args.tp_rr}:1  hold={args.max_bars}b'
        elif args.mode == 'combined':
            trades = run_combined_backtest(sym, daily, h4, h1, pin, args.tp_rr, args.max_bars,
                                           args.min_sl_dist, args.max_sl_dist,
                                           args.bear_filter, args.score_min)
            _flt  = (_fstr(args) )
            label = f'{sym}  combined_4h+1h  pin={pin:.2f}  R/R={args.tp_rr}:1  hold={args.max_bars}h1bars{_flt}'
        elif args.mode == 'idm-stack':
            max_15m = args.max_bars * 4
            trades  = run_idm_stack_backtest(sym, daily, h4, h1, m15, pin, args.tp_rr, max_15m,
                                             args.min_sl_dist, args.max_sl_dist,
                                             args.bear_filter, args.score_min)
            _flt  = (_fstr(args))
            label = f'{sym}  idm_stack_4h+1h+15m  R/R={args.tp_rr}:1  hold={args.max_bars}h({max_15m}x15m){_flt}'
        elif args.mode == 'idm-daily':
            trades = run_idm_daily_backtest(sym, daily, h4, pin, args.tp_rr,
                                            args.max_bars, args.min_sl_dist,
                                            args.max_sl_dist, args.score_min)
            _flt  = (_fstr(args))
            label = f'{sym}  idm_daily_4h_entry  pin={pin:.2f}  R/R={args.tp_rr}:1  hold={args.max_bars}b{_flt}'
        elif args.mode == 'ob-scalp':
            trades = run_ob_scalp_backtest(sym, daily, h4, m1, pin,
                                           args.tp_fixed, args.max_bars,
                                           args.score_min)
            label  = f'{sym}  ob_scalp_4h+1m  pin={pin:.2f}  TP={args.tp_fixed:.2f}%  hold={args.max_bars}min  sc>={args.score_min}'
        else:  # combined-15m
            max_15m = args.max_bars * 4   # convert 1H bars to 15m bars (×4)
            trades  = run_combined_backtest_15m(sym, daily, h4, m15, pin, args.tp_rr, max_15m,
                                               args.min_sl_dist, args.max_sl_dist,
                                               args.bear_filter, args.score_min)
            _flt  = (_fstr(args))
            label = f'{sym}  combined_4h+15m  pin={pin:.2f}  R/R={args.tp_rr}:1  hold={args.max_bars}h({max_15m}x15m){_flt}'

        print_summary(trades, label, bar_hours=bar_h)
        all_trades.extend(trades)

    if len(symbols) > 1:
        bar_hours_all = 1/60 if needs_1m else (0.25 if needs_15m else (1.0 if needs_1h else 4.0))
        print_summary(all_trades, f'ALL SYMBOLS COMBINED ({args.mode})', bar_hours=bar_hours_all)

    if args.json:
        print('\n' + json.dumps(all_trades, indent=2))


if __name__ == '__main__':
    main()
