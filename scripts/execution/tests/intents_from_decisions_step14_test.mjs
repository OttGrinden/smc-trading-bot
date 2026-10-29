#!/usr/bin/env node
/**
 * IntentsFromDecisions — Phase 1 / Unit 14 tests (IFD-01 … IFD-08).
 *
 * Fully offline + deterministic. Verifies the approved-decision → UNSIZED-intent
 * normalizer, including end-to-end shape compatibility with sizeIntentsFromBroker
 * (Unit 12) via an injected fake broker.
 *
 * node scripts/execution/tests/intents_from_decisions_step14_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { approvedIntentsFromDecisions } from '../live_broker/intents_from_decisions.mjs';
import { sizeIntentsFromBroker } from '../live_broker/broker_account_sizing.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

// Mirror the decision_engine { intent, decision } output shape.
function entry({ symbol = 'AMAT', side = 'long', price_usd = 100, asset_type = 'stock',
                 approved = true, run_id = 'run_d', decision_id = 'dec_1', intent_id = 'int_1' } = {}) {
  return {
    intent:   { symbol, side, asset_type, price_usd, intent_id },
    decision: { decision_id, symbol, side, execution_ready: approved, run_id },
  };
}

// ─── IFD-01: approved decision → exact unsized-intent shape ───────────────────
{
  const out = approvedIntentsFromDecisions([entry()], {});
  const it = out.intents[0];
  check('IFD-01',
    out.total === 1 && out.approved === 1 && out.emitted === 1 && out.intents.length === 1 &&
    it.symbol === 'AMAT' && it.side === 'long' && it.action === 'open' && it.price_usd === 100 &&
    it.run_id === 'run_d' && it.asset_type === 'stock' &&
    it.decision_source.decision_id === 'dec_1' && it.decision_source.intent_id === 'int_1' &&
    !('quantity' in it),
    'approved → { symbol, side, action:open, price_usd, run_id, asset_type, decision_source }, UNSIZED');
}

// ─── IFD-02: non-approved decision → skipped(not_approved), nicht gezählt ─────
{
  const out = approvedIntentsFromDecisions([entry({ approved: false })], {});
  check('IFD-02',
    out.approved === 0 && out.emitted === 0 && out.intents.length === 0 &&
    out.skipped.length === 1 && out.skipped[0].reason === 'not_approved',
    'execution_ready=false → skip(not_approved), kein emit');
}

// ─── IFD-03: fail-closed Feldvalidierung ──────────────────────────────────────
{
  const out = approvedIntentsFromDecisions([
    entry({ symbol: '', }),                    // missing_symbol
    entry({ symbol: 'X', side: 'neutral' }),   // invalid_side
    entry({ symbol: 'Y', price_usd: 0 }),      // non_positive_price
    entry({ symbol: 'Z', run_id: null }),      // missing_run_id (no ctx.run_id)
  ], {});
  const reasons = out.skipped.map(s => s.reason);
  check('IFD-03',
    out.emitted === 0 && reasons.includes('missing_symbol') && reasons.includes('invalid_side') &&
    reasons.includes('non_positive_price') && reasons.includes('missing_run_id'),
    'bad symbol/side/price/run_id → je eigener fail-closed skip, kein emit');
}

// ─── IFD-04: run_id-Fallback aus ctx greift ───────────────────────────────────
{
  const out = approvedIntentsFromDecisions([entry({ run_id: null })], { run_id: 'ctx_run' });
  check('IFD-04',
    out.emitted === 1 && out.intents[0].run_id === 'ctx_run',
    'fehlende decision.run_id → ctx.run_id Fallback');
}

// ─── IFD-05: gemischte Liste → nur approved + valide emittiert ────────────────
{
  const out = approvedIntentsFromDecisions([
    entry({ symbol: 'AMAT', approved: true }),
    entry({ symbol: 'MU', approved: false }),
    entry({ symbol: 'GD', side: 'short', approved: true }),
    entry({ symbol: 'BAD', price_usd: -5, approved: true }),
  ], {});
  const syms = out.intents.map(i => i.symbol).sort();
  check('IFD-05',
    out.total === 4 && out.approved === 3 && out.emitted === 2 &&
    syms.length === 2 && syms[0] === 'AMAT' && syms[1] === 'GD' &&
    out.intents.find(i => i.symbol === 'GD').side === 'short',
    'mixed: 3 approved, 1 davon non_positive_price → 2 emitted (AMAT long, GD short)');
}

// ─── IFD-06: leere/ungültige Eingabe → leeres Summary, kein Throw ─────────────
{
  const a = approvedIntentsFromDecisions([], {});
  const b = approvedIntentsFromDecisions(null, {});
  check('IFD-06',
    a.total === 0 && a.emitted === 0 && a.intents.length === 0 &&
    b.total === 0 && b.emitted === 0,
    'leere Liste / null → leeres Summary, kein Throw');
}

// ─── IFD-07: pure / wiederholbar — zwei Aufrufe identisch ─────────────────────
{
  const decisions = [entry({ symbol: 'AMAT' }), entry({ symbol: 'GD', side: 'short' })];
  const a = approvedIntentsFromDecisions(decisions, {});
  const b = approvedIntentsFromDecisions(decisions, {});
  check('IFD-07',
    JSON.stringify(a.intents) === JSON.stringify(b.intents) && a.emitted === 2,
    'pure: identische Eingabe → identische Ausgabe (keine Mutation/Writes)');
}

// ─── IFD-08: END-TO-END — emittierte Intents sind sizeIntentsFromBroker-fertig ─
{
  const out = approvedIntentsFromDecisions([entry({ symbol: 'AMAT', price_usd: 100 })], {});
  const fakeBroker = {
    async getAccount() {
      return { provider: 'alpaca', account_id: 'a1', currency: 'USD', status: 'ACTIVE',
               cash: 10000, buying_power: 10000, portfolio_value: 10000, equity: 10000, paper: true,
               ts: '2026-06-19T10:00:00.000Z' };
    },
  };
  const sized = await sizeIntentsFromBroker(out.intents, { broker: fakeBroker });
  check('IFD-08',
    sized.account_ok === true && sized.totals.sized === 1 &&
    sized.sized[0].symbol === 'AMAT' && sized.sized[0].quantity > 0,
    'emittierte unsized Intents werden von sizeIntentsFromBroker direkt gesized (E2E-Form korrekt)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nintents_from_decisions_step14_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
