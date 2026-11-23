"""
4-Jahres-Validierung OB-Scalp-Strategie (ob_scalp_4h+1m).

Ziel: Prüfen ob 72-75% WR stabil über alle Marktphasen gilt.
Breakdown: Jahr × Symbol × Config.

Configs:
  TP0.20% 2h pin0.5 — bester Erwartungswert
  TP0.15% 2h pin0.5 — höchste WR
  TP0.10% 2h pin0.5 — engste TP-Ziel

Referenz: combined-15m RR1.5 48h sc9 sl<1.5 (Swing-System)
"""
import importlib.util, pathlib, sys, bisect, json, os, time
from datetime import datetime, timezone

sys.argv = ['x']
_HERE = pathlib.Path(__file__).resolve().parent
spec  = importlib.util.spec_from_file_location('bt', _HERE / 'backtest_smc.py')
bt    = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)

SYMBOLS  = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP']
YEARS_4  = 4
B_DAILY  = YEARS_4 * 365
B_4H     = YEARS_4 * 2200
B_1M     = YEARS_4 * 365 * 24 * 60   # 2 102 400

# ── Scalp-Funktion (pin_ratio parametrisierbar) ───────────────────────────────
def scalp(symbol, candles_daily, candles_4h, candles_1m,
          tp_pct, max_bars_1m, pin_ratio=0.5, score_min=9):
    bt._mod.SWEEP_G1_PIN_BAR_THRESHOLD = 0.70
    trades = []; pending_ob = {}; last_entry = -99; last_h4_end = -1; ema200 = 50_000.0
    h4ts = [c['timestamp'] for c in candles_4h]
    dts  = [c['timestamp'] for c in candles_daily]

    for j in range(bt.WARMUP_1M, len(candles_1m) - 1):
        if j - last_entry < 60:
            continue
        ts = candles_1m[j]['timestamp']
        h4e = bisect.bisect_right(h4ts, ts)
        de  = bisect.bisect_right(dts, ts)
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
        return {'n': 0, 'wr': 0, 'avg': 0, 'be': 0, 'above_be': False}
    n_tp   = sum(1 for t in trades if t['result'] == 'tp')
    wr     = round(n_tp / n * 100, 1)
    avg    = round(sum(t['pnl_pct'] for t in trades) / n, 3)
    sl_vals = [t['sl_dist_pct'] for t in trades if 'sl_dist_pct' in t]
    avsl   = sum(sl_vals) / len(sl_vals) if sl_vals else 0
    tp_pct_avg = sum(abs(t['pnl_pct']) for t in trades if t['result'] == 'tp') / max(n_tp, 1)
    rr_a   = tp_pct_avg / avsl if avsl > 0 else 0
    be     = round(100 / (1 + rr_a), 1) if rr_a > 0 else 99.0
    return {'n': n, 'wr': wr, 'avg': avg, 'be': be, 'above_be': wr > be,
            'n_tp': n_tp, 'n_sl': sum(1 for t in trades if t['result'] == 'sl'),
            'n_to': sum(1 for t in trades if t['result'] == 'timeout')}


# ── Configs ───────────────────────────────────────────────────────────────────
CONFIGS = [
    ('TP0.20% 2h pin0.5', 0.20, 120, 0.5),
    ('TP0.15% 2h pin0.5', 0.15, 120, 0.5),
    ('TP0.10% 2h pin0.5', 0.10, 120, 0.5),
]
YEARS  = list(range(2023, 2027))
B_15M  = YEARS_4 * 35200

# Memory-efficient: process one symbol at a time, del 1m after each
# (2.1M 1m-bars × Python-dict ≈ 1.1GB/Symbol — nie alle 5 gleichzeitig laden!)
per_sym_trades: dict = {cfg: {} for cfg, *_ in CONFIGS}
swing_all: list = []

print(f'=== OB-Scalp 4-Jahres-Validierung (memory-safe) ===')
print(f'Symbole: {SYMBOLS}  |  3 Configs  |  Swing-Referenz')
print(f'Strategie: 1 Symbol pro Runde, 1m-Cache nach jedem Symbol geloescht.\n')

t_start = time.time()

for s in SYMBOLS:
    t0 = time.time()
    print(f'\n--- {s} ---', flush=True)
    print(f'  daily...', end=' ', flush=True)
    daily = bt.fetch_binance_paginated(s, '1d', B_DAILY)
    print(f'{len(daily)}d  4h...', end=' ', flush=True)
    h4    = bt.fetch_binance_paginated(s, '4h', B_4H)
    print(f'{len(h4)}h4  1m (~10min)...', flush=True)
    m1    = bt.fetch_binance_paginated(s, '1m', B_1M)
    print(f'  {s}: {len(m1):,}x1m geladen in {int(time.time()-t0)}s', flush=True)

    for cfg_label, tp_pct, max_bars, pin_ratio in CONFIGS:
        trades = scalp(s, daily, h4, m1, tp_pct, max_bars, pin_ratio)
        per_sym_trades[cfg_label][s] = trades
        st = stats(trades)
        flag = ' ***' if st['wr'] >= 70 else ''
        print(f'  [{cfg_label}] {s}: N={st["n"]:4d}  WR={st["wr"]:.1f}%  avg={st["avg"]:+.3f}%  BE={st["be"]:.1f}%{flag}', flush=True)

    # Swing-Referenz für dieses Symbol
    print(f'  [swing] {s}: fetching 15m...', end=' ', flush=True)
    m15 = bt.fetch_binance_paginated(s, '15m', B_15M)
    t_sw = bt.run_combined_backtest_15m(s, daily, h4, m15, 0.70, 1.5, 48*4,
                                         score_min=9, max_sl_dist=1.5)
    swing_all += t_sw
    wr_sw = sum(1 for x in t_sw if x['result'] == 'tp') / max(len(t_sw), 1) * 100
    print(f'{len(t_sw)} trades  WR={wr_sw:.1f}%', flush=True)

    # 1m + 15m aus Cache entfernen → RAM freigeben
    bt._cache.pop(f'{s}_1m_paged', None)
    bt._cache.pop(f'{s}_15m_paged', None)
    del m1, m15
    print(f'  {s} fertig in {int(time.time()-t0)}s. 1m+15m-Cache geloescht.', flush=True)

print(f'\nAlle Symbole verarbeitet in {int(time.time()-t_start)}s\n')

# ── Aggregierte Ergebnisse pro Config ────────────────────────────────────────
all_results = {}

for cfg_label, tp_pct, max_bars, pin_ratio in CONFIGS:
    all_trades = []
    for s in SYMBOLS:
        all_trades += per_sym_trades[cfg_label].get(s, [])

    print(f'\n{"="*80}')
    print(f' Config: {cfg_label}')
    print(f'{"="*80}')
    for s in SYMBOLS:
        st = stats(per_sym_trades[cfg_label].get(s, []))
        flag = ' ***' if st['wr'] >= 70 else ''
        print(f'  {s:4s}: N={st["n"]:4d}  WR={st["wr"]:.1f}%  avg={st["avg"]:+.3f}%  BE={st["be"]:.1f}%  {"ABOVE" if st["above_be"] else "below"}{flag}')

    st_all = stats(all_trades)
    print(f'\n  GESAMT: N={st_all["n"]:4d}  WR={st_all["wr"]:.1f}%  avg={st_all["avg"]:+.3f}%  '
          f'BE={st_all["be"]:.1f}%  {"ABOVE BE" if st_all["above_be"] else "BELOW BE"}')

    print(f'\n  Jahr-Breakdown (Stabilitaetscheck):')
    yr_wrs = []
    for yr in YEARS:
        yr_trades = [t for t in all_trades if t['year'] == yr]
        st_yr = stats(yr_trades)
        yr_wrs.append(st_yr['wr'])
        flag = ' ***' if st_yr['wr'] >= 70 else ('  *' if st_yr['wr'] >= 60 else '  !')
        print(f'    {yr}: N={st_yr["n"]:4d}  WR={st_yr["wr"]:.1f}%  avg={st_yr["avg"]:+.3f}%  '
              f'TP={st_yr.get("n_tp",0)}  SL={st_yr.get("n_sl",0)}  TO={st_yr.get("n_to",0)}{flag}')

    valid_yr_wrs = [w for w in yr_wrs if w > 0]
    stable = all(w >= 65 for w in valid_yr_wrs)
    print(f'\n  WR-Stabilitaet (alle Jahre >= 65%): {"JA - STABIL" if stable else "NEIN - instabil"}')
    if valid_yr_wrs:
        print(f'  WR-Spanne: {min(valid_yr_wrs):.1f}% - {max(valid_yr_wrs):.1f}%')

    n_per_yr = st_all['n'] / YEARS_4
    eur_per_trade = 200 * st_all['avg'] / 100
    eur_per_yr = round(n_per_yr * eur_per_trade, 2)
    print(f'\n  Profit-Schaetzer (200 EUR Notional/Trade):')
    print(f'    ~{n_per_yr:.0f} Trades/Jahr × {eur_per_trade:+.4f} EUR/Trade = {eur_per_yr:+.2f} EUR/Jahr')

    all_results[cfg_label] = {
        'tp_pct': tp_pct, 'max_bars': max_bars,
        'total': st_all,
        'by_year': {str(yr): stats([t for t in all_trades if t['year'] == yr]) for yr in YEARS},
        'by_symbol': {s: stats(per_sym_trades[cfg_label].get(s, [])) for s in SYMBOLS},
    }

# ── Swing-Referenz-Zusammenfassung ───────────────────────────────────────────
st_sw = stats(swing_all)
print(f'\n\n{"="*80}')
print(f' REFERENZ: Swing combined-15m RR1.5 48h sc9 sl<1.5 (4 Jahre)')
print(f'{"="*80}')
print(f'  GESAMT: N={st_sw["n"]}  WR={st_sw["wr"]:.1f}%  avg={st_sw["avg"]:+.3f}%')

# ── Zusammenfassung + Entscheidungshilfe ─────────────────────────────────────
print(f'\n\n{"="*80}')
print(f' ENTSCHEIDUNGSMATRIX (4 Jahre, 5 Symbole)')
print(f'{"="*80}')
print(f'  {"System":<28} {"N":>5}  {"WR%":>6}  {"avgPnL":>9}  {"EUR/Jahr":>9}  {"Stabil":>8}')
print(f'  {"-"*28}  {"-"*5}  {"-"*6}  {"-"*9}  {"-"*9}  {"-"*8}')

for cfg_label, _, _, _ in CONFIGS:
    r  = all_results[cfg_label]
    st = r['total']
    yr_wrs = [r['by_year'][yr]['wr'] for yr in YEARS if r['by_year'][yr]['n'] > 0]
    stable = 'JA' if all(w >= 65 for w in yr_wrs) else 'NEIN'
    n_yr   = st['n'] / YEARS_4
    eur_yr = round(n_yr * 200 * st['avg'] / 100, 2)
    print(f'  {cfg_label:<28}  {st["n"]:>5}  {st["wr"]:>5.1f}%  {st["avg"]:>+8.3f}%  {eur_yr:>+8.2f}  {stable:>8}')

eur_sw = round(st_sw['n'] / YEARS_4 * 200 * st_sw['avg'] / 100, 2)
print(f'  {"Swing RR1.5/48h sc9 sl<1.5":<28}  {st_sw["n"]:>5}  {st_sw["wr"]:>5.1f}%  {st_sw["avg"]:>+8.3f}%  {eur_sw:>+8.2f}  {"(ref)":>8}')

# ── Save ──────────────────────────────────────────────────────────────────────
os.makedirs('C:/TradeLogs', exist_ok=True)
save = {}
for lbl, r in all_results.items():
    save[lbl] = {k: v for k, v in r.items() if k != 'trades'}  # exclude raw trades to keep size small
save['swing_reference'] = {'total': st_sw}
with open('C:/TradeLogs/ob_scalp_4yr_validation.json', 'w') as f:
    json.dump(save, f, indent=2)
print(f'\n  Gespeichert: C:/TradeLogs/ob_scalp_4yr_validation.json')
print(f'  Gesamtlaufzeit: {int(time.time()-t_start)}s')
