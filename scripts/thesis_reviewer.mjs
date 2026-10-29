#!/usr/bin/env node
/**
 * thesis_reviewer.mjs — Phase-2 SMC Gate
 *
 * Called by scan.mjs for every SMC signal with score >= 9.
 * Reads liq_heatmap + positioning from cache, calls Claude Haiku,
 * and returns a machine-readable JSON decision.
 *
 * CLI:  node thesis_reviewer.mjs --signal '{"symbol":"BTC","score":9,...}'
 * Exit: 0 always (fail-safe: API errors => approved:false)
 * Stdout: {"approved":bool,"confidence":1-10,"reason":"<=15 words","symbol":"BTC","score":9}
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';

function resolveCredentials() {
  if (process.env.ANTHROPIC_API_KEY) return { apiKey: process.env.ANTHROPIC_API_KEY };
  try {
    const creds = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
    const token = creds?.claudeAiOauth?.accessToken;
    if (token) return { authToken: token };
  } catch { /* ignore */ }
  return {};
}

const SCRIPTS_DIR  = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR    = join(SCRIPTS_DIR, '..', 'trading', 'cache');
const LIQ_PATH     = join(CACHE_DIR, 'liq_heatmap.json');
const POS_PATH     = join(CACHE_DIR, 'positioning_data.json');

// --- CLI arg parsing ---
const args = process.argv.slice(2);
const signalIdx = args.indexOf('--signal');
if (signalIdx === -1 || !args[signalIdx + 1]) {
  process.stderr.write(JSON.stringify({ error: 'thesis_reviewer: --signal argument required' }) + '\n');
  process.stdout.write(JSON.stringify({ approved: false, confidence: 1, reason: 'missing signal argument', symbol: '?', score: 0 }) + '\n');
  process.exit(0);
}

let signal;
try {
  signal = JSON.parse(args[signalIdx + 1]);
} catch {
  process.stderr.write(JSON.stringify({ error: 'thesis_reviewer: invalid JSON in --signal' }) + '\n');
  process.stdout.write(JSON.stringify({ approved: false, confidence: 1, reason: 'invalid signal JSON', symbol: '?', score: 0 }) + '\n');
  process.exit(0);
}

const { symbol, score, side, entry_price, h1_price, idm_price, origin_price, ote_low, ote_high, reason: smcReason } = signal;

// --- Load cache data (fail-soft) ---
function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

const liqCache = loadJSON(LIQ_PATH);
const posCache = loadJSON(POS_PATH);

const liq = liqCache?.[symbol] ?? null;
const pos = posCache?.[symbol] ?? null;

// Format liq data
const nearSell = liq?.nearest_sell_wall;
const nearBuy  = liq?.nearest_buy_wall;
const sellStr  = nearSell
  ? `$${nearSell.price.toFixed(0)} (${nearSell.pct_away > 0 ? '+' : ''}${nearSell.pct_away}% away, $${(nearSell.notional_usd / 1e6).toFixed(1)}M)`
  : 'n/a';
const buyStr   = nearBuy
  ? `$${nearBuy.price.toFixed(0)} (${nearBuy.pct_away}% away, $${(nearBuy.notional_usd / 1e6).toFixed(1)}M)`
  : 'n/a';

// Format positioning data
const fundingRate   = pos?.funding_rate ?? null;
const fundingPct    = fundingRate !== null ? (fundingRate * 100).toFixed(4) : 'n/a';
const fundingLabel  = fundingRate === null ? 'unknown'
  : Math.abs(fundingRate) < 0.0002 ? 'neutral'
  : fundingRate > 0 ? 'longs-paying'
  : 'shorts-paying';
const lsRatio       = pos?.long_short_ratio != null ? String(pos.long_short_ratio) : 'n/a';

// --- Build prompt ---
const SYSTEM = `You are a binary trade-gatekeeper for a crypto SMC strategy. \
Given technical signal data, respond ONLY with a single JSON object on one line: \
{"approved":bool,"confidence":1-10,"reason":"max 15 words"}. \
Approve when: (1) nearest sell wall (LONG) or buy wall (SHORT) is at least 3% away OR \
confirms the target zone, AND (2) funding rate is neutral/beneficial (< 0.05%/8h absolute). \
Reject when: a strong liq cluster blocks the path within 2% OR funding rate is extreme (> 0.08%).`;

const direction = (side ?? 'long').toUpperCase();
const USER = `SMC Signal — ${symbol} ${direction} @ $${entry_price ?? 'n/a'}
BOS ref: $${h1_price ?? 'n/a'} | IDM swept: $${idm_price ?? 'n/a'} | Origin: $${origin_price ?? 'n/a'}
OTE zone: $${ote_low ?? 'n/a'} – $${ote_high ?? 'n/a'}
SMC score: ${score} | Reason: ${smcReason ?? 'n/a'}

Nearest sell wall: ${sellStr}
Nearest buy wall:  ${buyStr}
Funding: ${fundingPct}%/8h (${fundingLabel})
L/S ratio: ${lsRatio}

Decision for ${direction} entry?`;

// --- Call Claude Haiku ---
async function review() {
  const client = new Anthropic(resolveCredentials());
  try {
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 150,
      system:     SYSTEM,
      messages:   [{ role: 'user', content: USER }],
    });

    const raw = msg.content?.[0]?.text?.trim() ?? '';

    // Extract JSON — handle markdown fences or extra text
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (!jsonMatch) throw new Error(`no JSON in response: ${raw.slice(0, 100)}`);

    const parsed = JSON.parse(jsonMatch[0]);
    const result = {
      approved:   Boolean(parsed.approved),
      confidence: Number(parsed.confidence ?? 5),
      reason:     String(parsed.reason ?? '').slice(0, 80),
      symbol,
      score,
    };
    process.stderr.write(JSON.stringify({ info: 'thesis_reviewer_result', ...result }) + '\n');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    const result = { approved: false, confidence: 1, reason: `api_error: ${err.message?.slice(0, 60) ?? 'unknown'}`, symbol, score };
    process.stderr.write(JSON.stringify({ warn: 'thesis_reviewer_api_error', error: err.message, symbol }) + '\n');
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

await review();
