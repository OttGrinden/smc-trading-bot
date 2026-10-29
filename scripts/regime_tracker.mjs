#!/usr/bin/env node
/**
 * regime_tracker.mjs — ETH Intraday Regime State Machine
 *
 * States:
 *   active         — LONG-Entries erlaubt
 *   watching       — Bearish-Bedingung erkannt, Timer läuft
 *   bearish_locked — Bearish seit >= LOCK_MINS → LONG-Entries blockiert
 *
 * Trigger:   RSI1h < 45 UND trend_1h = 'bearish'
 * Lock nach: 120 min kontinuierlich
 * Release:   trend_1h != 'bearish' ODER RSI1h >= 50
 * MTF null:  State unverändert beibehalten (kein false release)
 *
 * Output: intraday_regime.json
 * Stdout: nur bei watching/locked (silent bei active)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const MTF_PATH    = join(TRADING_DIR, 'cache', 'mtf_context.json');
const REGIME_PATH = join(TRADING_DIR, 'cache', 'intraday_regime.json');

const SYMBOL              = 'ETH';
const BEARISH_RSI_TRIGGER = 45;    // RSI1h unter diesem Wert → bearish condition
const RELEASE_RSI         = 50;    // RSI1h Recovery-Schwelle
const LOCK_MINS           = 120;   // nach X min kontinuierlich bearish → Lock

function loadMTF() {
  if (!existsSync(MTF_PATH)) return null;
  try {
    const d       = JSON.parse(readFileSync(MTF_PATH, 'utf8'));
    const ageMins = (Date.now() - new Date(d.computed_at).getTime()) / 60_000;
    return ageMins <= 15 ? d : null;
  } catch { return null; }
}

function loadRegime() {
  if (!existsSync(REGIME_PATH)) return null;
  try { return JSON.parse(readFileSync(REGIME_PATH, 'utf8')); } catch { return null; }
}

function run() {
  const now  = Date.now();
  const mtf  = loadMTF();
  const prev = loadRegime();

  const regime = prev ?? {
    symbol:        SYMBOL,
    state:         'active',
    bearish_since: null,
    lock_reason:   null,
    last_rsi_1h:   null,
    last_trend_1h: null,
    updated_at:    new Date(now).toISOString(),
  };

  // MTF nicht verfügbar → State einfrieren, kein false release
  if (!mtf) {
    regime.updated_at = new Date(now).toISOString();
    writeFileSync(REGIME_PATH, JSON.stringify(regime, null, 2) + '\n', 'utf8');
    process.stderr.write(JSON.stringify({ info: 'regime_done', symbol: SYMBOL, state: regime.state, note: 'mtf_unavailable' }) + '\n');
    return;
  }

  const symCtx  = mtf.symbols?.[SYMBOL];
  const rsi1h   = symCtx?.rsi_1h   ?? null;
  const trend1h = symCtx?.trend_1h ?? null;

  const isBearish = rsi1h !== null && rsi1h < BEARISH_RSI_TRIGGER && trend1h === 'bearish';
  const isRelease = trend1h !== 'bearish' || (rsi1h !== null && rsi1h >= RELEASE_RSI);

  const prevState = regime.state;

  if (isRelease) {
    regime.state        = 'active';
    regime.bearish_since = null;
    regime.lock_reason  = null;
  } else if (isBearish) {
    if (!regime.bearish_since) {
      regime.bearish_since = new Date(now).toISOString();
      regime.state         = 'watching';
    } else {
      const watchMins = (now - new Date(regime.bearish_since).getTime()) / 60_000;
      regime.state = watchMins >= LOCK_MINS ? 'bearish_locked' : 'watching';
      if (regime.state === 'bearish_locked') {
        regime.lock_reason = `RSI1h=${rsi1h} < ${BEARISH_RSI_TRIGGER}, trend=bearish seit ${Math.round(watchMins)}min`;
      }
    }
  }

  regime.last_rsi_1h   = rsi1h;
  regime.last_trend_1h = trend1h;
  regime.updated_at    = new Date(now).toISOString();

  writeFileSync(REGIME_PATH, JSON.stringify(regime, null, 2) + '\n', 'utf8');

  // Stdout: nur bei watching/locked oder State-Wechsel (silent bei active+clean)
  const changed = prevState !== regime.state;
  if (changed || regime.state !== 'active') {
    const icon = regime.state === 'bearish_locked' ? '🔒' : regime.state === 'watching' ? '⏱' : '🔓';
    const sinceStr = regime.bearish_since ? ` seit ${regime.bearish_since.slice(11, 16)} UTC` : '';
    process.stdout.write(`${icon} Regime ${SYMBOL}: ${regime.state}  RSI1h=${rsi1h ?? '?'} trend=${trend1h ?? '?'}${sinceStr}\n`);
  }

  process.stderr.write(JSON.stringify({
    info: 'regime_done', symbol: SYMBOL,
    state: regime.state, rsi_1h: rsi1h, trend_1h: trend1h,
    bearish_since: regime.bearish_since,
  }) + '\n');
}

try { run(); } catch (e) {
  process.stderr.write(JSON.stringify({ error: 'regime_crash', detail: e.message }) + '\n');
  process.exit(1);
}
