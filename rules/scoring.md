# SMC Scoring Rules

Basiert auf Smart Money Concepts Bootcamp (April 2024) + System-Kalibrierung.

## Kern-Konzepte

### Marktstruktur
- **BOS (Break of Structure)**: Candle-Body schließt über letztes Swing-High (bullish) oder unter letztes Swing-Low (bearish)
- **CHoCH (Change of Character)**: Erster Gegentrend-BOS — Warnsignal, kein Reversal-Bestätigung
- **MSS (Market Structure Shift)**: Zweiter BOS in Gegenrichtung — bestätigt Trendwechsel
- **Swing-Bestätigung**: Mindestens 2 Gegenrichtungs-Candles (oder 1 sehr große Candle)

### Liquidität
- **Buy-Side Liquidity**: Liegt über Swing-Highs (Stop-Losses der Shorts + Long-Limit-Orders)
- **Sell-Side Liquidity**: Liegt unter Swing-Lows (Stop-Losses der Longs + Short-Limit-Orders)
- **Liquidity Sweep**: Wick oder Body schließt über/unter einen Swing-Level → Liquidität wird abgeholt

### Order Block (OB)
- Letzte bearishe Candle vor einem bullischen Impulsmove (Bullish OB)
- Letzte bullishe Candle vor einem bearischen Impulsmove (Bearish OB)
- Preis kehrt zum OB zurück → potenzielle Entry-Zone
- **Invalidierung**: Preis schließt vollständig durch den OB

### Fair Value Gap (FVG)
- 3-Candle-Pattern: Lücke zwischen Wick der Candle davor und Wick der Candle danach
- Bessere **Take-Profit-Ziele** als Entry-Zonen (Preis schließt FVGs häufiger als er darin kehrt)
- Ziel: Mitte des FVG (konservativ) oder Ende (aggressiv)

## Score-Gate-Hierarchie (1–10)

| Gate | Kriterium | Punkte |
|------|-----------|--------|
| G1 | BOS-Richtung bestätigt (letzter BOS = Handelsrichtung) | +2 |
| G2 | EMA200 bestätigt (Long: Preis über EMA200 / Short: unter EMA200) | +1 |
| G3 | Liquidity Sweep identifiziert (IDM: Inducement-Level wurde genommen) | +2 |
| G4 | Order Block gezeichnet (letzte Candle vor Impulse) | +2 |
| G5 | Preis kehrt zum OB zurück (innerhalb der Zone) | +1 |
| G6 | Candlestick-Bestätigung (Advancing Wicks / 3-Line Strike / Hammer / Engulfing) | +1 |
| G7 | R/R ≥ 1:2 (nächste S/R-Level erlaubt mind. 1:2 bis Ziel) | +1 |

**Score ≥ 9** → Auto-Open nach thesis_reviewer-Freigabe  
**Score = 8** → Monitoring-only (kein Auto-Open)  
**Score ≤ 7** → Kein Signal

## EMA-Regeln (21 / 50 / 200)

- **Uptrend**: EMA21 > EMA50 > EMA200, aufgefächert nach oben
- **Downtrend**: EMA21 < EMA50 < EMA200, aufgefächert nach unten
- **Konsolidierung**: EMAs eng zusammen → schlechte Handelszeit, Whipsaw-Risiko
- In Uptrend: EMA21/50 = dynamischer Support
- In Downtrend: EMA21/50 = dynamischer Widerstand
- **Golden Cross** (EMA50 kreuzt EMA200 nach oben) = zu träge für Entry, besser: Close über EMA200

## Candlestick-Bestätigungen

**Bullish:**
- Advancing Wicks: Jeder Wick höher als vorheriger (sauberste Form)
- Hammer: Langer unterer Docht, kleiner Body oben
- 3-Line Strike: 3 bearishe Candles + 1 große bullishe die alle 3 schließt
- Morning Star: 3-Candle-Pattern (bearish → Doji/Spinning → bullish)
- Bullish Engulfing: Bullishe Candle umschließt vorherige bearishe komplett

**Bearish (Reverse):**
- Retracing Wicks, Shooting Star, 3-Line Strike bearish, Evening Star, Bearish Engulfing

## Room to Breathe — Pflichtcheck

Vor jedem Entry: Gibt es zwischen Entry und Target eine S/R-Zone?  
→ **Ja, zu nahe** (< 0.5% Distanz): Skip  
→ **Nein, freier Raum**: Valid

Minimum Swing-Größe für Entry: 1–2% Preis-Move zwischen Entry und nächstem Ziel.  
Unter 1% ist zu eng — zu viel Noise, zu wenig Edge.

## Macro-Filter

- **Regime = bull**: Nur LONG-Setups handeln (level_entry SHORT wird unterdrückt)
- **Regime = bear**: Nur SHORT-Setups handeln (level_entry LONG wird unterdrückt)
- **Regime = neutral/unbekannt**: Fail-open — beide Richtungen erlaubt

## Konfikt-Filter

Wenn SMC-Detector LONG Score ≥ 8 und level_entry SHORT für dasselbe Symbol:  
→ level_entry-Signal wird unterdrückt (SMC-Detector ist präziser: BOS + IDM + EMA200)
