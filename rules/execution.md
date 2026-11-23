# Execution Rules

## Auto-Open Schwellen

| Score | Seite | Aktion |
|-------|-------|--------|
| ≥ 9 | SHORT | thesis_reviewer → bei Freigabe: auto_open sofort |
| ≥ 9 | LONG | thesis_reviewer → bei Freigabe: auto_open sofort |
| 8 | beide | Monitoring-only — kein auto_open |
| ≤ 7 | beide | Kein Signal |

**Score 8 darf KEIN auto_open auslösen** — diese Regel hat Vorrang vor allem anderen.

## Thesis-Fenster

| Entry-Typ | Fenster |
|-----------|---------|
| heatmap_short_squeeze | 5 Tage |
| catalyst_event | 14 Tage |
| smc_detector (Score 9) | 7 Tage |
| level_entry | 10 Tage |

Nach Ablauf ohne ausreichenden Move (|pnl_pct| < 4%): `thesis_expired_stagnant` → Close.

## Risk/Reward — Pflicht vor Entry

- Minimum: 1:2 (verliere $10, gewinne $20)
- Sweet Spot: 1:2 bis 1:3
- Unter 1:1.5: kein Trade, auch bei sauberem Setup
- Nächste S/R-Zone muss mindestens 1–2% entfernt sein ("room to breathe")

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

Grund: Liquidationspreis ≈ 1/Leverage × Preis. Bei 10% SL + 10x → Liquidation bei exakt SL.

## Portfolio Policy

- Max 5 gleichzeitige Positionen
- Cash-Floor: 20% des NAV (engine-enforced)
- Keine Positionen im gleichen Sektor wenn bereits eine offen (Korrelationsrisiko)

## Stop-Loss Platzierung

Nach Bootcamp-Regel:
- **Breakout-Trade**: SL über/unter Breakout-Candle. Hat sie keinen Docht: Candle davor verwenden.
- **OB-Trade**: SL unter/über den gesamten Order Block (Candle inkl. Wick)
- **Retest-Trade**: SL unter/über die ursprüngliche Breakout-Zone

## Ceiling8-Block

Nach einem Direction-Flip-Exit: 14-Tage-Block für dasselbe Symbol.  
Ausnahme: Score ≥ 9 kann Ceiling8-Block überschreiben (Bypass aktiv).

## Position-Sizing

Virtual Portfolio: 1000 EUR gesamt.  
Typische Position: 20–30% des freien Cash (nicht des NAV).  
Niemals Gesamtkapital in eine Position.

## Was NICHT tun

- Pre-Market oder Off-Hours-Preis für `manual_open` verwenden — immer letzten Cache-Close
- Microcap-Crypto ohne starken Catalyst oder Mindestvolumen ~$5M (kein spekulativer Entry)
- Stocks scannen oder handeln (nur Crypto SMC)
- OpenInsider-Bot jetzt implementieren (für eigenständigen späteren Bot vorgemerkt)
