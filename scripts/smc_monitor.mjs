#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const cwd = process.cwd();

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function firstCloseAfter(closes, open) {
  const oTs = open?.timestamp;
  if (!oTs) return null;

  // Find earliest close after open for same symbol+side.
  let best = null;
  for (const c of closes) {
    if (c?.symbol !== open?.symbol) continue;
    if (c?.side !== open?.side) continue;
    if (!c?.timestamp) continue;
    if (!(c.timestamp > oTs)) continue;

    if (!best || c.timestamp < best.timestamp) best = c;
  }
  return best;
}

function scoreToTargetRrr(score) {
  if (score === 9) return 8.0;
  if (score === 10) return 10.0;
  return 0;
}

const historyPath = path.join(cwd, 'portfolio_history.jsonl');
const history = readJsonl(historyPath);

const opens = history.filter(
  (e) =>
    e?.event === 'trade_opened' &&
    typeof e?.reason === 'string' &&
    e.reason.includes('SMC_')
);

const closes = history.filter((e) => e?.event === 'trade_closed');

let completed = 0;
let wins = 0;
let losses = 0;
let totalPnl = 0;

const openPositions = [];

for (const o of opens) {
  const c = firstCloseAfter(closes, o);

  if (c) {
    completed++;
    const pnl = parseFloat(c.realized_pnl_eur ?? 0);
    totalPnl += pnl;
    if (pnl > 0) wins++;
    else losses++;
  } else {
    openPositions.push(o);
  }
}

const winRate = completed > 0 ? ((wins / completed) * 100).toFixed(1) : '0.0';

const rrrSum = opens.reduce((s, t) => s + scoreToTargetRrr(t?.score), 0);
const avgRrr = opens.length > 0 ? (rrrSum / opens.length).toFixed(2) : '0.00';

const today = new Date().toISOString().slice(0, 10);
const auditPath = path.join(cwd, 'logs', `audit_${today}.jsonl`);
const audit = readJsonl(auditPath);

const executed = audit.filter((e) => e?.info === 'smc_thesis_review_start').length;
const blocked = audit.filter((e) => e?.warn === 'smc_auto_open_blocked').length;

console.log('=== SMC Monitor ===');
console.log(`Completed : ${completed}  (open: ${openPositions.length})`);
console.log(`Win-Rate  : ${winRate}%  (${wins}W / ${losses}L)`);
console.log(
  `Total PnL : ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} EUR`
);
console.log(`Avg RRR   : ${avgRrr}  (score-based: 9->8.0 · 10->10.0)`);

if (openPositions.length > 0) {
  console.log('Open:');
  for (const p of openPositions) {
    console.log(`  -> ${p.symbol} ${p.side} s${p.score}  ${p.reason}`);
  }
}

console.log(
  `Reviewer  : ${Math.max(0, executed - blocked)} executed · ${blocked} blocked (Today)`
);
