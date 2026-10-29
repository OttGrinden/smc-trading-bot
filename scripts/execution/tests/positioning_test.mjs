#!/usr/bin/env node
/**
 * Positioning-Enrichment — offline tests (POS-01 … POS-07).
 * Keine Netzwerk-Calls: pure Funktionen + Cache-Roundtrip.
 *
 * node scripts/execution/tests/positioning_test.mjs
 * Exit 0 = all PASS. Exit 1 = mindestens ein FAIL.
 */

import { readFileSync, writeFileSync } from 'fs';
import {
  buildPositioningSummary, assessSqueezeRisk,
  readPositioning, writePositioning,
} from '../../positioning_fetcher.mjs';
import { readIndicatorCache } from '../../indicator_cache.mjs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', '..', '..', 'trading');

const CACHE = join(TRADING_DIR, 'cache', 'positioning_data.json');

let pass = 0, fail = 0;
function check(id, cond, msg) {
  cond ? pass++ : fail++;
  process.stderr.write(`  ${cond ? 'PASS' : 'FAIL'}  ${id}: ${msg}\n`);
}

// POS-01: long_squeeze_risk bei crowded long + erhöhtem Funding
check('POS-01', assessSqueezeRisk({ long_short_ratio: 2.5, funding_rate: 0.0008 }) === 'long_squeeze_risk',
  'L/S 2.5 + Fund 0.08% → long_squeeze_risk');

// POS-02: short_squeeze_risk bei crowded short + negativem Funding
check('POS-02', assessSqueezeRisk({ long_short_ratio: 0.4, funding_rate: -0.0008 }) === 'short_squeeze_risk',
  'L/S 0.4 + Fund −0.08% → short_squeeze_risk');

// POS-03: crowded long, aber Funding unter Schwelle → kein Flag
check('POS-03', assessSqueezeRisk({ long_short_ratio: 2.5, funding_rate: 0.0001 }) === null,
  'crowded aber Funding niedrig → null');

// POS-04: fehlende Inputs → null
check('POS-04', assessSqueezeRisk({ long_short_ratio: null, funding_rate: 0.001 }) === null,
  'fehlende Ratio → null');

// POS-05: Summary-Format (tabellenfertig, deterministisch)
const s = buildPositioningSummary({
  long_short_ratio: 2.31, long_account_pct: 0.698,
  funding_rate: 0.00012, oi_usd: 31.2e9, oi_change_24h_pct: -4.1,
});
check('POS-05', s === 'L/S 2.31 (70% long) · Fund +0.0120% · OI $31.2B (-4.1%/24h) · balanced',
  `Summary: ${s}`);

// POS-06: Cache-Roundtrip + indicator_cache.json bleibt unberührt (getrennte Caches)
const tvProbe  = 'SILVER';
const tvBefore = JSON.stringify(readIndicatorCache(tvProbe));
writePositioning('TESTPOS', { funding_rate: 0.001, long_short_ratio: 2.2, summary: 'test' });
const r       = readPositioning('TESTPOS');
const tvAfter = JSON.stringify(readIndicatorCache(tvProbe));
check('POS-06', r.available === true && r.long_short_ratio === 2.2 && tvBefore === tvAfter,
  'Roundtrip ok, indicator_cache.json unverändert');

// POS-07: Staleness — Eintrag älter als 90 min → stale
{
  const c = JSON.parse(readFileSync(CACHE, 'utf8'));
  c.TESTPOS.positioning_at = new Date(Date.now() - 91 * 60_000).toISOString();
  writeFileSync(CACHE, JSON.stringify(c, null, 2) + '\n');
  const stale = readPositioning('TESTPOS');
  check('POS-07', stale.available === false && stale.reason === 'stale', '91 min alt → stale');
  delete c.TESTPOS;
  writeFileSync(CACHE, JSON.stringify(c, null, 2) + '\n');
}

process.stderr.write(`\npositioning_test: ${pass}/${pass + fail} PASS\n`);
process.exit(fail > 0 ? 1 : 0);
