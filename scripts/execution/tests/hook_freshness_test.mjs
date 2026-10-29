#!/usr/bin/env node
/**
 * Freshness-Gate (Problem #3-Fix) — Hook-Tests (HG-01 … HG-09).
 *
 * node scripts/execution/tests/hook_freshness_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 *
 * Isolation: der Hook wird als Subprozess mit HOOK_LOGS_DIR auf ein
 * Temp-Verzeichnis ausgeführt. Das echte trading/logs wird nie angefasst.
 * Die Tests prüfen die KONKRETEN Entscheidungsgründe im Direktiven-Text,
 * nicht nur ein Boolean.
 */

import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir }                                 from 'os';
import { execFileSync }                           from 'child_process';
import { fileURLToPath }                          from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', '..', '..', 'trading');

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'session_start_hook.mjs');

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const SCRATCH = join(tmpdir(), `hookgate_${process.pid}`);

function runHook(tcId, files = {}) {
  const dir = join(SCRATCH, tcId);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  }
  const out = execFileSync(process.execPath, [HOOK], {
    env: { ...process.env, HOOK_LOGS_DIR: dir },
    timeout: 15_000,
  }).toString('utf8');
  return JSON.parse(out).hookSpecificOutput.additionalContext;
}

function makeRun(ageMinutes, { tvOk = 2, tvBad = 0, marks = undefined } = {}) {
  const cand = (sym, ok) => ({ symbol: sym, price_usd: 100, technical: { available: ok } });
  const longs = [];
  for (let i = 0; i < tvOk; i++)  longs.push(cand(`OK${i}`, true));
  for (let i = 0; i < tvBad; i++) longs.push(cand(`BAD${i}`, false));
  return {
    run_at: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
    run_id: `run_test_${ageMinutes}`,
    long_candidates:  longs,
    short_candidates: [],
    ...(marks !== undefined ? { portfolio_marks: marks } : {}),
  };
}

// HG-01 (a): frisch + vollständig → wiederverwenden, mit tv-Angabe
{
  const d = runHook('hg01', { 'run_a.json': makeRun(10, { tvOk: 20, marks: { MU: { available: true, price_usd: 910 } } }) });
  check('HG-01',
    d.includes('Kein neuer Full-Scan nötig') && d.includes('vollständig (tv 20/20') && d.includes('portfolio_marks ok'),
    'frisch+vollständig → Wiederverwenden mit tv 20/20 + marks ok im Text');
}

// HG-02 (b): frisch + unvollständig (0/20) → Full-Scan mit tv_ratio-Grund + Anti-Loop
{
  const d = runHook('hg02', { 'run_a.json': makeRun(10, { tvOk: 0, tvBad: 20 }) });
  check('HG-02',
    d.includes('UNVOLLSTÄNDIG') && d.includes('tv_ratio_below_threshold (tv_ratio 0 < 0.8, tv 0/20)')
    && d.includes('scan.mjs') && d.includes('Anti-Loop'),
    'frisch+unvollständig → Full-Scan mit explizitem tv_ratio-Grund + Anti-Loop-Hinweis');
}

// HG-03 (c): alt + vollständig → Full-Scan wegen Alter, OHNE Unvollständig-Vorwurf
{
  const d = runHook('hg03', { 'run_a.json': makeRun(120, { tvOk: 20 }) });
  check('HG-03',
    d.includes('SESSION_START DIRECTIVE') && d.includes('120 min alt (> 90 min)')
    && !d.includes('unvollständig') && d.includes('scan.mjs'),
    'alt+vollständig → Full-Scan nur wegen Alter');
}

// HG-04 (d): alt + unvollständig → Full-Scan mit Alter UND Qualitätsgrund
{
  const d = runHook('hg04', { 'run_a.json': makeRun(120, { tvOk: 0, tvBad: 20 }) });
  check('HG-04',
    d.includes('120 min alt (> 90 min)') && d.includes('zudem unvollständig')
    && d.includes('tv_ratio_below_threshold'),
    'alt+unvollständig → beide Gründe im Text');
}

// HG-05 (e): leeres Logs-Verzeichnis → Full-Scan "kein Run gefunden"
{
  const d = runHook('hg05', {});
  check('HG-05', d.includes('kein Run gefunden') && d.includes('scan.mjs'),
    'leeres Verzeichnis → fail-soft Richtung Full-Scan');
}

// HG-06 (f): kaputtes JSON → Full-Scan "invalid_run_json", kein Crash
{
  const d = runHook('hg06', { 'run_broken.json': '{ kaputt' });
  check('HG-06', d.includes('invalid_run_json') && d.includes('run_broken.json') && d.includes('scan.mjs'),
    'kaputtes JSON → fail-soft mit invalid_run_json + Dateiname');
}

// HG-07 (g): Legacy-Log ohne portfolio_marks → darf NICHT daran scheitern
{
  const d = runHook('hg07', { 'run_a.json': makeRun(10, { tvOk: 20 }) });   // kein marks-Feld
  check('HG-07',
    d.includes('Kein neuer Full-Scan nötig') && !d.includes('portfolio_marks_failed'),
    'Legacy-Log ohne portfolio_marks → Wiederverwenden, kein Marks-Vorwurf');
}

// HG-08 (h): portfolio_marks mit available:false → unvollständig mit Zähler
{
  const d = runHook('hg08', { 'run_a.json': makeRun(10, {
    tvOk: 20,
    marks: { MU: { available: true, price_usd: 910 }, XYZ: { available: false, reason: 'no_price_source' } },
  }) });
  check('HG-08',
    d.includes('UNVOLLSTÄNDIG') && d.includes('portfolio_marks_failed: 1'),
    'mark_failed-Eintrag → Full-Scan mit portfolio_marks_failed: 1');
}

// HG-09: Regression heutiger Vorfall — echtes degradiertes run_2026-06-11_0839.json,
// run_at auf jetzt gesetzt (frisch), 0/20 Technicals → MUSS abgelehnt werden.
{
  const real = JSON.parse(readFileSync(join(TRADING_DIR, 'logs', 'run_2026-06-11_0839.json'), 'utf8'));
  real.run_at = new Date(Date.now() - 15 * 60_000).toISOString();   // 15 min alt wie im Vorfall
  const d = runHook('hg09', { 'run_incident.json': real });
  check('HG-09',
    d.includes('UNVOLLSTÄNDIG') && d.includes('tv 0/20') && d.includes('scan.mjs'),
    'Heutiger 0/20-Vorfall (15 min alt) wird jetzt abgelehnt statt durchgewunken');
}

const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nhook_freshness_test: ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed > 0 ? 1 : 0);
