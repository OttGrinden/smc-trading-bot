#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const cwd = process.cwd();
const args = process.argv.slice(2);
const RUN_SCAN = args.includes('--run-scan');

function ageHours(filePath) {
  try {
    const mtime = fs.statSync(filePath).mtimeMs;
    return (Date.now() - mtime) / 3_600_000;
  } catch {
    return null;
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// --- Cache staleness ---
const cacheDir = path.join(cwd, 'trading', 'cache');

const ohlcvSymbols = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB'];
const ohlcvAges = {};
for (const sym of ohlcvSymbols) {
  const p = path.join(cacheDir, `ohlcv_daily_${sym}.json`);
  const h = ageHours(p);
  if (h !== null) ohlcvAges[sym] = h;
}

const liqAge = ageHours(path.join(cacheDir, 'liq_heatmap.json'));
const posAge = ageHours(path.join(cacheDir, 'positioning_data.json'));

const btcAge = ohlcvAges['BTC'] ?? null;

let status = 'GREEN';
const warnings = [];

if (btcAge === null) {
  status = 'RED';
  warnings.push('ohlcv_daily_BTC.json missing');
} else if (btcAge > 6) {
  status = 'RED';
  warnings.push(`ohlcv_daily_BTC.json stale (${btcAge.toFixed(1)}h)`);
}

// liq_heatmap MAX_AGE_MIN=14 → warn at 20min; positioning DEFAULT_MAX_AGE=90 → warn at 100min
if (liqAge === null || liqAge > 20 / 60) {
  if (status !== 'RED') status = 'YELLOW';
  warnings.push(liqAge === null ? 'liq_heatmap.json missing' : `liq_heatmap.json stale (${(liqAge * 60).toFixed(0)}min)`);
}

if (posAge === null || posAge > 100 / 60) {
  if (status !== 'RED') status = 'YELLOW';
  warnings.push(posAge === null ? 'positioning_data.json missing' : `positioning_data.json stale (${(posAge * 60).toFixed(0)}min)`);
}

// --- Portfolio history ---
const histCandidates = [
  path.join(cwd, 'portfolio_history.jsonl'),
  path.join(cwd, 'trading', 'execution', 'portfolio', 'portfolio_history.jsonl'),
];
const histPath = histCandidates.find(p => fs.existsSync(p)) ?? histCandidates[0];
const history = readJsonl(histPath);

const cutoff = Date.now() - 7 * 24 * 3_600_000;

const smc7d = history.filter(e =>
  e?.event === 'trade_opened' &&
  typeof e?.reason === 'string' &&
  e.reason.includes('SMC_') &&
  new Date(e.timestamp).getTime() >= cutoff
).length;

const pnl7d = history
  .filter(e =>
    e?.event === 'trade_closed' &&
    typeof e?.realized_pnl_eur === 'number' &&
    new Date(e.timestamp).getTime() >= cutoff
  )
  .reduce((s, e) => s + e.realized_pnl_eur, 0);

// --- Audit blocked today ---
const today = new Date().toISOString().slice(0, 10);
const auditCandidates = [
  path.join(cwd, 'logs', `audit_${today}.jsonl`),
  path.join(cwd, 'trading', 'execution', 'audit', `audit_${today}.jsonl`),
];
const auditPath = auditCandidates.find(p => fs.existsSync(p)) ?? auditCandidates[0];
const audit = readJsonl(auditPath);
const blockedToday = audit.filter(e => e?.warn === 'smc_auto_open_blocked').length;

// --- Output ---
console.log(`\n=== Paper Runbook Health Check ===`);
console.log(`STATUS   : ${status}`);
if (warnings.length > 0) warnings.forEach(w => console.log(`  ! ${w}`));

console.log(`\nCache ages:`);
for (const [sym, h] of Object.entries(ohlcvAges)) {
  console.log(`  ohlcv_${sym}   : ${h.toFixed(1)}h`);
}
console.log(`  liq_heatmap  : ${liqAge !== null ? (liqAge * 60).toFixed(0) + 'min' : 'missing'}`);
console.log(`  positioning  : ${posAge !== null ? (posAge * 60).toFixed(0) + 'min' : 'missing'}`);

console.log(`\nSMC last 7d  : ${smc7d} trades opened`);
console.log(`PnL last 7d  : ${pnl7d >= 0 ? '+' : ''}${pnl7d.toFixed(2)} EUR`);
console.log(`Blocked today: ${blockedToday}`);

const summary = {
  status,
  cache: {
    ohlcv_hours: btcAge !== null ? parseFloat(btcAge.toFixed(2)) : null,
    liq_hours:   liqAge !== null ? parseFloat(liqAge.toFixed(2)) : null,
    pos_hours:   posAge !== null ? parseFloat(posAge.toFixed(2)) : null,
  },
  smc_7d: smc7d,
  pnl_7d_eur: parseFloat(pnl7d.toFixed(2)),
  blocked_today: blockedToday,
};
console.log('\n' + JSON.stringify(summary));

// --- Optional scan ---
if (RUN_SCAN) {
  if (status === 'RED') {
    if (btcAge === null) {
      console.log('\n--run-scan skipped: STATUS=RED (ohlcv_daily_BTC.json missing)');
      process.exit(1);
    }
    // smc_scan.mjs runs ohlcv_fetcher as Step 1 — no pre-refresh needed here
    console.log('\nSTATUS=RED — smc_scan will refresh stale caches as Step 1');
  }
  const scanPath = path.join(cwd, 'scripts', 'smc_scan.mjs');
  console.log(`\nRunning scan: node ${scanPath}`);
  const result = spawnSync(process.execPath, [scanPath], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

process.exit(status === 'RED' ? 1 : 0);
