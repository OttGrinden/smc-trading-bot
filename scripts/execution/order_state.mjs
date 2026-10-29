/**
 * Order State Machine
 *
 * Validates and applies order lifecycle transitions.
 * Rejects invalid transitions with a descriptive error.
 *
 * Lifecycle:
 *   created → validated → approved → sent → acknowledged → filled
 *          ↘ blocked                                   ↘ partially_filled → filled
 *                                                       any → cancel_pending → cancelled
 *                                    sent → rejected
 *                                    filled → failed_reconciliation
 *
 * Usage (module): import { transition, isTerminal } from './order_state.mjs'
 */

import { ORDER_STATES, ORDER_TRANSITIONS } from './schemas.mjs';
import { auditLog }                        from './audit_log.mjs';

/**
 * transition — attempt to move an order to a new state.
 * Mutates the order object in place and appends an event record.
 *
 * @param {object} order     — paper order object (from makePaperOrder)
 * @param {string} nextState — target ORDER_STATES value
 * @param {object} meta      — additional fields to include in the state event
 * @returns {object}         — the mutated order
 * @throws  {Error}          — if transition is not allowed
 */
export function transition(order, nextState, meta = {}) {
  const allowed = ORDER_TRANSITIONS[order.state] ?? [];

  if (!allowed.includes(nextState)) {
    throw new Error(
      `Invalid order state transition: ${order.state} → ${nextState} ` +
      `(order_id=${order.order_id}, symbol=${order.symbol})`
    );
  }

  const prev  = order.state;
  order.state = nextState;

  const event = {
    ts:         new Date().toISOString(),
    from_state: prev,
    to_state:   nextState,
    ...meta,
  };

  order.events.push(event);

  auditLog('paper_order_state_change', {
    order_id:   order.order_id,
    symbol:     order.symbol,
    from_state: prev,
    to_state:   nextState,
    ...meta,
  });

  return order;
}

/**
 * isTerminal — returns true if the order is in a final, non-changeable state.
 */
export function isTerminal(order) {
  return ORDER_TRANSITIONS[order.state]?.length === 0;
}

/**
 * canTransitionTo — check without applying.
 */
export function canTransitionTo(order, nextState) {
  return (ORDER_TRANSITIONS[order.state] ?? []).includes(nextState);
}
