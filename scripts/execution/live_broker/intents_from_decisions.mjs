/**
 * IntentsFromDecisions — the source bridge that turns decision_engine output into
 * worker_pass-ready UNSIZED approved intents (Phase 1, Unit 14).
 *
 * THE MISSING SOURCE: decision_engine.buildDecisions() yields { intent, decision }[]
 * (decision.execution_ready marks an approval), but nothing converts the APPROVED
 * subset into the shape the operative sizing path consumes
 * (worker_pass(sizeFromAccount:true) → sizeIntentsFromBroker → account_sizing). This
 * unit is the smallest safe join on the ENTRY side:
 *
 *   for { intent, decision } in decisions:
 *     decision.execution_ready !== true            → skip(not_approved)
 *     validate symbol / side / price_usd / run_id  → fail-closed skip(reason)
 *     emit { symbol, side, action:'open', price_usd, run_id, asset_type,
 *            decision_source:{decision_id, intent_id} }   (UNSIZED — account_sizing sizes it)
 *
 * The emitted shape is EXACTLY the sizeIntentsFromAccount / sizeIntentsFromBroker input,
 * so summary.intents can be handed straight to runWorkerPassOnce as ctx.approvedIntents
 * (with ctx.sizeFromAccount=true).
 *
 * SCOPE (Unit 14 ONLY) — deliberately tiny and additive:
 *   - a PURE function: no broker, no network, no I/O, no persistence
 *   - filter (approved) + map (to unsized intent shape) only
 *   - no imports of any core module (it consumes the documented output shape)
 *
 * EXPLICITLY NOT in this unit: a production entrypoint / scan.mjs / CLI wiring, a
 * daemon, running decision_engine itself, building a broker, sizing (10.8/12), dispatch
 * (10.6), de-duplication (order_dispatch owns the deterministic cid idempotency), close
 * intents, stop/bracket logic, live trading. No existing module is modified.
 *
 * Fail-closed: a non-approved decision or any missing/ambiguous required field skips
 * that item with a reason — never an optimistic emit. A non-positive price is filtered
 * HERE (rather than later surfacing as an account_sizing skip), so only genuinely
 * sizeable intents leave this stage.
 */

/**
 * approvedIntentsFromDecisions — select + normalize approved decisions into UNSIZED intents.
 *
 * @param {Array<{intent:object, decision:object}>} decisions — decision_engine.buildDecisions output
 * @param {object} ctx — { run_id? } fallback run_id when a decision carries none
 * @returns {object} summary {
 *   total, approved, emitted,
 *   intents: [{ symbol, side, action:'open', price_usd, run_id, asset_type, decision_source }],
 *   skipped: [{ symbol, reason }]
 * }
 */
function deriveTpPct(ceiling) {
  if (!Number.isFinite(ceiling)) return null;
  if (ceiling >= 9) return 20;
  if (ceiling >= 8) return 18;
  return null;
}

export function approvedIntentsFromDecisions(decisions = [], ctx = {}) {
  const list = Array.isArray(decisions) ? decisions : [];
  const summary = { total: list.length, approved: 0, emitted: 0, intents: [], skipped: [] };

  const skip = (symbol, reason) => { summary.skipped.push({ symbol: symbol ?? null, reason }); };

  for (const entry of list) {
    const intent   = entry?.intent   ?? null;
    const decision = entry?.decision ?? null;
    const symbol   = intent?.symbol ?? decision?.symbol ?? null;

    // ── approval gate (only execution_ready decisions proceed) ──────────────────
    if (decision?.execution_ready !== true) { skip(symbol, 'not_approved'); continue; }
    summary.approved += 1;

    // ── fail-closed field validation (never emit on doubt) ──────────────────────
    if (typeof symbol !== 'string' || !symbol) { skip(symbol, 'missing_symbol'); continue; }
    const side = intent?.side ?? decision?.side ?? null;
    if (side !== 'long' && side !== 'short')   { skip(symbol, 'invalid_side'); continue; }
    const price = intent?.price_usd;
    if (!Number.isFinite(price) || price <= 0) { skip(symbol, 'non_positive_price'); continue; }
    const runId = decision?.run_id ?? intent?.run_id ?? ctx.run_id ?? null;
    if (!runId)                                { skip(symbol, 'missing_run_id'); continue; }

    const decisionId = decision?.decision_id ?? null;
    const intentId   = intent?.intent_id ?? decision?.intent_id ?? null;

    summary.intents.push({
      symbol,
      side,
      action: 'open',
      price_usd: price,
      run_id: runId,
      asset_type: intent?.asset_type ?? null,
      stop_loss_pct:   intent?.risk?.stop_loss_pct ?? null,
      take_profit_pct: intent?.risk?.take_profit_pct
        ?? deriveTpPct(intent?.score_bounds?.ceiling)
        ?? null,
      decision_source: { decision_id: decisionId, intent_id: intentId },
    });
    summary.emitted += 1;
  }

  return summary;
}
