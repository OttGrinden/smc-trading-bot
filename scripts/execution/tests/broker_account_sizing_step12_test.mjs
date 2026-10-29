#!/usr/bin/env node
/**
 * BrokerAccountSizing — Phase 1 / Unit 12 tests (BAS-01 … BAS-08).
 *
 * Fully offline: a fake broker with an injectable getAccount() is used so the
 * read-only fetch → account_sizing bridge is verified without any network call.
 *
 * node scripts/execution/tests/broker_account_sizing_step12_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { sizeIntentsFromBroker } from '../live_broker/broker_account_sizing.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threw(fn) { try { await fn(); return false; } catch { return true; } }

// Fake broker: records getAccount calls; returns a canned snapshot or throws.
function makeBroker(accountOrThrow) {
  const calls = { getAccount: 0 };
  const broker = {
    getAccount: async () => {
      calls.getAccount += 1;
      if (typeof accountOrThrow === 'function') return accountOrThrow();
      return accountOrThrow;
    },
  };
  return { broker, calls };
}
const okAccount = (over = {}) => ({
  provider: 'alpaca', account_id: 'acct_1', currency: 'USD', status: 'ACTIVE',
  cash: 10000, buying_power: 10000, portfolio_value: 10000, equity: 10000, paper: true,
  ts: '2026-06-19T10:00:00.000Z', ...over,
});
const intent = (over = {}) => ({ symbol: 'AMAT', side: 'long', price_usd: 100, run_id: 'r1', asset_type: 'stock', ...over });

// ─── BAS-01: success → getAccount 1×, intents sized, dispatch-ready shape ─────
{
  const { broker, calls } = makeBroker(okAccount());
  const out = await sizeIntentsFromBroker([intent()], { broker });
  const s = out.sized[0];
  check('BAS-01',
    calls.getAccount === 1 && out.account_ok === true && out.totals.sized === 1
    && s && s.symbol === 'AMAT' && s.side === 'long' && s.action === 'open'
    && Number.isFinite(s.quantity) && s.quantity > 0 && s.run_id === 'r1',
    'getAccount 1×; sized intent in dispatchApproved-Form (symbol/side/action/quantity/run_id)');
}

// ─── BAS-02: inaktives Konto → account_sizing lehnt alle ab, 0 sized ─────────
{
  const { broker } = makeBroker(okAccount({ status: 'ACCOUNT_CLOSED' }));
  const out = await sizeIntentsFromBroker([intent()], { broker });
  check('BAS-02',
    out.account_ok === false && out.account_reason === 'account_not_active'
    && out.totals.sized === 0 && out.sized.length === 0,
    'inaktiver Snapshot → account_not_active, 0 sized (fail-closed via account_sizing)');
}

// ─── BAS-03: getAccount wirft → gefangen, account_fetch_failed, 0 sized ──────
{
  const err = Object.assign(new Error('ECONNRESET'), { error_class: 'transient_network' });
  const { broker, calls } = makeBroker(() => { throw err; });
  const out = await sizeIntentsFromBroker([intent(), intent({ symbol: 'MU' })], { broker });
  check('BAS-03',
    calls.getAccount === 1 && out.account_ok === false && out.account_reason === 'account_fetch_failed'
    && out.fetch_error && out.fetch_error.error_class === 'transient_network'
    && out.totals.sized === 0 && out.skipped.length === 2
    && out.skipped.every((x) => x.reason === 'account_fetch_failed'),
    'Fetch-Fehler gefangen → account_fetch_failed, alle Intents skipped, 0 sized');
}

// ─── BAS-04: fehlender/incapabler Broker → throw VOR jedem Fetch ─────────────
{
  const ok =
    (await threw(() => sizeIntentsFromBroker([intent()], {}))) &&
    (await threw(() => sizeIntentsFromBroker([intent()], { broker: {} }))) &&
    (await threw(() => sizeIntentsFromBroker([intent()], { broker: { getAccount: 'nope' } })));
  check('BAS-04', ok, 'fehlender/incapabler Broker → throw (Pre-flight fail-closed)');
}

// ─── BAS-05: sizing-opts werden durchgereicht (cap greift) ───────────────────
{
  const { broker } = makeBroker(okAccount());
  // tiny per-position cap → target_notional clamped to 50 → qty = 0.5 @ price 100
  const out = await sizeIntentsFromBroker([intent()], { broker, max_position_notional_usd: 50 });
  const s = out.sized[0];
  check('BAS-05',
    out.account_ok === true && s && s.quantity === 0.5 && s.sizing.capped_by === 'max_position_notional',
    'opts (max_position_notional_usd) erreichen account_sizing → capped_by=max_position_notional');
}

// ─── BAS-06: leere Intent-Liste → account_ok true, 0 sized (kein Throw) ──────
{
  const { broker, calls } = makeBroker(okAccount());
  const out = await sizeIntentsFromBroker([], { broker });
  check('BAS-06',
    calls.getAccount === 1 && out.account_ok === true && out.totals.intents === 0 && out.sized.length === 0,
    'leere Liste → kein Throw, account_ok, 0 sized');
}

// ─── BAS-07: Observability — account_source/id/ts auf Erfolg gesetzt ─────────
{
  const { broker } = makeBroker(okAccount({ account_id: 'acctX', ts: '2026-06-19T11:22:33.000Z' }));
  const out = await sizeIntentsFromBroker([intent()], { broker });
  check('BAS-07',
    out.account_source === 'broker' && out.account_id === 'acctX'
    && out.account_ts === '2026-06-19T11:22:33.000Z' && out.fetch_error === null,
    'Erfolg: account_source=broker, account_id + account_ts + fetch_error=null gesetzt');
}

// ─── BAS-08: rein lesend / wiederholbar — 2 Aufrufe gleich, getAccount 2× ────
{
  const { broker, calls } = makeBroker(okAccount());
  const a = await sizeIntentsFromBroker([intent()], { broker });
  const b = await sizeIntentsFromBroker([intent()], { broker });
  check('BAS-08',
    calls.getAccount === 2 && a.totals.sized === 1 && b.totals.sized === 1
    && a.sized[0].quantity === b.sized[0].quantity,
    'idempotent/no-writes: zwei Aufrufe identisch, je 1 read-only getAccount');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nbroker_account_sizing_step12_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
