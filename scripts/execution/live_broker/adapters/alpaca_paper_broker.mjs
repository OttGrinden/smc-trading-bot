/**
 * Alpaca PAPER Broker — write-capable adapter (Phase 1, Step 3).
 *
 * SCOPE (Step 3 ONLY):
 *   - submitOrder(orderReq)          → POST /v2/orders        (paper endpoint only)
 *   - getOrderByClientId(clientId)   → GET  /v2/orders:by_client_order_id
 *
 * This module is a PURE adapter: request build → HTTP call → response normalize →
 * error classify. It contains NO flow orchestration:
 *   - no OrderGateway, no persistence, no polling, no listOpenOrders
 *   - no cancel, no replace, no reconciler, no retry orchestration
 *   - no runtime wiring, no portfolio mutation, no local state machine
 *
 * Safety (fail-closed):
 *   - constructed ONLY from a validated alpaca_paper exec config (paper endpoint),
 *     re-asserted here; any non-paper / unclear config throws.
 *   - client_order_id is mandatory on both methods.
 *   - errors are classified and surfaced, never swallowed; no automatic retry.
 *
 * HTTP transport is injectable (opts.httpRequest) so the request shape and error
 * mapping are fully testable offline. Default transport uses node:https only.
 */

import https from 'node:https';
import { URL } from 'node:url';
import { BROKER_EXEC_MODES } from '../live_broker_config.mjs';

const ALPACA_PAPER_URL   = 'https://paper-api.alpaca.markets';   // literal guard (matches live_broker_config)
const REQUEST_TIMEOUT_MS = 15_000;

// ─── Error classification ──────────────────────────────────────────────────────

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
  if (typeof body === 'object') return body.message ?? JSON.stringify(body).slice(0, 400);
  return String(body);
}

/** classifyHttp — map an HTTP status + body to a BrokerError class (no retry here). */
function classifyHttp(statusCode, body) {
  const msg = messageOf(body);
  if (statusCode === 401 || statusCode === 403) return new BrokerError(BROKER_ERROR_CLASSES.AUTH, msg, statusCode);
  if (statusCode === 429)                       return new BrokerError(BROKER_ERROR_CLASSES.RATE_LIMIT, msg, statusCode);
  if (statusCode === 404)                       return new BrokerError(BROKER_ERROR_CLASSES.NOT_FOUND, msg, statusCode);
  if (statusCode === 422) {
    return /client_order_id/i.test(msg)
      ? new BrokerError(BROKER_ERROR_CLASSES.DUPLICATE_CLIENT_ORDER_ID, msg, statusCode)
      : new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, msg, statusCode);
  }
  if (statusCode >= 400 && statusCode < 500)    return new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, msg, statusCode);
  if (statusCode >= 500)                        return new BrokerError(BROKER_ERROR_CLASSES.BROKER_INTERNAL, msg, statusCode);
  return new BrokerError(BROKER_ERROR_CLASSES.UNEXPECTED_RESPONSE, `unexpected status ${statusCode}: ${msg}`, statusCode);
}

// ─── Default HTTP transport (node:https; resolves on ANY status, rejects only on network) ──

function defaultHttpRequest({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error(`invalid_url: ${url} — ${e.message}`)); }

    const payload = body != null ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Accept':       'application/json',
        'User-Agent':   'trading-bot/phase1-paper-write/1.0',
        ...(payload != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
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
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`request_timeout_${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

// ─── Response normalizer (small brokerOrderView; no portfolio view, no state machine) ──

function normalizeBrokerOrder(raw, fallbackClientId = null) {
  return {
    provider:        'alpaca',
    client_order_id: raw?.client_order_id ?? fallbackClientId,
    broker_order_id: raw?.id ?? null,
    broker_status:   raw?.status ?? null,           // RAW Alpaca status — mapping is the poller's job (out of scope)
    filled_qty:      raw?.filled_qty != null ? parseFloat(raw.filled_qty) : 0,
    avg_fill_price:  raw?.filled_avg_price != null ? parseFloat(raw.filled_avg_price) : null,
    symbol:          raw?.symbol ?? null,
    qty:             raw?.qty != null ? parseFloat(raw.qty) : null,
    side:            raw?.side ?? null,             // Alpaca order side (buy|sell)
    type:            raw?.type ?? null,
    time_in_force:   raw?.time_in_force ?? null,
    raw_status:      raw?.status ?? null,
  };
}

/**
 * normalizeAccount — normalize an Alpaca account response to the project-internal
 * snapshot shape consumed by account_sizing.sizeIntentsFromAccount (Unit 10.8):
 *   { currency, cash, buying_power, portfolio_value, equity, status, paper }
 * Mirrors the read-only alpaca_adapter normalizer; paper is always true here.
 */
function normalizeAccount(raw) {
  return {
    provider:        'alpaca',
    account_id:      raw?.id ?? raw?.account_number ?? null,
    currency:        raw?.currency ?? 'USD',
    cash:            parseFloat(raw?.cash ?? 0),
    buying_power:    parseFloat(raw?.buying_power ?? 0),
    portfolio_value: parseFloat(raw?.portfolio_value ?? 0),
    equity:          parseFloat(raw?.equity ?? raw?.portfolio_value ?? 0),
    status:          raw?.status ?? null,
    paper:           true,
    ts:              new Date().toISOString(),
  };
}

// order_action (position semantics) → Alpaca order side. Short legs map to sell/buy.
function alpacaSideFor(orderAction) {
  if (orderAction === 'buy' || orderAction === 'buy_to_cover') return 'buy';
  if (orderAction === 'sell' || orderAction === 'sell_short')  return 'sell';
  return null;
}

// ─── AlpacaPaperBroker ─────────────────────────────────────────────────────────

export class AlpacaPaperBroker {
  /**
   * @param {object} execConfig — from parseBrokerExecConfig() (must be enabled alpaca_paper)
   * @param {object} opts       — { httpRequest? } injectable transport for tests
   */
  constructor(execConfig, opts = {}) {
    if (!execConfig || execConfig.enabled !== true || execConfig.mode !== BROKER_EXEC_MODES.ALPACA_PAPER) {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION,
        'AlpacaPaperBroker requires an enabled alpaca_paper exec config (fail-closed).');
    }
    if (execConfig.paper !== true || execConfig.base_url !== ALPACA_PAPER_URL) {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION,
        `AlpacaPaperBroker refuses non-paper config (paper=${execConfig.paper}, base_url=${execConfig.base_url}).`);
    }
    if (!execConfig.key_id || !execConfig.secret_key) {
      throw new BrokerError(BROKER_ERROR_CLASSES.AUTH, 'AlpacaPaperBroker requires key_id and secret_key.');
    }
    this.baseUrl  = execConfig.base_url;
    this.paper    = true;
    this.provider = 'alpaca';
    this.mode     = 'write_paper';
    this._headers = Object.freeze({
      'APCA-API-KEY-ID':     execConfig.key_id,
      'APCA-API-SECRET-KEY': execConfig.secret_key,
    });
    this._http = typeof opts.httpRequest === 'function' ? opts.httpRequest : defaultHttpRequest;
  }

  /**
   * submitOrder — POST a new order to the Alpaca PAPER endpoint.
   * Pure adapter call: validate → POST → normalize → classify. No retry, no persistence.
   *
   * @param {object} orderReq — { client_order_id (req), symbol (req), qty (req>0),
   *   order_action (req: buy|sell|sell_short|buy_to_cover), order_type (market|limit),
   *   time_in_force (day|gtc), limit_price (req when limit) }
   * @returns {object} normalized brokerOrderView
   * @throws  {BrokerError}
   */
  async submitOrder(orderReq = {}) {
    const cid = orderReq.client_order_id;
    if (typeof cid !== 'string' || !cid) {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, 'submitOrder: client_order_id is required');
    }
    if (typeof orderReq.symbol !== 'string' || !orderReq.symbol) {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, `submitOrder: symbol is required (${cid})`);
    }
    const qty = orderReq.qty;
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, `submitOrder: qty must be > 0 (${cid})`);
    }
    const side = alpacaSideFor(orderReq.order_action);
    if (!side) {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION,
        `submitOrder: invalid/absent order_action "${orderReq.order_action}" (${cid})`);
    }
    const type = orderReq.order_type ?? 'market';
    if (type !== 'market' && type !== 'limit' && type !== 'stop') {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, `submitOrder: invalid order_type "${type}" (${cid})`);
    }
    const tif = orderReq.time_in_force ?? 'day';
    if (tif !== 'day' && tif !== 'gtc') {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, `submitOrder: invalid time_in_force "${tif}" (${cid})`);
    }
    if (type === 'limit' && !(Number.isFinite(orderReq.limit_price) && orderReq.limit_price > 0)) {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, `submitOrder: limit order requires limit_price > 0 (${cid})`);
    }
    if (type === 'stop' && !(Number.isFinite(orderReq.stop_price) && orderReq.stop_price > 0)) {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, `submitOrder: stop order requires stop_price > 0 (${cid})`);
    }

    const payload = {
      symbol:          orderReq.symbol,
      qty:             String(qty),
      side,
      type,
      time_in_force:   tif,
      client_order_id: cid,
      ...(type === 'limit' ? { limit_price: String(orderReq.limit_price) } : {}),
      ...(type === 'stop'  ? { stop_price:  String(orderReq.stop_price)  } : {}),
    };

    let resp;
    try {
      resp = await this._http({ method: 'POST', url: `${this.baseUrl}/v2/orders`, headers: this._headers, body: payload });
    } catch (e) {
      throw new BrokerError(BROKER_ERROR_CLASSES.TRANSIENT_NETWORK, `submitOrder network error (${cid}): ${e.message}`);
    }
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      if (resp.json == null || typeof resp.json !== 'object') {
        throw new BrokerError(BROKER_ERROR_CLASSES.UNEXPECTED_RESPONSE, `submitOrder: non-JSON 2xx body (${cid})`, resp.statusCode);
      }
      return normalizeBrokerOrder(resp.json, cid);
    }
    throw classifyHttp(resp.statusCode, resp.json ?? resp.text);
  }

  /**
   * getOrderByClientId — look up an order by client_order_id at the broker.
   * @returns {object|null} normalized brokerOrderView, or null if not found (404).
   * @throws  {BrokerError} on any non-404 error
   */
  async getOrderByClientId(clientOrderId) {
    if (typeof clientOrderId !== 'string' || !clientOrderId) {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, 'getOrderByClientId: client_order_id is required');
    }
    const url = `${this.baseUrl}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`;

    let resp;
    try {
      resp = await this._http({ method: 'GET', url, headers: this._headers });
    } catch (e) {
      throw new BrokerError(BROKER_ERROR_CLASSES.TRANSIENT_NETWORK,
        `getOrderByClientId network error (${clientOrderId}): ${e.message}`);
    }
    if (resp.statusCode === 404) return null;            // not found → null (explicit, not an error)
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      if (resp.json == null || typeof resp.json !== 'object') {
        throw new BrokerError(BROKER_ERROR_CLASSES.UNEXPECTED_RESPONSE,
          `getOrderByClientId: non-JSON 2xx body (${clientOrderId})`, resp.statusCode);
      }
      return normalizeBrokerOrder(resp.json, clientOrderId);
    }
    throw classifyHttp(resp.statusCode, resp.json ?? resp.text);
  }

  /**
   * cancelOrder — request cancellation of a live order at the Alpaca PAPER endpoint.
   * DELETE /v2/orders/{broker_order_id}. This is the adapter's ONLY mutating DELETE.
   *
   * Pure adapter: validate → DELETE → classify. NO persistence, NO state machine,
   * NO retry. The caller (order_cancel.requestCancel) drives the local record; the
   * existing FillPoller terminalizes the cancel (pending_cancel→cancel_pending,
   * canceled→cancelled). This method NEVER terminalizes anything itself.
   *
   * Alpaca returns 204 No Content on an accepted cancel request. A 2xx (incl. 204,
   * empty body) is therefore SUCCESS — unlike submit/get, no JSON body is required.
   *
   * @param {string} brokerOrderId — the broker order id (NOT the client_order_id)
   * @returns {object} { accepted:true, http_status, broker_order_id } on 2xx
   * @throws  {BrokerError} 404→not_found, 422→validation (no longer cancelable),
   *                        network→transient_network, 401/403→auth, 429→rate_limit, 5xx→broker_internal
   */
  async cancelOrder(brokerOrderId) {
    if (typeof brokerOrderId !== 'string' || !brokerOrderId) {
      throw new BrokerError(BROKER_ERROR_CLASSES.VALIDATION, 'cancelOrder: broker_order_id is required');
    }
    let resp;
    try {
      resp = await this._http({
        method:  'DELETE',
        url:     `${this.baseUrl}/v2/orders/${encodeURIComponent(brokerOrderId)}`,
        headers: this._headers,
      });
    } catch (e) {
      throw new BrokerError(BROKER_ERROR_CLASSES.TRANSIENT_NETWORK, `cancelOrder network error (${brokerOrderId}): ${e.message}`);
    }
    // 2xx incl. 204 No Content = accepted (no body expected on a DELETE).
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return { accepted: true, http_status: resp.statusCode, broker_order_id: brokerOrderId };
    }
    throw classifyHttp(resp.statusCode, resp.json ?? resp.text);
  }

  /**
   * getAccount — fetch and normalize the Alpaca PAPER account summary.
   * GET /v2/account. READ-ONLY (no mutation), so it preserves adapter purity; it
   * exists here so account_sizing (Unit 10.8) can be fed a real account snapshot in
   * the write path (the read-only alpaca_adapter is a separate, observe-only module).
   *
   * Pure adapter: GET → normalize → classify. No persistence, no retry.
   *
   * @returns {object} normalized account snapshot (account_sizing-compatible shape)
   * @throws  {BrokerError} network→transient_network, non-JSON 2xx→unexpected_response,
   *                        401/403→auth, 429→rate_limit, 4xx→validation, 5xx→broker_internal
   */
  async getAccount() {
    let resp;
    try {
      resp = await this._http({ method: 'GET', url: `${this.baseUrl}/v2/account`, headers: this._headers });
    } catch (e) {
      throw new BrokerError(BROKER_ERROR_CLASSES.TRANSIENT_NETWORK, `getAccount network error: ${e.message}`);
    }
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      if (resp.json == null || typeof resp.json !== 'object') {
        throw new BrokerError(BROKER_ERROR_CLASSES.UNEXPECTED_RESPONSE, 'getAccount: non-JSON 2xx body', resp.statusCode);
      }
      return normalizeAccount(resp.json);
    }
    throw classifyHttp(resp.statusCode, resp.json ?? resp.text);
  }
}
