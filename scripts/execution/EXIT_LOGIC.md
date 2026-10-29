# Portfolio Engine — Exit Logic SOP

## Exit Rules (auto-close)

| Trigger | Reason code | Source |
|---------|-------------|--------|
| `unrealized_pnl_pct ≤ −stop_loss_pct` | `stop_loss_hit` | Engine (each run) |
| Scan approves opposite side for open symbol | `direction_flip` | Engine (each run) |
| Explicit close with reason | `thesis_quality_fail` / `manual_override` / … | `manual_close.mjs` |

## Non-Exit States (HOLD + flag)

| Situation | Flag set on position | Engine action |
|-----------|----------------------|---------------|
| Symbol not in current scan (no price) | `mark_status: 'missing_from_scan'` | Hold at last mark, log to `unmatched_positions` |
| Symbol in scan but outside top candidates | `approval_status: 'not_in_top_candidates'` | Hold at current mark, log to `unranked_positions` |
| Outside top candidates + ≥21 days open + ≥5% unrealised gain on notional | `approval_status: 'aged_profit_review'` + `days_open: N` | Hold — **no auto-close**; review signal only, logged to audit + stderr |
| Opposite-side signal present for this symbol | `approval_status: 'direction_watch'` | Hold; no exit triggered |

Flags are cleared automatically each run when the position re-enters top candidates (price mark pass).

`aged_profit_review` is a **pure operator signal** — thresholds live in `ALLOC_RULES.AGED_PROFIT_REVIEW_MIN_DAYS` (21) and `ALLOC_RULES.AGED_PROFIT_REVIEW_MIN_PNL_PCT` (5). No automatic exit, trim, or rebalance is attached.

## Rule of thumb

> **No price and no ranking are data problems, not exit signals.  
> Only stop-loss, direction-flip, and manual policy closes terminate a position.**
