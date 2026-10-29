/**
 * Alpaca Read-Only Broker Adapter
 *
 * Implements the LiveBroker read-only interface against the Alpaca REST API.
 *
 * ── What this adapter does ────────────────────────────────────────────────────
 *   - GET /v2/account            → account summary (cash, buying power, equity)
 *   - GET /v2/positions          → list of open positions
 *   - GET /v2/orders?status=open → open orders (read-only observe only)
 *   - GET /v2/stocks/snapshots   → quote snapshots for stock symbols (data API)
 *   - Health check via /v2/account reachability
 *
 * ── What this adapter does NOT do ────────────────────────────────────────────
 *   - No placeOrder
 *   - No cancelOrder
 *   - No modifyOrder
 *   - No submit / patch / delete endpoints of any kind
 *   - No position management
 *   - No websocket subscriptions
 *
 * ── Authentication ────────────────────────────────────────────────────────────
 *   APCA-API-KEY-ID:     env.ALPACA_KEY_ID
 *   APCA-API-SECRET-KEY: env.ALPACA_SECRET_KEY
 *
 * ── Endpoints ─────────────────────────────────────────────────────────────────
 *   Broker API (account / positions / orders):
 *     ALPACA_PAPER=true  → https://paper-api.alpaca.markets  (default, safe)
 *     ALPACA_PAPER=false → https://api.alpaca.markets        (live account)
 *   Data API (quotes / snapshots):
 *     https://data.alpaca.markets   (same for paper and live)
 *
 * ── Dependencies ─────────────────────────────────────────────────────────────
 *   node:https only — no external packages.
 *
 * Usage (module):
 *   import { AlpacaAdapter } from './alpaca_adapter.mjs'
 *   const adapter = new AlpacaAdapter(brokerConfig.alpaca)
 *   const account = await adapter.getAccount()
 */

import https from 'node:https';
import { URL } from 'node:url';

// ─── HTTP helper ─────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * httpGet — make a read-only HTTPS GET request.
 * Throws on network error, timeout, or HTTP 4xx/5xx.
 *
 * @param {string} urlStr
 * @param {object} headers
 * @returns {Promise<any>} — parsed JSON response body
 */
function httpGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${urlStr} — ${e.message}`));
    }

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        'Accept':       'application/json',
        'User-Agent':   'trading-bot/phase4-readonly/1.0',
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const preview = body.slice(0, 400);
          reject(new Error(`HTTP ${res.statusCode} from ${parsed.hostname}${parsed.pathname}: ${preview}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse error from ${parsed.hostname}${parsed.pathname}: ${body.slice(0, 200)}`));
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request_timeout_${REQUEST_TIMEOUT_MS}ms: ${urlStr}`));
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Response normalizers ────────────────────────────────────────────────────

/**
 * normalizeAccount — normalize Alpaca account response to project-internal shape.
 *
 * Internal shape:
 *   { provider, account_id, currency, cash, buying_power, portfolio_value,
 *     equity, status, paper, ts, raw }
 */
function normalizeAccount(raw, paper) {
  return {
    provider:        'alpaca',
    account_id:      raw.id ?? raw.account_number ?? null,
    currency:        raw.currency ?? 'USD',
    cash:            parseFloat(raw.cash ?? 0),
    buying_power:    parseFloat(raw.buying_power ?? 0),
    portfolio_value: parseFloat(raw.portfolio_value ?? 0),
    equity:          parseFloat(raw.equity ?? raw.portfolio_value ?? 0),
    status:          raw.status ?? null,
    paper,
    ts:              new Date().toISOString(),
    raw,
  };
}

/**
 * normalizePosition — normalize one Alpaca position to project-internal shape.
 *
 * Internal shape:
 *   { provider, symbol, qty, side, avg_entry_price_usd, current_price_usd,
 *     market_value_usd, unrealized_pl_usd, unrealized_plpc }
 */
function normalizePosition(raw) {
  return {
    provider:            'alpaca',
    symbol:              raw.symbol,
    qty:                 parseFloat(raw.qty ?? 0),
    side:                raw.side ?? (parseFloat(raw.qty) >= 0 ? 'long' : 'short'),
    avg_entry_price_usd: parseFloat(raw.avg_entry_price ?? 0),
    current_price_usd:   parseFloat(raw.current_price ?? 0),
    market_value_usd:    parseFloat(raw.market_value ?? 0),
    unrealized_pl_usd:   parseFloat(raw.unrealized_pl ?? 0),
    unrealized_plpc:     parseFloat(raw.unrealized_plpc ?? 0),
  };
}

/**
 * normalizeOpenOrder — normalize one Alpaca order to project-internal shape.
 *
 * Internal shape:
 *   { provider, order_id, symbol, qty, side, type, status, created_at }
 */
function normalizeOpenOrder(raw) {
  return {
    provider:   'alpaca',
    order_id:   raw.id,
    symbol:     raw.symbol,
    qty:        parseFloat(raw.qty ?? raw.notional ?? 0),
    side:       raw.side,
    type:       raw.type,
    status:     raw.status,
    created_at: raw.created_at,
  };
}

/**
 * normalizeQuote — normalize one Alpaca stock snapshot to project-internal shape.
 *
 * Internal shape:
 *   { provider, symbol, price, bid, ask, spread,
 *     daily_open, daily_high, daily_low, daily_close, daily_volume, ts, source }
 */
function normalizeQuote(symbol, raw) {
  const trade = raw.latestTrade ?? {};
  const quote = raw.latestQuote ?? {};
  const daily = raw.dailyBar   ?? {};

  const bid    = parseFloat(quote.bp ?? 0);
  const ask    = parseFloat(quote.ap ?? 0);
  const price  = parseFloat(trade.p  ?? 0) || (bid + ask) / 2 || 0;

  return {
    provider:     'alpaca',
    symbol,
    price:        price,
    bid:          bid,
    ask:          ask,
    spread:       ask > 0 && bid > 0 ? +(ask - bid).toFixed(4) : null,
    daily_open:   parseFloat(daily.o ?? 0),
    daily_high:   parseFloat(daily.h ?? 0),
    daily_low:    parseFloat(daily.l ?? 0),
    daily_close:  parseFloat(daily.c ?? 0),
    daily_volume: parseInt(daily.v   ?? 0, 10),
    ts:           trade.t ?? new Date().toISOString(),
    source:       'alpaca_snapshot',
  };
}

// ─── AlpacaAdapter ───────────────────────────────────────────────────────────

export class AlpacaAdapter {
  /**
   * @param {object} alpacaConfig — from parseBrokerConfig().alpaca
   *   { key_id, secret_key, paper, base_url, data_url }
   */
  constructor(alpacaConfig) {
    if (!alpacaConfig?.key_id || !alpacaConfig?.secret_key) {
      throw new Error('AlpacaAdapter: key_id and secret_key are required.');
    }
    this.baseUrl  = alpacaConfig.base_url;
    this.dataUrl  = alpacaConfig.data_url;
    this.paper    = alpacaConfig.paper;
    this._headers = Object.freeze({
      'APCA-API-KEY-ID':     alpacaConfig.key_id,
      'APCA-API-SECRET-KEY': alpacaConfig.secret_key,
    });
    this.provider = 'alpaca';
    this.mode     = 'read_only';  // explicit — no write methods exist
  }

  // ── Read-only methods ──────────────────────────────────────────────────────

  /**
   * healthCheck — verify connectivity by fetching the account endpoint.
   * Returns a structured health result; does NOT throw on broker-side failures.
   *
   * @returns {{ ok: boolean, latency_ms: number, account_id?: string, error?: string }}
   */
  async healthCheck() {
    const t0 = Date.now();
    try {
      const raw = await httpGet(`${this.baseUrl}/v2/account`, this._headers);
      const acc = normalizeAccount(raw, this.paper);
      return {
        ok:          true,
        latency_ms:  Date.now() - t0,
        account_id:  acc.account_id,
        status:      acc.status,
        paper:       this.paper,
        base_url:    this.baseUrl,
      };
    } catch (e) {
      return {
        ok:         false,
        latency_ms: Date.now() - t0,
        error:      e.message,
        base_url:   this.baseUrl,
      };
    }
  }

  /**
   * getAccount — fetch and normalize the Alpaca account summary.
   *
   * @returns {object} — normalized account snapshot
   */
  async getAccount() {
    const raw = await httpGet(`${this.baseUrl}/v2/account`, this._headers);
    return normalizeAccount(raw, this.paper);
  }

  /**
   * getPositions — fetch all open positions.
   *
   * @returns {object[]} — array of normalized position snapshots
   */
  async getPositions() {
    const raw = await httpGet(`${this.baseUrl}/v2/positions`, this._headers);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizePosition);
  }

  /**
   * getOpenOrders — fetch currently open orders (observational, read-only).
   * These are real orders on the broker account, NOT our paper orders.
   *
   * @returns {object[]} — array of normalized open orders
   */
  async getOpenOrders() {
    const url = `${this.baseUrl}/v2/orders?status=open&limit=100&direction=asc`;
    const raw = await httpGet(url, this._headers);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeOpenOrder);
  }

  /**
   * getQuote — fetch a quote snapshot for a single stock symbol.
   *
   * @param {string} symbol — e.g. 'AAPL'
   * @returns {object} — normalized quote snapshot, or null if not available
   */
  async getQuote(symbol) {
    const quotes = await this.getQuotes([symbol]);
    return quotes[symbol] ?? null;
  }

  /**
   * getQuotes — fetch quote snapshots for multiple stock symbols in one request.
   * Symbols must be US stocks supported by Alpaca. Crypto symbols are not supported
   * by this method — see note in return value.
   *
   * @param {string[]} symbols — stock symbols, e.g. ['AAPL', 'NVDA', 'MSFT']
   * @returns {object}         — map: { [symbol]: normalizedQuote | null }
   */
  async getQuotes(symbols) {
    if (!symbols || symbols.length === 0) return {};

    // Alpaca snapshots endpoint accepts up to ~100 symbols per request
    const url = new URL(`${this.dataUrl}/v2/stocks/snapshots`);
    url.searchParams.set('symbols', symbols.join(','));
    url.searchParams.set('feed',    'iex');   // iex feed — available on free tier

    let raw;
    try {
      raw = await httpGet(url.toString(), this._headers);
    } catch (e) {
      // Return partial result: all symbols errored
      const out = {};
      for (const s of symbols) out[s] = null;
      process.stderr.write(JSON.stringify({ warning: 'alpaca_quotes_failed', error: e.message }) + '\n');
      return out;
    }

    const result = {};
    for (const sym of symbols) {
      result[sym] = raw[sym] ? normalizeQuote(sym, raw[sym]) : null;
    }
    return result;
  }
}
