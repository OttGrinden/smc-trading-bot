# SMC Trading Bot

Automated crypto trading system using Smart Money Concepts (SMC) + liquidity heatmap signals.

## Supported Exchange
- **Bitunix Futures** (live trading via API)
- Paper/simulation mode (default, no API keys needed)

## Quick Start

### 1. Clone & Install
```bash
git clone https://github.com/OttGrinden/smc-trading-bot.git
cd smc-trading-bot
cd scripts && npm install && cd ..
```

### 2. Configure
```bash
cp .env.example .env
# Edit .env and fill in your Bitunix API key + secret
```

### 3. Run a scan (paper mode — no live trading)
```bash
node scripts/paper_runbook.mjs --run-scan
```

### 4. Enable live Bitunix trading
Add to your `.env`:
```
BROKER_EXEC=bitunix_futures
```
Then run scans normally — the engine will execute real orders when signals qualify.

## How it Works

The scan pipeline runs every 15 minutes (set up a cron job or run manually):

```
paper_runbook.mjs
  └── smc_scan.mjs
        ├── ohlcv_fetcher.mjs      — OHLCV data (Bitunix)
        ├── positioning_fetcher.mjs — Funding rates / OI
        ├── liq_heatmap.mjs        — Liquidity wall detection
        ├── level_entry.py         — 882/LSOB limit order entries
        ├── regime_filter.py       — Market regime gate (GREEN/RED)
        ├── smc_detector.py        — SMC structure signals
        ├── macro_trader.mjs       — BTC/ETH macro scoring
        ├── thesis_expiry_check.mjs — Position expiry management
        └── heatmap_trader.mjs     — Heatmap-based trade execution
```

## Signals

A trade opens when ALL conditions are met:
- **Regime**: GREEN (FNG 10–80, ATR ≥ 1.5% — FNG < 10 = extreme panic, > 80 = extreme greed)
- **Heatmap**: buy/sell ratio ≥ 1.15 with buy wall within 0.5%
- **Portfolio**: < 5 open positions, symbol not blocked, cash floor > 20%

## SMC Scoring (G1–G7, max 10 pts)
| Gate | Criterion | Points |
|------|-----------|--------|
| G1 | BOS confirmed in trade direction | +2 |
| G2 | EMA200 confirmed (long: price above / short: below) | +1 |
| G3 | Liquidity sweep / IDM identified | +2 |
| G4 | Order Block drawn | +2 |
| G5 | Price returns to OB | +1 |
| G6 | Candlestick confirmation | +1 |
| G7 | R/R ≥ 1:2 | +1 |

| Score | Action |
|-------|--------|
| ≥ 9 | Auto-open after thesis_reviewer approval |
| 8 | Monitoring only — no auto-open |
| ≤ 7 | No signal |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BITUNIX_API_KEY` | For live trading | Bitunix Futures API key |
| `BITUNIX_SECRET_KEY` | For live trading | Bitunix Futures secret key |
| `BROKER_EXEC` | No | Set to `bitunix_futures` to enable live orders |
| `DISCORD_WEBHOOK_URL` | No | Discord notification webhook |

## License
MIT
