"""
Scalping WR grid — combined-15m over 4 years, in-process (data fetched once, reused across configs).

Break-even WR = 1 / (1 + R/R):
  R/R=0.3→76.9%  R/R=0.5→66.7%  R/R=0.75→57.1%  R/R=1.0→50%  R/R=1.5→40%
"""
import importlib.util, pathlib, sys, os, json, time

# ── Import backtest_smc in-process so _cache is shared ───────────────────────
_HERE  = pathlib.Path(__file__).resolve().parent
_spec  = importlib.util.spec_from_file_location('backtest_smc', _HERE / 'backtest_smc.py')
bt     = importlib.util.module_from_spec(_spec)
sys.argv = ['backtest_smc.py']  # prevent argparse from firing
_spec.loader.exec_module(bt)

SYMBOLS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP']
YEARS   = 4

# ── Bar counts for N years ────────────────────────────────────────────────────
BARS_DAILY = YEARS * 365
BARS_4H    = YEARS * 2200
BARS_15M   = YEARS * 35200

# ── Configs: (label, tp_rr, max_bars_h, score_min, max_sl_dist) ──────────────
CONFIGS = [
    # Scalping — tiny TP
    ('RR0.3  2h sc9 sl<2.0', 0.30,  2, 9, 2.0),
    ('RR0.3  4h sc9 sl<2.0', 0.30,  4, 9, 2.0),
    ('RR0.3  8h sc9 sl<2.0', 0.30,  8, 9, 2.0),
    ('RR0.5  2h sc9 sl<2.0', 0.50,  2, 9, 2.0),
    ('RR0.5  4h sc9 sl<2.0', 0.50,  4, 9, 2.0),
    ('RR0.5  8h sc9 sl<2.0', 0.50,  8, 9, 2.0),
    ('RR0.5  2h sc9 sl<1.5', 0.50,  2, 9, 1.5),
    ('RR0.5  4h sc9 sl<1.5', 0.50,  4, 9, 1.5),
    ('RR0.5  4h all  sl<2.0', 0.50, 4, 0, 2.0),
    # Swing — reference configs
    ('RR0.75 4h sc9 sl<2.0', 0.75,  4, 9, 2.0),
    ('RR0.75 8h sc9 sl<2.0', 0.75,  8, 9, 2.0),
    ('RR0.75 24h sc9 sl<2.0',0.75, 24, 9, 2.0),
    ('RR1.0  4h sc9 sl<2.0', 1.00,  4, 9, 2.0),
    ('RR1.0  8h sc9 sl<2.0', 1.00,  8, 9, 2.0),
    ('RR1.5  48h sc9 sl<1.5',1.50, 48, 9, 1.5),  # reference (prev best)
]

PIN_BAR = 0.70

# ── Fetch data once ───────────────────────────────────────────────────────────
print(f'Fetching {YEARS}-year data for {len(SYMBOLS)} symbols…')
t_fetch = time.time()
data: dict = {}
for sym in SYMBOLS:
    print(f'  {sym} daily…', end=' ', flush=True)
    daily = bt.fetch_binance_paginated(sym, '1d', BARS_DAILY)
    print(f'{len(daily)}d  4h…', end=' ', flush=True)
    h4    = bt.fetch_binance_paginated(sym, '4h', BARS_4H)
    print(f'{len(h4)}h4  15m…', end=' ', flush=True)
    m15   = bt.fetch_binance_paginated(sym, '15m', BARS_15M)
    print(f'{len(m15)}x15m')
    data[sym] = (daily, h4, m15)

print(f'Data fetched in {int(time.time()-t_fetch)}s\n')

# ── Run grid ──────────────────────────────────────────────────────────────────
def be_wr(rr: float) -> float:
    return round(100.0 / (1.0 + rr), 1)

print('=' * 108)
print(f' SCALPING WR GRID  —  {YEARS} Jahre, combined-15m, pin={PIN_BAR}, alle Symbole')
print(f'   WR% = result==tp  |  pnl>0% inkl. Timeouts  |  BE = Break-Even WR bei R/R')
print('=' * 108)
print(f'  {"Config":<26} {"N":>5}  {"WR%":>6}  {"pnl>0%":>7}  {"avgPnL":>9}  {"BE%":>6}  {"above?":>7}  {"Zeit":>5}')
print(f'  {"-"*26}  {"-"*5}  {"-"*6}  {"-"*7}  {"-"*9}  {"-"*6}  {"-"*7}  {"-"*5}')
sys.stdout.flush()

results = []
for label, tp_rr, max_bars_h, score_min, max_sl_dist in CONFIGS:
    t0 = time.time()
    all_trades = []
    max_bars_15m = max_bars_h * 4  # hours → 15m bars

    for sym in SYMBOLS:
        daily, h4, m15 = data[sym]
        if len(daily) < bt.WARMUP_DAILY + 10 or len(h4) < bt.WARMUP_H4 + 10:
            continue
        if len(m15) < bt.WARMUP_15M + 10:
            continue
        trades = bt.run_combined_backtest_15m(
            sym, daily, h4, m15,
            pin_bar_threshold=PIN_BAR,
            tp_rr=tp_rr,
            max_bars_15m=max_bars_15m,
            score_min=score_min,
            max_sl_dist=max_sl_dist,
        )
        all_trades.extend(trades)

    dt = round(time.time() - t0, 1)
    n  = len(all_trades)

    if n == 0:
        print(f'  {label:<26}  {"0":>5}  {"—":>6}  {"—":>7}  {"—":>9}  {"—":>6}  {"—":>7}  {dt:>4}s')
        sys.stdout.flush()
        continue

    n_tp    = sum(1 for t in all_trades if t['result'] == 'tp')
    n_pos   = sum(1 for t in all_trades if t['pnl_pct'] > 0)
    wr      = round(n_tp / n * 100, 1)
    pos_pct = round(n_pos / n * 100, 1)
    avg     = round(sum(t['pnl_pct'] for t in all_trades) / n, 3)
    be      = be_wr(tp_rr)
    above   = 'YES ***' if wr > be else 'no'

    print(f'  {label:<26}  {n:>5}  {wr:>5.1f}%  {pos_pct:>6.1f}%  {avg:>+8.3f}%  {be:>5.1f}%  {above:>7}  {dt:>4}s')
    sys.stdout.flush()
    results.append({'label': label, 'tp_rr': tp_rr, 'max_bars_h': max_bars_h,
                    'score_min': score_min, 'max_sl_dist': max_sl_dist,
                    'n': n, 'wr': wr, 'pos_pct': pos_pct, 'avg': avg,
                    'be': be, 'above_be': wr > be})

print('=' * 108)

above_be = [r for r in results if r['above_be']]
if above_be:
    best = max(above_be, key=lambda r: r['wr'])
    print(f'\n  Beste WR: {best["label"]}  WR={best["wr"]}%  avg={best["avg"]:+.3f}%  N={best["n"]}')
    print(f'\n  {len(above_be)} Config(s) ueber Break-Even:')
    for r in sorted(above_be, key=lambda x: -x['wr']):
        print(f'    {r["label"]:28s} WR={r["wr"]:.1f}%  BE={r["be"]:.1f}%  avg={r["avg"]:+.3f}%  N={r["n"]}')
else:
    print('\n  Keine Config erreicht Break-Even WR.')

os.makedirs('C:/TradeLogs', exist_ok=True)
out_path = 'C:/TradeLogs/scalp_grid_results.json'
with open(out_path, 'w') as f:
    json.dump(results, f, indent=2)
print(f'\n  Ergebnisse gespeichert: {out_path}')
