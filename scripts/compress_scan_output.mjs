/**
 * Lightweight scan output compressor — strips internal/debug fields Claude doesn't need.
 * Reduces run JSON by ~55% while keeping all fields required for scoring and output.
 *
 * Fields KEPT (all required for Claude scoring/output):
 *   symbol, category, sector, direction, change_pct, price_usd, volume_usd, rank
 *   risk.{risk_level, suggested_position_pct, stop_loss_pct}
 *   technical.{available, rsi, age_minutes, summary}
 *   technical.fib.{available, in_zone, zone_summary}
 *   score_bounds.{floor, ceiling, t_stark, leverage_at_ceiling, sl_pct_at_ceiling}
 *   portfolio_marks, btc_positioning, pinned_watchlist.{pinned, in_candidates, available}
 *   meta, run_at, run_id, catalyst_upcoming
 *
 * Usage: pipe scan output through this before logging to context
 *   node scan.mjs | node compress_scan_output.mjs
 * Or call compressScanOutput(obj) from any script.
 */

// Keys always stripped regardless of nesting depth
const STRIP_KEYS = new Set([
  // timestamps (in run JSON, age_minutes is the relevant indicator — not raw ISO strings)
  'fetched_at', 'updated_at', 'catalyst_recognized_at',
  'thesis_last_reviewed_at', 'mark_updated_at', 'blocked_at',
  'entry_timestamp',
  // internal execution metadata
  'tags', 'order_id', 'entry_run_id', 'decision_source',
  'sizing_constraint', 'conviction_override_applied',
  'is_notable', 'error',
  // candidate display name — symbol is sufficient for all scoring/output rules
  'name',
  // pre-research sort score — output.md: Claude determines final score via research, NOT from JSON
  'score',
  // technical indicators already baked into technical.summary string
  'rsi_weekly', 'rsi_monthly', 'macd_hist', 'macd_signal',
  // internal T★ computation detail — result already in score_bounds.t_stark
  't_stark_score',
]);

// Keys stripped only when parent key is 'fib'
const FIB_STRIP_KEYS = new Set([
  'direction',          // redundant with candidate direction
  'swing_high', 'swing_low', 'range', 'lookback',  // internal calc inputs
  'levels',             // raw fib_382/500/618 prices — not used in output
  'current_price',      // same as price_usd
  'nearest_level_name', 'nearest_level_price', 'dist_pct',  // all in zone_summary
  'tolerance_pct',      // internal threshold
]);

// Keys stripped only when parent key is 'technical'
const TECHNICAL_STRIP_KEYS = new Set([
  't_stark',         // redundant with score_bounds.t_stark
  't_stark_signals', // internal array, usually empty
]);

// Keys stripped only when parent key is 'risk'
const RISK_STRIP_KEYS = new Set([
  'composite', // internal numeric score, not used in output or scoring rules
  'flags',     // informational tags; not referenced in scoring/execution logic
]);

function compress(obj, parentKey = null) {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const arr = obj.map(v => compress(v, null)).filter(v => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (STRIP_KEYS.has(k)) continue;
      if (parentKey === 'fib'       && FIB_STRIP_KEYS.has(k))       continue;
      if (parentKey === 'technical' && TECHNICAL_STRIP_KEYS.has(k)) continue;
      if (parentKey === 'risk'      && RISK_STRIP_KEYS.has(k))      continue;
      if (v === null || v === '') continue;
      // Note: do NOT skip `false` — boolean flags like in_zone, available carry meaning
      // shorten age_minutes to 1 decimal
      if (k === 'age_minutes' && typeof v === 'number') { out[k] = +v.toFixed(1); continue; }
      // truncate reason strings
      if (k === 'reason' && typeof v === 'string' && v.length > 60) { out[k] = v.slice(0, 60); continue; }
      const c = compress(v, k);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return obj;
}

export function compressScanOutput(raw) {
  const compressed = compress(raw);
  const rawSize  = JSON.stringify(raw).length;
  const compSize = JSON.stringify(compressed).length;
  const saved    = (((rawSize - compSize) / rawSize) * 100).toFixed(1);
  process.stderr.write(JSON.stringify({
    info:             'compress_scan_output',
    raw_bytes:        rawSize,
    compressed_bytes: compSize,
    saved_pct:        saved + '%',
  }) + '\n');
  return compressed;
}

// CLI mode: read stdin, compress, write stdout
if (process.stdin.isTTY === false) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => buf += d);
  process.stdin.on('end', () => {
    try {
      const lines    = buf.trim().split('\n');
      const jsonLine = [...lines].reverse().find(l => l.startsWith('{'));
      if (!jsonLine) { process.stdout.write(buf); return; }
      const raw        = JSON.parse(jsonLine);
      const compressed = compressScanOutput(raw);
      process.stdout.write(JSON.stringify(compressed, null, 2) + '\n');
    } catch {
      process.stdout.write(buf);
    }
  });
}
