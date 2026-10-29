/**
 * Live Broker — Health Checks
 *
 * Runs pre-flight connectivity and capability checks against the live broker
 * adapter BEFORE any data is consumed by the portfolio layer.
 *
 * All checks are read-only. A failed check does NOT crash the caller —
 * results are returned as a structured report and the caller decides severity.
 *
 * Checks performed:
 *   1. credentials_present   — key_id + secret_key are set (config-level, no network)
 *   2. health_endpoint       — GET /v2/account reachable (primary health signal)
 *   3. positions_read        — GET /v2/positions works
 *   4. open_orders_read      — GET /v2/orders?status=open works
 *   5. quote_read            — GET /v2/stocks/snapshots?symbols=AAPL works (canary stock)
 *
 * Usage (module):
 *   import { runHealthChecks } from './health_checks.mjs'
 *   const report = await runHealthChecks(adapter, alpacaConfig)
 */

const QUOTE_CANARY_SYMBOL = 'AAPL';

/**
 * runHealthChecks — execute all read-only pre-flight checks.
 *
 * @param {object} adapter      — AlpacaAdapter (or compatible read-only adapter)
 * @param {object} alpacaConfig — from parseBrokerConfig().alpaca
 * @returns {object}            — { all_ok, checks: { [check]: { ok, ... } } }
 */
export async function runHealthChecks(adapter, alpacaConfig) {
  const checks = {};

  // ── 1. Credentials present (config level, no network) ────────────────────
  checks.credentials_present = {
    ok:     alpacaConfig?.credentials_present === true,
    detail: alpacaConfig?.credentials_present
      ? 'ALPACA_KEY_ID and ALPACA_SECRET_KEY are set'
      : 'One or both credentials are missing',
  };

  // ── 2. Health endpoint (primary connectivity check) ──────────────────────
  try {
    const health = await adapter.healthCheck();
    checks.health_endpoint = {
      ok:          health.ok,
      latency_ms:  health.latency_ms,
      account_id:  health.account_id ?? null,
      status:      health.status     ?? null,
      paper:       health.paper,
      base_url:    health.base_url,
      error:       health.error ?? null,
    };
  } catch (e) {
    checks.health_endpoint = { ok: false, error: e.message };
  }

  // Skip remaining network checks if we cannot reach the broker
  if (!checks.health_endpoint.ok) {
    checks.positions_read    = { ok: false, skipped: true, reason: 'health_endpoint_failed' };
    checks.open_orders_read  = { ok: false, skipped: true, reason: 'health_endpoint_failed' };
    checks.quote_read        = { ok: false, skipped: true, reason: 'health_endpoint_failed' };
  } else {
    // ── 3. Positions read ───────────────────────────────────────────────────
    try {
      const positions = await adapter.getPositions();
      checks.positions_read = { ok: true, count: positions.length };
    } catch (e) {
      checks.positions_read = { ok: false, error: e.message };
    }

    // ── 4. Open orders read (observational) ────────────────────────────────
    try {
      const orders = await adapter.getOpenOrders();
      checks.open_orders_read = { ok: true, count: orders.length };
    } catch (e) {
      checks.open_orders_read = { ok: false, error: e.message };
    }

    // ── 5. Quote read (canary: AAPL) ────────────────────────────────────────
    try {
      const quote = await adapter.getQuote(QUOTE_CANARY_SYMBOL);
      checks.quote_read = {
        ok:     quote !== null && quote.price > 0,
        symbol: QUOTE_CANARY_SYMBOL,
        price:  quote?.price ?? null,
        source: quote?.source ?? null,
      };
    } catch (e) {
      checks.quote_read = { ok: false, symbol: QUOTE_CANARY_SYMBOL, error: e.message };
    }
  }

  const all_ok = Object.values(checks).every(c => c.ok === true);

  return { all_ok, checks };
}

/**
 * formatHealthReport — produce a compact human-readable summary of health checks.
 * Used in the stderr summary block.
 *
 * @param {object} report — from runHealthChecks()
 * @returns {string}
 */
export function formatHealthReport(report) {
  const lines = [];
  for (const [name, check] of Object.entries(report.checks)) {
    const status  = check.ok ? 'ok' : (check.skipped ? 'skipped' : 'FAILED');
    const detail  = check.error
      ? ` — ${check.error.slice(0, 100)}`
      : check.count != null ? ` (${check.count} items)`
      : check.price != null ? ` (${check.symbol}: $${check.price})`
      : check.latency_ms != null ? ` (${check.latency_ms}ms)`
      : '';
    lines.push(`    ${name}: ${status}${detail}`);
  }
  return lines.join('\n');
}
