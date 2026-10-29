#!/usr/bin/env node
/**
 * paper_submit_dev — controlled DEV/SMOKE entrypoint for ONE order submit (Unit 10.1).
 *
 * A deliberate manual dev/smoke tool — NOT a productized runtime entry. It wires up
 * exactly ONE `order_gateway.submit(orderReq, ctx)` call so the opt-in startup gate
 * (Unit 10) can be exercised via a real CLI. NO loop, NO scheduler, NO daemon, NO
 * portfolio mutation, and NO changes to any core module.
 *
 *   parseBrokerExecConfig(argv, env)  → fail-closed alpaca_paper guard
 *   build minimal orderReq from args  (small defaults: 1 share, market, day)
 *   ctx = { broker, execConfig, run_id }
 *     --startup-gate on  → ctx.startupGate = { execConfig, broker }   (real gate)
 *     --startup-gate off → ctx.startupGate is OMITTED entirely (byte-for-byte default-off)
 *   → exactly ONE order_gateway.submit(orderReq, ctx)
 *   → print a JSON summary, exit deterministically
 *
 * Exit codes: 0 success / dry-run · 2 fail-closed (blocked_by_startup_gate, invalid
 * args, config not enabled, missing creds, non-paper) · 1 unexpected error.
 *
 * The broker is INJECTABLE (opts.broker / opts.makeBroker) so the entrypoint is fully
 * offline-testable; the isMain CLI constructs a real AlpacaPaperBroker only when run
 * directly with paper credentials.
 *
 * Args:
 *   --broker-exec alpaca_paper        (or env BROKER_EXEC=alpaca_paper) — REQUIRED
 *   --symbol <SYM>                    REQUIRED
 *   --qty <n>                         REQUIRED (> 0)
 *   --action buy|sell|sell_short|buy_to_cover   (default buy; this is order_action)
 *   --type market|limit               (default market)
 *   --limit-price <n>                 (REQUIRED when --type limit)
 *   --tif day|gtc                     (default day)
 *   --startup-gate on|off             (default off)
 *   --dry-run                         (validate + build ctx, do NOT submit)
 *   --client-order-id <cid>           (optional; else smoke_{YYYYMMDDHHMMSS}_{SYMBOL})
 */

import { fileURLToPath } from 'url';

import { parseBrokerExecConfig, brokerExecEnabled } from './live_broker_config.mjs';
import { AlpacaPaperBroker }                        from './adapters/alpaca_paper_broker.mjs';
import { submit }                                   from './order_gateway.mjs';
import { ORDER_ACTIONS }                            from '../schemas.mjs';

function flag(argv, name) { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null; }
function has(argv, name)  { return argv.includes(name); }

/**
 * runPaperSubmitDevOnce — validate args+config, build ctx, perform ONE submit attempt.
 * Never calls process.exit; returns a summary carrying exit_code. Fail-closed.
 *
 * @param {object} o — { argv?, env?, broker?, makeBroker? }
 * @returns {Promise<object>} summary { ok, client_order_id?, state?, broker_order_id?,
 *                                      blocked_by_startup_gate?, gate?, dry_run?, exit_code, error? }
 */
export async function runPaperSubmitDevOnce({
  argv = [], env = {}, broker = null,
  makeBroker = (cfg) => new AlpacaPaperBroker(cfg),
} = {}) {
  // 1) Argument validation (fail-closed → exit 2). No store/broker IO yet.
  const symbol   = flag(argv, '--symbol');
  const qtyRaw   = flag(argv, '--qty');
  const action   = flag(argv, '--action') ?? 'buy';
  const type     = flag(argv, '--type')   ?? 'market';
  const tif      = flag(argv, '--tif')    ?? 'day';
  const limitRaw = flag(argv, '--limit-price');
  const gateRaw  = flag(argv, '--startup-gate') ?? 'off';
  const dryRun   = has(argv, '--dry-run');
  const explicitCid = flag(argv, '--client-order-id');

  const errs = [];
  if (typeof symbol !== 'string' || !symbol) errs.push('missing --symbol');
  const qty = qtyRaw != null ? parseFloat(qtyRaw) : NaN;
  if (!Number.isFinite(qty) || qty <= 0) errs.push('--qty must be a number > 0');
  if (!ORDER_ACTIONS.includes(action)) errs.push(`--action must be one of ${ORDER_ACTIONS.join('|')}`);
  if (type !== 'market' && type !== 'limit') errs.push('--type must be market|limit');
  if (tif !== 'day' && tif !== 'gtc') errs.push('--tif must be day|gtc');
  let limit_price = null;
  if (type === 'limit') {
    limit_price = limitRaw != null ? parseFloat(limitRaw) : NaN;
    if (!Number.isFinite(limit_price) || limit_price <= 0) errs.push('--limit-price must be > 0 for a limit order');
  }
  if (gateRaw !== 'on' && gateRaw !== 'off') errs.push('--startup-gate must be on|off');
  if (errs.length) return { ok: false, exit_code: 2, error: { reason: 'invalid_args', detail: errs } };

  // 2) Config guard (fail-closed → exit 2).
  let execConfig;
  try { execConfig = parseBrokerExecConfig(argv, env); }
  catch (e) { return { ok: false, exit_code: 2, error: { reason: 'config_invalid', detail: e?.message ?? String(e) } }; }
  if (!brokerExecEnabled(execConfig)) {
    return { ok: false, exit_code: 2, error: { reason: 'broker_exec_not_enabled', detail: 'requires --broker-exec alpaca_paper / BROKER_EXEC=alpaca_paper' } };
  }

  // 3) client_order_id (CID-safe) + minimal orderReq.
  const cidSym = String(symbol).toUpperCase().replace(/[^A-Za-z0-9_-]/g, '_');   // keep CID-safe charset (incl. _ and -)
  const ts     = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);   // YYYYMMDDHHMMSS
  // Auto-generated CID is capped at 48 chars (CID-safe); an explicit --client-order-id is used as-is.
  const clientOrderId = explicitCid ?? `smoke_${ts}_${cidSym}`.slice(0, 48);
  const run_id        = `smoke_${ts}`;
  const side          = (action === 'buy' || action === 'buy_to_cover') ? 'long' : 'short';
  const orderReq = {
    client_order_id: clientOrderId, symbol, qty,
    order_action: action, order_type: type, time_in_force: tif,
    side, action: 'open', run_id,
    ...(type === 'limit' ? { limit_price } : {}),
  };

  // 4) Dry-run: validated + ctx-shaped, but NO submit.
  if (dryRun) {
    return { ok: true, dry_run: true, client_order_id: clientOrderId, order: orderReq, startup_gate: gateRaw, exit_code: 0 };
  }

  // 5) Broker + ctx + EXACTLY ONE submit.
  const paperBroker = broker ?? makeBroker(execConfig);
  const ctx = { broker: paperBroker, execConfig, run_id };
  if (gateRaw === 'on') ctx.startupGate = { execConfig, broker: paperBroker };   // off → omitted entirely

  let result;
  try { result = await submit(orderReq, ctx); }
  catch (e) {
    return { ok: false, exit_code: 1, client_order_id: clientOrderId, error: { reason: 'unexpected', detail: e?.message ?? String(e) } };
  }

  if (result && result.blocked_by_startup_gate === true) {
    return { ok: false, blocked_by_startup_gate: true, client_order_id: clientOrderId, gate: result.gate ?? null, exit_code: 2 };
  }
  // Non-blocked → a persisted broker order record was returned (submit was allowed).
  return {
    ok: true, client_order_id: result?.client_order_id ?? clientOrderId,
    result: { state: result?.state ?? null, broker_order_id: result?.broker_order_id ?? null },
    startup_gate: gateRaw, exit_code: 0,
  };
}

/** submitDevExitCode — map a summary to a CLI exit code (defaults to 1 if absent). */
export function submitDevExitCode(summary) {
  return Number.isInteger(summary?.exit_code) ? summary.exit_code : 1;
}

// ─── CLI (dev/smoke only) — single explicit invocation, never auto-runs on import ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runPaperSubmitDevOnce({ argv: process.argv.slice(2), env: process.env })
    .then((summary) => {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      process.exit(submitDevExitCode(summary));
    })
    .catch((err) => {
      process.stderr.write(JSON.stringify({ ok: false, reason: 'fatal', error: err?.message ?? String(err), exit_code: 1 }) + '\n');
      process.exit(1);
    });
}
