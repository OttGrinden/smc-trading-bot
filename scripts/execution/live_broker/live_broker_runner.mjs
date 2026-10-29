/**
 * Live Broker Runner
 *
 * Orchestrates the full read-only live broker flow for one scan cycle:
 *   1. Build and validate the adapter
 *   2. Run health checks
 *   3. Fetch account, positions, open orders, quotes
 *   4. Persist normalized snapshots to disk
 *   5. Reconcile with the internal virtual portfolio state
 *   6. Return a structured summary for stderr reporting
 *
 * This module is called from scan.mjs AFTER the scan pipeline and all other
 * execution summaries are written. It is additive and never replaces or disrupts
 * any existing output.
 *
 * Failure model:
 *   - Config/credential errors: thrown to caller (scan.mjs exits non-zero)
 *   - Network/API errors:       caught internally, reported in summary, exit 0
 *   - Disk write errors:        caught internally, reported in summary, exit 0
 *
 * No order placement. No portfolio mutations. No broker write calls of any kind.
 *
 * Output artifacts (under trading/execution/live_broker/):
 *   account_snapshot.json    — latest normalized account state
 *   positions_snapshot.json  — latest normalized positions list
 *   quotes_snapshot.json     — latest stock quote snapshots for scan candidates
 *   open_orders_snapshot.json— latest open orders observed (read-only)
 *   reconciliation.json      — virtual vs live comparison report
 *
 * Usage (module):
 *   import { runLiveBroker } from './live_broker_runner.mjs'
 *   const summary = await runLiveBroker(runOutput, brokerConfig)
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath }            from 'url';

import { AlpacaAdapter }            from './adapters/alpaca_adapter.mjs';
import { runHealthChecks, formatHealthReport } from './health_checks.mjs';
import { reconcile, formatReconciliationSummary } from './reconciliation.mjs';
import { loadOrInit }               from '../portfolio/portfolio_state.mjs';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', '..', '..', 'trading');

const LIVE_BROKER_DIR = join(TRADING_DIR, 'execution', 'live_broker');

// ─── Persistence helpers ──────────────────────────────────────────────────────

function persistSnapshot(filename, data) {
  try {
    mkdirSync(LIVE_BROKER_DIR, { recursive: true });
    writeFileSync(
      join(LIVE_BROKER_DIR, filename),
      JSON.stringify(data, null, 2) + '\n',
      'utf8',
    );
    return join(LIVE_BROKER_DIR, filename);
  } catch (e) {
    process.stderr.write(JSON.stringify({
      warning: 'live_broker_persist_failed', file: filename, error: e.message,
    }) + '\n');
    return null;
  }
}

// ─── Symbol extraction from scan output ──────────────────────────────────────

/**
 * Extract stock symbols (category='Stock') from scan candidates for quote fetching.
 * Crypto and tokenized stocks are skipped (not supported by Alpaca stock snapshot API).
 */
function extractStockSymbols(runOutput) {
  const all = [
    ...(runOutput.long_candidates  ?? []),
    ...(runOutput.short_candidates ?? []),
  ];
  const stocks  = [];
  const skipped = [];
  for (const c of all) {
    if (c.category === 'Stock') {
      stocks.push(c.symbol);
    } else {
      skipped.push({ symbol: c.symbol, category: c.category, reason: 'not_a_stock' });
    }
  }
  // Deduplicate (a symbol may appear in both long and short)
  return { symbols: [...new Set(stocks)], skipped };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * runLiveBroker — execute one read-only live broker cycle.
 *
 * @param {object} runOutput    — parsed scan output (long_candidates, short_candidates, run_id)
 * @param {object} brokerConfig — from parseBrokerConfig() — must have broker_mode='live_readonly'
 * @returns {object}            — structured summary for stderr reporting
 */
export async function runLiveBroker(runOutput, brokerConfig) {
  const provider = brokerConfig.broker_provider;
  const runId    = runOutput?.run_id ?? null;
  const t0       = Date.now();

  const summary = {
    provider,
    run_id:            runId,
    health:            null,
    account:           null,
    positions_count:   null,
    open_orders_count: null,
    quotes_fetched:    0,
    quotes_skipped:    0,
    reconciliation:    null,
    files:             {},
    errors:            [],
    duration_ms:       null,
  };

  // ── Build adapter ────────────────────────────────────────────────────────
  let adapter;
  try {
    if (provider === 'alpaca') {
      adapter = new AlpacaAdapter(brokerConfig.alpaca);
    } else {
      throw new Error(`No adapter implemented for provider: "${provider}"`);
    }
  } catch (e) {
    // Adapter construction failure = config/credential issue → rethrow (caller exits non-zero)
    throw e;
  }

  // ── Health checks ─────────────────────────────────────────────────────────
  let healthReport;
  try {
    healthReport = await runHealthChecks(adapter, brokerConfig.alpaca);
    summary.health = healthReport;
  } catch (e) {
    healthReport = { all_ok: false, checks: { health_endpoint: { ok: false, error: e.message } } };
    summary.health = healthReport;
    summary.errors.push({ step: 'health_checks', error: e.message });
  }

  // ── Fetch account ─────────────────────────────────────────────────────────
  let account = null;
  if (healthReport?.checks?.health_endpoint?.ok) {
    try {
      account = await adapter.getAccount();
      summary.account = {
        account_id:      account.account_id,
        currency:        account.currency,
        cash:            account.cash,
        buying_power:    account.buying_power,
        portfolio_value: account.portfolio_value,
        equity:          account.equity,
        status:          account.status,
        paper:           account.paper,
      };
      summary.files.account = persistSnapshot('account_snapshot.json', {
        ts: new Date().toISOString(), run_id: runId, ...account,
      });
    } catch (e) {
      summary.errors.push({ step: 'get_account', error: e.message });
    }
  }

  // ── Fetch positions ───────────────────────────────────────────────────────
  let positions = [];
  if (healthReport?.checks?.positions_read?.ok) {
    try {
      positions = await adapter.getPositions();
      summary.positions_count = positions.length;
      summary.files.positions = persistSnapshot('positions_snapshot.json', {
        ts: new Date().toISOString(), run_id: runId, positions,
      });
    } catch (e) {
      summary.errors.push({ step: 'get_positions', error: e.message });
    }
  }

  // ── Fetch open orders (observational) ────────────────────────────────────
  let openOrders = [];
  if (healthReport?.checks?.open_orders_read?.ok) {
    try {
      openOrders = await adapter.getOpenOrders();
      summary.open_orders_count = openOrders.length;
      summary.files.open_orders = persistSnapshot('open_orders_snapshot.json', {
        ts: new Date().toISOString(), run_id: runId, open_orders: openOrders,
      });
    } catch (e) {
      summary.errors.push({ step: 'get_open_orders', error: e.message });
    }
  }

  // ── Fetch quotes for stock candidates ────────────────────────────────────
  let quotesSnapshot = {};
  if (healthReport?.checks?.quote_read?.ok) {
    const { symbols, skipped } = extractStockSymbols(runOutput);
    summary.quotes_skipped = skipped.length;
    if (symbols.length > 0) {
      try {
        quotesSnapshot = await adapter.getQuotes(symbols);
        const fetched = Object.values(quotesSnapshot).filter(q => q !== null).length;
        summary.quotes_fetched = fetched;
        summary.files.quotes   = persistSnapshot('quotes_snapshot.json', {
          ts: new Date().toISOString(), run_id: runId,
          stock_symbols_requested: symbols,
          crypto_skipped: skipped.map(s => s.symbol),
          quotes: quotesSnapshot,
        });
      } catch (e) {
        summary.errors.push({ step: 'get_quotes', error: e.message });
      }
    }
  }

  // ── Reconciliation ───────────────────────────────────────────────────────
  try {
    const virtualState   = loadOrInit();
    const reconReport    = reconcile(virtualState, positions, account);
    summary.reconciliation = reconReport;
    summary.files.reconciliation = persistSnapshot('reconciliation.json', reconReport);
  } catch (e) {
    summary.errors.push({ step: 'reconciliation', error: e.message });
  }

  summary.duration_ms = Date.now() - t0;
  return summary;
}
