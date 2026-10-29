/**
 * Audit Logger
 *
 * Append-only JSONL log for all execution-layer events.
 * One file per UTC day: trading/execution/audit/audit_YYYY-MM-DD.jsonl
 *
 * Event taxonomy:
 *   decision_started         — decision_engine begins processing a candidate
 *   decision_completed       — decision_engine produced a TradeIntent + decision
 *   risk_check_failed        — a specific risk check returned passed=false
 *   risk_check_placeholder   — a check ran in placeholder mode (always passes)
 *   trade_blocked            — candidate blocked by gate, will not proceed
 *   trade_approved           — candidate passed all gates, eligible for paper/live
 *   paper_order_created      — paper broker created an order record
 *   paper_order_state_change — order moved to a new lifecycle state
 *   paper_order_filled       — paper order simulated as filled
 *
 * Usage (module): import { auditLog } from './audit_log.mjs'
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', '..', 'trading');

const AUDIT_DIR = join(TRADING_DIR, 'execution', 'audit');

function todayFileName() {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(AUDIT_DIR, `audit_${d}.jsonl`);
}

/**
 * auditLog — write a structured event to the daily audit file.
 *
 * @param {string} event — event type from the taxonomy above
 * @param {object} payload — event-specific fields
 */
export function auditLog(event, payload = {}) {
  const entry = {
    ts:    new Date().toISOString(),
    event,
    ...payload,
  };
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    appendFileSync(todayFileName(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    // Audit failure must never crash the caller — log to stderr only
    process.stderr.write(JSON.stringify({ warning: 'audit_log_failed', event, error: e.message }) + '\n');
  }
  return entry;
}
