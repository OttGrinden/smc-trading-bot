/**
 * Execution Realism Config
 *
 * Parses and validates realism configuration from CLI args and environment variables.
 *
 * When realism_mode='off' (default), behavior is identical to pre-realism:
 * fills are immediate, full, and costless.
 *
 * CLI flags (--execution virtual_portfolio is still required for fills to run):
 *   --realism on|off
 *   --slippage-bps N        e.g. 5 = 0.05%
 *   --fee-bps N             e.g. 10 = 0.10%
 *   --min-fee-eur N         minimum fee floor per order, in EUR
 *   --partial-fills on|off
 *   --max-fill-fraction N   fraction filled per cycle, e.g. 0.5 = 50%
 *
 * Env vars (fallback when CLI flag absent):
 *   REALISM_MODE, SLIPPAGE_BPS, FEE_BPS, MIN_FEE_EUR, PARTIAL_FILLS, MAX_FILL_FRACTION
 *
 * Fail-fast: invalid values throw an Error — caught by scan.mjs → stderr + exit 1.
 *
 * Usage (module): import { parseRealismConfig, realismEnabled, REALISM_DEFAULTS } from './realism_config.mjs'
 */

export const REALISM_DEFAULTS = Object.freeze({
  realism_mode:                'off',  // 'off' | 'on'
  slippage_bps:                0,      // basis points >= 0  (e.g. 5 = 0.05% slippage)
  fee_bps:                     0,      // basis points >= 0  (e.g. 10 = 0.10% commission)
  minimum_fee_eur:             0,      // EUR floor per order (applied if fee_bps result is lower)
  partial_fill_mode:           'off',  // 'off' | 'on'
  max_fill_fraction_per_cycle: 1.0,    // (0, 1] — fraction filled on first cycle
});

/**
 * parseRealismConfig — parse CLI args + env vars into a validated config object.
 *
 * @param {string[]} cliArgs — process.argv slice (may contain realism flags anywhere)
 * @param {object}   env     — process.env or subset
 * @returns {Readonly<object>} — validated, frozen realism config
 */
export function parseRealismConfig(cliArgs = [], env = {}) {
  function flag(name) {
    const idx = cliArgs.indexOf(name);
    return idx !== -1 && cliArgs[idx + 1] !== undefined ? cliArgs[idx + 1] : null;
  }

  const rawMode     = flag('--realism')           ?? env.REALISM_MODE      ?? REALISM_DEFAULTS.realism_mode;
  const rawSlipBps  = flag('--slippage-bps')      ?? env.SLIPPAGE_BPS      ?? null;
  const rawFeeBps   = flag('--fee-bps')           ?? env.FEE_BPS           ?? null;
  const rawMinFee   = flag('--min-fee-eur')       ?? env.MIN_FEE_EUR       ?? null;
  const rawPartial  = flag('--partial-fills')     ?? env.PARTIAL_FILLS     ?? REALISM_DEFAULTS.partial_fill_mode;
  const rawFraction = flag('--max-fill-fraction') ?? env.MAX_FILL_FRACTION ?? null;

  // realism_mode
  if (!['on', 'off'].includes(rawMode)) {
    throw new Error(`Invalid --realism value: "${rawMode}". Use "on" or "off".`);
  }
  const realism_mode = rawMode;

  // partial_fill_mode
  if (!['on', 'off'].includes(rawPartial)) {
    throw new Error(`Invalid --partial-fills value: "${rawPartial}". Use "on" or "off".`);
  }
  const partial_fill_mode = rawPartial;

  // slippage_bps
  const slippage_bps = rawSlipBps !== null ? Number(rawSlipBps) : REALISM_DEFAULTS.slippage_bps;
  if (!Number.isFinite(slippage_bps) || slippage_bps < 0) {
    throw new Error(`Invalid --slippage-bps: "${rawSlipBps}". Must be a non-negative number.`);
  }

  // fee_bps
  const fee_bps = rawFeeBps !== null ? Number(rawFeeBps) : REALISM_DEFAULTS.fee_bps;
  if (!Number.isFinite(fee_bps) || fee_bps < 0) {
    throw new Error(`Invalid --fee-bps: "${rawFeeBps}". Must be a non-negative number.`);
  }

  // minimum_fee_eur
  const minimum_fee_eur = rawMinFee !== null ? Number(rawMinFee) : REALISM_DEFAULTS.minimum_fee_eur;
  if (!Number.isFinite(minimum_fee_eur) || minimum_fee_eur < 0) {
    throw new Error(`Invalid --min-fee-eur: "${rawMinFee}". Must be a non-negative number.`);
  }

  // max_fill_fraction_per_cycle
  const max_fill_fraction_per_cycle = rawFraction !== null
    ? Number(rawFraction)
    : REALISM_DEFAULTS.max_fill_fraction_per_cycle;
  if (
    !Number.isFinite(max_fill_fraction_per_cycle) ||
    max_fill_fraction_per_cycle <= 0 ||
    max_fill_fraction_per_cycle > 1.0
  ) {
    throw new Error(
      `Invalid --max-fill-fraction: "${rawFraction}". Must be in range (0, 1].`,
    );
  }

  return Object.freeze({
    realism_mode,
    slippage_bps,
    fee_bps,
    minimum_fee_eur,
    partial_fill_mode,
    max_fill_fraction_per_cycle,
  });
}

/** realismEnabled — shorthand check used throughout the execution layer. */
export function realismEnabled(config) {
  return config?.realism_mode === 'on';
}
