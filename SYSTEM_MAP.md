# SMC Trading Bot — System Map

## Scan Pipeline (paper_runbook.mjs → smc_scan.mjs)

```
paper_runbook.mjs
  └─ Health-Check (cache-alter, NAV, blocks)
  └─ smc_scan.mjs
       1. ohlcv_fetcher.mjs      — OHLCV daily/weekly/monthly + 15m/1h/4h für SMC-Symbole
       2. positioning_fetcher.mjs — Bitunix Fund-Flow (BTC/ETH/SOL)
       3. liq_heatmap.mjs        — Liquiditäts-Heatmap: BS-Ratio, wall-size, squeeze-zones
       4. level_entry.py         — Fib 88.2% Level-Entries (G1–G7 Gates)
       5. regime_filter.py       — FNG-Score → RED/GREEN; bei RED: smc_detector skip
       6. [smc_detector.py]      — SKIPPED wenn regime_RED; SMC-Score G1–G7
       7. macro_trader.mjs       — BTC/ETH Swing, min-score 8, regime-first
       8. thesis_expiry_check.mjs — Thesis-Fenster prüfen → thesis_expired_stagnant
       9. heatmap_trader.mjs     — BS-Ratio ≥ 1.15 + wall → auto_open (unabhängig von Regime)
      10. mark_to_market          — Unrealized PnL, NAV update
```

## Score-Gate-Hierarchie

| Gate | Kriterium | Punkte |
|------|-----------|--------|
| G1 | BOS-Richtung bestätigt | +2 |
| G2 | EMA200 bestätigt | +1 |
| G3 | Liquidity Sweep (IDM) | +2 |
| G4 | Order Block gezeichnet | +2 |
| G5 | Preis kehrt zum OB zurück | +1 |
| G6 | Candlestick-Bestätigung | +1 |
| G7 | R/R ≥ 1:2 | +1 |

Score ≥ 9 → auto_open | Score 8 → monitoring only | Score ≤ 7 → kein Signal

## Aktive Symbole

```
SMC_SYMBOLS (smc_scan.mjs):  BTC, ETH, BNB, SOL, XRP, TAO
HEATMAP_SYMBOLS:             BTC, ETH, XRP, SOL, BNB
MACRO_SYMBOLS:               BTC, ETH
LEVEL_ENTRY_SYMBOLS:         BTC, ETH, BNB, SOL, XRP, TAO
```

## Cache-Dateien (trading/cache/)

| Datei | Inhalt | Schreiber |
|-------|--------|-----------|
| `ohlcv_daily_<SYM>.json` | OHLCV daily | ohlcv_fetcher.mjs |
| `ohlcv_4h_<SYM>.json` | OHLCV 4h | ohlcv_fetcher.mjs |
| `ohlcv_1h_<SYM>.json` | OHLCV 1h | ohlcv_fetcher.mjs |
| `ohlcv_15m_<SYM>.json` | OHLCV 15m | ohlcv_fetcher.mjs |
| `liq_heatmap_<SYM>.json` | BS-Ratio, wall_usd, squeeze-zones | liq_heatmap.mjs |
| `positioning_data.json` | Fund-Flow pro Symbol | positioning_fetcher.mjs |
| `macro_signals.json` | regime: bull/bear/neutral, FNG-Score | macro_signal.mjs / regime_filter.py |
| `level_entry_state.json` | armed/triggered-Status pro Symbol | level_entry.py |
| `smc_scan_last.json` | letztes Scan-Ergebnis | smc_scan.mjs |

## Datenspeicher (trading/execution/) — gitignored

| Datei | Inhalt |
|-------|--------|
| `portfolio/portfolio_state.json` | Offene Positionen, Cash, NAV |
| `portfolio/portfolio_history.jsonl` | Portfolio-Snapshots |
| `portfolio/trade_ledger.jsonl` | Alle open/close Events (Quelle für Analytics) |
| `orders/<order_id>.json` | Paper-Order-Objekte |
| `orders/order_events.jsonl` | Order-State-Transitions |
| `audit/audit_log.jsonl` | Engine-Entscheidungen |

## Execution-Flow (auto_open)

```
heatmap_trader / smc_detector
  → auto_open.mjs
       → policy_gate (max 5 pos, cash-floor 20%, sector-ban, ceiling8-block)
       → paper_broker.mjs → ORDER_DIR/<id>.json
       → portfolio_engine.mjs → portfolio_state.json + trade_ledger.jsonl
```

## Key-Scripts (nicht Scan-Pipeline)

| Script | Zweck |
|--------|-------|
| `execution/auto_open.mjs` | Policy-Gate + Paper-Order erstellen; Partial-TP1/TP2 |
| `execution/manual_open.mjs` | Manueller Entry mit Cache-Preis |
| `execution/manual_close.mjs` | Manueller Exit mit Grund |
| `execution/portfolio/portfolio_engine.mjs` | NAV, Cash-Floor-Enforcement, SL-Check |
| `execution/portfolio/portfolio_state.mjs` | State-Read/Write-Helpers |
| `execution/paper_broker.mjs` | Order-Lifecycle (fill, cancel, state) |
| `execution/risk_engine.mjs` | Sizing: notional = 5% NAV, Leverage-Tabelle |
| `execution/decision_engine.mjs` | Signal → Decision-Record |
| `thesis_reviewer.mjs` | LLM-basierte Thesis-Prüfung vor auto_open |
| `thesis_expiry_check.mjs` | Thesis-Fenster: heatmap=5d, smc=7d, level=10d, catalyst=14d |
| `macro_signal.mjs` | FNG-Fetch + regime-Klassifikation |
| `portfolio_analytics.mjs` | WR, Expectancy, Sektor-Breakdown |
| `research_run.mjs` | Headless Claude Research Agent |
| `paths.mjs` | Zentrale Pfad-Konstanten (import.meta.url-basiert) |

## Portfolio-Policy (engine-enforced)

- Max 5 gleichzeitige Positionen
- Cash-Floor: 20% NAV
- Kein Doppel-Sektor
- Ceiling8-Block: 14 Tage nach Direction-Flip-Exit (Score ≥ 9 kann overriden)
- Position-Sizing: ~5% NAV notional (20–30% des freien Cash)
- Virtual Portfolio: 1000 EUR gesamt; EXECUTION_MODE = virtual

## Thesis-Fenster

| Typ | Fenster |
|-----|---------|
| heatmap_short_squeeze | 5 Tage |
| smc_detector (Score 9) | 7 Tage |
| level_entry | 10 Tage |
| catalyst_event | 14 Tage |

Nach Ablauf ohne |pnl_pct| ≥ 4% → `thesis_expired_stagnant` → Close

## Leverage-Tabelle (Bitunix Futures, virtuell)

| SL-Distanz | Max Leverage |
|-----------|-------------|
| ≤ 2% | 20x |
| ≤ 3% | 15x |
| ≤ 4% | 12x |
| ≤ 5% | 10x |
| ≤ 7% | 7x |
| ≤ 10% | 5x |
| > 10% | 3x |

## Legacy / nicht mehr verwenden

- `intraday_paper.mjs` — veraltet
- `scan.mjs` — veraltet (nur Stocks, durch smc_scan.mjs ersetzt)
- `backtest_intraday.mjs` — veraltet
- `scripts/execution/live_broker/` — Bitunix-Live-Integration (Phase 2 offen, nicht aktiv)
