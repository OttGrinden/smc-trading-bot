#!/usr/bin/env node
/**
 * Bitunix Exec Layer — Unit 34 tests (BEL34-01 … BEL34-11).
 *
 * Tests for bitunix_exec_layer.mjs:
 *   validateBitunixExecConfig  — credential guards, correct mode
 *   runBitunixExecLayerWithDispatch — fail-closed pre-flights, DI points,
 *                                     dispatch summary shape, USDT account path
 *
 * All tests are fully offline — no network calls, no disk I/O beyond imports.
 * makeBroker, _buildDecisions, _approvedIntentsFromDecisions,
 * _getAccount, _sizeIntentsFromAccount, _dispatchApproved all injectable.
 *
 * node scripts/execution/tests/bitunix_exec_layer_step34_test.mjs
 * Exit 0 = all PASS. Exit 1 = at least one FAIL.
 */

import {
  validateBitunixExecConfig,
  runBitunixExecLayerWithDispatch,
} from '../live_broker/bitunix_exec_layer.mjs';

const RESULTS = [];
function pass(id, msg) { RESULTS.push({ id, status: 'PASS' }); process.stderr.write(`  PASS  ${id}: ${msg}\n`); }
function fail(id, msg) { RESULTS.push({ id, status: 'FAIL' }); process.stderr.write(`  FAIL  ${id}: ${msg}\n`); }
function check(id, cond, msg) { cond ? pass(id, msg) : fail(id, `${msg} [ASSERTION FAILED]`); }

// ── Shared stubs ──────────────────────────────────────────────────────────────
const EXEC_CFG = Object.freeze({ enabled: true, mode: 'bitunix_futures', api_key: 'k', secret_key: 's' });
const SCAN_JSON = JSON.stringify({ run_id: 'run_test_34', long_candidates: [], short_candidates: [] });

const FAKE_BROKER = {
  submitOrder:        async () => ({ provider: 'bitunix', broker_order_id: 'X::1', broker_status: 'NEW' }),
  getOrderByClientId: async () => null,
  getAccount:         async () => ({ provider: 'bitunix', currency: 'USDT', cash: 500, buying_power: 500, portfolio_value: 500, equity: 500, status: 'active', paper: false }),
};
const FAKE_DECISIONS = [
  { intent: { symbol: 'BTC', side: 'long' }, decision: { execution_ready: false, blocked_reasons: ['test'] } },
];
const FAKE_NORM = { intents: [], approved: 0, emitted: 0, skipped: 1 };
const FAKE_ACCOUNT = { currency: 'USDT', buying_power: 500, equity: 500, status: 'active' };
const FAKE_SIZE_RESULT = { account_ok: true, account_reason: null, sized: [], skipped: [], totals: { intents: 0, sized: 0, skipped: 0 } };
const FAKE_DISPATCH = { total: 0, submitted: 0, already_dispatched: 0, skipped: 0, errored: 0, results: [] };

async function run() {

  // ── BEL34-01: validateBitunixExecConfig — missing both keys → throws ──────────
  {
    let threw = false; let msg = '';
    try { validateBitunixExecConfig([], {}); } catch (e) { threw = true; msg = e.message; }
    check('BEL34-01', threw && /BITUNIX_API_KEY/.test(msg),
      'validateBitunixExecConfig: missing both keys → throws with BITUNIX_API_KEY in message');
  }

  // ── BEL34-02: validateBitunixExecConfig — missing BITUNIX_SECRET_KEY → throws ─
  {
    let threw = false; let msg = '';
    try { validateBitunixExecConfig([], { BITUNIX_API_KEY: 'key' }); } catch (e) { threw = true; msg = e.message; }
    check('BEL34-02', threw && /BITUNIX_SECRET_KEY/.test(msg),
      'validateBitunixExecConfig: missing BITUNIX_SECRET_KEY → throws');
  }

  // ── BEL34-03: validateBitunixExecConfig — missing BITUNIX_API_KEY → throws ────
  {
    let threw = false; let msg = '';
    try { validateBitunixExecConfig([], { BITUNIX_SECRET_KEY: 'secret' }); } catch (e) { threw = true; msg = e.message; }
    check('BEL34-03', threw && /BITUNIX_API_KEY/.test(msg),
      'validateBitunixExecConfig: missing BITUNIX_API_KEY → throws');
  }

  // ── BEL34-04: validateBitunixExecConfig — both keys present → enabled config ──
  {
    let cfg;
    try { cfg = validateBitunixExecConfig([], { BITUNIX_API_KEY: 'test_key', BITUNIX_SECRET_KEY: 'test_secret' }); }
    catch { cfg = null; }
    check('BEL34-04',
      cfg?.enabled === true && cfg?.mode === 'bitunix_futures' &&
      cfg?.api_key === 'test_key' && cfg?.secret_key === 'test_secret' &&
      cfg?.credentials_present === true,
      'validateBitunixExecConfig: both keys → enabled=true, mode=bitunix_futures');
  }

  // ── BEL34-05: runBitunixExecLayerWithDispatch — invalid JSON → throws ─────────
  {
    let threw = false;
    try { await runBitunixExecLayerWithDispatch('not json', EXEC_CFG); } catch { threw = true; }
    check('BEL34-05', threw,
      'runBitunixExecLayerWithDispatch: invalid scan JSON → throws');
  }

  // ── BEL34-06: runBitunixExecLayerWithDispatch — disabled execConfig → throws ──
  {
    const disabledCfg = { enabled: false, mode: 'bitunix_futures', api_key: 'k', secret_key: 's' };
    let threw = false; let msg = '';
    try { await runBitunixExecLayerWithDispatch(SCAN_JSON, disabledCfg); } catch (e) { threw = true; msg = e.message; }
    check('BEL34-06', threw && /fail-closed/i.test(msg),
      'runBitunixExecLayerWithDispatch: disabled execConfig → throws fail-closed');
  }

  // ── BEL34-07: runBitunixExecLayerWithDispatch — wrong mode → throws ───────────
  {
    const wrongCfg = { enabled: true, mode: 'alpaca_paper', paper: true, api_key: 'k', secret_key: 's' };
    let threw = false;
    try { await runBitunixExecLayerWithDispatch(SCAN_JSON, wrongCfg); } catch { threw = true; }
    check('BEL34-07', threw,
      'runBitunixExecLayerWithDispatch: wrong mode (alpaca_paper) → throws fail-closed');
  }

  // ── BEL34-08: runBitunixExecLayerWithDispatch — incapable broker → throws ─────
  {
    const badBroker = { submitOrder: async () => {}, getOrderByClientId: async () => {} };  // no getAccount
    let threw = false; let msg = '';
    try {
      await runBitunixExecLayerWithDispatch(SCAN_JSON, EXEC_CFG, {
        makeBroker: () => badBroker,
        _buildDecisions: () => [],
      });
    } catch (e) { threw = true; msg = e.message; }
    check('BEL34-08', threw && /getAccount/.test(msg),
      'runBitunixExecLayerWithDispatch: broker missing getAccount → throws fail-closed');
  }

  // ── BEL34-09: runBitunixExecLayerWithDispatch — full dispatch, summary shape ──
  // Injects all DI points; verifies return shape and DI wiring.
  {
    let brokerArg = null;
    let getAccountCalled = false;
    let sizeArgs = null;
    let dispatchArgs = null;

    const result = await runBitunixExecLayerWithDispatch(SCAN_JSON, EXEC_CFG, {
      makeBroker: (cfg) => { brokerArg = cfg; return FAKE_BROKER; },
      _buildDecisions:               () => FAKE_DECISIONS,
      _approvedIntentsFromDecisions: () => FAKE_NORM,
      _getAccount:                   async () => { getAccountCalled = true; return FAKE_ACCOUNT; },
      _sizeIntentsFromAccount:       async (intents, account) => { sizeArgs = { intents, account }; return FAKE_SIZE_RESULT; },
      _dispatchApproved:             async (items, ctx) => { dispatchArgs = { items, ctx }; return FAKE_DISPATCH; },
    });

    check('BEL34-09',
      result.run_id === 'run_test_34' &&
      result.decisions_total === 1 &&
      result.approved === 0 &&
      result.emitted === 0 &&
      result.skipped === 1 &&
      result.account_ok === true &&
      result.account_reason === null &&
      result.sized === 0 &&
      result.dispatch === null &&        // sized.length===0 → dispatch skipped
      brokerArg === EXEC_CFG &&          // makeBroker received execConfig
      getAccountCalled === true &&       // getAccount was called
      sizeArgs?.account === FAKE_ACCOUNT,// sizeIntents received the account
      'full dispatch: correct summary shape + all DI points wired correctly');
  }

  // ── BEL34-10: dispatch runs when account_ok=true AND sized.length>0 ───────────
  {
    const sizeResultWithIntents = {
      account_ok: true, account_reason: null,
      sized: [{ symbol: 'BTC', side: 'long', quantity: 0.001, run_id: 'run_test_34', price_usd: 50000 }],
      skipped: [],
      totals: { intents: 1, sized: 1, skipped: 0 },
    };
    let dispatchedItems = null;

    const result = await runBitunixExecLayerWithDispatch(SCAN_JSON, EXEC_CFG, {
      makeBroker: () => FAKE_BROKER,
      _buildDecisions:               () => FAKE_DECISIONS,
      _approvedIntentsFromDecisions: () => ({ intents: [{ symbol: 'BTC', side: 'long', price_usd: 50000 }], approved: 1, emitted: 1, skipped: 0 }),
      _getAccount:                   async () => FAKE_ACCOUNT,
      _sizeIntentsFromAccount:       async () => sizeResultWithIntents,
      _dispatchApproved:             async (items, ctx) => { dispatchedItems = items; return { submitted: 1, total: 1, skipped: 0, errored: 0, results: [] }; },
    });

    check('BEL34-10',
      result.sized === 1 &&
      result.dispatch?.submitted === 1 &&
      Array.isArray(dispatchedItems) && dispatchedItems.length === 1,
      'dispatch runs when account_ok=true and sized.length>0 → submits 1 order');
  }

  // ── BEL34-11: dispatch skipped when account_ok=false ─────────────────────────
  {
    const sizeResultBad = {
      account_ok: false, account_reason: 'account_currency_unsupported',
      sized: [], skipped: [{ symbol: 'BTC', reason: 'account_currency_unsupported' }],
      totals: { intents: 1, sized: 0, skipped: 1 },
    };
    let dispatchCalled = false;

    const result = await runBitunixExecLayerWithDispatch(SCAN_JSON, EXEC_CFG, {
      makeBroker: () => FAKE_BROKER,
      _buildDecisions:               () => FAKE_DECISIONS,
      _approvedIntentsFromDecisions: () => FAKE_NORM,
      _getAccount:                   async () => FAKE_ACCOUNT,
      _sizeIntentsFromAccount:       async () => sizeResultBad,
      _dispatchApproved:             async () => { dispatchCalled = true; return FAKE_DISPATCH; },
    });

    check('BEL34-11',
      result.account_ok === false &&
      result.account_reason === 'account_currency_unsupported' &&
      result.dispatch === null &&
      dispatchCalled === false,
      'dispatch skipped when account_ok=false → dispatch=null, _dispatchApproved never called');
  }

}

run().catch(e => {
  process.stderr.write(`\nUncaught error: ${e.stack ?? e.message}\n`);
  process.exit(1);
}).then(() => {
  const failed = RESULTS.filter(r => r.status === 'FAIL').length;
  process.stderr.write(`\nBitunix Exec Layer (Unit 34): ${RESULTS.length - failed}/${RESULTS.length} PASS\n`);
  process.exit(failed === 0 ? 0 : 1);
});
