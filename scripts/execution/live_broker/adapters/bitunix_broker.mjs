/**
 * Bitunix Futures Broker — write-capable adapter (Unit 33).
 *
 * SCOPE:
 *   - submitOrder(orderReq)          → POST /api/v1/futures/trade/place_order
 *   - getOrderByClientId(clientId)   → GET  /api/v1/futures/trade/get_order_detail?clientId=...
 *   - cancelOrder(encodedId)         → POST /api/v1/futures/trade/cancel_order
 *   - getAccount()                   → GET  /api/v1/futures/account?marginCoin=USDT
 *
 * Pure adapter: request build → sign → HTTP call → response normalize → error classify.
 * No flow orchestration, no persistence, no state machine, no retry.
 *
 * Auth: HMAC-SHA256 over nonce+timestamp+api_key+queryStr+body signed with secret_key.
 * Headers required: api-key, sign, timestamp, nonce.
 *
 * broker_order_id encoding: "${symbol}::${orderId}" — allows cancel to recover symbol
 * from the encoded id without additional lookup (Bitunix cancel requires symbol).
 *
 * Order statuses Bitunix → internal (via FillPoller.mapBrokerStatus lowercase):
 *   NEW            → acknowledged
 *   PARTIALLY_FILLED → partially_filled
 *   FILLED         → filled
 *   CANCELLED      → cancelled
 *   REJECTED       → rejected
 *
 * HTTP transport is injectable (opts.httpRequest) for offline testing.
 */

import https                  from 'node:https';
import { URL }                from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { BROKER_EXEC_MODES }  from '../live_broker_config.mjs';

export const BITUNIX_FUTURES_URL = 'https://fapi.bitunix.com';
const REQUEST_TIMEOUT_MS         = 15_000;

// ─── Error classification (mirrors alpaca_paper_broker for interface parity) ────

export const BROKER_ERROR_CLASSES = Object.freeze({
  VALIDATION:                 'validation',
  AUTH:                       'auth',
  DUPLICATE_CLIENT_ORDER_ID:  'duplicate_client_order_id',
  RATE_LIMIT:                 'rate_limit',
  TRANSIENT_NETWORK:          'transient_network',
  BROKER_INTERNAL:            'broker_internal',
  NOT_FOUND:                  'not_found',
  UNEXPECTED_RESPONSE:        'unexpected_broker_response',
});

export class BrokerError extends Error {
  constructor(errorClass, detail, httpStatus = null) {
    super(`[${errorClass}] ${detail}`);
    this.name        = 'BrokerError';
    this.error_class = errorClass;
    this.http_status = httpStatus;
    this.detail      = detail;
  }
}

function messageOf(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'object') return body.msg ?? body.message ?? JSON.stringify(body).slice(0, 400);
  return String(body);
}

/** classifyBitunix — map HTTP status + Bitunix error code to a BrokerError. */
function classifyBitunix(code, msg, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403 || code === 40001 || code === 40002 || code === 10007 || code === 10008)
    return new BrokerError(BROKER_ERROR_CLASSES.AUTH, msg, httpStatus);
  if (httpStatus === 429 || code === 42900)
    return new BrokerError(BROKER_ERROR_CLASSES.RATE_LIMIT, msg, httpStatus);
  if (httpStatus === 404 || code === 40004 || code === 404)
    return new BrokerError(BROKER_ERROR_CLASSES.NOT_FOUND, msg, httpStatus);
  if (code === 40003 || /duplicate|client.*id/i.test(String(msg)))
    return new BrokerError(BROKER_ERROR_CLASSES.DUPLICATE_CLIENT_ORDER_ID, msg, httpStatus);
  if (httpStatus >= 500)
    return new BrokerError(BROKER_ERROR_CLASSES.BROKER_INTERNAL, msg, httpStatus);
  if (httpStatus >= 400 || (code != null && code !== 0))
    return new BrokerError(BROKER_ERROR_CLASSES.VALIDATION,
      `Bitunix error ${code != null ? `(code=${code}) ` : ''}${msg}`, httpStatus);
  return new BrokerError(BROKER_ERROR_CLASSES.UNEXPECTED_RESPONSE,
    `unexpected status ${httpStatus}: ${msg}`, httpStatus);
}

// ─── Double-SHA256 signing (Bitunix spec) ──────────────────────────────────────
//
// Bitunix uses a two-round SHA256, NOT HMAC-SHA256:
//   digest = SHA256(nonce + timestamp + apiKey + signParams + body)
//   sign   = SHA256(digest + secretKey)
//
// Query params for signing: sort keys alphabetically, concatenate as key+value
// with NO separators (e.g. { marginCoin:'USDT' } → 'marginCoinUSDT').
// The URL still uses standard ?key=value encoding.

function makeNonce() {
  return randomBytes(16).toString('hex');   // 32-char lowercase hex
}

/** signParams — serialize query params for the signature (sorted, no separators). */
function signParams(params = {}) {
  return Object.keys(params).sort().map(k => k + params[k]).join('');
}

/** urlParams — serialize query params for the URL (sorted, standard encoding). */
function urlParams(params = {}) {
  return Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
}

/**
 * authHeaders — build the four required Bitunix auth headers.
 * @param {object} opts.params — query params object (GET); omit for POST
 * @param {string} opts.body   — compact JSON string (POST); omit for GET
 */
function authHeaders({ apiKey, secretKey, params = {}, body = '' }) {
  const timestamp = Date.now().toString();
  const nonce     = makeNonce();
  const sp        = signParams(params);
  const digest    = createHash('sha256').update(nonce + timestamp + apiKey + sp + body).digest('hex');
  const signature = createHash('sha256').update(digest + secretKey).digest('hex');
  return {
    'api-key':   apiKey,
    'sign':      signature,
    'timestamp': timestamp,
    'nonce':     nonce,
  };
}

// ─── Default HTTP transport (node:https; same contract as alpaca_paper_broker) ──

function defaultHttpRequest({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) {
      return reject(new Error(`invalid_url: ${url} — ${e.message}`));
    }
    const payload = body != null ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Accept':     'application/json',
        'User-Agent': 'trading-bot/bitunix-futures/1.0',
        ...(payload != null
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = undefined; }
        resolve({ statusCode: res.statusCode, json, text: raw });
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () =>
      req.destroy(new Error(`request_timeout_${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

// ─── Response normalizers ───────────────────────────────────────────────────────

/**
 * normalizeBrokerOrder — project-internal broker view.
 * broker_order_id is encoded as "SYMBOL::orderId" so cancelOrder can recover both.
 * On a submit response Bitunix only returns orderId+clientId; status/qty come from GET.
 */
function normalizeBrokerOrder(raw, fallbackClientId = null, fallbackSymbol = null) {
  const orderId  = raw?.orderId  ?? raw?.order_id  ?? null;
  const symbol   = raw?.symbol   ?? fallbackSymbol ?? null;
  const clientId = raw?.clientId ?? raw?.client_id ?? fallbackClientId;
  return {
    provider:        'bitunix',
    client_order_id: clientId,
    broker_order_id: (orderId && symbol) ? `${symbol}::${orderId}` : orderId,
    broker_status:   raw?.status ?? null,           // raw Bitunix status — FillPoller maps it
    filled_qty:      raw?.filledQty != null ? parseFloat(raw.filledQty) : 0,
    avg_fill_price:  (raw?.avgPrice != null && parseFloat(raw.avgPrice) > 0)
                     ? parseFloat(raw.avgPrice) : null,
    symbol,
    qty:             raw?.qty != null ? parseFloat(raw.qty) : null,
    side:            raw?.side   ?? null,
    type:            raw?.orderType?.toLowerCase() ?? null,
    time_in_force:   raw?.timeInForce?.toLowerCase() ?? null,
    raw_status:      raw?.status ?? null,
  };
}

/**
 * normalizeAccount — normalize Bitunix account response to the account_sizing shape:
 *   { provider, currency, cash, buying_power, portfolio_value, equity, status, paper }
 * Bitunix returns a single USDT margin account object.
 */
function normalizeAccount(raw) {
  // data can be an object or array; find USDT entry if array.
  const entry = Array.isArray(raw)
    ? (raw.find(e => e.marginCoin === 'USDT') ?? raw[0] ?? {})
    : (raw ?? {});

  const available = parseFloat(entry.available ?? 0);
  const frozen    = parseFloat(entry.frozen    ?? 0);
  // Bitunix 'equity' = unrealized PnL of open positions (not total wallet balance).
  // Total wallet = available (free) + frozen (margin in use).
  const totalWallet = available + frozen;

  return {
    provider:        'bitunix',
    account_id:      entry.accountId  ?? null,
    currency:        entry.marginCoin ?? 'USDT',
    cash:            available,
    buying_power:    available,
    portfolio_value: totalWallet,
    equity:          totalWallet,
    status:          'active',
    paper:           false,
    ts:              new Date().toISOString(),
  };
}

// ─── order_action → Bitunix side + tradeSide ───────────────────────────────────

function bitunixSideFor(orderAction) {
  if (orderAction === 'buy')          return { side: 'BUY',  tradeSide: 'OPEN'  };
  if (orderAction === 'sell')         return { side: 'SELL', tradeSide: 'CLOSE' };
  if (orderAction === 'sell_short')   return { side: 'SELL', tradeSide: 'OPEN'  };
  if (orderAction === 'buy_to_cover') return { side: 'BUY',  tradeSide: 'CLOSE' };
  return null;
}

// ─── broker_order_id encoding/decoding ─────────────────────────────────────────

/** parseEncodedId — split "SYMBOL::orderId" into parts. */
export function parseEncodedId(encodedId) {
  const sep = String(encodedId).indexOf('::');
  if (sep === -1) return { symbol: null, orderId: encodedId };
  return { symbol: encodedId.slice(0, sep), orderId: encodedId.slice(sep + 2) };
}

// ─── BitunixBroker ─────────────────────────────────────────────────────────────

export class BitunixBroker {
  /**
   * @param {object} execConfig — from parseBrokerExecConfig() (must be enabled bitunix_futures)
   * @param {object} opts       — { httpRequest? } injectable transport for offline tests
   */
  constructor(execConfig, opts = {}) {
    if (!execConfig || execConfig.enabled !== true ||
        execConfig.mode !== BROKER_EXEC_MODES.BITUNIX_FUTURES) {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION,
        'BitunixBroker requires an enabled bitunix_futures exec config (fail-closed).');
    }
    if (!execConfig.api_key || !execConfig.secret_key) {
      throw new BrokerError(BROKER_ERROR_CLASSES.AUTH,
        'BitunixBroker requires api_key and secret_key.');
    }
    this.baseUrl  = execConfig.base_url ?? BITUNIX_FUTURES_URL;
    this.provider = 'bitunix';
    this.mode     = 'futures';
    this._key     = execConfig.api_key;
    this._secret  = execConfig.secret_key;
    this._http    = typeof opts.httpRequest === 'function' ? opts.httpRequest : defaultHttpRequest;
  }

  /**
   * submitOrder — POST a new futures order to Bitunix.
   * Fills side/tradeSide from order_action; sets price=0 for market orders.
   *
   * @param {object} orderReq — { client_order_id (req), symbol (req), qty (req>0),
   *   order_action (req: buy|sell|sell_short|buy_to_cover), order_type (market|limit|stop),
   *   time_in_force (day|gtc), limit_price (req for limit), stop_price (req for stop) }
   * @returns {object} normalized brokerOrderView (broker_order_id = "SYMBOL::orderId")
   * @throws  {BrokerError}
   */
  async submitOrder(orderReq = {}) {
    const cid = orderReq.client_order_id;
    if (typeof cid !== 'string' || !cid)
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, 'submitOrder: client_order_id is required');
    if (typeof orderReq.symbol !== 'string' || !orderReq.symbol)
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, `submitOrder: symbol is required (${cid})`);

    const qty = orderReq.qty;
    if (!Number.isFinite(qty) || qty <= 0)
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, `submitOrder: qty must be > 0 (${cid})`);

    const sides = bitunixSideFor(orderReq.order_action);
    if (!sides)
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION,
        `submitOrder: invalid order_action "${orderReq.order_action}" (${cid})`);

    const rawType = (orderReq.order_type ?? 'market').toLowerCase();
    const typeMap = { market: 'MARKET', limit: 'LIMIT', stop: 'MARKET' };  // stop→MARKET+stopPrice
    const orderType = typeMap[rawType];
    if (!orderType)
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION,
        `submitOrder: invalid order_type "${orderReq.order_type}" (${cid})`);

    if (rawType === 'limit' && !(Number.isFinite(orderReq.limit_price) && orderReq.limit_price > 0))
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION,
        `submitOrder: limit order requires limit_price > 0 (${cid})`);
    if (rawType === 'stop' && !(Number.isFinite(orderReq.stop_price) && orderReq.stop_price > 0))
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION,
        `submitOrder: stop order requires stop_price > 0 (${cid})`);

    const price = rawType === 'market' ? '0'
                : rawType === 'stop'   ? String(orderReq.stop_price)
                : String(orderReq.limit_price);

    const payload = {
      symbol:    orderReq.symbol,
      qty:       String(qty),
      side:      sides.side,
      tradeSide: sides.tradeSide,
      orderType,
      clientId:  cid,
      price,
    };

    // Attach SL/TP to entry orders when price reference and percentages are available
    if (sides.tradeSide === 'OPEN') {
      const entryPrice = orderReq.price_usd;
      const isLong     = sides.side === 'BUY';
      if (Number.isFinite(entryPrice) && entryPrice > 0) {
        if (Number.isFinite(orderReq.stop_loss_pct) && orderReq.stop_loss_pct > 0) {
          const slFrac = orderReq.stop_loss_pct / 100;
          const slPrice = isLong
            ? entryPrice * (1 - slFrac)
            : entryPrice * (1 + slFrac);
          payload.slPrice     = String(+slPrice.toFixed(2));
          payload.slStopType  = 'MARK_PRICE';
          payload.slOrderType = 'MARKET';
        }
        if (Number.isFinite(orderReq.take_profit_pct) && orderReq.take_profit_pct > 0) {
          const tpFrac = orderReq.take_profit_pct / 100;
          const tpPrice = isLong
            ? entryPrice * (1 + tpFrac)
            : entryPrice * (1 - tpFrac);
          payload.tpPrice     = String(+tpPrice.toFixed(2));
          payload.tpStopType  = 'MARK_PRICE';
          payload.tpOrderType = 'MARKET';
        }
      }
    }

    const bodyStr = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      ...authHeaders({ apiKey: this._key, secretKey: this._secret, body: bodyStr }),
    };

    let resp;
    try {
      resp = await this._http({
        method:  'POST',
        url:     `${this.baseUrl}/api/v1/futures/trade/place_order`,
        headers,
        body:    payload,
      });
    } catch (e) {
      throw new BrokerError(BROKER_ERROR_CLASSES.TRANSIENT_NETWORK,
        `submitOrder network error (${cid}): ${e.message}`);
    }

    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      const { code, msg, data } = resp.json ?? {};
      if (code !== 0)
        throw classifyBitunix(code, msg ?? messageOf(resp.json), resp.statusCode);
      if (data == null || typeof data !== 'object')
        throw new BrokerError(BROKER_ERROR_CLASSES.UNEXPECTED_RESPONSE,
          `submitOrder: unexpected data shape (${cid})`, resp.statusCode);
      return normalizeBrokerOrder(data, cid, orderReq.symbol);
    }
    const body = resp.json ?? {};
    throw classifyBitunix(body.code, body.msg ?? messageOf(body), resp.statusCode);
  }

  /**
   * getOrderByClientId — look up an order by clientId.
   * Bitunix GET /api/v1/futures/trade/get_order_detail?clientId=...
   *
   * @returns {object|null} normalized brokerOrderView, or null if not found.
   * @throws  {BrokerError} on any non-404 error
   */
  async getOrderByClientId(clientOrderId) {
    if (typeof clientOrderId !== 'string' || !clientOrderId)
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION,
        'getOrderByClientId: client_order_id is required');

    const params  = { clientId: clientOrderId };
    const headers = authHeaders({ apiKey: this._key, secretKey: this._secret, params });
    const url     = `${this.baseUrl}/api/v1/futures/trade/get_order_detail?${urlParams(params)}`;

    let resp;
    try {
      resp = await this._http({ method: 'GET', url, headers });
    } catch (e) {
      throw new BrokerError(BROKER_ERROR_CLASSES.TRANSIENT_NETWORK,
        `getOrderByClientId network error (${clientOrderId}): ${e.message}`);
    }

    if (resp.statusCode === 404) return null;
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      const { code, msg, data } = resp.json ?? {};
      if (code === 40004 || code === 404) return null;   // Bitunix "not found" code
      if (code !== 0) throw classifyBitunix(code, msg, resp.statusCode);
      if (data == null || typeof data !== 'object')
        throw new BrokerError(BROKER_ERROR_CLASSES.UNEXPECTED_RESPONSE,
          `getOrderByClientId: unexpected data shape (${clientOrderId})`, resp.statusCode);
      return normalizeBrokerOrder(data, clientOrderId);
    }
    const body = resp.json ?? {};
    throw classifyBitunix(body.code, body.msg ?? messageOf(body), resp.statusCode);
  }

  /**
   * cancelOrder — request cancellation via POST /api/v1/futures/trade/cancel_order.
   * Bitunix requires symbol; it is recovered from the encoded broker_order_id ("SYM::id").
   *
   * @param {string} encodedBrokerOrderId — "SYMBOL::orderId" (from normalizeBrokerOrder)
   * @returns {{ accepted:true, http_status, broker_order_id }} on success
   * @throws  {BrokerError}
   */
  async cancelOrder(encodedBrokerOrderId) {
    if (typeof encodedBrokerOrderId !== 'string' || !encodedBrokerOrderId)
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION,
        'cancelOrder: broker_order_id is required');

    const { symbol, orderId } = parseEncodedId(encodedBrokerOrderId);
    const payload = symbol ? { symbol, orderId } : { orderId };

    const bodyStr = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      ...authHeaders({ apiKey: this._key, secretKey: this._secret, body: bodyStr }),
    };

    let resp;
    try {
      resp = await this._http({
        method:  'POST',
        url:     `${this.baseUrl}/api/v1/futures/trade/cancel_order`,
        headers,
        body:    payload,
      });
    } catch (e) {
      throw new BrokerError(BROKER_ERROR_CLASSES.TRANSIENT_NETWORK,
        `cancelOrder network error (${encodedBrokerOrderId}): ${e.message}`);
    }

    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      const { code, msg } = resp.json ?? {};
      if (code === 40004) throw new BrokerError(BROKER_ERROR_CLASSES.NOT_FOUND, msg, resp.statusCode);
      if (code !== 0)     throw classifyBitunix(code, msg, resp.statusCode);
      return { accepted: true, http_status: resp.statusCode, broker_order_id: encodedBrokerOrderId };
    }
    const body = resp.json ?? {};
    throw classifyBitunix(body.code, body.msg ?? messageOf(body), resp.statusCode);
  }

  /**
   * getAccount — fetch and normalize the Bitunix futures account.
   * GET /api/v1/futures/account/account
   *
   * @returns {object} normalized account snapshot (account_sizing-compatible shape)
   * @throws  {BrokerError}
   */
  async getAccount() {
    // marginCoin is required. In the signature: 'marginCoinUSDT' (no separator).
    // In the URL: ?marginCoin=USDT (standard encoding).
    const params  = { marginCoin: 'USDT' };
    const headers = authHeaders({ apiKey: this._key, secretKey: this._secret, params });

    let resp;
    try {
      resp = await this._http({
        method:  'GET',
        url:     `${this.baseUrl}/api/v1/futures/account?${urlParams(params)}`,
        headers,
      });
    } catch (e) {
      throw new BrokerError(BROKER_ERROR_CLASSES.TRANSIENT_NETWORK,
        `getAccount network error: ${e.message}`);
    }

    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      const { code, msg, data } = resp.json ?? {};
      if (code !== 0) {
        const detail = (code === 404 || code === 40004)
          ? `${msg ?? 'Not Found'} — Bitunix futures account not found; enable futures trading on your Bitunix account and ensure the API key has futures permissions`
          : (msg ?? `code ${code}`);
        throw classifyBitunix(code, detail, resp.statusCode);
      }
      if (data == null)
        throw new BrokerError(BROKER_ERROR_CLASSES.UNEXPECTED_RESPONSE,
          'getAccount: null data', resp.statusCode);
      return normalizeAccount(data);
    }
    const body = resp.json ?? {};
    throw classifyBitunix(body.code, body.msg ?? messageOf(body), resp.statusCode);
  }
}
