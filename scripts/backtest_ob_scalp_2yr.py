"""
2-Jahres-Validierung OB-Scalp-Strategie (ob_scalp_4h+1m).
Config: TP0.15% 2h pin0.5 score>=9 — beste stabile Config aus 4yr-Backtest.
Symbole: BTC, ETH, SOL, BNB, XRP
"""
import importlib.util, pathlib, sys, bisect, json, os, time
from datetime import datetime, timezone

sys.argv = ['x']
_HERE = pathlib.Path(__file__).resolve().parent
spec  = importlib.util.spec_from_file_location('bt', _HERE / 'backtest_smc.py')
bt    = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)

SYMBOLS  = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP']
YEARS    = 2
B_DAILY  = YEARS * 365
B_4H     = YEARS * 2200
B_1M     = YEARS * 365 * 24 * 60   # ~1 051 200

TP_PCT    = 0.15
MAX_BARS  = 120   # 2h hold
PIN_RATIO = 0.5
SCORE_MIN = 9


def scalp(symbol, candles_daily, candles_4h, candles_1m):
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
            h4s  = candles_4h[:h4e]
            ds   = candles_daily[:de]
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
        if ob['score'] < SCORE_MIN:
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
        if body <= 0 or lwick < body * PIN_RATIO:
            continue
        eb = j + 1
        if eb >= len(candles_1m):
            continue
        ep  = candles_1m[eb]['open']
        slp = ob['sl'] * 0.999
        sld = ep - slp
        if sld <= 0 or sld / ep * 100 > TP_PCT * 3:
            continue
        tp  = ep * (1 + TP_PCT / 100)
        out = bt.simulate_exit(candles_1m, eb, ep, slp, tp, MAX_BARS)
        signal_dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        trades.append({
            'symbol':      symbol,
            'score':       ob['score'],
            'signal_ts':   signal_dt.strftime('%Y-%m-%d %H:%M'),
            'year':        signal_dt.year,
            'entry_price': round(ep, 6),
            'sl':          round(slp, 6),
            'tp':          round(tp, 6),
            'sl_dist_pct': round(sld / ep * 100, 3),
            **out,
        })
        del pending_ob[symbol]
        last_entry = eb
    return trades


def stats(trades):
    n = len(trades)
    if n == 0:
        return {'n': 0, 'wr': 0.0, 'avg': 0.0, 'be': 0.0}
    n_tp  = sum(1 for t in trades if t['result'] == 'tp')
    n_sl  = sum(1 for t in trades if t['result'] == 'sl')
    n_to  = sum(1 for t in trades if t['result'] == 'timeout')
    wr    = round(n_tp / n * 100, 1)
    avg   = round(sum(t['pnl_pct'] for t in trades) / n, 3)
    sl_v  = [t['sl_dist_pct'] for t in trades]
    avsl  = sum(sl_v) / len(sl_v) if sl_v else 0
    tp_v  = [abs(t['pnl_pct']) for t in trades if t['result'] == 'tp']
    avtp  = sum(tp_v) / max(len(tp_v), 1)
    rr    = avtp / avsl if avsl > 0 else 0
    be    = round(100 / (1 + rr), 1) if rr > 0 else 99.0
    return {'n': n, 'wr': wr, 'avg': avg, 'be': be,
            'n_tp': n_tp, 'n_sl': n_sl, 'n_to': n_to}


print(f'=== OB-Scalp 2-Jahres-Validierung ===')
print(f'Config: TP={TP_PCT}% / {MAX_BARS}min / pin>={PIN_RATIO} / Score>={SCORE_MIN}')
print(f'Symbole: {SYMBOLS}\n')

t_start   = time.time()
all_trades = []

for s in SYMBOLS:
    t0 = time.time()
    print(f'--- {s} ---', flush=True)
    daily = bt.fetch_binance_paginated(s, '1d', B_DAILY)
    h4    = bt.fetch_binance_paginated(s, '4h', B_4H)
    print(f'  {len(daily)}d  {len(h4)}h4  1m (~5min)...', flush=True)
    m1    = bt.fetch_binance_paginated(s, '1m', B_1M)
    print(f'  {s}: {len(m1):,}x1m in {int(time.time()-t0)}s', flush=True)

    trades = scalp(s, daily, h4, m1)
    st = stats(trades)
    all_trades += trades
    flag = ' ***' if st['wr'] >= 70 else (' **' if st['wr'] >= 65 else '')
    print(f'  {s}: N={st["n"]:4d}  WR={st["wr"]:.1f}%  avg={st["avg"]:+.3f}%  '
          f'BE={st["be"]:.1f}%  TP={st.get("n_tp",0)}  SL={st.get("n_sl",0)}  TO={st.get("n_to",0)}{flag}', flush=True)

    bt._cache.pop(f'{s}_1m_paged', None)
    del m1

print(f'\nAlle Symbole in {int(time.time()-t_start)}s\n')

# ── Gesamt ────────────────────────────────────────────────────────────────────
st_all = stats(all_trades)
print(f'{"="*60}')
print(f' GESAMT (2 Jahre, {len(SYMBOLS)} Symbole):')
print(f'  N={st_all["n"]}  WR={st_all["wr"]:.1f}%  avg={st_all["avg"]:+.3f}%  BE={st_all["be"]:.1f}%')
print(f'  {"ABOVE BE" if st_all["wr"] > st_all["be"] else "BELOW BE"}')

# ── Jahr-Breakdown ────────────────────────────────────────────────────────────
years = sorted({t['year'] for t in all_trades})
print(f'\n Jahr-Breakdown:')
for yr in years:
    yr_t = [t for t in all_trades if t['year'] == yr]
    s = stats(yr_t)
    flag = ' ***' if s['wr'] >= 70 else (' *' if s['wr'] >= 65 else '  !')
    print(f'  {yr}: N={s["n"]:4d}  WR={s["wr"]:.1f}%  avg={s["avg"]:+.3f}%  '
          f'TP={s.get("n_tp",0)}  SL={s.get("n_sl",0)}  TO={s.get("n_to",0)}{flag}')

yr_wrs = [stats([t for t in all_trades if t['year'] == yr])['wr'] for yr in years]
stable  = all(w >= 65 for w in yr_wrs if w > 0)
print(f'\n WR-Stabilitaet (>= 65% jedes Jahr): {"JA - STABIL" if stable else "NEIN - instabil"}')
print(f' WR-Spanne: {min(yr_wrs):.1f}% - {max(yr_wrs):.1f}%')

# ── Symbol-Breakdown ──────────────────────────────────────────────────────────
print(f'\n Symbol-Breakdown:')
for s in SYMBOLS:
    sym_t = [t for t in all_trades if t['symbol'] == s]
    st = stats(sym_t)
    flag = ' ***' if st['wr'] >= 70 else ''
    print(f'  {s:4s}: N={st["n"]:4d}  WR={st["wr"]:.1f}%  avg={st["avg"]:+.3f}%{flag}')

# ── Profit-Schätzer ────────────────────────────────────────────────────────────
n_yr     = st_all['n'] / YEARS
eur_trade = 200 * st_all['avg'] / 100
eur_yr   = round(n_yr * eur_trade, 2)
print(f'\n Profit-Schätzer (200 EUR Notional/Trade):')
print(f'  ~{n_yr:.0f} Trades/Jahr × {eur_trade:+.4f} EUR/Trade = {eur_yr:+.2f} EUR/Jahr')

# ── Implementierungscheck ──────────────────────────────────────────────────────
ref_wr = 73.9
ref_be = 68.3
print(f'\n{"="*60}')
print(f' IMPLEMENTIERUNGSCHECK vs. 4yr-Referenz (TP0.15%):')
print(f'  4yr WR: {ref_wr}%  ->  2yr WR: {st_all["wr"]:.1f}%')
delta = st_all['wr'] - ref_wr
status = 'OK' if abs(delta) <= 5 else 'ABWEICHUNG'
print(f'  Delta: {delta:+.1f}pp  ->  {status}')
print(f'  {"IMPLEMENTIERUNG KORREKT" if status == "OK" else "BITTE PRUEFEN"}')
print(f'{"="*60}')

# ── Save ──────────────────────────────────────────────────────────────────────
os.makedirs('C:/TradeLogs', exist_ok=True)
result = {
    'config': {'tp_pct': TP_PCT, 'max_bars': MAX_BARS, 'pin_ratio': PIN_RATIO, 'score_min': SCORE_MIN, 'years': YEARS},
    'total': st_all,
    'by_year': {str(yr): stats([t for t in all_trades if t['year'] == yr]) for yr in years},
    'by_symbol': {s: stats([t for t in all_trades if t['symbol'] == s]) for s in SYMBOLS},
    'ref_4yr_wr': ref_wr,
    'delta_pp': round(delta, 1),
    'status': status,
}
with open('C:/TradeLogs/ob_scalp_2yr_validation.json', 'w') as f:
    json.dump(result, f, indent=2)
print(f'Ergebnisse gespeichert: C:/TradeLogs/ob_scalp_2yr_validation.json')
