/**
 * ProtectiveExit — derive deterministic broker-backed protective stop EXIT requests
 * from open positions (Phase 1, Unit 10.9).
 *
 * THE MISSING PIECE (protection side): positions exist logically in the bot, but there
 * is no broker-backed protective/exit order. The submit path today supports ONLY
 * market/limit (ORDER_TYPES = {market, limit}) — there is NO stop order type, no
 * stop_price, no bracket/order_class anywhere. A true RESTING broker stop would require
 * adding a 'stop' order type to schemas + order_gateway + alpaca_paper_broker (a
 * contract change to three core modules). That is deliberately OUT OF SCOPE here.
 *
 * This unit is therefore the smallest correct, fully-additive step: a PURE PLANNER that
 * turns each open position into a well-formed, idempotent protective stop EXIT request:
 *
 *   per open position:
 *     stop_price = entry · (1 - sl%/100)   [long  → close via 'sell']
 *                  entry · (1 + sl%/100)   [short → close via 'buy_to_cover']
 *     → protective request { action:'close', order_action, qty, order_type:'stop',
 *                            stop_price_usd, time_in_force:'gtc', client_order_id }
 *
 * It does NOT place anything (placing a resting stop needs the stop-type wiring — a
 * deliberate follow-up). Representing a stop as a 'limit' close would be semantically
 * WRONG (it would fill immediately instead of protecting), so the planner honestly
 * emits order_type:'stop' as a plan.
 *
 * SCOPE (Unit 10.9 ONLY) — deliberately tiny and additive:
 *   - a PURE function: no broker, no network, no store I/O, no portfolio mutation
 *   - one protective stop per open position, deterministic + idempotent client_order_id
 *   - close-side order_action derived from position side (same mapping as order_dispatch)
 *
 * EXPLICITLY NOT in this unit: placing/submitting the stop (no stop-type wiring), bracket
 * / multi-leg orders, trailing stops, continuous monitoring / loop, live execution, any
 * change to schemas / order_gateway / alpaca_paper_broker / order_dispatch, and any touch
 * of existing open orders or the portfolio.
 *
 * Fail-closed: a position missing/with an implausible symbol/side/qty/entry/stop_loss_pct
 * is skipped with a reason — never an optimistic protective plan.
 */

const CID_RE  = /^[A-Za-z0-9_-]+$/;   // must match OrderStore / OrderGateway charset
const CID_MAX = 64;

function safe(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_'); }

/** Close-side order_action for a protective exit (same mapping order_dispatch uses). */
function closeOrderAction(side) { return side === 'long' ? 'sell' : 'buy_to_cover'; }

/**
 * buildProtectiveExits — plan one protective stop exit per open position.
 *
 * @param {object[]} positions — open positions. Per item:
 *   { symbol, side:'long'|'short', quantity (>0), entry_price_usd (>0),
 *     stop_loss_pct (0<pct<100), order_id? }
 * @param {object} opts — { existingProtectiveCids?: string[]|Set } (positions already protected)
 * @returns {object} summary {
 *   total, protected:[...], skipped:[{symbol,reason}],
 *   totals:{ protected, skipped, already_protected }
 * }
 */
export function buildProtectiveExits(positions = [], opts = {}) {
  const existingRaw = opts.existingProtectiveCids;
  const existing = new Set(
    existingRaw instanceof Set ? [...existingRaw] : Array.isArray(existingRaw) ? existingRaw : [],
  );
  const list = Array.isArray(positions) ? positions : [];

  const summary = {
    total: list.length, protected: [], skipped: [],
    totals: { protected: 0, skipped: 0, already_protected: 0 },
  };
  const seen = new Set();
  const skip = (p, reason) => { summary.skipped.push({ symbol: p?.symbol ?? null, reason }); };

  for (const p of list) {
    const symbol = p?.symbol;
    if (typeof symbol !== 'string' || !symbol) { skip(p, 'invalid_symbol'); continue; }
    const side = p?.side;
    if (side !== 'long' && side !== 'short')   { skip(p, 'invalid_side'); continue; }
    const qty = p?.quantity;
    if (!Number.isFinite(qty) || qty <= 0)     { skip(p, 'invalid_quantity'); continue; }
    const entry = p?.entry_price_usd;
    if (!Number.isFinite(entry) || entry <= 0) { skip(p, 'invalid_entry_price'); continue; }
    const slPct = p?.stop_loss_pct;
    if (!Number.isFinite(slPct) || slPct <= 0 || slPct >= 100) { skip(p, 'invalid_stop_loss_pct'); continue; }

    const stopPrice = side === 'long' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
    const stopPriceUsd = +stopPrice.toFixed(6);
    if (!Number.isFinite(stopPriceUsd) || stopPriceUsd <= 0) { skip(p, 'invalid_stop_price'); continue; }

    const cid = `protect_v1_${safe(symbol)}_${side}`.slice(0, CID_MAX);
    if (!CID_RE.test(cid)) { skip(p, 'unbuildable_client_order_id'); continue; }

    // idempotency: already protected (prior placement) or duplicate within this batch
    if (existing.has(cid) || seen.has(cid)) {
      summary.totals.already_protected += 1;
      summary.skipped.push({ symbol, reason: 'already_protected' });
      continue;
    }
    seen.add(cid);

    summary.protected.push({
      symbol, side,
      action:        'close',
      order_action:  closeOrderAction(side),
      quantity:      qty,
      order_type:    'stop',          // honest broker semantics; placing it is a deferred follow-up
      stop_price_usd: stopPriceUsd,
      time_in_force: 'gtc',           // a protective stop rests until triggered
      client_order_id: cid,
      source_position: {
        order_id:        p?.order_id ?? null,
        entry_price_usd: entry,
        stop_loss_pct:   slPct,
      },
    });
  }

  summary.totals.protected = summary.protected.length;
  summary.totals.skipped   = summary.skipped.length;
  return summary;
}
