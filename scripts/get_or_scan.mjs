/**
 * get_or_scan.mjs — Freshness-gate wrapper for headless agent.
 *
 * Outputs slim scan JSON to stdout:
 *   - If a _slim.json exists < FRESHNESS_MINS old → reads and outputs it (no scan.mjs run)
 *   - Otherwise → runs scan.mjs and passes through its stdout
 *
 * Usage:  node get_or_scan.mjs
 * Stdout: slim scan JSON (identical format to scan.mjs slim output)
 * Stderr: freshness decision + age for diagnostics (safe to ignore)
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR   = join(__dirname, '../trading/logs');
const SCAN_MJS   = join(__dirname, 'scan.mjs');
const FRESH_MINS = 30;

function findLatestSlim() {
  try {
    const files = readdirSync(LOGS_DIR)
      .filter(f => /^run_\d{4}-\d{2}-\d{2}_\d{4}_slim\.json$/.test(f))
      .sort()
      .reverse();
    return files.length ? join(LOGS_DIR, files[0]) : null;
  } catch {
    return null;
  }
}

const latestSlim = findLatestSlim();

if (latestSlim) {
  const ageMins = (Date.now() - statSync(latestSlim).mtimeMs) / 60_000;
  if (ageMins < FRESH_MINS) {
    process.stderr.write(`[get_or_scan] FRESH (${ageMins.toFixed(1)}min) — using ${latestSlim}\n`);
    process.stdout.write(readFileSync(latestSlim, 'utf8'));
    process.exit(0);
  }
  process.stderr.write(`[get_or_scan] STALE (${ageMins.toFixed(1)}min) — running scan.mjs\n`);
} else {
  process.stderr.write('[get_or_scan] NO_SLIM — running scan.mjs\n');
}

// Fall-through: run full scan
try {
  const out = execFileSync('node', [SCAN_MJS], { maxBuffer: 20 * 1024 * 1024 });
  process.stdout.write(out);
} catch (e) {
  process.stderr.write(`[get_or_scan] scan.mjs failed: ${e.message}\n`);
  process.exit(1);
}
