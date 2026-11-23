#!/usr/bin/env python3
"""
smc_scalp_detector.py — OB-Scalp signal detector (live).

For each symbol in SMC_SYMBOLS:
  1. Load 4H + daily OHLCV from cache (written by ohlcv_fetcher.mjs).
  2. Run detect_sweep_reversal_4h() — reuses smc_detector.py functions via importlib.
  3. If Score >= 9 LONG setup found: define OB zone [sl_level, sweep_level x 1.012].
  4. Fetch latest 200 1m bars from Binance (live, 5s timeout).
  5. Check last 10 completed 1m bars for bullish pin bar inside OB zone.
  6. If confirmed: emit scalp signal JSON.

Output: NDJSON — one line per signal (stdout)
Stderr: progress/debug
Exit: always 0 (fail-soft)
"""

import importlib.util
import json
import pathlib
import sys
import time
import urllib.request
from datetime import datetime, timezone
from typing import Optional

sys.argv = ['x']  # prevent argparse in imported modules

_HERE = pathlib.Path(__file__).resolve().parent
_CACHE_DIR = _HERE.parent / 'trading' / 'cache'
_DEDUP_PATH = _CACHE_DIR / 'scalp_pin_dedup.json'
_DEDUP_TTL  = 1800  # 30 min — same pin_ts won't re-fire within this window

def _load_dedup() -> dict:
    try:
        return json.loads(_DEDUP_PATH.read_text())
    except Exception:
        return {}

def _save_dedup(d: dict) -> None:
    try:
        _DEDUP_PATH.write_text(json.dumps(d))
    except Exception:
        pass

spec = importlib.util.spec_from_file_location('smc_det', _HERE / 'smc_detector.py')
smc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smc)

BINANCE_KLINES = 'https://api.binance.com/api/v3/klines'
SYMBOLS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'TAO']
SCORE_MIN = 9
PIN_RATIO = 0.5         # lower wick >= 0.5 x body
MAX_PIN_AGE = 10        # check last 10 completed 1m bars (~10 min window)
OB_TOP_MULT = 1.012     # OB zone top = sweep_level x 1.012

# Mixed-Optimal-5 config (backtest validated 2023-2026)
SCALP_TP_PCT: dict[str, float] = {
    'BTC': 0.15, 'BNB': 0.15,
    'ETH': 0.15, 'SOL': 0.15, 'XRP': 0.15, 'TAO': 0.15,
}


def fetch_1m_bars(symbol: str, n: int = 200, timeout: int = 30) -> list:
    pair = symbol.upper() + 'USDT'
    url = f'{BINANCE_KLINES}?symbol={pair}&interval=1m&limit={n}'
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            raw = json.loads(r.read())
        return [
            {
                'timestamp': int(r[0]),
                'open':  float(r[1]),
                'high':  float(r[2]),
                'low':   float(r[3]),
                'close': float(r[4]),
            }
            for r in raw
        ]
    except Exception as e:
        print(json.dumps({'warn': f'scalp_1m_fetch_failed', 'symbol': symbol, 'detail': str(e)}),
              file=sys.stderr)
        return []


def check_pin_bar(bars_1m: list, sl_level: float, ob_top: float) -> Optional[dict]:
    """
    Scan last MAX_PIN_AGE completed bars (skip last in-progress bar)
    for a bullish pin bar in the OB zone [sl_level, ob_top].
    Returns the matching bar dict or None.
    """
    # bars_1m[-1] may be in-progress; check [-MAX_PIN_AGE-1 : -1]
    window = bars_1m[-(MAX_PIN_AGE + 1):-1]
    for c in reversed(window):
        if c['close'] <= c['open']:
            continue
        if not (sl_level <= c['close'] <= ob_top):
            continue
        body = c['close'] - c['open']
        lwick = c['open'] - c['low']
        if body <= 0 or lwick < body * PIN_RATIO:
            continue
        return c
    return None


_dedup = _load_dedup()

for sym in SYMBOLS:
    try:
        daily = smc.load_ohlcv(sym)
        h4 = smc.load_ohlcv_4h(sym)
        if h4 is None or len(h4) < 20:
            continue

        pivot_highs, pivot_lows = smc.find_pivots(daily)
        ema200 = smc.calc_ema([c['close'] for c in daily])

        sig = smc.detect_sweep_reversal_4h(h4, pivot_lows, ema200, sym)
        if sig is None or sig['score'] < SCORE_MIN or sig['side'] != 'long':
            continue

        sl_level = sig['sl_level']
        sweep_level = sig['sweep_level']
        ob_top = round(sweep_level * OB_TOP_MULT, 6)

        bars_1m = fetch_1m_bars(sym)
        if len(bars_1m) < MAX_PIN_AGE + 2:
            continue

        pin = check_pin_bar(bars_1m, sl_level, ob_top)
        if pin is None:
            continue

        current_price = bars_1m[-1]['close']
        entry_price = current_price
        sl_price = sl_level * 0.999
        tp_pct = SCALP_TP_PCT.get(sym, 0.20)

        sl_dist_pct = (entry_price - sl_price) / entry_price * 100 if entry_price > sl_price else 0.0
        if sl_dist_pct <= 0 or sl_dist_pct > tp_pct * 3:
            print(json.dumps({
                'info': 'scalp_skip_rr', 'symbol': sym,
                'sl_dist_pct': round(sl_dist_pct, 4), 'tp_pct': tp_pct,
                'reason': 'sl too wide relative to tp',
            }), file=sys.stderr)
            continue

        pin_ts = datetime.fromtimestamp(pin['timestamp'] / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')

        # Dedup: skip if this pin_ts was already emitted for this symbol within TTL
        last = _dedup.get(sym, {})
        if last.get('pin_ts') == pin_ts and (time.time() - last.get('emitted_at', 0)) < _DEDUP_TTL:
            print(json.dumps({'info': 'scalp_pin_dedup', 'symbol': sym, 'pin_ts': pin_ts}),
                  file=sys.stderr)
            continue

        result = {
            'symbol':        sym,
            'side':          'long',
            'strategy':      'ob_scalp',
            'score':         sig['score'],
            'sl_level':      round(sl_level, 6),
            'sl_price':      round(sl_price, 6),
            'ob_top':        round(ob_top, 6),
            'sweep_level':   round(sweep_level, 6),
            'tp_pct':        tp_pct,
            'sl_dist_pct':   round(sl_dist_pct, 4),
            'current_price': round(current_price, 6),
            'pin_bar_ts':    pin_ts,
            'pin_bar_close': round(pin['close'], 6),
            'reason':        (
                f'ob_scalp sweep{sweep_level:.4f} '
                f'pin{pin["close"]:.4f} tp{tp_pct}pct'
            ),
        }
        _dedup[sym] = {'pin_ts': pin_ts, 'emitted_at': time.time()}
        _save_dedup(_dedup)
        print(json.dumps(result), flush=True)

    except Exception as e:
        print(json.dumps({'warn': 'scalp_detector_error', 'symbol': sym, 'detail': str(e)}),
              file=sys.stderr)
