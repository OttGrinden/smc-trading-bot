// check_scan_guard.mjs — Freshness guard helper for run_morgenscan.vbs
//
// Semantics:
//   Exit 0 = recent successful scan exists → VBS should skip (Doppel-Run guard).
//   Exit 1 = scan should run.
//
// Fail-safe contract: any unexpected state (missing file, broken JSON, missing
// finished_at, unparseable timestamp) exits 1 — run the scan rather than suppress.
// This means the guard can only cause a false-run, never a false-skip.
//
// Authority: finished_at (ISO 8601 UTC, written by scan.mjs) is the sole
// freshness source. File mtime (DateLastModified) is NOT used.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const STATUS_PATH  = join(TRADING_DIR, 'logs', 'last_scan_status.json');
const FRESH_MAX_MS = 30 * 60 * 1000; // 30 min — high-frequency scheduler mode

try {
  const raw = readFileSync(STATUS_PATH, 'utf8');
  const s   = JSON.parse(raw);

  if (s.status !== 'ok') process.exit(1);  // failed / unknown → run
  if (!s.finished_at)    process.exit(1);  // missing timestamp → run

  const finished = new Date(s.finished_at);
  if (Number.isNaN(finished.getTime())) process.exit(1); // unparseable → run

  const stale = (Date.now() - finished.getTime()) > FRESH_MAX_MS;
  process.exit(stale ? 1 : 0);
} catch {
  process.exit(1); // file missing / broken JSON / any I/O error → run
}
