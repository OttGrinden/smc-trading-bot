#!/usr/bin/env node
/**
 * Phase 1 / Step 1 — contract + factory + paper-guard tests (BC-01 … BC-11).
 *
 * Verifies the ADDITIVE broker-execution contract extension, the makeBrokerOrderRecord
 * factory, and the fail-closed alpaca_paper guard — WITHOUT touching the existing
 * sim/PaperBroker behavior.
 *
 * node scripts/execution/tests/contract_broker_step1_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import {
  ORDER_STATES, ORDER_TRANSITIONS, ORDER_TYPES, TIME_IN_FORCE,
  makeBrokerOrderRecord, makePaperOrder,
} from '../schemas.mjs';
import { isTerminal, canTransitionTo } from '../order_state.mjs';
import {
  parseBrokerExecConfig, brokerExecEnabled, BROKER_EXEC_MODES, parseBrokerConfig,
} from '../live_broker/live_broker_config.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
const o = (state) => ({ state, order_id: 't', symbol: 'T' });
function threws(fn) { try { fn(); return false; } catch { return true; } }

// ─── BC-01: neue States additiv vorhanden ────────────────────────────────────
{
  const want = ['pending_submit','submitted','submit_unknown','replace_pending','replaced','expired','reconcile_hold'];
  const have = Object.values(ORDER_STATES);
  check('BC-01', want.every(s => have.includes(s)) && want.every(s => s in ORDER_TRANSITIONS),
    'pending_submit/submitted/submit_unknown/replace_pending/replaced/expired/reconcile_hold in States + Transitions');
}

// ─── BC-02: bestehende Sim-Transitionen unverändert ──────────────────────────
{
  const ok =
    canTransitionTo(o('created'), 'validated') &&
    canTransitionTo(o('validated'), 'approved') &&
    canTransitionTo(o('approved'), 'sent') &&            // Sim-Pfad bleibt
    canTransitionTo(o('sent'), 'acknowledged') &&
    canTransitionTo(o('acknowledged'), 'filled') &&
    canTransitionTo(o('partially_filled'), 'filled') &&
    canTransitionTo(o('cancel_pending'), 'cancelled') &&
    canTransitionTo(o('filled'), 'failed_reconciliation');
  check('BC-02', ok, 'alle bestehenden Sim-Kanten weiterhin gültig (inkl. approved→sent)');
}

// ─── BC-03: Terminal-Regeln korrekt ──────────────────────────────────────────
{
  const terminals    = ['rejected','cancelled','blocked','failed_reconciliation','replaced','expired'];
  const nonTerminals = ['pending_submit','submitted','submit_unknown','reconcile_hold','acknowledged','approved','cancel_pending'];
  check('BC-03',
    terminals.every(s => isTerminal(o(s)) === true) && nonTerminals.every(s => isTerminal(o(s)) === false),
    'replaced/expired terminal; pending_submit/submitted/submit_unknown/reconcile_hold nicht-terminal');
}

// ─── BC-04: additive neue Kanten vorhanden ───────────────────────────────────
{
  const ok =
    canTransitionTo(o('approved'), 'pending_submit') &&
    canTransitionTo(o('pending_submit'), 'submitted') &&
    canTransitionTo(o('pending_submit'), 'submit_unknown') &&
    canTransitionTo(o('submit_unknown'), 'pending_submit') &&   // safe-resubmit
    canTransitionTo(o('submitted'), 'acknowledged') &&
    canTransitionTo(o('acknowledged'), 'reconcile_hold') &&
    canTransitionTo(o('cancel_pending'), 'filled') &&           // race outcome
    canTransitionTo(o('reconcile_hold'), 'filled');
  check('BC-04', ok, 'additive Kanten (approved→pending_submit, submit_unknown↔pending_submit, cancel_pending→filled, reconcile_hold→filled)');
}

// ─── BC-05: verbotene/abwesende Kanten + keine Terminal-Lecks ────────────────
{
  const ok =
    !canTransitionTo(o('created'), 'filled') &&
    !canTransitionTo(o('approved'), 'filled') &&
    !canTransitionTo(o('approved'), 'submitted') &&   // muss über pending_submit-Anker
    canTransitionTo(o('replaced'), 'filled') === false &&
    canTransitionTo(o('expired'), 'submitted') === false &&
    ORDER_TRANSITIONS.replaced.length === 0 &&
    ORDER_TRANSITIONS.expired.length === 0;
  check('BC-05', ok, 'kein optimistischer Fill, kein Anker-Bypass, terminale States ohne Auslauf');
}

// ─── BC-06: makeBrokerOrderRecord Defaults vollständig + konsistent ──────────
{
  const intent   = { intent_id: 'i1', symbol: 'AMAT', side: 'long', asset_type: 'stock' };
  const decision = { decision_id: 'd1' };
  const r = makeBrokerOrderRecord(intent, decision, {
    client_order_id: 'cid_test_1', run_id: 'run_x', action: 'open',
    order_action: 'buy', qty: 3.6, order_type: 'market', time_in_force: 'day',
  });
  check('BC-06',
    r.schema_version === 1 && r.client_order_id === 'cid_test_1' && r.broker_order_id === null
    && r.state === ORDER_STATES.CREATED && r.filled_qty === 0 && r.remaining_qty === 3.6
    && r.avg_fill_price === null && Array.isArray(r.fills) && r.fills.length === 0
    && r.last_applied_filled_qty === 0 && r.broker === 'alpaca_paper'
    && r.idempotency_status === 'not_submitted' && r.attempt_count === 0
    && r.replaces_cid === null && r.replaced_by_cid === null && r.error === null && r.reconcile_flag === null
    && r.intent_id === 'i1' && r.decision_id === 'd1' && r.symbol === 'AMAT' && r.side === 'long'
    && r.order_action === 'buy' && r.order_type === 'market' && r.time_in_force === 'day'
    && r.created_at != null && r.anchor_persisted_at === null && r.submitted_at === null
    && r.last_poll_at === null && r.terminal_at === null && Array.isArray(r.events),
    'vollständige, konsistente Defaults (state=created, Anker-Felder null, fills/events leer)');
}

// ─── BC-07: makeBrokerOrderRecord fail-closed Validierung ────────────────────
{
  const base = [{ symbol: 'X' }, { decision_id: 'd' }];
  const ok =
    threws(() => makeBrokerOrderRecord(...base, {}))                                            && // fehlende cid
    threws(() => makeBrokerOrderRecord(...base, { client_order_id: 'c', qty: 0 }))              && // qty <= 0
    threws(() => makeBrokerOrderRecord(...base, { client_order_id: 'c', qty: -1 }))             &&
    threws(() => makeBrokerOrderRecord(...base, { client_order_id: 'c', order_type: 'stop_limit' })) && // bad order_type ('stop' is now valid — Unit 17)
    threws(() => makeBrokerOrderRecord(...base, { client_order_id: 'c', time_in_force: 'ioc' }))&& // bad tif
    threws(() => makeBrokerOrderRecord(...base, { client_order_id: 'c', order_action: 'long' })); // bad order_action
  check('BC-07', ok, 'wirft bei fehlender cid / qty<=0 / falschem order_type / tif / order_action');
}

// ─── BC-08: Guard Default OFF ────────────────────────────────────────────────
{
  const cfg = parseBrokerExecConfig([], {});
  check('BC-08',
    cfg.enabled === false && cfg.mode === BROKER_EXEC_MODES.OFF && brokerExecEnabled(cfg) === false,
    'ohne Flag/Env: enabled=false (Sim-Pfad bleibt Default)');
}

// ─── BC-09: Guard fail-closed bei unklarer/falscher Config ───────────────────
{
  const args = ['--broker-exec', 'alpaca_paper'];
  const ok =
    threws(() => parseBrokerExecConfig(args, {}))                                                            && // keine Creds
    threws(() => parseBrokerExecConfig(args, { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's', ALPACA_PAPER: 'false' })) && // live verboten
    threws(() => parseBrokerExecConfig(args, { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's', ALPACA_BASE_URL: 'https://api.alpaca.markets' })) && // non-paper URL
    threws(() => parseBrokerExecConfig(['--broker-exec', 'live'], {}));                                       // ungültiger Modus
  check('BC-09', ok, 'fail-closed: keine Creds / ALPACA_PAPER=false / live-URL / ungültiger Modus → Throw');
}

// ─── BC-10: Guard Erfolg nur bei eindeutiger Paper-Config ────────────────────
{
  const cfg = parseBrokerExecConfig(['--broker-exec', 'alpaca_paper'],
    { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' });   // ALPACA_PAPER unset → default paper
  check('BC-10',
    cfg.enabled === true && cfg.mode === BROKER_EXEC_MODES.ALPACA_PAPER && cfg.paper === true
    && cfg.base_url === 'https://paper-api.alpaca.markets' && brokerExecEnabled(cfg) === true,
    'gültige Paper-Config → enabled=true, base_url=paper-Endpunkt');
}

// ─── BC-11: Sim-Pfad unangetastet ────────────────────────────────────────────
{
  const po = makePaperOrder(
    { intent_id: 'i', symbol: 'AMAT', side: 'long', asset_type: 'stock', price_usd: 100, risk: { stop_loss_pct: 8 } },
    { decision_id: 'd' });
  const simCfg = parseBrokerConfig([], {});
  check('BC-11',
    po.state === ORDER_STATES.CREATED && po.broker === 'paper' && Array.isArray(po.events)
    && simCfg.broker_mode === 'off',
    'makePaperOrder unverändert (state=created, broker=paper); read-only Broker default off');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\ncontract_broker_step1_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
