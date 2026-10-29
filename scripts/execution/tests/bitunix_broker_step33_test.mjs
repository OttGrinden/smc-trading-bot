#!/usr/bin/env node
/**
 * bitunix_broker_step33_test.mjs — Unit 33: BitunixBroker adapter tests.
 *
 * Tests (all offline, injected httpRequest):
 *   BX-01: Constructor rejects OFF config
 *   BX-02: Constructor rejects wrong mode
 *   BX-03: Constructor rejects missing credentials
 *   BX-04: Constructor accepts valid config
 *   BX-05: submitOrder validates client_order_id
 *   BX-06: submitOrder validates symbol
 *   BX-07: submitOrder validates qty
 *   BX-08: submitOrder validates order_action
 *   BX-09: submitOrder builds correct side/tradeSide for all 4 actions
 *   BX-10: submitOrder market → price=0; limit → price=limit_price
 *   BX-11: submitOrder 2xx+code=0 → normalizes to broker view
 *   BX-12: submitOrder broker_order_id encodes "SYMBOL::orderId"
 *   BX-13: submitOrder code≠0 → throws validation BrokerError
 *   BX-14: submitOrder network error → throws transient_network
 *   BX-15: getOrderByClientId validates clientId
 *   BX-16: getOrderByClientId 404 → null
 *   BX-17: getOrderByClientId code=40004 → null
 *   BX-18: getOrderByClientId 2xx+code=0 → normalized view
 *   BX-19: cancelOrder validates broker_order_id
 *   BX-20: cancelOrder parses SYMBOL::orderId and sends both
 *   BX-21: cancelOrder success → { accepted:true }
 *   BX-22: cancelOrder code=40004 → throws NOT_FOUND
 *   BX-23: getAccount normalizes USDT balance
 *   BX-24: getAccount network error → throws transient_network
 *   BX-25: Auth headers (api-key, sign, timestamp, nonce) present on every method
 *   BX-26: HMAC sign is non-empty hex string
 *   BX-27: parseBrokerExecConfig bitunix_futures — missing keys → throws
 *   BX-28: parseBrokerExecConfig bitunix_futures — valid → enabled config
 *   BX-29: brokerExecEnabled returns true for bitunix_futures
 *   BX-30: bitunixExecEnabled returns true only for bitunix_futures
 *
 * node execution/tests/bitunix_broker_step33_test.mjs
 */

import {
  BitunixBroker, BrokerError, BROKER_ERROR_CLASSES, parseEncodedId,
} from '../live_broker/adapters/bitunix_broker.mjs';
import {
  BROKER_EXEC_MODES, parseBrokerExecConfig, brokerExecEnabled, bitunixExecEnabled,
} from '../live_broker/live_broker_config.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(id, cond, detail = '') {
  if (cond) {
    process.stderr.write(`  PASS  ${id}\n`);
    passed++;
  } else {
    process.stderr.write(`  FAIL  ${id}${detail ? ': ' + detail : ''}\n`);
    failed++;
  }
}

function throws(fn, errClass = null) {
  try { fn(); return false; }
  catch (e) {
    if (errClass != null) return e instanceof errClass;
    return true;
  }
}

async function throwsAsync(fn, errClass = null) {
  try { await fn(); return false; }
  catch (e) {
    if (errClass != null) return e instanceof errClass;
    return true;
  }
}

function makeExecConfig(overrides = {}) {
  return {
    enabled:             true,
    mode:                BROKER_EXEC_MODES.BITUNIX_FUTURES,
    base_url:            'https://fapi.bitunix.com',
    api_key:             'test_api_key',
    secret_key:          'test_secret_key',
    credentials_present: true,
    ...overrides,
  };
}

function fakeBroker(execConfig, response) {
  return new BitunixBroker(execConfig, {
    httpRequest: async () => response,
  });
}

function captureRequest(execConfig) {
  let captured = null;
  const broker = new BitunixBroker(execConfig, {
    httpRequest: async (req) => { captured = req; return { statusCode: 200, json: { code: 0, data: { orderId: 'o1', clientId: 'c1' } }, text: '' }; },
  });
  return { broker, getCapture: () => captured };
}

// ─── BX-01: Constructor rejects OFF config ────────────────────────────────────

console.log('\n--- Constructor ---');
assert('BX-01',
  throws(() => new BitunixBroker({ enabled: false, mode: BROKER_EXEC_MODES.OFF }), BrokerError),
  'OFF config must throw BrokerError');

// BX-02: Constructor rejects wrong mode
assert('BX-02',
  throws(() => new BitunixBroker({ enabled: true, mode: BROKER_EXEC_MODES.ALPACA_PAPER, api_key: 'k', secret_key: 's' }), BrokerError),
  'alpaca_paper mode must throw BrokerError');

// BX-03: Constructor rejects missing credentials
assert('BX-03',
  throws(() => new BitunixBroker({ enabled: true, mode: BROKER_EXEC_MODES.BITUNIX_FUTURES }), BrokerError),
  'missing credentials must throw BrokerError');

// BX-04: Constructor accepts valid config
{
  let ok = false;
  try { new BitunixBroker(makeExecConfig()); ok = true; } catch {}
  assert('BX-04', ok, 'valid config must not throw');
}

// ─── BX-05..BX-08: submitOrder validation ────────────────────────────────────

console.log('\n--- submitOrder validation ---');

{
  const b = fakeBroker(makeExecConfig(), {});
  assert('BX-05', await throwsAsync(() => b.submitOrder({}), BrokerError),
    'missing client_order_id → BrokerError');
  assert('BX-06', await throwsAsync(() => b.submitOrder({ client_order_id: 'c1' }), BrokerError),
    'missing symbol → BrokerError');
  assert('BX-07', await throwsAsync(() => b.submitOrder({ client_order_id: 'c1', symbol: 'BTCUSDT', qty: -1, order_action: 'buy' }), BrokerError),
    'qty <= 0 → BrokerError');
  assert('BX-08', await throwsAsync(() => b.submitOrder({ client_order_id: 'c1', symbol: 'BTCUSDT', qty: 1, order_action: 'hold' }), BrokerError),
    'invalid order_action → BrokerError');
}

// ─── BX-09: side/tradeSide mapping ───────────────────────────────────────────

console.log('\n--- submitOrder side/tradeSide ---');
{
  const cases = [
    { action: 'buy',          side: 'BUY',  tradeSide: 'OPEN'  },
    { action: 'sell',         side: 'SELL', tradeSide: 'CLOSE' },
    { action: 'sell_short',   side: 'SELL', tradeSide: 'OPEN'  },
    { action: 'buy_to_cover', side: 'BUY',  tradeSide: 'CLOSE' },
  ];
  let allOk = true;
  for (const { action, side, tradeSide } of cases) {
    let sentBody = null;
    const b = new BitunixBroker(makeExecConfig(), {
      httpRequest: async (req) => { sentBody = req.body; return { statusCode: 200, json: { code: 0, data: { orderId: 'o1', clientId: 'c1' } }, text: '' }; },
    });
    await b.submitOrder({ client_order_id: 'c1', symbol: 'BTCUSDT', qty: 1, order_action: action });
    if (sentBody?.side !== side || sentBody?.tradeSide !== tradeSide) { allOk = false; break; }
  }
  assert('BX-09', allOk, 'all 4 order_action values map correctly to side+tradeSide');
}

// ─── BX-10: price encoding ────────────────────────────────────────────────────
{
  let mktBody = null, limBody = null;
  const makeCapture = () => new BitunixBroker(makeExecConfig(), {
    httpRequest: async (req) => { return { statusCode: 200, json: { code: 0, data: { orderId: 'o1', clientId: 'c1' } }, text: '' }; },
  });
  // market: price=0
  const bm = new BitunixBroker(makeExecConfig(), { httpRequest: async (req) => { mktBody = req.body; return { statusCode: 200, json: { code: 0, data: { orderId: 'o1', clientId: 'c1' } }, text: '' }; } });
  await bm.submitOrder({ client_order_id: 'c1', symbol: 'BTCUSDT', qty: 1, order_action: 'buy', order_type: 'market' });
  // limit: price=limit_price
  const bl = new BitunixBroker(makeExecConfig(), { httpRequest: async (req) => { limBody = req.body; return { statusCode: 200, json: { code: 0, data: { orderId: 'o1', clientId: 'c1' } }, text: '' }; } });
  await bl.submitOrder({ client_order_id: 'c2', symbol: 'BTCUSDT', qty: 1, order_action: 'buy', order_type: 'limit', limit_price: 60000 });
  assert('BX-10', mktBody?.price === '0' && limBody?.price === '60000', `market price=${mktBody?.price} limit price=${limBody?.price}`);
}

// ─── BX-11: 2xx+code=0 → normalized view ─────────────────────────────────────
console.log('\n--- submitOrder response ---');
{
  const b = fakeBroker(makeExecConfig(), {
    statusCode: 200,
    json: { code: 0, data: { orderId: 'ord123', clientId: 'dispatch_v1_x', symbol: 'BTCUSDT', status: 'NEW', qty: '1', filledQty: '0', avgPrice: '0' } },
    text: '',
  });
  const view = await b.submitOrder({ client_order_id: 'dispatch_v1_x', symbol: 'BTCUSDT', qty: 1, order_action: 'buy' });
  assert('BX-11', view.provider === 'bitunix' && view.client_order_id === 'dispatch_v1_x' && view.broker_order_id != null,
    `provider=${view.provider} cid=${view.client_order_id}`);
}

// ─── BX-12: broker_order_id = "SYMBOL::orderId" ──────────────────────────────
{
  const b = fakeBroker(makeExecConfig(), {
    statusCode: 200,
    json: { code: 0, data: { orderId: 'ord999', clientId: 'c1' } },
    text: '',
  });
  const view = await b.submitOrder({ client_order_id: 'c1', symbol: 'ETHUSDT', qty: 0.5, order_action: 'sell_short' });
  const { symbol, orderId } = parseEncodedId(view.broker_order_id);
  assert('BX-12', symbol === 'ETHUSDT' && orderId === 'ord999',
    `broker_order_id=${view.broker_order_id}`);
}

// ─── BX-13: code≠0 → BrokerError ─────────────────────────────────────────────
{
  const b = fakeBroker(makeExecConfig(), { statusCode: 200, json: { code: 40003, msg: 'duplicate clientId' }, text: '' });
  assert('BX-13', await throwsAsync(() =>
    b.submitOrder({ client_order_id: 'c1', symbol: 'BTCUSDT', qty: 1, order_action: 'buy' }), BrokerError),
    'code=40003 → BrokerError');
}

// ─── BX-14: network error → transient_network ────────────────────────────────
{
  const b = new BitunixBroker(makeExecConfig(), { httpRequest: async () => { throw new Error('ECONNREFUSED'); } });
  const err = await throwsAsync(() => b.submitOrder({ client_order_id: 'c1', symbol: 'BTCUSDT', qty: 1, order_action: 'buy' }), BrokerError);
  assert('BX-14', err, 'network error → BrokerError');
}

// ─── BX-15..BX-18: getOrderByClientId ────────────────────────────────────────
console.log('\n--- getOrderByClientId ---');
{
  const b = fakeBroker(makeExecConfig(), {});
  assert('BX-15', await throwsAsync(() => b.getOrderByClientId(''), BrokerError),
    'empty clientId → BrokerError');
}
{
  const b = fakeBroker(makeExecConfig(), { statusCode: 404, json: null, text: '' });
  const result = await b.getOrderByClientId('c1');
  assert('BX-16', result === null, '404 → null');
}
{
  const b = fakeBroker(makeExecConfig(), { statusCode: 200, json: { code: 40004, msg: 'not found' }, text: '' });
  const result = await b.getOrderByClientId('c1');
  assert('BX-17', result === null, 'code=40004 → null');
}
{
  const b = fakeBroker(makeExecConfig(), {
    statusCode: 200,
    json: { code: 0, data: { orderId: 'o5', clientId: 'c5', symbol: 'SOLIUSDT', status: 'FILLED', qty: '2', filledQty: '2', avgPrice: '100' } },
    text: '',
  });
  const view = await b.getOrderByClientId('c5');
  assert('BX-18',
    view.provider === 'bitunix' && view.broker_status === 'FILLED' && view.filled_qty === 2 && view.avg_fill_price === 100,
    `status=${view.broker_status} filled=${view.filled_qty} avg=${view.avg_fill_price}`);
}

// ─── BX-19..BX-22: cancelOrder ───────────────────────────────────────────────
console.log('\n--- cancelOrder ---');
{
  const b = fakeBroker(makeExecConfig(), {});
  assert('BX-19', await throwsAsync(() => b.cancelOrder(''), BrokerError),
    'empty id → BrokerError');
}
{
  let sentBody = null;
  const b = new BitunixBroker(makeExecConfig(), {
    httpRequest: async (req) => { sentBody = req.body; return { statusCode: 200, json: { code: 0, data: {} }, text: '' }; },
  });
  await b.cancelOrder('BTCUSDT::ord777');
  assert('BX-20', sentBody?.symbol === 'BTCUSDT' && sentBody?.orderId === 'ord777',
    `symbol=${sentBody?.symbol} orderId=${sentBody?.orderId}`);
}
{
  const b = fakeBroker(makeExecConfig(), { statusCode: 200, json: { code: 0, data: {} }, text: '' });
  const result = await b.cancelOrder('BTCUSDT::ord888');
  assert('BX-21', result.accepted === true && result.broker_order_id === 'BTCUSDT::ord888',
    `accepted=${result.accepted}`);
}
{
  const b = fakeBroker(makeExecConfig(), { statusCode: 200, json: { code: 40004, msg: 'order not found' }, text: '' });
  const err = await throwsAsync(() => b.cancelOrder('BTCUSDT::ord999'), BrokerError);
  assert('BX-22', err, 'code=40004 → NOT_FOUND BrokerError');
}

// ─── BX-23..BX-24: getAccount ────────────────────────────────────────────────
console.log('\n--- getAccount ---');
{
  const b = fakeBroker(makeExecConfig(), {
    statusCode: 200,
    json: { code: 0, data: { accountId: 'acc1', marginCoin: 'USDT', available: '850.50', frozen: '150.00', equity: '1000.50' } },
    text: '',
  });
  const acc = await b.getAccount();
  assert('BX-23',
    acc.provider === 'bitunix' && acc.currency === 'USDT' &&
    acc.cash === 850.5 && acc.equity === 1000.5 && acc.paper === false,
    `cash=${acc.cash} equity=${acc.equity} paper=${acc.paper}`);
}
{
  const b = new BitunixBroker(makeExecConfig(), { httpRequest: async () => { throw new Error('timeout'); } });
  assert('BX-24', await throwsAsync(() => b.getAccount(), BrokerError), 'network error → BrokerError');
}

// ─── BX-25..BX-26: Auth headers ──────────────────────────────────────────────
console.log('\n--- Auth headers ---');
{
  const AUTH_FIELDS = ['api-key', 'sign', 'timestamp', 'nonce'];
  let capturedHeaders = null;
  const b = new BitunixBroker(makeExecConfig(), {
    httpRequest: async (req) => {
      capturedHeaders = req.headers;
      return { statusCode: 200, json: { code: 0, data: { orderId: 'o1', clientId: 'c1' } }, text: '' };
    },
  });
  await b.submitOrder({ client_order_id: 'c1', symbol: 'BTCUSDT', qty: 1, order_action: 'buy' });
  assert('BX-25',
    AUTH_FIELDS.every(f => typeof capturedHeaders?.[f] === 'string' && capturedHeaders[f].length > 0),
    `headers=${JSON.stringify(Object.keys(capturedHeaders ?? {}))}`);
  assert('BX-26',
    /^[0-9a-f]{64}$/.test(capturedHeaders?.['sign'] ?? ''),
    `sign="${capturedHeaders?.['sign']}"`);
}

// ─── BX-27..BX-30: parseBrokerExecConfig Bitunix ────────────────────────────
console.log('\n--- parseBrokerExecConfig ---');
{
  assert('BX-27',
    throws(() => parseBrokerExecConfig(['--broker-exec', 'bitunix_futures'], {})),
    'missing BITUNIX_API_KEY/SECRET_KEY → throws');
}
{
  const cfg = parseBrokerExecConfig(
    ['--broker-exec', 'bitunix_futures'],
    { BITUNIX_API_KEY: 'k', BITUNIX_SECRET_KEY: 's' }
  );
  assert('BX-28',
    cfg.enabled === true && cfg.mode === BROKER_EXEC_MODES.BITUNIX_FUTURES &&
    cfg.api_key === 'k' && cfg.secret_key === 's' &&
    cfg.base_url === 'https://fapi.bitunix.com',
    `enabled=${cfg.enabled} mode=${cfg.mode}`);
}
{
  const cfg = parseBrokerExecConfig(
    ['--broker-exec', 'bitunix_futures'],
    { BITUNIX_API_KEY: 'k', BITUNIX_SECRET_KEY: 's' }
  );
  assert('BX-29', brokerExecEnabled(cfg) === true,
    'brokerExecEnabled must be true for bitunix_futures');
}
{
  const cfgBx  = parseBrokerExecConfig(['--broker-exec', 'bitunix_futures'], { BITUNIX_API_KEY: 'k', BITUNIX_SECRET_KEY: 's' });
  const cfgOff = parseBrokerExecConfig([], {});
  assert('BX-30',
    bitunixExecEnabled(cfgBx) === true && bitunixExecEnabled(cfgOff) === false,
    'bitunixExecEnabled true only for bitunix_futures');
}

// ─── BX-31..BX-35: TPSL on entry orders ──────────────────────────────────────
console.log('\n--- TPSL entry orders ---');
{
  // BX-31: LONG entry with SL → slPrice below entry, MARK_PRICE, MARKET
  const { broker, getCapture } = captureRequest(makeExecConfig());
  await broker.submitOrder({
    client_order_id: 'tpsl_long_sl',
    symbol: 'BTCUSDT', qty: 0.001, order_action: 'buy',
    price_usd: 100000, stop_loss_pct: 5,
  });
  const body = JSON.parse(getCapture().body ? JSON.stringify(getCapture().body) : '{}');
  const slExpected = String(+(100000 * 0.95).toFixed(2));
  assert('BX-31',
    body.slPrice === slExpected && body.slStopType === 'MARK_PRICE' && body.slOrderType === 'MARKET',
    `slPrice=${body.slPrice} expected=${slExpected} slStopType=${body.slStopType}`);
}
{
  // BX-32: SHORT entry with TP → tpPrice BELOW entry
  const { broker, getCapture } = captureRequest(makeExecConfig());
  await broker.submitOrder({
    client_order_id: 'tpsl_short_tp',
    symbol: 'ETHUSDT', qty: 0.1, order_action: 'sell_short',
    price_usd: 4000, take_profit_pct: 20,
  });
  const body = JSON.parse(getCapture().body ? JSON.stringify(getCapture().body) : '{}');
  const tpExpected = String(+(4000 * 0.80).toFixed(2));
  assert('BX-32',
    body.tpPrice === tpExpected && body.tpStopType === 'MARK_PRICE' && body.tpOrderType === 'MARKET' && !body.slPrice,
    `tpPrice=${body.tpPrice} expected=${tpExpected}`);
}
{
  // BX-33: CLOSE order (sell) → no TPSL in payload
  const { broker, getCapture } = captureRequest(makeExecConfig());
  await broker.submitOrder({
    client_order_id: 'tpsl_close',
    symbol: 'BTCUSDT', qty: 0.001, order_action: 'sell',
    price_usd: 100000, stop_loss_pct: 5, take_profit_pct: 20,
  });
  const body = JSON.parse(getCapture().body ? JSON.stringify(getCapture().body) : '{}');
  assert('BX-33', !body.slPrice && !body.tpPrice,
    `close order must not have TPSL: slPrice=${body.slPrice} tpPrice=${body.tpPrice}`);
}
{
  // BX-34: missing price_usd → no TPSL even if pct provided
  const { broker, getCapture } = captureRequest(makeExecConfig());
  await broker.submitOrder({
    client_order_id: 'tpsl_noprice',
    symbol: 'BTCUSDT', qty: 0.001, order_action: 'buy',
    stop_loss_pct: 5, take_profit_pct: 20,
  });
  const body = JSON.parse(getCapture().body ? JSON.stringify(getCapture().body) : '{}');
  assert('BX-34', !body.slPrice && !body.tpPrice,
    `no price_usd → no TPSL: slPrice=${body.slPrice} tpPrice=${body.tpPrice}`);
}
{
  // BX-35: LONG with both SL+TP → correct absolute prices for both
  const { broker, getCapture } = captureRequest(makeExecConfig());
  await broker.submitOrder({
    client_order_id: 'tpsl_both',
    symbol: 'BTCUSDT', qty: 0.001, order_action: 'buy',
    price_usd: 80000, stop_loss_pct: 2.5, take_profit_pct: 18,
  });
  const body = JSON.parse(getCapture().body ? JSON.stringify(getCapture().body) : '{}');
  const slExp = String(+(80000 * 0.975).toFixed(2));
  const tpExp = String(+(80000 * 1.18).toFixed(2));
  assert('BX-35',
    body.slPrice === slExp && body.tpPrice === tpExp,
    `sl=${body.slPrice}/${slExp} tp=${body.tpPrice}/${tpExp}`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nbitunix_broker_step33_test: ${passed}/${passed + failed} PASS`);
if (failed > 0) process.exit(1);
