#!/usr/bin/env node
/**
 * AlpacaPaperBroker.getAccount — Phase 1 / Unit 11 tests (GA-01 … GA-08).
 *
 * Fully offline: a fake HTTP transport is injected (opts.httpRequest) so the
 * request shape, normalization, account_sizing-compatibility, and error
 * classification are verified without any network call.
 *
 * node scripts/execution/tests/paper_get_account_step11_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import { parseBrokerExecConfig } from '../live_broker/live_broker_config.mjs';
import { AlpacaPaperBroker, BROKER_ERROR_CLASSES } from '../live_broker/adapters/alpaca_paper_broker.mjs';
import { sizeIntentsFromAccount } from '../live_broker/account_sizing.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }
async function threwClass(fn, cls) {
  try { await fn(); return false; } catch (e) { return e?.error_class === cls; }
}

const PAPER_CFG = parseBrokerExecConfig(['--broker-exec', 'alpaca_paper'],
  { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' });

function makeHttp(responder) {
  const calls = [];
  const http = async (req) => { calls.push(req); return responder(req, calls.length); };
  return { http, calls };
}
function brokerWith(responder) {
  const { http, calls } = makeHttp(responder);
  return { broker: new AlpacaPaperBroker(PAPER_CFG, { httpRequest: http }), calls };
}
const okAccount = (over = {}) => ({
  id: 'acct_1', account_number: 'PA123', currency: 'USD', status: 'ACTIVE',
  cash: '5000.50', buying_power: '10000.25', portfolio_value: '12000.75', equity: '12000.75', ...over,
});

// ─── GA-01: 2xx JSON → korrekter GET-Request + Normalisierung ─────────────────
{
  const { broker, calls } = brokerWith(() => ({ statusCode: 200, json: okAccount() }));
  const acc = await broker.getAccount();
  const req = calls[0];
  check('GA-01',
    req.method === 'GET' && req.url.endsWith('/v2/account') && req.body == null
    && acc.provider === 'alpaca' && acc.account_id === 'acct_1' && acc.currency === 'USD'
    && acc.cash === 5000.50 && acc.buying_power === 10000.25 && acc.portfolio_value === 12000.75
    && acc.equity === 12000.75 && acc.status === 'ACTIVE' && acc.paper === true && typeof acc.ts === 'string',
    'GET /v2/account, kein Body; Strings → Zahlen; paper=true; ts gesetzt');
}

// ─── GA-02: Snapshot füttert account_sizing → account_ok=true, sized > 0 ──────
{
  const { broker } = brokerWith(() => ({ statusCode: 200, json: okAccount() }));
  const acc = await broker.getAccount();
  const out = sizeIntentsFromAccount(
    [{ symbol: 'AMAT', side: 'long', price_usd: 100, run_id: 'r1' }], acc);
  check('GA-02',
    out.account_ok === true && out.account_reason === null && out.currency === 'USD'
    && out.totals.sized === 1 && out.sized[0].quantity > 0,
    'normalisierter Snapshot ist account_sizing-kompatibel (account_ok, sized)');
}

// ─── GA-03: Netzwerkfehler → transient_network, GENAU EIN Call (kein Retry) ──
{
  const { broker, calls } = brokerWith(() => { throw new Error('ECONNRESET'); });
  const threw = await threwClass(() => broker.getAccount(), BROKER_ERROR_CLASSES.TRANSIENT_NETWORK);
  check('GA-03', threw && calls.length === 1, 'Netzwerkfehler → transient_network; kein Retry (1 Call)');
}

// ─── GA-04: 2xx ohne JSON-Body → unexpected_broker_response ──────────────────
{
  const { broker } = brokerWith(() => ({ statusCode: 200, json: undefined, text: '<html>oops' }));
  const threw = await threwClass(() => broker.getAccount(), BROKER_ERROR_CLASSES.UNEXPECTED_RESPONSE);
  check('GA-04', threw, '2xx ohne JSON → unexpected_broker_response');
}

// ─── GA-05: Fehlerklassifikation ─────────────────────────────────────────────
{
  const cls = async (statusCode, json) => {
    const { broker } = brokerWith(() => ({ statusCode, json }));
    try { await broker.getAccount(); return 'NO_THROW'; } catch (e) { return e.error_class; }
  };
  const ok =
    (await cls(401, { message: 'unauthorized' })) === BROKER_ERROR_CLASSES.AUTH &&
    (await cls(403, { message: 'forbidden' }))    === BROKER_ERROR_CLASSES.AUTH &&
    (await cls(429, { message: 'rate limited' }))  === BROKER_ERROR_CLASSES.RATE_LIMIT &&
    (await cls(404, { message: 'not found' }))      === BROKER_ERROR_CLASSES.NOT_FOUND &&
    (await cls(400, { message: 'bad request' }))    === BROKER_ERROR_CLASSES.VALIDATION &&
    (await cls(500, { message: 'server error' }))   === BROKER_ERROR_CLASSES.BROKER_INTERNAL;
  check('GA-05', ok, '401/403→auth, 429→rate_limit, 404→not_found, 400→validation, 500→broker_internal');
}

// ─── GA-06: fehlende Felder → 0; equity fällt auf portfolio_value zurück ──────
{
  const { broker } = brokerWith(() => ({ statusCode: 200, json: { id: 'a2', status: 'ACTIVE', portfolio_value: '777' } }));
  const acc = await broker.getAccount();
  check('GA-06',
    acc.cash === 0 && acc.buying_power === 0 && acc.portfolio_value === 777
    && acc.equity === 777 && acc.currency === 'USD' && acc.paper === true,
    'fehlende cash/buying_power→0; equity fehlt→portfolio_value; currency default USD');
}

// ─── GA-07: non-paper / ungültige Config → kein getAccount möglich (Konstruktor) ──
{
  const mk = (cfg) => { try { new AlpacaPaperBroker(cfg, { httpRequest: async () => ({ statusCode: 200, json: okAccount() }) }); return false; } catch { return true; } };
  const ok =
    mk({ enabled: false }) &&
    mk({ enabled: true, mode: 'alpaca_paper', paper: true, base_url: 'https://api.alpaca.markets', key_id: 'k', secret_key: 's' }) &&
    mk({ enabled: true, mode: 'alpaca_paper', paper: true, base_url: 'https://paper-api.alpaca.markets' });
  check('GA-07', ok, 'getAccount nur über paper-validierten Broker erreichbar (Konstruktor fail-closed)');
}

// ─── GA-08: inaktives Konto wird durchgereicht; account_sizing lehnt fail-closed ab ──
{
  const { broker } = brokerWith(() => ({ statusCode: 200, json: okAccount({ status: 'ACCOUNT_CLOSED' }) }));
  const acc = await broker.getAccount();
  const out = sizeIntentsFromAccount([{ symbol: 'X', side: 'long', price_usd: 10 }], acc);
  check('GA-08',
    acc.status === 'ACCOUNT_CLOSED' && out.account_ok === false && out.account_reason === 'account_not_active'
    && out.totals.sized === 0,
    'Adapter wertet nicht; inaktiver Status → account_sizing fail-closed (account_not_active)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const fails = RESULTS.filter(r => r.status === 'FAIL').length;
process.stderr.write(`\npaper_get_account_step11_test: ${RESULTS.length - fails}/${RESULTS.length} PASS\n`);
process.exit(fails > 0 ? 1 : 0);
