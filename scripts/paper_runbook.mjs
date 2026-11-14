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

  // --- Mark-to-market: update open positions with current heatmap prices ---
  try {
    const liqPath   = path.join(cacheDir, 'liq_heatmap.json');
    const statePath = path.join(cwd, 'trading', 'execution', 'portfolio', 'portfolio_state.json');
    if (fs.existsSync(liqPath) && fs.existsSync(statePath)) {
      const liq   = JSON.parse(fs.readFileSync(liqPath, 'utf8'));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (Array.isArray(state.open_positions) && state.open_positions.length > 0) {
        let updated = false;
        const now = new Date().toISOString();
        for (const pos of state.open_positions) {
          const entry = liq[pos.symbol];
          if (!entry?.current_price) continue;
          const newUsd = entry.current_price;
          // Simple EUR conversion: use entry EUR/USD ratio as proxy (no live FX needed)
          const entryRatio = pos.entry_price_eur && pos.entry_price_usd
            ? pos.entry_price_eur / pos.entry_price_usd : null;
          const newEur = entryRatio ? +(newUsd * entryRatio).toFixed(6) : pos.mark_price_eur;
          const dirFactor = pos.side === 'short' ? -1 : 1;
          const pnlEur = entryRatio
            ? +((newEur - pos.entry_price_eur) * dirFactor * pos.quantity).toFixed(4)
            : 0;
          pos.mark_price_usd    = newUsd;
          pos.mark_price_eur    = newEur;
          pos.unrealized_pnl_eur = pnlEur;
          pos.mark_source       = 'liq_heatmap';
          pos.mark_updated_at   = now;
          updated = true;
        }
        if (updated) {
          // Recompute portfolio-level unrealized PnL and NAV
          const totalUnrealized = state.open_positions
            .reduce((s, p) => s + (p.unrealized_pnl_eur ?? 0), 0);
          state.unrealized_pnl = +totalUnrealized.toFixed(4);
          state.equity_nav     = +(state.cash + state.gross_exposure + totalUnrealized).toFixed(4);
          state.last_updated_at = now;
          fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
          process.stderr.write(JSON.stringify({
            info: 'mark_to_market_ok',
            positions: state.open_positions.map(p => ({
              symbol: p.symbol, mark_usd: p.mark_price_usd, unrealized_eur: p.unrealized_pnl_eur,
            })),
            equity_nav: state.equity_nav,
          }) + '\n');
        }
      }
    }
  } catch (e) {
    process.stderr.write(JSON.stringify({ warn: 'mark_to_market_failed', detail: e.message }) + '\n');
  }

  // --- SL enforcement: run portfolio_engine with fresh heatmap prices, no new allocations ---
  try {
    const liqPath   = path.join(cacheDir, 'liq_heatmap.json');
    const statePath = path.join(cwd, 'trading', 'execution', 'portfolio', 'portfolio_state.json');
    if (fs.existsSync(liqPath) && fs.existsSync(statePath)) {
      const liq   = JSON.parse(fs.readFileSync(liqPath, 'utf8'));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (Array.isArray(state.open_positions) && state.open_positions.length > 0) {
        const now = new Date().toISOString();
        const portfolioMarks = {};
        for (const [sym, entry] of Object.entries(liq)) {
          if (entry?.current_price) {
            portfolioMarks[sym] = { price_usd: entry.current_price, source: 'liq_heatmap', fetched_at: now, available: true };
          }
        }
        const slRunLog = {
          run_id:            `sl_check_${Date.now()}`,
          run_at:            now,
          long_candidates:   [],
          short_candidates:  [],
          portfolio_marks:   portfolioMarks,
        };
        const tmpDir      = path.join(cwd, 'trading', 'execution', 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const runLogPath  = path.join(tmpDir, `sl_run_log_${Date.now()}.json`);
        const emptyDecPath = path.join(tmpDir, 'empty_decisions.json');
        fs.writeFileSync(runLogPath,   JSON.stringify(slRunLog));
        fs.writeFileSync(emptyDecPath, JSON.stringify([]));
        const enginePath = path.join(cwd, 'scripts', 'execution', 'portfolio', 'portfolio_engine.mjs');
        spawnSync(process.execPath, [enginePath, '--run-log', runLogPath, '--decisions', emptyDecPath], { stdio: 'inherit' });
        try { fs.unlinkSync(runLogPath); } catch {}
      }
    }
  } catch (e) {
    process.stderr.write(JSON.stringify({ warn: 'sl_engine_error', detail: e.message }) + '\n');
  }

  process.exit(result.status ?? 0);
}

process.exit(status === 'RED' ? 1 : 0);
