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
- **Regime**: GREEN (FNG 30-74, ATR < 4%)
- **Heatmap**: buy/sell ratio >= 1.15 with buy wall >= ~$3M within 0.5%
- **Portfolio**: < 5 open positions, symbol not blocked, cash floor > 20%

## Scoring (1-10)
| Score | Condition | Action |
|-------|-----------|--------|
| 10 | K=ja + RSI checked + Fib in zone | Auto-open, 10x leverage, SL 2% |
| 9  | K=ja + RSI checked | Auto-open, 8x leverage, SL 2.5% |
| 8  | K=ja OR T_stark | Auto-open, 6x leverage, SL 3.3% |
| 6-7 | Partial | Watchlist only |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BITUNIX_API_KEY` | For live trading | Bitunix Futures API key |
| `BITUNIX_SECRET_KEY` | For live trading | Bitunix Futures secret key |
| `BROKER_EXEC` | No | Set to `bitunix_futures` to enable live orders |
| `DISCORD_WEBHOOK_URL` | No | Discord notification webhook |

## License
MIT
