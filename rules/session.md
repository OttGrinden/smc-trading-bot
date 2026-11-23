# Session Rules — Trading Bot

## Session-Start Checkliste

Beim Start jeder Session in dieser Repo ausführen:

1. **Portfolio-State lesen** — `portfolio_engine.mjs --status` oder `portfolio_history.jsonl` letzten Eintrag prüfen
2. **Aktive Positionen** — Mark-to-Market, unrealized PnL, verbleibende Thesis-Fenster
3. **Blocks prüfen** — Welche Symbole sind ceiling8-geblockt und bis wann?
4. **Macro-Regime** — `trading/cache/macro_signals.json` lesen: bull/bear/neutral?
5. **Cache-Alter** — OHLCV, heatmap, macro_signals — alles < 2h?

## Autonomous Action — Wann sofort handeln

Wenn Portfolio-Policy-Verletzung erkannt → sofort `portfolio_engine.mjs` ausführen, nicht beschreiben.

Policy-Verletzungen sind:
- Unrealized Loss > SL-Level einer offenen Position
- Direction-Flip-Signal auf offener Position (Gegensignal ≥ Score 8)
- Thesis-Fenster abgelaufen (`thesis_expired_stagnant`)
- Cash-Floor < 20% des NAV

## Scan-Frequenz

- Manuell: `paper_runbook.mjs --run-scan` auf Anfrage
- Loop: nur mit expliziter Bestätigung (`/loop Nm ...`)
- Kein automatischer Scan ohne Auftrag

## Was NICHT tun

- `intraday_paper.mjs` oder andere Legacy-Scripts aufrufen
- Stocks analysieren oder scannen (nur Crypto SMC)
- Empfehlungen beschreiben ohne sie auszuführen (wenn Score ≥ Threshold)
- Pre-Market-Preise für `manual_open` verwenden — immer letzten Cache-Close

## Execution-Mode

`EXECUTION_MODE = virtual` — keine Live-Orders. Alles paper/simuliert.
