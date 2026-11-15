#!/usr/bin/env python3
"""
backtest_smc.py — Sliding-window backtest for SMC detectors

Fetches historical OHLCV from Binance public API (no auth needed):
  Daily: 300 bars  (~10 months)
  4H:   1000 bars  (~5.5 months)

Runs for each 4H bar (after warmup):
  - detect_sweep_reversal_4h  (new: sell-side sweep + reversal LONG)
  - detect_setup (existing:   BOS + EMA200 + IDM — both directions)

Entry: open of next 4H bar after signal
Exit:  first bar whose low ≤ SL  or  high ≥ TP  (or timeout at --max-bars)

Usage:
  python scripts/backtest_smc.py
  python scripts/backtest_smc.py --symbol ETH
  python scripts/backtest_smc.py --symbol BTC --tp-rr 2.5 --max-bars 48
  python scripts/backtest_smc.py --symbol BTC --all-symbols
"""

from __future__ import annotations

import argparse
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

find_pivots          = _mod.find_pivots
detect_setup         = _mod.detect_setup
detect_sweep_reversal_4h = _mod.detect_sweep_reversal_4h
calc_ema             = _mod.calc_ema
_ema                 = _mod._ema
EMA_PERIOD           = _mod.EMA_PERIOD

# ── Constants ─────────────────────────────────────────────────────────────────
BINANCE_KLINES = 'https://api.binance.com/api/v3/klines'
ALL_SYMBOLS    = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP']
DEFAULT_SYMBOL = 'BTC'
DAILY_LIMIT    = 300    # ~10 months
H4_LIMIT       = 1000   # ~5.5 months
WARMUP_DAILY   = 210    # need 200 for EMA200 + 10 for pivots
WARMUP_H4      = 60     # bars needed before first sweep check

# ── Fetch from Binance ────────────────────────────────────────────────────────

def fetch_binance(symbol: str, interval: str, limit: int) -> list:
    pair = symbol.upper() + 'USDT'
    url  = f'{BINANCE_KLINES}?symbol={pair}&interval={interval}&limit={limit}'
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            raw = json.loads(r.read())
    except Exception as e:
        print(f'[fetch_error] {symbol} {interval}: {e}', file=sys.stderr)
        return []
    return [
        {
            'timestamp': row[0],
            'open':      float(row[1]),
            'high':      float(row[2]),
            'low':       float(row[3]),
            'close':     float(row[4]),
            'volume':    float(row[5]),
        }
        for row in raw
    ]


# ── Exit simulation ───────────────────────────────────────────────────────────

def simulate_exit(candles_4h: list, entry_bar: int, entry_price: float,
                  sl: float, tp: float, max_bars: int) -> dict:
    """
    Scan forward from entry_bar.  Returns outcome dict.
    SL and TP are checked intra-bar (worst case: SL wins if both hit same bar).
    """
    for i in range(entry_bar, min(entry_bar + max_bars, len(candles_4h))):
        c = candles_4h[i]
        sl_hit = c['low']  <= sl
        tp_hit = c['high'] >= tp
        if sl_hit or tp_hit:
            if sl_hit and tp_hit:
                # Ambiguous — assume SL hit first (conservative)
                result = 'sl'
                exit_price = sl
            elif sl_hit:
                result = 'sl'
                exit_price = sl
            else:
                result = 'tp'
                exit_price = tp
            pnl_pct = (exit_price - entry_price) / entry_price * 100
            return {
                'result':     result,
                'exit_bar':   i,
                'bars_held':  i - entry_bar,
                'exit_price': round(exit_price, 4),
                'pnl_pct':    round(pnl_pct, 3),
            }
    # Timeout — close at last bar
    close_price = candles_4h[min(entry_bar + max_bars - 1, len(candles_4h) - 1)]['close']
    pnl_pct     = (close_price - entry_price) / entry_price * 100
    return {
        'result':     'timeout',
        'exit_bar':   entry_bar + max_bars,
        'bars_held':  max_bars,
        'exit_price': round(close_price, 4),
        'pnl_pct':    round(pnl_pct, 3),
    }


# ── Sweep backtest ────────────────────────────────────────────────────────────

def backtest_sweep(symbol: str, candles_daily: list, candles_4h: list,
                   tp_rr: float, max_bars: int) -> list:
    """
    For each 4H bar j (after warmup), run detect_sweep_reversal_4h on
    candles_4h[:j+1] and daily_candles up to same date.
    Return list of trade dicts.
    """
    trades    = []
    last_entry_bar = -99   # prevent duplicate entries within 12 bars

    for j in range(WARMUP_H4, len(candles_4h) - 1):
        # Skip if recently entered a sweep trade (avoid re-entry on same sweep)
        if j - last_entry_bar < 12:
            continue

        ts_4h = candles_4h[j]['timestamp']
        # Align daily slice to same timestamp
        daily_slice = [c for c in candles_daily if c['timestamp'] <= ts_4h]
        if len(daily_slice) < WARMUP_DAILY:
            continue

        _, piv_lows = find_pivots(daily_slice)
        if not piv_lows:
            continue

        h4_slice    = candles_4h[:j + 1]
        ema200      = calc_ema([c['close'] for c in daily_slice])

        sig = detect_sweep_reversal_4h(h4_slice, piv_lows, ema200, symbol)
        if sig is None or sig['score'] < 7:   # output even Score 7 for analysis
            continue

        entry_bar   = j + 1
        entry_price = candles_4h[entry_bar]['open']
        sl          = sig['sl_level']
        sl_dist     = entry_price - sl
        if sl_dist <= 0:
            continue
        tp = entry_price + sl_dist * tp_rr

        outcome = simulate_exit(candles_4h, entry_bar, entry_price, sl, tp, max_bars)

        trade = {
            'symbol':       symbol,
            'strategy':     'sweep_reversal_4h',
            'score':        sig['score'],
            'signal_bar':   j,
            'signal_ts':    datetime.fromtimestamp(ts_4h / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M'),
            'sweep_level':  sig['sweep_level'],
            'entry_price':  round(entry_price, 4),
            'sl':           round(sl, 4),
            'tp':           round(tp, 4),
            'rr_target':    tp_rr,
            **outcome,
        }
        trades.append(trade)
        last_entry_bar = entry_bar

    return trades


# ── Existing detector backtest ────────────────────────────────────────────────

def backtest_smc_detector(symbol: str, candles_daily: list, candles_4h: list,
                           tp_rr: float, max_bars: int) -> list:
    """
    For each daily bar i (after warmup), run detect_setup.
    Signal fires when score transitions to ≥ 9.
    Entry: open of first 4H bar on the same date.
    """
    trades         = []
    prev_score     = 0
    prev_side      = None
    last_entry_bar = -99

    for i in range(WARMUP_DAILY, len(candles_daily) - 1):
        daily_slice = candles_daily[:i + 1]
        ts_daily    = candles_daily[i]['timestamp']

        # 4H price at same time
        h4_at_time = [c for c in candles_4h if c['timestamp'] <= ts_daily]
        price_4h   = h4_at_time[-1]['close'] if h4_at_time else None

        try:
            sig = detect_setup(daily_slice, symbol, price_4h)
        except Exception:
            continue

        score = sig.get('score', 0)
        side  = sig.get('side')

        # Fire on fresh Score ≥ 9 (transition from < 9 or direction change)
        if score >= 9 and (prev_score < 9 or side != prev_side):
            # Find first 4H bar on the next daily close date
            next_ts = candles_daily[i + 1]['timestamp']
            h4_candidates = [
                (k, c) for k, c in enumerate(candles_4h)
                if c['timestamp'] >= ts_daily and c['timestamp'] < next_ts
            ]
            if not h4_candidates:
                prev_score, prev_side = score, side
                continue

            entry_4h_idx = h4_candidates[0][0]
            if entry_4h_idx - last_entry_bar < 6:
                prev_score, prev_side = score, side
                continue

            entry_price = candles_4h[entry_4h_idx]['open']
            sl_pct      = sig.get('idm_level') or 0
            # Use OTE zone as SL anchor: origin_level as absolute SL
            origin      = sig.get('origin_level') or 0
            if side == 'long':
                sl = origin * 0.998
                if sl >= entry_price:
                    prev_score, prev_side = score, side
                    continue
            else:
                sl = origin * 1.002
                if sl <= entry_price:
                    prev_score, prev_side = score, side
                    continue

            sl_dist = abs(entry_price - sl)
            if sl_dist <= 0:
                prev_score, prev_side = score, side
                continue

            tp = entry_price + sl_dist * tp_rr * (1 if side == 'long' else -1)

            # For short, invert simulate_exit (flip candle high/low)
            if side == 'short':
                inv_4h = [
                    {**c, 'high': -c['low'], 'low': -c['high'], 'open': -c['open'], 'close': -c['close']}
                    for c in candles_4h
                ]
                outcome = simulate_exit(inv_4h, entry_4h_idx, -entry_price, -sl, -tp, max_bars)
                outcome['pnl_pct'] = -outcome['pnl_pct']
                outcome['exit_price'] = -outcome['exit_price']
            else:
                outcome = simulate_exit(candles_4h, entry_4h_idx, entry_price, sl, tp, max_bars)

            trade = {
                'symbol':       symbol,
                'strategy':     f'smc_detector_{side}',
                'score':        score,
                'signal_bar':   i,
                'signal_ts':    datetime.fromtimestamp(ts_daily / 1000, tz=timezone.utc).strftime('%Y-%m-%d'),
                'h1_level':     sig.get('h1_level'),
                'idm_level':    sig.get('idm_level'),
                'entry_price':  round(entry_price, 4),
                'sl':           round(sl, 4),
                'tp':           round(tp, 4),
                'rr_target':    tp_rr,
                **outcome,
            }
            trades.append(trade)
            last_entry_bar = entry_4h_idx

        prev_score, prev_side = score, side

    return trades


# ── Summary printer ───────────────────────────────────────────────────────────

def print_summary(trades: list, label: str) -> None:
    if not trades:
        print(f'\n{label}: 0 trades — no signals fired')
        return

    wins     = [t for t in trades if t['result'] == 'tp']
    losses   = [t for t in trades if t['result'] == 'sl']
    timeouts = [t for t in trades if t['result'] == 'timeout']
    total    = len(trades)
    wr       = len(wins) / total * 100
    avg_pnl  = sum(t['pnl_pct'] for t in trades) / total
    total_pnl = sum(t['pnl_pct'] for t in trades)
    avg_bars = sum(t['bars_held'] for t in trades) / total

    print(f'\n{"-"*60}')
    print(f' {label}')
    print(f'{"-"*60}')
    print(f'  Trades   : {total}  (TP:{len(wins)}  SL:{len(losses)}  Timeout:{len(timeouts)})')
    print(f'  Win rate : {wr:.1f}%')
    print(f'  Avg PnL  : {avg_pnl:+.2f}% per trade')
    print(f'  Total PnL: {total_pnl:+.2f}% (sum of all trades)')
    print(f'  Avg hold : {avg_bars:.1f} 4H bars ({avg_bars * 4 / 24:.1f} days)')
    print()

    # Score breakdown
    for s in sorted(set(t['score'] for t in trades)):
        st = [t for t in trades if t['score'] == s]
        sw = [t for t in st if t['result'] == 'tp']
        print(f'  Score {s}: {len(st)} trades  WR={len(sw)/len(st)*100:.0f}%  avg={sum(t["pnl_pct"] for t in st)/len(st):+.2f}%')

    print()
    print('  Last 10 trades:')
    for t in trades[-10:]:
        mark = 'TP' if t['result']=='tp' else ('SL' if t['result']=='sl' else '—')
        print(f'    {t["signal_ts"]}  entry={t["entry_price"]}  {mark}  {t["pnl_pct"]:+.2f}%  {t["bars_held"]}bars')


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--symbol',      default=DEFAULT_SYMBOL, help='Symbol (BTC/ETH/SOL/…)')
    ap.add_argument('--all-symbols', action='store_true',    help='Run all SMC_SYMBOLS')
    ap.add_argument('--tp-rr',       type=float, default=2.0, help='Take-profit R/R (default 2.0)')
    ap.add_argument('--max-bars',    type=int,   default=48,  help='Max bars to hold (default 48 = 8 days)')
    ap.add_argument('--json',        action='store_true',    help='Output all trades as JSON')
    args = ap.parse_args()

    symbols = ALL_SYMBOLS if args.all_symbols else [args.symbol.upper()]

    all_trades: list = []

    for sym in symbols:
        print(f'\nFetching {sym} from Binance…', end=' ', flush=True)
        daily = fetch_binance(sym, '1d', DAILY_LIMIT)
        h4    = fetch_binance(sym, '4h', H4_LIMIT)
        print(f'{len(daily)} daily bars, {len(h4)} 4H bars')

        if len(daily) < WARMUP_DAILY + 10 or len(h4) < WARMUP_H4 + 10:
            print(f'  [skip] insufficient data for {sym}')
            continue

        sweep_trades = backtest_sweep(sym, daily, h4, args.tp_rr, args.max_bars)
        smc_trades   = backtest_smc_detector(sym, daily, h4, args.tp_rr, args.max_bars)

        print_summary(sweep_trades, f'{sym}  sweep_reversal_4h  (R/R {args.tp_rr}:1)')
        print_summary(smc_trades,   f'{sym}  smc_detector       (R/R {args.tp_rr}:1)')

        all_trades.extend(sweep_trades)
        all_trades.extend(smc_trades)

    if args.json:
        print('\n' + json.dumps(all_trades, indent=2))


if __name__ == '__main__':
    main()
