# Output Rules

## Scan-Output Format

Nach jedem `paper_runbook.mjs --run-scan`:

**Kompakt-Zusammenfassung** (nicht den rohen JSON wiederholen):

```
Symbol | Signal/Status | Preis | PnL/Detail
```

Nur Änderungen und Actionables hervorheben. Stabile Zustände in einer Tabelle.

## Wichtige Events — sofort melden

- Neuer auto_open (mit Symbol, Side, Score, Preis)
- Policy-Gate geblockt (mit Grund und Ablaufdatum)
- thesis_expired_stagnant (mit PnL)
- Macro-Regime-Wechsel
- Score-Upgrade von 8 → 9

## Nicht wiederholen

- Identische Scan-Resultate wie vorheriger Scan → "Identisch zum letzten Scan. [NAV] EUR."
- Rohe JSON-Blöcke nicht kommentarlos zitieren
- Cache-Alter nicht kommentieren außer bei Warnung (> 2h)

## Sprache

- Deutsch mit technischen Fachbegriffen auf Englisch (BOS, IDM, OB, FVG, CHoCH, MSS)
- Keine Emojis
- Keine langen Erklärungen bei Routine-Scans — ein Satz pro Symbol reicht

## Token-Effizienz

- Slim-Log: Nur relevante Zeilen aus Scan-Output zitieren
- Freshness-Gate: Macro-Cache-Alter nur erwähnen wenn > 180min oder > 240min (Refresh)
- Keine Wiederholung von Blöcken die sich nicht geändert haben

## Fehlerbehandlung

- `ETIMEDOUT` bei Python-Scripts → "non-fatal, Scan weitergelaufen" — nicht weiter kommentieren außer es passiert > 2x hintereinander
- `empty_response` bei OHLCV → notieren, kein Alarm
- `policy_gate_failed` → kurz notieren (Symbol, Grund, Ablauf)
