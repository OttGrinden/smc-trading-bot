#!/usr/bin/env node
/**
 * soak_report — read-only soak-run observer (Unit 27 observability).
 *
 * Reads local store records + live_order_events.jsonl for a given CID prefix and
 * produces a structured report: per-order current state, full broker-event timeline,
 * and open questions for the subsequent portfolio-booking phase.
 *
 * ZERO writes. ZERO broker calls. ZERO portfolio mutation. Purely local file reads.
 *
 * CID prefixes used by the pipeline:
 *   dispatch_v1   — orders placed via order_dispatch (--exec-dispatch / paper_pass_dev)
 *   protect_v1    — protective-exit stop orders (--exec-protective-exit / protective_exit_pass_dev)
 *
 * Args (CLI):
 *   --cid-prefix <prefix>   filter events + records by this prefix (required)
 *
 * Output:
 *   stdout  — machine-readable JSON report
 *   stderr  — human-readable timeline summary
 *
 * Exit: 0 ok · 2 missing/invalid args · 1 store read error (fail-closed)
 *
 * Injectable for offline tests:
 *   opts._listAll(...)          — replaces store.listAll
 *   opts._getEventsLogPath(...) — replaces store.getEventsLogPath
 */

import { fileURLToPath }             from 'url';
import { readFileSync, existsSync }  from 'fs';
import { listAll, getEventsLogPath } from './order_store.mjs';

const CID_PREFIX_RE = /^[A-Za-z0-9_-]+$/;

function cliFlag(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}

/**
 * buildSoakReport — assemble a structured run report for the given CID prefix.
 *
 * @param {string} cidPrefix — filter prefix for client_order_ids
 * @param {object} [opts]
 * @param {Function} [opts._listAll]          — injectable: replaces store.listAll
 * @param {Function} [opts._getEventsLogPath] — injectable: replaces store.getEventsLogPath
 * @returns {object} report { cid_prefix, generated_at, records_matched, events_matched,
 *                            orders: [...], open_questions: [...] }
 * @throws {Error} on invalid prefix or corrupt store (fail-closed)
 */
export function buildSoakReport(cidPrefix, opts = {}) {
  if (typeof cidPrefix !== 'string' || !cidPrefix || !CID_PREFIX_RE.test(cidPrefix)) {
    throw new Error(
      `soak_report: --cid-prefix must be non-empty and match [A-Za-z0-9_-]: ${JSON.stringify(cidPrefix)}`
    );
  }

  const doListAll       = typeof opts._listAll === 'function' ? opts._listAll : listAll;
  const doEventsLogPath = typeof opts._getEventsLogPath === 'function' ? opts._getEventsLogPath : getEventsLogPath;

  // 1. Load store records (fail-closed on corrupt)
  let allRecords;
  try { allRecords = doListAll(); }
  catch (e) { throw new Error(`soak_report: store read failed (fail-closed): ${e.message}`); }

  const records = allRecords.filter(
    r => typeof r.client_order_id === 'string' && r.client_order_id.startsWith(cidPrefix)
  );

  // 2. Read events log (fail-soft: missing = no events)
  const eventsLogPath = doEventsLogPath();
  const matchedEvents = [];
  if (existsSync(eventsLogPath)) {
    const raw = readFileSync(eventsLogPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        if (typeof ev.client_order_id === 'string' && ev.client_order_id.startsWith(cidPrefix)) {
          matchedEvents.push(ev);
        }
      } catch { /* skip corrupt lines — never abort a read-only observer */ }
    }
  }

  // 3. Group by CID (records are primary; events can surface CIDs whose records were removed)
  const byCid = {};
  for (const rec of records) {
    byCid[rec.client_order_id] = { record: rec, events: [] };
  }
  for (const ev of matchedEvents) {
    const cid = ev.client_order_id;
    if (!byCid[cid]) byCid[cid] = { record: null, events: [] };
    byCid[cid].events.push(ev);
  }

  // 4. Build per-order views + derive open questions for portfolio booking
  const openQuestions = [];
  const orders = Object.keys(byCid).sort().map(cid => {
    const { record: rec, events } = byCid[cid];
    const sortedEvents = [...events].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));

    if (rec?.state === 'filled') {
      openQuestions.push({
        cid, question: 'filled_not_yet_booked',
        filled_qty: rec.filled_qty ?? null, avg_fill_price: rec.avg_fill_price ?? null,
      });
    }
    if (rec?.state === 'partially_filled') {
      openQuestions.push({ cid, question: 'partial_fill_pending', filled_qty: rec.filled_qty ?? null });
    }
    if (rec?.reconcile_flag) {
      openQuestions.push({ cid, question: 'reconcile_flag_set', flag: rec.reconcile_flag, state: rec.state ?? null });
    }
    if (rec?.state === 'submit_unknown' || rec?.state === 'reconcile_hold') {
      openQuestions.push({ cid, question: 'order_needs_manual_review', state: rec.state });
    }
    if (rec == null && events.length > 0) {
      openQuestions.push({ cid, question: 'events_without_record', note: 'record removed (cleanup?), events remain' });
    }

    return {
      client_order_id: cid,
      state:           rec?.state               ?? null,
      broker_order_id: rec?.broker_order_id     ?? null,
      symbol:          rec?.symbol              ?? null,
      side:            rec?.side                ?? null,
      order_action:    rec?.order_action        ?? null,
      order_type:      rec?.order_type          ?? null,
      qty:             rec?.qty                 ?? null,
      filled_qty:      rec?.filled_qty          ?? null,
      avg_fill_price:  rec?.avg_fill_price      ?? null,
      reconcile_flag:  rec?.reconcile_flag      ?? null,
      created_at:      rec?.created_at          ?? null,
      terminal_at:     rec?.terminal_at         ?? null,
      // Strip client_order_id from individual events (redundant in grouped view)
      events: sortedEvents.map(({ client_order_id: _cid, ...rest }) => rest),
    };
  });

  return {
    cid_prefix:       cidPrefix,
    generated_at:     new Date().toISOString(),
    records_matched:  records.length,
    events_matched:   matchedEvents.length,
    orders,
    open_questions:   openQuestions,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv      = process.argv.slice(2);
  const cidPrefix = cliFlag(argv, '--cid-prefix');

  if (!cidPrefix) {
    process.stderr.write(JSON.stringify({
      ok: false, exit_code: 2, error: { reason: 'missing_args', detail: '--cid-prefix <prefix> is required' }
    }) + '\n');
    process.exit(2);
  }

  let report;
  try {
    report = buildSoakReport(cidPrefix);
  } catch (e) {
    process.stderr.write(JSON.stringify({
      ok: false, exit_code: 1, error: { reason: 'report_failed', detail: e.message }
    }) + '\n');
    process.exit(1);
  }

  // Machine-readable: stdout JSON
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  // Human-readable: stderr timeline summary
  process.stderr.write(`\n=== Soak Report — prefix: ${cidPrefix} ===\n`);
  process.stderr.write(`Generated: ${report.generated_at}\n`);
  process.stderr.write(`Matched:   ${report.records_matched} record(s), ${report.events_matched} event(s)\n\n`);

  for (const o of report.orders) {
    const stateLabel = o.state ?? '(no record)';
    process.stderr.write(`  ${o.client_order_id}\n`);
    process.stderr.write(`    state:       ${stateLabel}\n`);
    process.stderr.write(`    broker_id:   ${o.broker_order_id ?? '—'}\n`);
    process.stderr.write(`    symbol/side: ${o.symbol ?? '—'} ${o.side ?? ''} ${o.order_type ?? ''}\n`);
    process.stderr.write(`    qty/fill:    qty=${o.qty ?? '—'} filled=${o.filled_qty ?? 0} @${o.avg_fill_price ?? 'n/a'}\n`);
    process.stderr.write(`    events (${o.events.length}):\n`);
    for (const ev of o.events) {
      process.stderr.write(`      [${ev.ts ?? '?'}] ${ev.type}\n`);
    }
    process.stderr.write('\n');
  }

  if (report.open_questions.length > 0) {
    process.stderr.write(`Open questions for portfolio booking (${report.open_questions.length}):\n`);
    for (const q of report.open_questions) {
      const detail = q.flag ? ` flag=${q.flag}` : q.state ? ` state=${q.state}` : '';
      process.stderr.write(`  ! ${q.cid}: ${q.question}${detail}\n`);
    }
  } else {
    process.stderr.write('No open questions.\n');
  }
}
