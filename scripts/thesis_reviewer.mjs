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
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';

// Global circuit breaker: file exists → all reviewer API calls skipped until a successful call clears it.
const AUTH_BLOCK_PATH = join(homedir(), '.claude', 'trading', 'logs', 'reviewer_auth_block.json');

function resolveCredentials() {
  if (process.env.ANTHROPIC_API_KEY) return { apiKey: process.env.ANTHROPIC_API_KEY };
  try {
    const creds = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
    const token = creds?.claudeAiOauth?.accessToken;
    if (token) return { authToken: token };
  } catch { /* ignore */ }
  return {};
}

function isAuthBlocked() {
  return existsSync(AUTH_BLOCK_PATH);
}

function writeAuthBlock(errMsg) {
  try {
    writeFileSync(AUTH_BLOCK_PATH, JSON.stringify({ ts: new Date().toISOString(), error: errMsg }), 'utf8');
  } catch { /* non-fatal */ }
}

function clearAuthBlock() {
  try { if (existsSync(AUTH_BLOCK_PATH)) unlinkSync(AUTH_BLOCK_PATH); } catch { /* non-fatal */ }
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
const SYSTEM = `You are a binary trade-gatekeeper for a crypto SMC (Smart Money Concepts) strategy.
Given technical signal data and orderbook context, respond ONLY with a single JSON object on one line:
{"approved":bool,"confidence":1-10,"reason":"max 15 words"}

CRITICAL DISTINCTION — read carefully:
- BUY wall  = bid-side liquidity (demand) = price SUPPORT
- SELL wall = ask-side liquidity (supply) = price RESISTANCE

For LONG entries:
  SELL wall ABOVE entry = resistance the price must overcome → evaluate size/distance
  BUY wall at/below entry = support/demand = POSITIVE, NEVER a rejection reason
  A large buy wall at entry for a LONG = strong institutional demand behind the trade → lean APPROVE

For SHORT entries (mirror logic):
  BUY wall BELOW entry = support the price must break → evaluate size/distance
  SELL wall at/above entry = overhead supply = POSITIVE, NEVER a rejection reason

SELL wall rules (for LONG):
- Notional < $500k → easily swept, not structural → APPROVE
- Notional > $3M AND within 1% of entry AND TP cannot clear it → REJECT
- Notional > $3M but TP target is above/clear of the wall → short-squeeze setup → APPROVE

G7 / R:R gate (structural, not contextual):
- If the signal explicitly states G7=False or RR < 1.5 → REJECT (insufficient reward)
- RR 1.5–2.0 = marginal, only approve if wall context is clearly supportive
- RR ≥ 2.0 = meets minimum, evaluate normally

Funding rate:
- neutral (< 0.05%/8h absolute) or unknown = no veto
- extreme (> 0.08%/8h) AND against trade direction = REJECT

Default bias: APPROVE unless a HIGH-notional SELL wall (for LONG) or BUY wall (for SHORT)
structurally blocks the TP path, OR G7=False/RR < 1.5.`;

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
  // Global circuit breaker: skip if any previous auth failure is on record
  if (isAuthBlocked()) {
    const result = { approved: false, confidence: 1, reason: 'auth_circuit_open', symbol, score, reviewer_calls: 0, input_tokens: null, output_tokens: null };
    process.stderr.write(JSON.stringify({ warn: 'thesis_reviewer_auth_blocked', symbol }) + '\n');
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  const client = new Anthropic(resolveCredentials());
  try {
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 150,
      system:     SYSTEM,
      messages:   [{ role: 'user', content: USER }],
    });

    // Successful call — clear any stale auth block
    clearAuthBlock();

    const raw = msg.content?.[0]?.text?.trim() ?? '';
    const inputTokens  = msg.usage?.input_tokens  ?? null;
    const outputTokens = msg.usage?.output_tokens ?? null;

    // Extract JSON — handle markdown fences or extra text
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (!jsonMatch) throw new Error(`no JSON in response: ${raw.slice(0, 100)}`);

    const parsed = JSON.parse(jsonMatch[0]);
    const result = {
      approved:       Boolean(parsed.approved),
      confidence:     Number(parsed.confidence ?? 5),
      reason:         String(parsed.reason ?? '').slice(0, 80),
      symbol,
      score,
      reviewer_calls: 1,
      input_tokens:   inputTokens,
      output_tokens:  outputTokens,
    };
    process.stderr.write(JSON.stringify({ info: 'thesis_reviewer_result', ...result }) + '\n');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    const isAuth = /auth|unauthorized|401|403|invalid.*key|oauth/i.test(err.message ?? '');
    if (isAuth) {
      writeAuthBlock(err.message?.slice(0, 120) ?? 'unknown');
      process.stderr.write(JSON.stringify({ warn: 'thesis_reviewer_auth_error_blocked', error: err.message, symbol }) + '\n');
    } else {
      process.stderr.write(JSON.stringify({ warn: 'thesis_reviewer_api_error', error: err.message, symbol }) + '\n');
    }
    const result = {
      approved: false, confidence: 1,
      reason: `${isAuth ? 'auth_error' : 'api_error'}: ${err.message?.slice(0, 50) ?? 'unknown'}`,
      symbol, score, reviewer_calls: 1, input_tokens: null, output_tokens: null,
    };
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

await review();
