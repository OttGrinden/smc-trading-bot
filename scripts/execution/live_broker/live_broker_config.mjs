/**
 * Live Broker Config
 *
 * Parses and validates broker mode / provider configuration.
 *
 * Safe default: broker_mode='off' — no live connectivity of any kind.
 * Live connectivity requires an explicit opt-in.
 *
 * CLI flags (consistent with scan.mjs conventions):
 *   --broker-mode  off | live_readonly       default: 'off'
 *   --broker-provider  alpaca                default: null
 *
 * Credentials MUST come from environment variables, never CLI arguments.
 * Required env vars when provider=alpaca:
 *   ALPACA_KEY_ID        — Alpaca API Key ID (read-only scoped keys recommended)
 *   ALPACA_SECRET_KEY    — Alpaca API Secret Key
 *
 * Optional env vars when provider=alpaca:
 *   ALPACA_PAPER=true    — use paper endpoint (default: true = SAFE)
 *                          set to 'false' only if connecting to a live account
 *   ALPACA_BASE_URL      — override broker API base URL (default derived from ALPACA_PAPER)
 *   ALPACA_DATA_URL      — override data API base URL (default: https://data.alpaca.markets)
 *
 * Fail-fast: invalid mode/provider throws immediately (caught by scan.mjs → stderr + exit 2).
 * Missing credentials when live_readonly is requested → throws (exit 2).
 *
 * Usage (module):
 *   import { parseBrokerConfig, BROKER_MODES } from './live_broker_config.mjs'
 */

export const BROKER_MODES = Object.freeze({
  OFF:           'off',
  LIVE_READONLY: 'live_readonly',
});

export const SUPPORTED_PROVIDERS = Object.freeze(['alpaca']);

const ALPACA_PAPER_URL  = 'https://paper-api.alpaca.markets';
const ALPACA_LIVE_URL   = 'https://api.alpaca.markets';
const ALPACA_DATA_URL   = 'https://data.alpaca.markets';

/**
 * parseBrokerConfig — parse CLI args + env into a validated broker config.
 *
 * @param {string[]} cliArgs — process.argv slice
 * @param {object}   env     — process.env or subset
 * @returns {Readonly<object>} — validated broker config
 * @throws {Error}            — on invalid mode/provider or missing required credentials
 */
export function parseBrokerConfig(cliArgs = [], env = {}) {
  function flag(name) {
    const idx = cliArgs.indexOf(name);
    return idx !== -1 && cliArgs[idx + 1] !== undefined ? cliArgs[idx + 1] : null;
  }

  // ── Mode ─────────────────────────────────────────────────────────────────
  const rawMode    = flag('--broker-mode')     ?? env.BROKER_MODE     ?? BROKER_MODES.OFF;
  const rawProvider= flag('--broker-provider') ?? env.BROKER_PROVIDER ?? null;

  if (!Object.values(BROKER_MODES).includes(rawMode)) {
    throw new Error(
      `Invalid --broker-mode: "${rawMode}". Supported: ${Object.values(BROKER_MODES).join(' | ')}.`
    );
  }

  const broker_mode = rawMode;

  // ── Provider validation ───────────────────────────────────────────────────
  if (broker_mode === BROKER_MODES.LIVE_READONLY) {
    if (!rawProvider) {
      throw new Error(
        `--broker-provider is required when --broker-mode live_readonly. ` +
        `Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}.`
      );
    }
    if (!SUPPORTED_PROVIDERS.includes(rawProvider)) {
      throw new Error(
        `Unsupported --broker-provider: "${rawProvider}". ` +
        `Supported: ${SUPPORTED_PROVIDERS.join(', ')}.`
      );
    }
  }

  const broker_provider = rawProvider;

  // ── Alpaca credentials ────────────────────────────────────────────────────
  let alpaca = null;
  if (broker_provider === 'alpaca') {
    const key_id     = env.ALPACA_KEY_ID     ?? null;
    const secret_key = env.ALPACA_SECRET_KEY ?? null;

    if (broker_mode === BROKER_MODES.LIVE_READONLY && (!key_id || !secret_key)) {
      const missing = [];
      if (!key_id)     missing.push('ALPACA_KEY_ID');
      if (!secret_key) missing.push('ALPACA_SECRET_KEY');
      throw new Error(
        `Missing required env var(s) for Alpaca provider: ${missing.join(', ')}. ` +
        `Set these before using --broker-mode live_readonly.`
      );
    }

    const paper    = env.ALPACA_PAPER !== 'false';   // default: true (safe)
    const base_url = env.ALPACA_BASE_URL ?? (paper ? ALPACA_PAPER_URL : ALPACA_LIVE_URL);
    const data_url = env.ALPACA_DATA_URL ?? ALPACA_DATA_URL;

    alpaca = Object.freeze({
      key_id,
      secret_key,
      paper,
      base_url,
      data_url,
      credentials_present: !!(key_id && secret_key),
    });
  }

  return Object.freeze({
    broker_mode,
    broker_provider,
    alpaca,
  });
}

/** Shorthand: is live_readonly mode active? */
export function liveBrokerEnabled(config) {
  return config?.broker_mode === BROKER_MODES.LIVE_READONLY;
}

// ─── Phase 1: write-capable broker-execution guard (fail-closed, default OFF) ──
//
// This is a SEPARATE, opt-in guard for the future write path (alpaca_paper).
// Step 1 only defines the guard — nothing is activated and no submit code exists.
// It is intentionally NOT wired into scan.mjs yet (later steps consume it).
//
// Hard guarantees:
//   - Default OFF → the existing sim path stays the default; nothing changes.
//   - Explicit opt-in required: --broker-exec alpaca_paper (or BROKER_EXEC=alpaca_paper).
//   - Paper-only: refuses ALPACA_PAPER=false and any non-paper base_url (fail-closed).
//   - Any missing/contradictory config throws — never a permissive fallback.
//   - The live endpoint is therefore technically unreachable in this phase.

export const BROKER_EXEC_MODES = Object.freeze({
  OFF:             'off',
  ALPACA_PAPER:    'alpaca_paper',
  BITUNIX_FUTURES: 'bitunix_futures',
});

/**
 * parseBrokerExecConfig — validate the write-path execution config (fail-closed).
 *
 * @param {string[]} cliArgs — process.argv slice
 * @param {object}   env     — process.env or subset
 * @returns {Readonly<object>} — { enabled, mode, ... } ; enabled=false when OFF
 * @throws {Error} on invalid mode, missing credentials, non-paper, or contradictory config
 */
export function parseBrokerExecConfig(cliArgs = [], env = {}) {
  function flag(name) {
    const idx = cliArgs.indexOf(name);
    return idx !== -1 && cliArgs[idx + 1] !== undefined ? cliArgs[idx + 1] : null;
  }

  const rawMode = flag('--broker-exec') ?? env.BROKER_EXEC ?? BROKER_EXEC_MODES.OFF;

  if (!Object.values(BROKER_EXEC_MODES).includes(rawMode)) {
    throw new Error(
      `Invalid --broker-exec: "${rawMode}". Supported: ${Object.values(BROKER_EXEC_MODES).join(' | ')}.`
    );
  }

  // Default OFF → sim path remains default; nothing activated, no validation needed.
  if (rawMode === BROKER_EXEC_MODES.OFF) {
    return Object.freeze({ enabled: false, mode: BROKER_EXEC_MODES.OFF });
  }

  // bitunix_futures → real Bitunix Futures API (no paper mode; use small sizes for safety).
  if (rawMode === BROKER_EXEC_MODES.BITUNIX_FUTURES) {
    const api_key    = env.BITUNIX_API_KEY    ?? null;
    const secret_key = env.BITUNIX_SECRET_KEY ?? null;
    if (!api_key || !secret_key) {
      const missing = [];
      if (!api_key)    missing.push('BITUNIX_API_KEY');
      if (!secret_key) missing.push('BITUNIX_SECRET_KEY');
      throw new Error(
        `--broker-exec bitunix_futures requires env var(s): ${missing.join(', ')}. ` +
        `Set these before enabling the Bitunix futures write path.`
      );
    }
    const BITUNIX_FUTURES_URL = 'https://fapi.bitunix.com';
    return Object.freeze({
      enabled:             true,
      mode:                BROKER_EXEC_MODES.BITUNIX_FUTURES,
      base_url:            env.BITUNIX_BASE_URL ?? BITUNIX_FUTURES_URL,
      api_key,
      secret_key,
      credentials_present: true,
    });
  }

  // alpaca_paper → fail-closed paper-only guard.
  const key_id     = env.ALPACA_KEY_ID     ?? null;
  const secret_key = env.ALPACA_SECRET_KEY ?? null;
  if (!key_id || !secret_key) {
    const missing = [];
    if (!key_id)     missing.push('ALPACA_KEY_ID');
    if (!secret_key) missing.push('ALPACA_SECRET_KEY');
    throw new Error(
      `--broker-exec alpaca_paper requires env var(s): ${missing.join(', ')}. ` +
      `Set these before enabling the paper write path.`
    );
  }
  // Paper-only hard guard: ALPACA_PAPER=false is refused (no live in this phase).
  if (env.ALPACA_PAPER === 'false') {
    throw new Error(
      `--broker-exec alpaca_paper refuses ALPACA_PAPER=false — the live endpoint is ` +
      `not permitted in this phase (fail-closed).`
    );
  }
  // Base URL must resolve to the paper endpoint; any non-paper override is refused.
  const base_url = env.ALPACA_BASE_URL ?? ALPACA_PAPER_URL;
  if (base_url !== ALPACA_PAPER_URL) {
    throw new Error(
      `--broker-exec alpaca_paper refuses non-paper base_url "${base_url}" — ` +
      `only ${ALPACA_PAPER_URL} is permitted (fail-closed).`
    );
  }

  return Object.freeze({
    enabled:             true,
    mode:                BROKER_EXEC_MODES.ALPACA_PAPER,
    paper:               true,
    base_url,                                          // guaranteed paper endpoint
    data_url:            env.ALPACA_DATA_URL ?? ALPACA_DATA_URL,
    key_id,
    secret_key,
    credentials_present: true,
  });
}

/** Shorthand: is any write-path broker active? */
export function brokerExecEnabled(config) {
  return config?.enabled === true && (
    config?.mode === BROKER_EXEC_MODES.ALPACA_PAPER ||
    config?.mode === BROKER_EXEC_MODES.BITUNIX_FUTURES
  );
}

/** Shorthand: is the Bitunix futures write path active? */
export function bitunixExecEnabled(config) {
  return config?.enabled === true && config?.mode === BROKER_EXEC_MODES.BITUNIX_FUTURES;
}
