"""
Backtest-Grid: vergleicht 8 Konfigurationen auf allen Symbolen (1 Jahr).
Gibt eine kompakte WR-Tabelle aus.
"""
import subprocess, json, os, sys, time

PYTHON = sys.executable
SCRIPT = os.path.join(os.path.dirname(__file__), 'backtest_smc.py')
BASE_ARGS = ['--all-symbols', '--year', '--tp-rr', '3.0', '--pin-bar', '0.70', '--json']

CONFIGS = [
    ('baseline   combined-15m 48h',  ['--mode','combined-15m','--max-bars','48']),
    ('+96h hold  combined-15m 96h',  ['--mode','combined-15m','--max-bars','96']),
    ('+sl2.5pct  combined-15m 48h',  ['--mode','combined-15m','--max-bars','48','--min-sl-dist','2.5']),
    ('+bear-flt  combined-15m 48h',  ['--mode','combined-15m','--max-bars','48','--bear-filter']),
    ('all-3-flt  combined-15m 96h',  ['--mode','combined-15m','--max-bars','96','--min-sl-dist','2.5','--bear-filter']),
    ('idm-stack  4H+1H+15m   48h',  ['--mode','idm-stack',   '--max-bars','48']),
    ('idm-stk+3  4H+1H+15m   96h',  ['--mode','idm-stack',   '--max-bars','96','--min-sl-dist','2.5','--bear-filter']),
    ('idm-daily  daily->4H   48h',  ['--mode','idm-daily',   '--max-bars','48']),
]

def run_config(label, extra_args):
    cmd = [PYTHON, SCRIPT] + BASE_ARGS + extra_args
    t0  = time.time()
    r   = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                         env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
    elapsed = time.time() - t0

    stdout = r.stdout + r.stderr
    lines  = stdout.splitlines()
    json_start = next((i for i, l in enumerate(lines) if l.strip() == '['), None)
    if json_start is None:
        err_lines = [l for l in lines[-10:] if l.strip()]
        return label, 0, 0.0, 0.0, 0.0, elapsed, ' | '.join(err_lines[-3:])

    try:
        trades = json.loads('\n'.join(lines[json_start:]))
    except Exception as e:
        return label, 0, 0.0, 0.0, 0.0, elapsed, f'JSON error: {e}'

    if not trades:
        return label, 0, 0.0, 0.0, 0.0, elapsed, ''

    n    = len(trades)
    wins = sum(1 for t in trades if t['result'] == 'tp')
    wr   = wins / n * 100
    avg  = sum(t['pnl_pct'] for t in trades) / n
    tot  = sum(t['pnl_pct'] for t in trades)
    return label, n, wr, avg, tot, elapsed, ''

print('=' * 82)
print(' SMC BACKTEST GRID  --  1 Jahr, R/R=3.0, pin=0.70, alle Symbole')
print('=' * 82)
print(f'  {"Config":38s}  {"N":>5}  {"WR%":>6}  {"avgPnL":>8}  {"totPnL":>9}  {"Zeit":>5}')
print(f'  {"-"*38}  {"-"*5}  {"-"*6}  {"-"*8}  {"-"*9}  {"-"*5}')

results = []
for label, extra_args in CONFIGS:
    sys.stdout.write(f'  Running: {label} ...')
    sys.stdout.flush()
    res = run_config(label, extra_args)
    lbl, n, wr, avg, tot, elapsed, err = res
    if err:
        print(f'\r  {lbl:38s}  ERROR: {err[:60]}')
    else:
        marker = '  <-- best WR' if wr >= 55 else ''
        print(f'\r  {lbl:38s}  {n:>5}  {wr:>5.1f}%  {avg:>+7.3f}%  {tot:>+8.1f}%  {elapsed:>4.0f}s{marker}')
    results.append({'label': lbl, 'n': n, 'wr': wr, 'avg': avg, 'tot': tot, 'err': err})

print('=' * 82)
valid = [r for r in results if r['n'] > 0 and not r['err']]
if valid:
    best_wr  = max(valid, key=lambda r: r['wr'])
    best_avg = max(valid, key=lambda r: r['avg'])
    baseline = next((r for r in valid if 'baseline' in r['label']), None)
    print(f'  Best WR   : {best_wr["label"].strip():<40}  WR={best_wr["wr"]:.1f}%  N={best_wr["n"]}')
    print(f'  Best avg  : {best_avg["label"].strip():<40}  avg={best_avg["avg"]:+.3f}%  N={best_avg["n"]}')
    if baseline:
        print(f'\n  Delta vs baseline (WR={baseline["wr"]:.1f}%):')
        for r in valid:
            if r is baseline: continue
            d = r['wr'] - baseline['wr']
            sign = '+' if d >= 0 else ''
            print(f'    {r["label"].strip():<40}  {sign}{d:.1f}%  (N={r["n"]})')
print()
