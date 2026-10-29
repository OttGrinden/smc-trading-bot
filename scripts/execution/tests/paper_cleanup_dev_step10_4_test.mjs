#!/usr/bin/env node
/**
 * paper_cleanup_dev — Phase 1 / Unit 10.4 tests (PCU-01 … PCU-08).
 *
 * Offline: temp OrderStore (_setOrderStorePaths). No network, no broker. Verifies the
 * dev/smoke store-hygiene entrypoint: prefix + settled-only deletion, fail-closed on
 * non-terminal / invalid args / config / corrupt store, dry-run preview, idempotency.
 *
 * node scripts/execution/tests/paper_cleanup_dev_step10_4_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join }                     from 'path';
import { tmpdir }                   from 'os';

import { makeBrokerOrderRecord } from '../schemas.mjs';
import { upsert, exists, _setOrderStorePaths, _clearOrderStorePaths } from '../live_broker/order_store.mjs';
import { runPaperCleanupDevOnce, cleanupDevExitCode } from '../live_broker/paper_cleanup_dev.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

const ROOT = join(tmpdir(), `pcu104_${process.pid}`);
mkdirSync(ROOT, { recursive: true });

async function withEnv(tag, fn) {
  const d = join(ROOT, tag);
  mkdirSync(d, { recursive: true });
  _setOrderStorePaths({ dir: d, eventsLog: join(d, 'live_order_events.jsonl') });
  try { return await fn(d); } finally { _clearOrderStorePaths(); }
}

const ENV  = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' };
const BASE = ['--broker-exec', 'alpaca_paper'];

function seed(cid, state) {
  const r = makeBrokerOrderRecord(
    { intent_id: 'i_' + cid, symbol: 'AAPL', side: 'long', asset_type: 'stock' },
    { decision_id: 'd_' + cid },
    { client_order_id: cid, run_id: 'run_x', action: 'open', order_action: 'buy', qty: 10 },
  );
  upsert({ ...r, state, broker_order_id: 'B_' + cid });
}

// ─── PCU-01: valid cleanup — only smoke_ + settled removed; others untouched ──
await withEnv('pcu01', async () => {
  seed('smoke_a', 'cancelled');
  seed('smoke_b', 'filled');
  seed('smoke_live', 'submitted');   // prefix match but NON-terminal → must be kept + reported
  seed('keep_x', 'filled');          // no prefix → untouched
  const s = await runPaperCleanupDevOnce({ argv: BASE, env: ENV });
  check('PCU-01',
    s.ok === true && s.exit_code === 0 && cleanupDevExitCode(s) === 0
    && s.removed.sort().join(',') === 'smoke_a,smoke_b'
    && s.skipped_non_terminal.length === 1 && s.skipped_non_terminal[0].cid === 'smoke_live'
    && s.warning === 'non_terminal_matches_skipped'
    && !exists('smoke_a') && !exists('smoke_b') && exists('smoke_live') && exists('keep_x'),
    'removes smoke_ + settled only; non-terminal smoke kept+reported; non-prefix untouched');
});

// ─── PCU-02: nothing to clean (no matches) → exit 0, removed empty ────────────
await withEnv('pcu02', async () => {
  seed('keep_y', 'filled');
  const s = await runPaperCleanupDevOnce({ argv: BASE, env: ENV });
  check('PCU-02',
    s.ok === true && s.exit_code === 0 && s.removed.length === 0 && s.skipped_non_terminal.length === 0
    && exists('keep_y'),
    'no prefix matches → nothing removed (exit 0), unrelated record kept');
});

// ─── PCU-03: invalid args (empty / non-CID-safe prefix) → exit 2, no delete ───
await withEnv('pcu03', async () => {
  seed('smoke_z', 'cancelled');
  const empty = await runPaperCleanupDevOnce({ argv: [...BASE, '--cid-prefix', ''], env: ENV });
  const bad   = await runPaperCleanupDevOnce({ argv: [...BASE, '--cid-prefix', 'smoke*'], env: ENV });
  check('PCU-03',
    empty.exit_code === 2 && empty.error?.reason === 'invalid_args'
    && bad.exit_code === 2 && bad.error?.reason === 'invalid_args'
    && exists('smoke_z'),
    'empty / non-CID-safe --cid-prefix → exit 2 invalid_args, nothing deleted');
});

// ─── PCU-04: non-terminal match only → fail-closed, kept + reported ───────────
await withEnv('pcu04', async () => {
  seed('smoke_live', 'submitted');
  const s = await runPaperCleanupDevOnce({ argv: BASE, env: ENV });
  check('PCU-04',
    s.ok === true && s.exit_code === 0 && s.removed.length === 0
    && s.skipped_non_terminal.length === 1 && s.skipped_non_terminal[0].state === 'submitted'
    && s.warning === 'non_terminal_matches_skipped' && exists('smoke_live'),
    'non-terminal smoke record → never deleted, reported (fail-closed), exit 0');
});

// ─── PCU-05: config not enabled → exit 2, no delete ───────────────────────────
await withEnv('pcu05', async () => {
  seed('smoke_c', 'cancelled');
  const s = await runPaperCleanupDevOnce({ argv: ['--cid-prefix', 'smoke_'], env: {} });
  check('PCU-05',
    s.ok === false && s.exit_code === 2 && s.error?.reason === 'broker_exec_not_enabled' && exists('smoke_c'),
    'no --broker-exec / BROKER_EXEC → broker_exec_not_enabled (exit 2), nothing deleted');
});

// ─── PCU-06: idempotent — second run removes nothing ──────────────────────────
await withEnv('pcu06', async () => {
  seed('smoke_a', 'cancelled');
  const first  = await runPaperCleanupDevOnce({ argv: BASE, env: ENV });
  const second = await runPaperCleanupDevOnce({ argv: BASE, env: ENV });
  check('PCU-06',
    first.removed.join(',') === 'smoke_a' && !exists('smoke_a')
    && second.ok === true && second.removed.length === 0 && second.exit_code === 0,
    'first run removes smoke_a; second run is a stable no-op (idempotent)');
});

// ─── PCU-07: dry-run → preview only, deletes nothing ──────────────────────────
await withEnv('pcu07', async () => {
  seed('smoke_a', 'cancelled');
  const s = await runPaperCleanupDevOnce({ argv: [...BASE, '--dry-run'], env: ENV });
  check('PCU-07',
    s.ok === true && s.dry_run === true && s.exit_code === 0
    && s.would_remove.length === 1 && s.would_remove[0].cid === 'smoke_a'
    && s.removed === undefined && exists('smoke_a'),
    'dry-run → would_remove preview, no deletion (record still present)');
});

// ─── PCU-08: corrupt store → fail-closed, deletes nothing ─────────────────────
await withEnv('pcu08', async (d) => {
  seed('smoke_a', 'cancelled');
  writeFileSync(join(d, 'smoke_bad.json'), '{ broken json', 'utf8');   // listAll() throws
  const s = await runPaperCleanupDevOnce({ argv: BASE, env: ENV });
  check('PCU-08',
    s.ok === false && s.exit_code === 2 && s.error?.reason === 'store_unreadable' && exists('smoke_a'),
    'corrupt record → store_unreadable (exit 2), nothing deleted (fail-closed)');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_cleanup_dev_step10_4_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
