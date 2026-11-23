"""
R/R + Hold-Time Grid: findet den optimalen R/R und max_bars.
Testet auch idm-daily + idm-stack unter verschiedenen R/R.
"""
import subprocess, json, os, sys, time

PYTHON = sys.executable
SCRIPT = os.path.join(os.path.dirname(__file__), 'backtest_smc.py')
BASE = ['--all-symbols', '--year', '--pin-bar', '0.70', '--json']

CONFIGS = [
    # combined-15m — R/R sweep
    ('c15m RR1.5 48h',   ['--mode','combined-15m','--max-bars','48','--tp-rr','1.5']),
    ('c15m RR2.0 48h',   ['--mode','combined-15m','--max-bars','48','--tp-rr','2.0']),
    ('c15m RR2.0 96h',   ['--mode','combined-15m','--max-bars','96','--tp-rr','2.0']),
    ('c15m RR2.5 96h',   ['--mode','combined-15m','--max-bars','96','--tp-rr','2.5']),
    ('c15m RR3.0 192h',  ['--mode','combined-15m','--max-bars','192','--tp-rr','3.0']),
    # idm-daily — different R/R
    ('idm-d RR2.0 96h',  ['--mode','idm-daily','--max-bars','96','--tp-rr','2.0']),
    ('idm-d RR1.5 96h',  ['--mode','idm-daily','--max-bars','96','--tp-rr','1.5']),
    # idm-stack — different R/R
    ('idm-s RR2.0 48h',  ['--mode','idm-stack','--max-bars','48','--tp-rr','2.0']),
    ('idm-s RR1.5 48h',  ['--mode','idm-stack','--max-bars','48','--tp-rr','1.5']),
]

def break_even_wr(rr: float) -> float:
    return 1.0 / (1.0 + rr) * 100

def run_config(label, extra_args):
    cmd = [PYTHON, SCRIPT] + BASE + extra_args
    t0  = time.time()
    r   = subprocess.run(cmd, capture_output=True, text=True, timeout=700,
                         env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
    elapsed = time.time() - t0
    stdout = r.stdout + r.stderr
    lines  = stdout.splitlines()
    json_start = next((i for i, l in enumerate(lines) if l.strip() == '['), None)
    if json_start is None:
        err = [l for l in lines[-5:] if l.strip()]
        return label, 0, 0.0, 0.0, 0.0, 0.0, elapsed, ' | '.join(err[-2:])
    try:
        trades = json.loads('\n'.join(lines[json_start:]))
    except Exception as e:
        return label, 0, 0.0, 0.0, 0.0, 0.0, elapsed, str(e)
    if not trades:
        return label, 0, 0.0, 0.0, 0.0, 0.0, elapsed, ''

    n     = len(trades)
    wins  = sum(1 for t in trades if t['result'] == 'tp')
    touts = sum(1 for t in trades if t['result'] == 'timeout')
    tout_pos = sum(1 for t in trades if t['result'] == 'timeout' and t['pnl_pct'] > 0)
    wr    = wins / n * 100
    pnl0  = sum(1 for t in trades if t['pnl_pct'] > 0) / n * 100
    avg   = sum(t['pnl_pct'] for t in trades) / n
    rr_val = float(next(a for a in extra_args[extra_args.index('--tp-rr')+1:extra_args.index('--tp-rr')+2]))
    be    = break_even_wr(rr_val)
    return label, n, wr, pnl0, avg, be, elapsed, ''

print('=' * 100)
print(' R/R + HOLD-TIME GRID  --  1 Jahr, pin=0.70, alle Symbole')
print('  WR% = result==tp  |  pnl>0% = incl. profitable timeouts  |  BE = break-even WR at R/R')
print('=' * 100)
print(f'  {"Config":24s}  {"N":>5}  {"WR%":>6}  {"pnl>0%":>7}  {"avgPnL":>8}  {"BE%":>5}  {"above?":>7}  {"Zeit":>5}')
print(f'  {"-"*24}  {"-"*5}  {"-"*6}  {"-"*7}  {"-"*8}  {"-"*5}  {"-"*7}  {"-"*5}')

results = []
for label, extra_args in CONFIGS:
    sys.stdout.write(f'  {label} ...')
    sys.stdout.flush()
    res = run_config(label, extra_args)
    lbl, n, wr, pnl0, avg, be, elapsed, err = res
    if err:
        print(f'\r  {lbl:24s}  ERROR: {err[:50]}')
    else:
        above = 'YES' if wr > be else 'no'
        marker = '  <<' if wr > be and wr >= 30 else ''
        print(f'\r  {lbl:24s}  {n:>5}  {wr:>5.1f}%  {pnl0:>6.1f}%  {avg:>+7.3f}%  {be:>4.1f}%  {above:>7}{marker}')
    results.append({'label': lbl, 'n': n, 'wr': wr, 'pnl0': pnl0, 'avg': avg, 'be': be, 'err': err})

print('=' * 100)
valid = [r for r in results if r['n'] > 0 and not r['err']]
above_be = [r for r in valid if r['wr'] > r['be']]
if above_be:
    print(f'\n  Configs ABOVE break-even (wr > be):')
    for r in sorted(above_be, key=lambda x: x['wr'], reverse=True):
        print(f'    {r["label"]:24s}  WR={r["wr"]:.1f}%  BE={r["be"]:.1f}%  margin={r["wr"]-r["be"]:+.1f}%  N={r["n"]}')
else:
    print('\n  No configs above break-even.')
if valid:
    best_avg = max(valid, key=lambda r: r['avg'])
    print(f'\n  Best avgPnL: {best_avg["label"]}  avg={best_avg["avg"]:+.3f}%  N={best_avg["n"]}')
print()
