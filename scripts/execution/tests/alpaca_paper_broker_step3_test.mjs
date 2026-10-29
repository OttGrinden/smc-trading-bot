#!/usr/bin/env node
/**
 * AlpacaPaperBroker — Phase 1 / Step 3 adapter tests (AP-01 … AP-13).
 *
 * Fully offline: a fake HTTP transport is injected (opts.httpRequest) so the
 * request shape, normalization, and error classification are verified without
 * any network call.
 *
 * node scripts/execution/tests/alpaca_paper_broker_step3_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { parseBrokerExecConfig } from '../live_broker/live_broker_config.mjs';
import { AlpacaPaperBroker, BROKER_ERROR_CLASSES } from '../live_broker/adapters/alpaca_paper_broker.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwClass(fn, cls) {
  try { await fn(); return false; } catch (e) { return e?.error_class === cls; }
}

const PAPER_CFG = parseBrokerExecConfig(['--broker-exec', 'alpaca_paper'],
  { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' });

// Fake transport: records calls, returns a canned response or throws (network).
function makeHttp(responder) {
  const calls = [];
  const http = async (req) => { calls.push(req); return responder(req, calls.length); };
  return { http, calls };
}
function brokerWith(responder) {
  const { http, calls } = makeHttp(responder);
  return { broker: new AlpacaPaperBroker(PAPER_CFG, { httpRequest: http }), calls };
}
const okOrder = (over = {}) => ({
  id: 'B1', client_order_id: 'cid_1', status: 'accepted', symbol: 'AMAT',
  qty: '3.6', side: 'buy', type: 'market', time_in_force: 'day',
  filled_qty: '0', filled_avg_price: null, ...over,
});

// ─── AP-01: market submit → korrekter Paper-Request + Normalisierung ─────────
{
  const { broker, calls } = brokerWith(() => ({ statusCode: 200, json: okOrder() }));
  const view = await broker.submitOrder({ client_order_id: 'cid_1', symbol: 'AMAT', qty: 3.6, order_action: 'buy' });
  const req = calls[0], b = req.body;
  check('AP-01',
    req.method === 'POST' && req.url.endsWith('/v2/orders')
    && b.symbol === 'AMAT' && b.qty === '3.6' && b.side === 'buy' && b.type === 'market'
    && b.time_in_force === 'day' && b.client_order_id === 'cid_1' && !('limit_price' in b)
    && view.broker_order_id === 'B1' && view.broker_status === 'accepted'
    && view.filled_qty === 0 && view.avg_fill_price === null,
    'market: POST /v2/orders, qty als String, side=buy, kein limit_price; Normalisierung korrekt');
}

// ─── AP-02: limit submit → type=limit + limit_price ──────────────────────────
{
  const { broker, calls } = brokerWith(() => ({ statusCode: 200, json: okOrder({ type: 'limit' }) }));
  await broker.submitOrder({ client_order_id: 'cid_2', symbol: 'AMAT', qty: 2, order_action: 'buy', order_type: 'limit', limit_price: 123.45 });
  const b = calls[0].body;
  check('AP-02', b.type === 'limit' && b.limit_price === '123.45' && b.qty === '2',
    'limit: type=limit + limit_price als String');
}

// ─── AP-03: client_order_id Pflicht (kein HTTP-Call) ─────────────────────────
{
  const { broker, calls } = brokerWith(() => ({ statusCode: 200, json: okOrder() }));
  const threw = await threwClass(() => broker.submitOrder({ symbol: 'AMAT', qty: 1, order_action: 'buy' }),
    BROKER_ERROR_CLASSES.VALIDATION);
  check('AP-03', threw && calls.length === 0, 'fehlende client_order_id → validation, kein HTTP-Call');
}

// ─── AP-04: non-paper / ungültige Config → Konstruktor fail-closed ───────────
{
  const mk = (cfg) => { try { new AlpacaPaperBroker(cfg, { httpRequest: async () => ({ statusCode: 200, json: {} }) }); return false; } catch { return true; } };
  const ok =
    mk({ enabled: false })                                                                                       &&
    mk({ enabled: true, mode: 'off' })                                                                           &&
    mk({ enabled: true, mode: 'alpaca_paper', paper: false, base_url: 'https://paper-api.alpaca.markets', key_id: 'k', secret_key: 's' }) &&
    mk({ enabled: true, mode: 'alpaca_paper', paper: true, base_url: 'https://api.alpaca.markets', key_id: 'k', secret_key: 's' }) &&
    mk({ enabled: true, mode: 'alpaca_paper', paper: true, base_url: 'https://paper-api.alpaca.markets' });      // keine Creds
  check('AP-04', ok, 'Konstruktor wirft bei disabled / mode off / paper=false / live-URL / fehlenden Creds');
}

// ─── AP-05: order_action → Alpaca side Mapping ───────────────────────────────
{
  const seen = {};
  const { broker } = brokerWith((req) => { seen[req.body.client_order_id] = req.body.side; return { statusCode: 200, json: okOrder() }; });
  await broker.submitOrder({ client_order_id: 'a', symbol: 'X', qty: 1, order_action: 'sell_short' });
  await broker.submitOrder({ client_order_id: 'b', symbol: 'X', qty: 1, order_action: 'buy_to_cover' });
  check('AP-05', seen.a === 'sell' && seen.b === 'buy', 'sell_short→sell, buy_to_cover→buy');
}

// ─── AP-06: getOrderByClientId gefunden → Normalisierung ─────────────────────
{
  const { broker, calls } = brokerWith(() => ({ statusCode: 200, json: okOrder({ status: 'filled', filled_qty: '3.6', filled_avg_price: '584.42' }) }));
  const v = await broker.getOrderByClientId('cid_1');
  check('AP-06',
    calls[0].method === 'GET' && calls[0].url.includes('by_client_order_id')
    && v.broker_status === 'filled' && v.filled_qty === 3.6 && v.avg_fill_price === 584.42 && v.broker_order_id === 'B1',
    'GET by_client_order_id; normalisiert filled_qty/avg_fill_price/broker_order_id');
}

// ─── AP-07: getOrderByClientId 404 → null ────────────────────────────────────
{
  const { broker } = brokerWith(() => ({ statusCode: 404, json: { message: 'order not found' } }));
  const v = await broker.getOrderByClientId('cid_missing');
  check('AP-07', v === null, '404 → null (kein Throw)');
}

// ─── AP-08: Fehlerklassifikation ─────────────────────────────────────────────
{
  const cls = async (statusCode, json) => {
    const { broker } = brokerWith(() => ({ statusCode, json }));
    try { await broker.submitOrder({ client_order_id: 'c', symbol: 'X', qty: 1, order_action: 'buy' }); return 'NO_THROW'; }
    catch (e) { return e.error_class; }
  };
  const ok =
    (await cls(401, { message: 'unauthorized' }))                       === BROKER_ERROR_CLASSES.AUTH &&
    (await cls(422, { message: 'client_order_id must be unique' }))     === BROKER_ERROR_CLASSES.DUPLICATE_CLIENT_ORDER_ID &&
    (await cls(422, { message: 'qty must be positive' }))               === BROKER_ERROR_CLASSES.VALIDATION &&
    (await cls(429, { message: 'rate limited' }))                       === BROKER_ERROR_CLASSES.RATE_LIMIT &&
    (await cls(400, { message: 'bad request' }))                        === BROKER_ERROR_CLASSES.VALIDATION &&
    (await cls(500, { message: 'server error' }))                       === BROKER_ERROR_CLASSES.BROKER_INTERNAL;
  check('AP-08', ok, '401→auth, 422(cid)→duplicate, 422(other)→validation, 429→rate_limit, 400→validation, 500→broker_internal');
}

// ─── AP-09: Netzwerkfehler → transient_network, GENAU EIN Call (kein Retry) ──
{
  const { broker, calls } = brokerWith(() => { throw new Error('ECONNRESET'); });
  const threw = await threwClass(() => broker.submitOrder({ client_order_id: 'c', symbol: 'X', qty: 1, order_action: 'buy' }),
    BROKER_ERROR_CLASSES.TRANSIENT_NETWORK);
  check('AP-09', threw && calls.length === 1, 'Netzwerkfehler → transient_network; kein automatischer Retry (1 Call)');
}

// ─── AP-10: 2xx ohne JSON-Body → unexpected_broker_response ──────────────────
{
  const { broker } = brokerWith(() => ({ statusCode: 200, json: undefined, text: '<html>oops' }));
  const threw = await threwClass(() => broker.submitOrder({ client_order_id: 'c', symbol: 'X', qty: 1, order_action: 'buy' }),
    BROKER_ERROR_CLASSES.UNEXPECTED_RESPONSE);
  check('AP-10', threw, '2xx ohne JSON → unexpected_broker_response');
}

// ─── AP-11: getOrderByClientId cid Pflicht ───────────────────────────────────
{
  const { broker, calls } = brokerWith(() => ({ statusCode: 200, json: okOrder() }));
  const threw = await threwClass(() => broker.getOrderByClientId(''), BROKER_ERROR_CLASSES.VALIDATION);
  check('AP-11', threw && calls.length === 0, 'leere client_order_id → validation, kein HTTP-Call');
}

// ─── AP-12: submit-Request-Validierung fail-closed vor HTTP ──────────────────
{
  const { broker, calls } = brokerWith(() => ({ statusCode: 200, json: okOrder() }));
  const v = BROKER_ERROR_CLASSES.VALIDATION;
  const ok =
    (await threwClass(() => broker.submitOrder({ client_order_id: 'c', symbol: 'X', qty: 0, order_action: 'buy' }), v)) &&
    (await threwClass(() => broker.submitOrder({ client_order_id: 'c', symbol: 'X', qty: 1, order_action: 'nope' }), v)) &&
    (await threwClass(() => broker.submitOrder({ client_order_id: 'c', symbol: 'X', qty: 1, order_action: 'buy', order_type: 'stop' }), v)) &&
    (await threwClass(() => broker.submitOrder({ client_order_id: 'c', symbol: 'X', qty: 1, order_action: 'buy', time_in_force: 'ioc' }), v)) &&
    (await threwClass(() => broker.submitOrder({ client_order_id: 'c', symbol: 'X', qty: 1, order_action: 'buy', order_type: 'limit' }), v)) &&
    calls.length === 0;
  check('AP-12', ok, 'qty<=0 / bad order_action / bad order_type / bad tif / limit ohne limit_price → validation, kein HTTP');
}

// ─── AP-13: Normalisierung — fehlende Fill-Felder ────────────────────────────
{
  const { broker } = brokerWith(() => ({ statusCode: 200, json: { id: 'B2', client_order_id: 'cid_n', status: 'new', symbol: 'X', qty: '1', side: 'buy', type: 'market', time_in_force: 'day' } }));
  const v = await broker.submitOrder({ client_order_id: 'cid_n', symbol: 'X', qty: 1, order_action: 'buy' });
  check('AP-13',
    v.filled_qty === 0 && v.avg_fill_price === null && v.raw_status === 'new' && v.client_order_id === 'cid_n',
    'fehlende filled_qty→0, filled_avg_price→null, raw_status passthrough');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\nalpaca_paper_broker_step3_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
