# Portfolio-aware Risk Gates

> **Status:** implemented + tested. Entry-side only, inside `allocation_engine.allocate()`
> — **not** in the stateless risk engine. Tests: `tests/risk_gates_test.mjs` RG-01…13;
> cash / post-SL / regression / positioning / portfolio_marks suites unchanged green.

Purpose: hard-limit sector/cluster risk and aggregate portfolio risk, in addition to the
existing hard gates (cash reserve floor, run-deployment cap, `max_open_positions`,
`symbol_already_open`, manual / post-SL blocks — all unchanged).

## Two hard gates (default ON)

- **`sector_exposure_cap`** = `0.40` → max 40 % NAV committed notional per sector
  (`intent.sector`-based).
- **`portfolio_risk_budget`** = `0.06` → max 6 % NAV at risk, where one position's risk =
  `notional_eur × stop_loss_pct / 100`, aggregated over open + new positions (cumulative
  within a run).

Per candidate the gates **clamp first** (recording `sizing_constraint`), then **hard-skip**
only if the clamped size falls below the minimum position size (5 % NAV). A gate is disabled
by setting its fraction `>= 1.0` (room = Infinity → never binds). Invalid values (`<= 0`)
fail fast in `runPortfolio`.

Parameters: `--sector-exposure-cap` / `--portfolio-risk-budget` (env: `SECTOR_EXPOSURE_CAP` /
`PORTFOLIO_RISK_BUDGET`), threaded `scan.mjs → portfolio_engine → allocate`.

## Tie-break / attribution order (highest first)

```
sector_exposure_cap → portfolio_risk_budget → run_deployment_cap → cash_reserve_floor → insufficient_capacity
```

Identical for the skip `reason` and for `sizing_constraint`. Portfolio-aware gates rank above
cash/budget clamps so cluster-/risk-driven skips are never mislabelled as a cash problem.
`cash_reserve_floor` applies only when unreserved cash would have sufficed (i.e. the reserve
itself was the binding factor).

## Sector backfill (engine Step 0 — `backfillSectors`)

- Additively fills `sector` on open positions that lack it. Source:
  `registry.stocks.sectors.<key>.watchlist[].symbol` (same map the scanner uses for
  `candidate.sector`). This makes `sector_exposure_cap` see real cluster exposure on legacy
  books that predate the `sector` field.
- **Idempotent** (positions that already carry a sector are never overwritten),
  **no migration**, **no schema enforcement**.
- **No crash** on an unreadable registry (`registry_ok: false`) or an unmapped symbol
  (e.g. crypto / delisted → `unresolved[]`); both surfaced in audit (`sector_backfill`) and
  the summary.
- **Persistence:** the durable write happens on the next real `virtual_portfolio` run via the
  engine's `save(state)`. Until then the backfill applies in-memory each run. There is no
  standalone migration script (deliberate).

## Behavior when `sector` is missing

A position without a `sector` (still unmapped after backfill, e.g. crypto) is counted against
**no** named-sector cap (legacy-tolerant) and is itself not limited by `sector_exposure_cap`.
`portfolio_risk_budget` still applies (sector-agnostic).

## Behavior when stop-loss is missing (no-SL policy, fail-closed)

- **Existing position without SL:** NOT booked as 0 risk in the at-risk aggregate; charged
  conservatively at `RISK_UNKNOWN_SL_PCT = 20 %` (the max plausible stop per the risk_engine
  bounds) so unbounded legacy/manual positions consume the budget.
- **New candidate without a usable SL:** while the risk budget is active → hard-skip
  `risk_unknown` (fail-closed) — a missing SL must never make a fresh approval easier. When
  the budget is disabled (`>= 1.0`) this guard does not apply (and the no-SL guard is off too).

## Observability (additive, machine-readable)

- Audit: `sector_exposure_cap_reached`, `portfolio_risk_budget_reached`, `sector_backfill`.
- Summary / history: `sector_exposure_cap_eur/_pct`, `sector_exposure_eur`,
  `portfolio_risk_budget_eur/_pct`, `portfolio_at_risk_eur/_pct`, `sector_cap_skips`,
  `risk_budget_skips`, `risk_unknown_skips`, `sector_backfill`.
- Per position: `sector` persisted; `sizing_constraint` may be `sector_exposure_cap` /
  `portfolio_risk_budget`; skip reasons `sector_exposure_cap` / `portfolio_risk_budget` /
  `risk_unknown`.

## Conviction-based, stop-loss-derived sizing (opt-in — `--conviction-sizing`)

Unit added 2026-06-15. Default **off** → legacy `target_position_pct` sizing (fully
backward compatible). When on, the target notional is derived from conviction and the
stop-loss distance instead of a flat % of NAV:

```
risk_pct        = convictionRiskPct(confidence_score_normalized)   // deterministic bands
risk_eur        = risk_pct × NAV
target_notional = min( risk_eur / (stop_loss_pct/100), MAX_PCT_PER_POSITION × NAV )
```

Deterministic bands (`CONVICTION_RISK_BANDS`, mirrors the ★…★★★★★ / 0.2…1.0 score):

| score (★) | risk_pct/trade |
|-----------|----------------|
| 1.0 (★★★★★) | 2.0 % |
| 0.8 (★★★★) | 1.5 % |
| 0.6 (★★★) | 1.0 % |
| 0.4 (★★) | 0.75 % |
| else (★) | 0.5 % |

Properties:
- **Conviction never buys raw leverage** — it only scales the per-trade *risk budget*; the
  notional still follows from the stop-loss distance and is capped by `MAX_PCT_PER_POSITION`.
- **Stop-loss is mandatory** under conviction sizing: a missing/zero SL → hard-skip
  `risk_unknown` even if the portfolio risk budget is disabled (no fail-open).
- **The aggregate `portfolio_risk_budget` (6 %) remains the hard ceiling** above per-trade
  sizing; all other gates (cash floor, sector cap, run cap) still clamp.
- Per position: `sized_by` (`conviction_risk` | `target_pct`) and `risk_pct_at_entry` persisted.
- Activation: `--conviction-sizing` flag or `CONVICTION_SIZING=true` (scan.mjs / engine CLI).

Tests: `node scripts/execution/tests/conviction_sizing_test.mjs` — CS-00…06
(bands · higher conviction→larger · larger stop→smaller · no-SL reject · aggregate budget
still binds · backward-compat off · tiny-SL capped by MAX_PCT).

## Planned next unit — real long leverage (NOT yet implemented)

Real leverage requires a margin model and must NOT ship as a metadata label. Scope for the
next unit (long side only first):
- `portfolio_state.recompute()` + cash formula: cash reduced by **margin = notional/leverage**,
  not full notional; track `margin_used`, `free_margin`, `margin_utilization`.
- Hard caps: max leverage per position, max portfolio gross leverage, margin-utilization cap,
  liquidation-safety buffer (derived from SL distance vs margin).
- Leveraged entries require a valid SL (hard reject otherwise).
- Conservative ladder 1.0 / 1.25 / 1.5 / 2.0x (hard cap), default 1.0x.
- Own test set (margin/cash consistency, gross-leverage cap, liquidation buffer).
Until then `leverage` stays metadata-only and does not affect cash/PnL/risk.

## Deliberately NOT in scope (current units)

- No correlation groups (e.g. semiconductor + ai_infrastructure as one block), no FX
  revaluation (`EUR_USD_RATE` stays 1.08), no intraday risk model.
- No real leverage yet (planned as the next unit, see above).
- `squeeze_risk` stays soft / unwired; thesis/catalyst fields stay operator-managed.

## Tests

`node scripts/execution/tests/risk_gates_test.mjs` — RG-01…13:

- RG-01 allowed under both caps · RG-02 sector clamp · RG-03 sector skip · RG-04 risk clamp ·
  RG-05 risk skip · RG-06 legacy without sector (no crash) · RG-07 gate disable + fail-fast ·
  RG-08 cumulative sector cap within run · RG-09 engine summary/audit + exposure aggregation ·
  RG-10 backfill (fill/idempotent/unresolved) · RG-11 cluster recognized after backfill ·
  RG-12 no-SL existing charged conservatively · RG-13 no-SL new entry fail-closed.
