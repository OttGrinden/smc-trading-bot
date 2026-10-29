/**
 * Live Broker — Reconciliation
 *
 * Read-only comparison between the internal virtual portfolio state and
 * live broker positions/account. Purely observational: no orders, no mutations.
 *
 * Purpose:
 *   Detect structural discrepancies between what the simulation believes is open
 *   and what actually exists in the live broker account. This validates that the
 *   internal interface maps correctly to real broker structures.
 *
 * Important limitations (explicitly documented):
 *   - The virtual portfolio is EUR-denominated; the live broker is USD-denominated.
 *     Value/PnL comparisons are NOT attempted — currencies differ.
 *   - The virtual portfolio is a simulation that diverges from any real account.
 *     Discrepancies are EXPECTED and normal; this is not a sync tool.
 *   - Quantity comparison uses a tolerance of 0.0001 to handle floating-point rounding.
 *   - This module never makes broker API calls.
 *
 * Usage (module):
 *   import { reconcile, formatReconciliationSummary } from './reconciliation.mjs'
 */

const QTY_TOLERANCE = 0.0001;

/**
 * reconcile — compare virtual portfolio positions against live broker positions.
 *
 * @param {object}   virtualState   — from portfolio_state.json (loadOrInit())
 * @param {object[]} livePositions  — from adapter.getPositions() (normalized)
 * @param {object}   liveAccount    — from adapter.getAccount() (normalized), or null
 * @returns {object}                — reconciliation report
 */
export function reconcile(virtualState, livePositions, liveAccount) {
  const virtualMap = new Map(
    (virtualState?.open_positions ?? []).map(p => [p.symbol, p])
  );
  const liveMap = new Map(
    (livePositions ?? []).map(p => [p.symbol, p])
  );

  const only_in_virtual  = [];
  const only_in_live     = [];
  const direction_mismatch = [];
  const quantity_mismatch  = [];
  const in_both            = [];

  // Check virtual positions against live
  for (const [sym, vPos] of virtualMap) {
    if (!liveMap.has(sym)) {
      only_in_virtual.push({
        symbol:       sym,
        virtual_side: vPos.side,
        virtual_qty:  vPos.quantity,
      });
    } else {
      const lPos = liveMap.get(sym);
      if (vPos.side !== lPos.side) {
        direction_mismatch.push({
          symbol:       sym,
          virtual_side: vPos.side,
          live_side:    lPos.side,
          virtual_qty:  vPos.quantity,
          live_qty:     lPos.qty,
        });
      } else if (Math.abs(vPos.quantity - lPos.qty) > QTY_TOLERANCE) {
        quantity_mismatch.push({
          symbol:       sym,
          side:         vPos.side,
          virtual_qty:  vPos.quantity,
          live_qty:     lPos.qty,
          diff:         +( vPos.quantity - lPos.qty ).toFixed(6),
        });
      } else {
        in_both.push({ symbol: sym, side: vPos.side, qty: vPos.quantity });
      }
    }
  }

  // Check live positions not in virtual
  for (const [sym, lPos] of liveMap) {
    if (!virtualMap.has(sym)) {
      only_in_live.push({
        symbol:    sym,
        live_side: lPos.side,
        live_qty:  lPos.qty,
        live_market_value_usd: lPos.market_value_usd,
      });
    }
  }

  const discrepancy_count = only_in_virtual.length + only_in_live.length +
                            direction_mismatch.length + quantity_mismatch.length;

  return {
    ts:                        new Date().toISOString(),
    provider:                  livePositions?.[0]?.provider ?? 'unknown',

    virtual_nav_eur:           virtualState?.equity_nav          ?? null,
    virtual_cash_eur:          virtualState?.cash                ?? null,
    virtual_open_positions:    virtualState?.open_positions?.length ?? 0,
    virtual_cumulative_fees_eur: virtualState?.cumulative_fees_eur ?? 0,

    live_cash_usd:             liveAccount?.cash                 ?? null,
    live_buying_power_usd:     liveAccount?.buying_power         ?? null,
    live_portfolio_value_usd:  liveAccount?.portfolio_value      ?? null,
    live_open_positions:       livePositions?.length             ?? 0,

    in_both,
    only_in_virtual,
    only_in_live,
    direction_mismatch,
    quantity_mismatch,
    discrepancy_count,

    note: [
      'Read-only comparison only. No orders placed. No portfolio mutations.',
      'Virtual portfolio is EUR-denominated; live broker is USD-denominated — value comparison not attempted.',
      'Discrepancies between virtual and live are expected: the simulation diverges from any real account.',
      'This report validates interface compatibility, not portfolio sync.',
    ].join(' '),
  };
}

/**
 * formatReconciliationSummary — compact human-readable summary for stderr.
 *
 * @param {object} report — from reconcile()
 * @returns {string}
 */
export function formatReconciliationSummary(report) {
  const lines = [
    `- virtual open: ${report.virtual_open_positions}  |  live open: ${report.live_open_positions}`,
  ];

  if (report.in_both.length > 0) {
    lines.push(`- in both (no discrepancy): ${report.in_both.map(p => `${p.side} ${p.symbol}`).join(', ')}`);
  }
  if (report.only_in_virtual.length > 0) {
    lines.push(`- only in virtual (not in live): ${report.only_in_virtual.map(p => `${p.virtual_side} ${p.symbol}`).join(', ')}`);
  }
  if (report.only_in_live.length > 0) {
    lines.push(`- only in live (not in virtual): ${report.only_in_live.map(p => `${p.live_side} ${p.symbol}`).join(', ')}`);
  }
  if (report.direction_mismatch.length > 0) {
    lines.push(`- direction mismatch: ${report.direction_mismatch.map(p => `${p.symbol} (virt:${p.virtual_side} vs live:${p.live_side})`).join(', ')}`);
  }
  if (report.quantity_mismatch.length > 0) {
    lines.push(`- quantity mismatch: ${report.quantity_mismatch.map(p => `${p.symbol} virt=${p.virtual_qty} live=${p.live_qty}`).join(', ')}`);
  }
  if (report.discrepancy_count === 0) {
    lines.push('- discrepancies: none (virtual and live positions match)');
  } else {
    lines.push(`- discrepancies: ${report.discrepancy_count} total`);
  }

  return lines.join('\n');
}
