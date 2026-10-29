#!/usr/bin/env node
/**
 * Paper Stop-Placement Wiring — Phase 1 / Unit 17 tests (SP-01 … SP-08).
 *
 * Verifies the minimal 'stop' order-type wiring across the three core modules:
 *   schemas (ORDER_TYPES + stop_price) → order_gateway (validate/persist/forward)
 *   → alpaca_paper_broker (Alpaca stop payload). Fail-closed when stop_price is absent;
 *   market/limit behaviour is unchanged.
 *
 * Fully offline + deterministic: fake HTTP transport for the broker; temp OrderStore
 * for the gateway; fake broker capturing the forwarded request. No network, no live.
 *
 * node scripts/execution/tests/paper_stop_placement_step17_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { mkdirSync } from 'fs';
import { join }   from 'path';
import { tmpdir } from 'os';

import { parseBrokerExecConfig } from '../live_broker/live_broker_config.mjs';
import { AlpacaPaperBroker, BROKER_ERROR_CLASSES } from '../live_broker/adapters/alpaca_paper_broker.mjs';
import { makeBrokerOrderRecord, ORDER_TYPES } from '../schemas.mjs';
import { submit } from '../live_broker/order_gateway.mjs';
import { _setOrderStorePaths, _clearOrderStorePaths, get as storeGet } from '../live_broker/order_store.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwClass(fn, cls) { try { await fn(); return false; } catch (e) { return e?.error_class === cls; } }
async function threw(fn) { try { await fn(); return false; } catch { return true; } }

const ROOT = join(tmpdir(), `stopwire_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
mkdirSync(ROOT, { recursive: true });

const PAPER_CFG = parseBrokerExecConfig(['--broker-exec', 'alpaca_paper'], { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' });

// Fake HTTP transport for the adapter: records requests, returns a canned accepted order.
function adapterWith(responder) {
  const calls = [];
  const http = async (req) => { calls.push(req); return responder ? responder(req) : { statusCode: 200, json: { id: 'B1', client_order_id: req.body?.client_order_id, status: 'accepted', symbol: req.body?.symbol, qty: req.body?.qty, side: req.body?.side, type: req.body?.type, time_in_force: req.body?.time_in_force } }; };
  return { broker: new AlpacaPaperBroker(PAPER_CFG, { httpRequest: http }), calls };
}

// Fake broker for the gateway: captures the forwarded orderReq (toOrderReq output).
function gatewayBroker() {
  const seen = { submit: [], lookups: 0 };
  return {
    seen,
    async submitOrder(req) { seen.submit.push(req); return { provider: 'alpaca', client_order_id: req.client_order_id, broker_order_id: 'B_' + req.client_order_id, broker_status: 'accepted' }; },
    async getOrderByClientId(cid) { seen.lookups += 1; return null; },
  };
}
function withStore(tag, fn) {
  const dir = join(ROOT, tag);
  mkdirSync(dir, { recursive: true });
  _setOrderStorePaths({ dir, eventsLog: join(dir, 'live_order_events.jsonl') });
  return Promise.resolve(fn()).finally(() => _clearOrderStorePaths());
}

// ─── SP-01: broker stop → Alpaca payload {type:'stop', stop_price}, kein limit_price ─
{
  const { broker, calls } = adapterWith();
  const v = await broker.submitOrder({ client_order_id: 'cid_s1', symbol: 'AMAT', qty: 2, order_action: 'sell', order_type: 'stop', stop_price: 95.5, time_in_force: 'gtc' });
  const b = calls[0].body;
  check('SP-01',
    b.type === 'stop' && b.stop_price === '95.5' && !('limit_price' in b) && b.side === 'sell' && b.time_in_force === 'gtc' && v.broker_order_id === 'B1',
    'broker: type=stop + stop_price als String, kein limit_price; normalisiert');
}

// ─── SP-02: broker stop ohne stop_price → VALIDATION, kein HTTP-Call ─────────────
{
  const { broker, calls } = adapterWith();
  const threwV = await threwClass(() => broker.submitOrder({ client_order_id: 'cid_s2', symbol: 'X', qty: 1, order_action: 'sell', order_type: 'stop' }), BROKER_ERROR_CLASSES.VALIDATION);
  check('SP-02', threwV && calls.length === 0, 'broker: stop ohne stop_price → validation, kein HTTP-Call (fail-closed)');
}

// ─── SP-03: broker market/limit unverändert (kein stop_price-Leak) ──────────────
{
  const { broker, calls } = adapterWith();
  await broker.submitOrder({ client_order_id: 'm1', symbol: 'X', qty: 1, order_action: 'buy' });                                  // market
  await broker.submitOrder({ client_order_id: 'l1', symbol: 'X', qty: 1, order_action: 'buy', order_type: 'limit', limit_price: 10 }); // limit
  const mkt = calls[0].body, lim = calls[1].body;
  check('SP-03',
    mkt.type === 'market' && !('stop_price' in mkt) && !('limit_price' in mkt) &&
    lim.type === 'limit' && lim.limit_price === '10' && !('stop_price' in lim),
    'broker: market/limit unverändert, kein stop_price-Leak');
}

// ─── SP-04: makeBrokerOrderRecord trägt stop_price für 'stop'; null sonst ────────
{
  const stopRec = makeBrokerOrderRecord({ symbol: 'AMAT', side: 'long' }, {}, { client_order_id: 'r_stop', order_action: 'sell', qty: 2, order_type: 'stop', stop_price: 95.5 });
  const mktRec  = makeBrokerOrderRecord({ symbol: 'AMAT', side: 'long' }, {}, { client_order_id: 'r_mkt', order_action: 'buy', qty: 2 });
  check('SP-04',
    ORDER_TYPES.STOP === 'stop' && stopRec.order_type === 'stop' && stopRec.stop_price === 95.5 &&
    mktRec.order_type === 'market' && mktRec.stop_price === null,
    'schema: ORDER_TYPES.STOP vorhanden; record.stop_price gesetzt für stop, null für market');
}

// ─── SP-05: gateway stop → Record + Broker-Req tragen stop; state submitted ──────
await withStore('sp05', async () => {
  const b = gatewayBroker();
  const res = await submit({ client_order_id: 'cid_g5', symbol: 'AMAT', qty: 2, order_action: 'sell', order_type: 'stop', stop_price: 95.5, time_in_force: 'gtc', run_id: 'run_s' }, { broker: b });
  const rec = storeGet('cid_g5');
  const fwd = b.seen.submit[0];
  check('SP-05',
    res.state === 'submitted' && rec.order_type === 'stop' && rec.stop_price === 95.5 &&
    fwd.order_type === 'stop' && fwd.stop_price === 95.5 && b.seen.submit.length === 1,
    'gateway: stop persistiert (order_type+stop_price) und an Broker weitergereicht; submitted');
});

// ─── SP-06: gateway stop ohne stop_price → fail-closed, kein Submit ──────────────
await withStore('sp06', async () => {
  const b = gatewayBroker();
  const threwE = await threw(() => submit({ client_order_id: 'cid_g6', symbol: 'AMAT', qty: 2, order_action: 'sell', order_type: 'stop', run_id: 'run_s' }, { broker: b }));
  check('SP-06', threwE === true && b.seen.submit.length === 0,
    'gateway: stop ohne stop_price → throw (fail-closed), kein Broker-Submit');
});

// ─── SP-07: gateway market unverändert (kein stop_price im Broker-Req) ───────────
await withStore('sp07', async () => {
  const b = gatewayBroker();
  await submit({ client_order_id: 'cid_g7', symbol: 'AMAT', qty: 1, order_action: 'buy', run_id: 'run_s' }, { broker: b });
  const fwd = b.seen.submit[0];
  check('SP-07', fwd.order_type === 'market' && !('stop_price' in fwd) && !('limit_price' in fwd),
    'gateway: market unverändert, kein stop_price im Broker-Req');
});

// ─── SP-08: gateway limit unverändert (limit_price ja, stop_price nein) ──────────
await withStore('sp08', async () => {
  const b = gatewayBroker();
  await submit({ client_order_id: 'cid_g8', symbol: 'AMAT', qty: 1, order_action: 'buy', order_type: 'limit', limit_price: 12.5, run_id: 'run_s' }, { broker: b });
  const fwd = b.seen.submit[0];
  check('SP-08', fwd.order_type === 'limit' && fwd.limit_price === 12.5 && !('stop_price' in fwd),
    'gateway: limit unverändert (limit_price weitergereicht, kein stop_price)');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_stop_placement_step17_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
