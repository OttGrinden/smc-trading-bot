#!/usr/bin/env node
/**
 * Safety Gates — Unit 31 tests (SG-01 … SG-10).
 *
 * SG-01 … SG-08: unit tests for checkSafetyGates() in isolation (fully injectable).
 * SG-09 … SG-10: worker_pass integration — safety gate fires, dispatch is skipped,
 *                 cycle + sync still run (maintenance path not blocked).
 *
 * Tests:
 *   SG-01  no gates enabled (empty opts)  → safe: true
 *   SG-02  killSwitch.active=true          → safe: false, reason: kill_switch
 *   SG-03  killSwitch._existsSync → false  → safe: true
 *   SG-04  killSwitch._existsSync → true   → safe: false, reason: kill_switch
 *   SG-05  maxDailyLoss below threshold    → safe: true
 *   SG-06  maxDailyLoss at/above threshold → safe: false, reason: max_daily_loss_exceeded + details
 *   SG-07  maxDailyLoss state read error   → safe: false, reason: max_daily_loss_state_error (fail-closed)
 *   SG-08  kill_switch fires first (both triggered) → reason: kill_switch (not maxDailyLoss)
 *   SG-09  worker_pass + killSwitch active → dispatch skipped, cycle ran, sync ran
 *   SG-10  worker_pass + maxDailyLoss exceeded → dispatch skipped, cycle ran, sync ran
 *
 * node scripts/execution/tests/safety_gates_step31_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { checkSafetyGates, DEFAULT_MAX_DAILY_LOSS_PCT } from '../live_broker/safety_gates.mjs';
import { initPortfolio, loadOrInit, _setTestPaths, _clearTestPaths } from '../portfolio/portfolio_state.mjs';
import { _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { _setLeasePath, _clearLeasePath } from '../live_broker/run_lease.mjs';
import { runWorkerPassOnce } from '../live_broker/worker_pass.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const ROOT = join(tmpdir(), `sg31_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
mkdirSync(ROOT, { recursive: true });

const PAPER_CFG = Object.freeze({ enabled: true, mode: 'alpaca_paper', paper: true, base_url: 'https://paper-api.alpaca.markets', key_id: 'k', secret_key: 's' });

// ── SG-01: no opts → safe ───────────────────────────────────────────────────
{
  const r = checkSafetyGates({});
  check('SG-01', r.safe === true, 'empty opts → safe: true (no gates enabled)');
}

// ── SG-02: killSwitch.active=true → safe:false ──────────────────────────────
{
  const r = checkSafetyGates({ killSwitch: { active: true } });
  check('SG-02',
    r.safe === false && r.reason === 'kill_switch',
    'killSwitch.active=true → safe:false, reason:kill_switch');
}

// ── SG-03: injectable _existsSync → false → safe ────────────────────────────
{
  const r = checkSafetyGates({ killSwitch: { _existsSync: () => false } });
  check('SG-03',
    r.safe === true,
    '_existsSync returns false → sentinel absent → safe:true');
}

// ── SG-04: injectable _existsSync → true → blocked ──────────────────────────
{
  const r = checkSafetyGates({ killSwitch: { _existsSync: () => true } });
  check('SG-04',
    r.safe === false && r.reason === 'kill_switch',
    '_existsSync returns true → sentinel present → safe:false, reason:kill_switch');
}

// ── SG-05: maxDailyLoss below threshold → safe ──────────────────────────────
// NAV 1901, initial_capital 2000: loss = 99, loss_pct = 0.0495 < 0.05
{
  const r = checkSafetyGates({
    maxDailyLoss: { _loadState: () => ({ equity_nav: 1901, initial_capital: 2000 }) },
  });
  check('SG-05',
    r.safe === true,
    'loss_pct 4.95% < 5% threshold → safe:true');
}

// ── SG-06: maxDailyLoss at/above threshold → blocked + details ──────────────
// NAV 1800, initial_capital 2000: loss = 200, loss_pct = 0.10 ≥ 0.05
{
  const state = { equity_nav: 1800, initial_capital: 2000 };
  const r = checkSafetyGates({
    maxDailyLoss: { _loadState: () => state },
  });
  check('SG-06',
    r.safe === false &&
    r.reason === 'max_daily_loss_exceeded' &&
    r.details?.equity_nav === 1800 &&
    r.details?.initial_capital === 2000 &&
    r.details?.threshold_pct === DEFAULT_MAX_DAILY_LOSS_PCT &&
    typeof r.details?.loss_pct === 'number' && r.details.loss_pct > 0,
    'NAV 1800 vs initial 2000 (10% loss) → safe:false, reason:max_daily_loss_exceeded + details');
}

// ── SG-07: maxDailyLoss state read error → fail-closed ──────────────────────
{
  const r = checkSafetyGates({
    maxDailyLoss: { _loadState: () => { throw new Error('disk_error'); } },
  });
  check('SG-07',
    r.safe === false && r.reason === 'max_daily_loss_state_error',
    'state read error → safe:false, reason:max_daily_loss_state_error (fail-closed)');
}

// ── SG-08: kill_switch fires before maxDailyLoss ────────────────────────────
// Both conditions triggered; kill_switch must win (checked first).
{
  const r = checkSafetyGates({
    killSwitch:   { active: true },
    maxDailyLoss: { _loadState: () => ({ equity_nav: 1700, initial_capital: 2000 }) },
  });
  check('SG-08',
    r.safe === false && r.reason === 'kill_switch',
    'both gates triggered → kill_switch wins (checked first)');
}

// ── Worker-pass integration helpers ─────────────────────────────────────────
async function withEnv(tag, fn) {
  const d          = join(ROOT, tag);
  const ordersDir  = join(d, 'orders');
  const pfDir      = join(d, 'portfolio');
  mkdirSync(ordersDir, { recursive: true });
  mkdirSync(pfDir,     { recursive: true });
  const leaseP     = join(ordersDir, '.paper_runner.lease');
  const statePath  = join(pfDir, 'state.json');
  writeFileSync(statePath, JSON.stringify(initPortfolio(), null, 2) + '\n', 'utf8');
  const pfPaths = { state: statePath, history: join(pfDir, 'hist.jsonl'), ledger: join(pfDir, 'ledger.jsonl') };
  const apply = () => {
    _setOrderStorePaths({ dir: ordersDir, eventsLog: join(ordersDir, 'events.jsonl') });
    _setLeasePath(leaseP);
    _setTestPaths(pfPaths);
  };
  apply();
  const reloadState = () => { apply(); return loadOrInit(); };
  try { return await fn({ reloadState }); }
  finally { _clearOrderStorePaths(); _clearLeasePath(); _clearTestPaths(); }
}

function fakeBroker() {
  return {
    async submitOrder(r) {
      return { provider: 'alpaca', client_order_id: r.client_order_id, broker_order_id: 'B_' + r.client_order_id, broker_status: 'accepted' };
    },
    async getOrderByClientId(cid) {
      return { provider: 'alpaca', broker_order_id: 'B_' + cid, broker_status: 'accepted', filled_qty: 0, avg_fill_price: null };
    },
  };
}

// ── SG-09: worker_pass + killSwitch active → dispatch skipped, cycle ran ────
await withEnv('sg09', async () => {
  const s = await runWorkerPassOnce({
    broker: fakeBroker(), execConfig: PAPER_CFG,
    safetyGates: { killSwitch: { active: true } },
  });
  check('SG-09',
    s.ran === true &&
    s.steps.safety?.safe === false &&
    s.steps.safety?.reason === 'kill_switch' &&
    s.steps.dispatch?.skipped === true &&
    s.steps.dispatch?.reason === 'kill_switch' &&
    s.steps.cycle?.ran === true &&
    s.steps.sync != null && s.steps.sync.skipped !== true,
    'killSwitch active: dispatch skipped(kill_switch), cycle ran, sync ran (maintenance continues)');
});

// ── SG-10: worker_pass + maxDailyLoss exceeded → dispatch skipped, cycle ran ─
await withEnv('sg10', async () => {
  const s = await runWorkerPassOnce({
    broker: fakeBroker(), execConfig: PAPER_CFG,
    safetyGates: {
      maxDailyLoss: {
        pct: 0.05,
        _loadState: () => ({ equity_nav: 1800, initial_capital: 2000 }),
      },
    },
  });
  check('SG-10',
    s.ran === true &&
    s.steps.safety?.safe === false &&
    s.steps.safety?.reason === 'max_daily_loss_exceeded' &&
    s.steps.dispatch?.skipped === true &&
    s.steps.dispatch?.reason === 'max_daily_loss_exceeded' &&
    s.steps.cycle?.ran === true &&
    s.steps.sync != null && s.steps.sync.skipped !== true,
    'maxDailyLoss exceeded: dispatch skipped, cycle ran, sync ran (maintenance continues)');
});

// ── Summary ───────────────────────────────────────────────────────────────────
const failed = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nSafety Gates (Unit 31): ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
process.exit(failed === 0 ? 0 : 1);
