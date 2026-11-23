"""
BNB + XRP Re-Test mit Retry-Fetch.

Fix: timeout=20s + break bei Fehler → ersetzt durch Retry (3x, Resume).
Ziel: Volle 4yr 1m-Daten für BNB und XRP.
Configs: TP0.20%, TP0.15%
"""
import importlib.util, pathlib, sys, bisect, json, time, urllib.request
from datetime import datetime, timezone
from typing import Optional

sys.argv = ['x']
_HERE = pathlib.Path(__file__).resolve().parent
spec  = importlib.util.spec_from_file_location('bt', _HERE / 'backtest_smc.py')
bt    = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)

BINANCE_KLINES = 'https://api.binance.com/api/v3/klines'
SYMBOLS  = ['BNB', 'XRP']
YEARS_4  = 4
B_DAILY  = YEARS_4 * 365
B_4H     = YEARS_4 * 2200
B_1M     = YEARS_4 * 365 * 24 * 60   # 2 102 400
YEARS    = list(range(2023, 2027))


def fetch_with_retry(symbol: str, interval: str, total: int,
                     per_page: int = 1000, timeout: int = 30,
                     max_retries: int = 3) -> list:
    """Fetch mit Retry + Resume: bei Timeout wird von letzter erfolgreicher Page weitergemacht."""
    pair     = symbol.upper() + 'USDT'
    all_raw: list = []
    end_time: Optional[int] = None
    consecutive_fails = 0

    while len(all_raw) < total:
        url = f'{BINANCE_KLINES}?symbol={pair}&interval={interval}&limit={per_page}'
        if end_time is not None:
            url += f'&endTime={end_time}'

        page = None
        for attempt in range(max_retries):
            try:
                with urllib.request.urlopen(url, timeout=timeout) as r:
                    page = json.loads(r.read())
                consecutive_fails = 0
                break
            except Exception as e:
                wait = 3 * (attempt + 1)
                print(f'  [retry {attempt+1}/{max_retries}] {symbol} {interval} '
                      f'@ {len(all_raw)} bars: {e} — wait {wait}s', file=sys.stderr)
                if attempt < max_retries - 1:
                    time.sleep(wait)

        if page is None:
            consecutive_fails += 1
            print(f'  [fetch_abort] {symbol} {interval}: '
                  f'alle Retries erschöpft @ {len(all_raw)} bars', file=sys.stderr)
            if consecutive_fails >= 3 or len(all_raw) == 0:
                break
            # Versuche weiter mit älterer end_time (überspringe ggf. Lücke)
            if end_time is not None:
                end_time -= per_page * 60_000  # ~1000min zurück (bei 1m)
            continue

        if not page:
            break
        all_raw = page + all_raw
        end_time = int(page[0][0]) - 1
        if len(page) < per_page:
            break

        if len(all_raw) % 100_000 < per_page:
            pct = len(all_raw) / total * 100
            print(f'  [{symbol} {interval}] {len(all_raw):,}/{total:,} ({pct:.0f}%)', flush=True)

    candles = [
        {'timestamp': int(r[0]), 'open': float(r[1]), 'high': float(r[2]),
         'low': float(r[3]), 'close': float(r[4]), 'volume': float(r[5])}
        for r in all_raw
    ]
    candles.sort(key=lambda c: c['timestamp'])
    return candles


def scalp(symbol, candles_daily, candles_4h, candles_1m,
          tp_pct, max_bars_1m=120, pin_ratio=0.5, score_min=9):
    bt._mod.SWEEP_G1_PIN_BAR_THRESHOLD = 0.70
    trades = []; pending_ob = {}; last_entry = -99; last_h4_end = -1; ema200 = 50_000.0
    h4ts = [c['timestamp'] for c in candles_4h]
    dts  = [c['timestamp'] for c in candles_daily]

    for j in range(bt.WARMUP_1M, len(candles_1m) - 1):
        if j - last_entry < 60:
            continue
        ts   = candles_1m[j]['timestamp']
        h4e  = bisect.bisect_right(h4ts, ts)
        de   = bisect.bisect_right(dts, ts)
        if h4e < 20 or de < bt.WARMUP_DAILY:
            continue
        if h4e != last_h4_end:
            last_h4_end = h4e
            h4s   = candles_4h[:h4e]
            ds    = candles_daily[:de]
            _, piv = bt.find_pivots(ds)
            ema200 = bt.calc_ema([c['close'] for c in ds])
            sig = bt.detect_sweep_reversal_4h(h4s, piv, ema200, symbol)
            if sig and sig['score'] >= 8:
                sl, sw = sig['sl_level'], sig['sweep_level']
                pending_ob[symbol] = {
                    'ts': h4s[-1]['timestamp'], 'sl': sl, 'level': sw,
                    'score': sig['score'], 'ob_top': sw * 1.012,
                }
            elif symbol in pending_ob:
                if ts - pending_ob[symbol]['ts'] > 259_200_000:
                    del pending_ob[symbol]
        if symbol not in pending_ob:
            continue
        ob = pending_ob[symbol]
        if ob['score'] < score_min:
            continue
        if ts <= ob['ts']:
            continue
        c = candles_1m[j]
        if not (ob['sl'] <= c['close'] <= ob['ob_top']):
            continue
        if c['close'] <= c['open']:
            continue
        body  = c['close'] - c['open']
        lwick = c['open']  - c['low']
        if body <= 0 or lwick < body * pin_ratio:
            continue
        eb = j + 1
        if eb >= len(candles_1m):
            continue
        ep  = candles_1m[eb]['open']
        slp = ob['sl'] * 0.999
        sld = ep - slp
        if sld <= 0 or sld / ep * 100 > tp_pct * 3:
            continue
        tp  = ep * (1 + tp_pct / 100)
        out = bt.simulate_exit(candles_1m, eb, ep, slp, tp, max_bars_1m)
        signal_dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        trades.append({
            'symbol': symbol, 'score': ob['score'],
            'signal_ts': signal_dt.strftime('%Y-%m-%d %H:%M'),
            'year': signal_dt.year, 'entry_price': round(ep, 6),
            'sl': round(slp, 6), 'tp': round(tp, 6),
            'sl_dist_pct': round(sld / ep * 100, 3),
            **out,
        })
        del pending_ob[symbol]
        last_entry = eb
    return trades


def stats(trades):
    n = len(trades)
    if n == 0:
        return {'n': 0, 'wr': 0, 'avg': 0, 'be': 0, 'above_be': False,
                'n_tp': 0, 'n_sl': 0, 'n_to': 0}
    n_tp   = sum(1 for t in trades if t['result'] == 'tp')
    wr     = round(n_tp / n * 100, 1)
    avg    = round(sum(t['pnl_pct'] for t in trades) / n, 3)
    sl_v   = [t['sl_dist_pct'] for t in trades if 'sl_dist_pct' in t]
    avsl   = sum(sl_v) / len(sl_v) if sl_v else 0
    tp_avg = sum(abs(t['pnl_pct']) for t in trades if t['result'] == 'tp') / max(n_tp, 1)
    rr_a   = tp_avg / avsl if avsl > 0 else 0
    be     = round(100 / (1 + rr_a), 1) if rr_a > 0 else 99.0
    return {'n': n, 'wr': wr, 'avg': avg, 'be': be, 'above_be': wr > be,
            'n_tp': n_tp, 'n_sl': sum(1 for t in trades if t['result'] == 'sl'),
            'n_to': sum(1 for t in trades if t['result'] == 'timeout')}


CONFIGS = [('TP0.20%', 0.20), ('TP0.15%', 0.15)]

print(f'=== BNB + XRP Re-Test (Retry-Fetch, timeout=30s) ===\n')

t_start = time.time()
results: dict = {s: {} for s in SYMBOLS}

for s in SYMBOLS:
    t0 = time.time()
    print(f'\n--- {s} ---', flush=True)
    print(f'  daily...', end=' ', flush=True)
    daily = bt.fetch_binance_paginated(s, '1d', B_DAILY)
    print(f'{len(daily)}d  4h...', end=' ', flush=True)
    h4    = bt.fetch_binance_paginated(s, '4h', B_4H)
    print(f'{len(h4)}h4  1m (Retry, ~15min)...', flush=True)
    m1    = fetch_with_retry(s, '1m', B_1M)
    yrs_fetched = round(len(m1) / (365 * 24 * 60), 2)
    print(f'  {s}: {len(m1):,}x1m = {yrs_fetched}yr in {int(time.time()-t0)}s', flush=True)

    if yrs_fetched < 3.5:
        print(f'  WARNUNG: nur {yrs_fetched}yr Daten — Jahr-Breakdown unvollständig!', flush=True)

    for lbl, tp_pct in CONFIGS:
        trades = scalp(s, daily, h4, m1, tp_pct)
        results[s][lbl] = trades
        st = stats(trades)
        flag = ' ***' if st['wr'] >= 70 else ('  *' if st['wr'] >= 65 else '  !')
        print(f'  [{lbl}] {s}: N={st["n"]:4d}  WR={st["wr"]:.1f}%  avg={st["avg"]:+.3f}%  '
              f'BE={st["be"]:.1f}%  {"ABOVE" if st["above_be"] else "below"}{flag}', flush=True)

    del m1
    print(f'  {s} fertig in {int(time.time()-t0)}s', flush=True)

print(f'\nAlle Symbole fertig in {int(time.time()-t_start)}s\n')

# ── Ergebnisse ─────────────────────────────────────────────────────────────────
for lbl, tp_pct in CONFIGS:
    print(f'\n{"="*72}')
    print(f' Config: {lbl}')
    print(f'{"="*72}')
    for s in SYMBOLS:
        st = stats(results[s].get(lbl, []))
        flag = ' ***' if st['wr'] >= 70 else ('  *' if st['wr'] >= 65 else '  !')
        print(f'  {s:4s}: N={st["n"]:4d}  WR={st["wr"]:.1f}%  avg={st["avg"]:+.3f}%  '
              f'BE={st["be"]:.1f}%  {"ABOVE" if st["above_be"] else "below"}{flag}')

    all_t = results['BNB'].get(lbl, []) + results['XRP'].get(lbl, [])
    st_all = stats(all_t)
    print(f'\n  BNB+XRP GESAMT: N={st_all["n"]:4d}  WR={st_all["wr"]:.1f}%  avg={st_all["avg"]:+.3f}%')

    print(f'\n  Jahr-Breakdown:')
    yr_wrs = []
    for yr in YEARS:
        yr_t = [t for t in all_t if t['year'] == yr]
        st_y = stats(yr_t)
        yr_wrs.append(st_y['wr'])
        flag = ' ***' if st_y['wr'] >= 70 else ('  *' if st_y['wr'] >= 65 else '  !')
        print(f'    {yr}: N={st_y["n"]:4d}  WR={st_y["wr"]:.1f}%  TP={st_y["n_tp"]}  '
              f'SL={st_y["n_sl"]}  TO={st_y["n_to"]}{flag}')
    valid = [w for w in yr_wrs if w > 0]
    stable = all(w >= 65 for w in valid)
    print(f'\n  WR-Stabilitaet (>= 65%): {"JA - STABIL" if stable else "NEIN - instabil"}')

print(f'\nGesamtlaufzeit: {int(time.time()-t_start)}s')
