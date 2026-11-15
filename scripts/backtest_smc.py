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

find_pivots              = _mod.find_pivots
detect_sweep_reversal_4h = _mod.detect_sweep_reversal_4h
detect_sweep_reversal_1h = _mod.detect_sweep_reversal_1h
calc_ema                 = _mod.calc_ema
EMA_PERIOD               = _mod.EMA_PERIOD

# ── Constants ─────────────────────────────────────────────────────────────────
BINANCE_KLINES = 'https://api.binance.com/api/v3/klines'
ALL_SYMBOLS    = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP']
DEFAULT_SYMBOL = 'BTC'
DAILY_LIMIT    = 300    # ~10 months
H4_LIMIT       = 1000   # ~5.5 months
H1_LIMIT       = 1000   # ~42 days
WARMUP_DAILY   = 210    # 200 for EMA200 + 10 for pivots
WARMUP_H4      = 60     # bars before first 4H sweep check
WARMUP_H1      = 50     # bars before first 1H sweep check

# ── Parameter sweep grid ──────────────────────────────────────────────────────
PARAM_PIN_BAR   = [0.50, 0.55, 0.60, 0.65, 0.70]
PARAM_TP_RR     = [1.5,  2.0,  2.5,  3.0]
PARAM_MAX_BARS  = [24,   48,   72]
# Confluence filter: require next 4H candle after sweep to also close bullish
# (proxy for heatmap buy-pressure confirmation — buyers follow through)
PARAM_CONFLUENCE = [False, True]

# ── Fetch from Binance ────────────────────────────────────────────────────────

_cache: dict = {}   # {symbol+interval: candles}  — reuse across runs

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
        if sl_dist <= 0:
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


# ── Summary helpers ───────────────────────────────────────────────────────────

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
                    choices=['4h', '1h', 'combined'],
                    help='4h=sweep_reversal_4h  1h=standalone 1H  combined=4H+1H confluence')
    ap.add_argument('--param-sweep',  action='store_true',
                    help='Grid search over all parameter combinations (4H mode)')
    ap.add_argument('--json',         action='store_true')
    args = ap.parse_args()

    symbols = ALL_SYMBOLS if args.all_symbols else [args.symbol.upper()]

    if args.param_sweep:
        run_param_sweep(symbols)
        return

    needs_1h = args.mode in ('1h', 'combined')
    all_trades: list = []

    for sym in symbols:
        print(f'Fetching {sym}…', end=' ', flush=True)
        daily = fetch_binance(sym, '1d', DAILY_LIMIT)
        h4    = fetch_binance(sym, '4h', H4_LIMIT)
        h1    = fetch_binance(sym, '1h', H1_LIMIT) if needs_1h else []
        bar_h = 1.0 if args.mode in ('1h', 'combined') else 4.0
        print(f'{len(daily)}d / {len(h4)}h4 / {len(h1)}h1 bars')

        if len(daily) < WARMUP_DAILY + 10 or len(h4) < WARMUP_H4 + 10:
            print(f'  [skip] not enough daily/4H data')
            continue
        if needs_1h and len(h1) < WARMUP_H1 + 10:
            print(f'  [skip] not enough 1H data')
            continue

        pin = args.pin_bar if args.pin_bar is not None else _mod.SWEEP_G1_PIN_BAR_THRESHOLD

        if args.mode == '4h':
            trades = run_sweep_backtest(sym, daily, h4, pin, args.tp_rr,
                                       args.max_bars, args.confluence)
            conf_label = ' +confluence' if args.confluence else ''
            label = f'{sym}  sweep_reversal_4h  pin={pin:.2f}  R/R={args.tp_rr}:1  hold={args.max_bars}b{conf_label}'
        elif args.mode == '1h':
            trades = run_1h_backtest(sym, daily, h4, h1, pin, args.tp_rr, args.max_bars)
            label  = f'{sym}  sweep_reversal_1h  pin={pin:.2f}  R/R={args.tp_rr}:1  hold={args.max_bars}b'
        else:  # combined
            trades = run_combined_backtest(sym, daily, h4, h1, pin, args.tp_rr, args.max_bars)
            label  = f'{sym}  combined_4h+1h  pin={pin:.2f}  R/R={args.tp_rr}:1  hold={args.max_bars}h1bars'

        print_summary(trades, label, bar_hours=bar_h)
        all_trades.extend(trades)

    if len(symbols) > 1:
        print_summary(all_trades, f'ALL SYMBOLS COMBINED ({args.mode})',
                      bar_hours=1.0 if needs_1h else 4.0)

    if args.json:
        print('\n' + json.dumps(all_trades, indent=2))


if __name__ == '__main__':
    main()
