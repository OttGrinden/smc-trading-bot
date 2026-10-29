#!/usr/bin/env node
/**
 * outcome_analytics.mjs — Trade Outcome Analytics + Learning Engine
 *
 * Liest trade_ledger.jsonl + cross-referenziert Entry-Run-Logs.
 * Ausgabe: Win-Rate, P&L, Erwartungswert nach Dimension.
 *
 * Mit --save-learning: schreibt learning_state.json + Memory-Dateien
 * für Muster mit ausreichender statistischer Basis.
 *
 * Usage:
 *   node outcome_analytics.mjs                      # all-time, Text-Report
 *   node outcome_analytics.mjs --days 30            # letzte 30 Tage
 *   node outcome_analytics.mjs --json               # JSON-Output
 *   node outcome_analytics.mjs --trades             # Einzeltrades anzeigen
 *   node outcome_analytics.mjs --save-learning      # + learning_state.json + Memories
 *   node outcome_analytics.mjs --save-learning --quiet  # kein Text-Report, nur Dateien
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath }                            from 'url';
import { join, dirname, resolve }                   from 'path';
const _d = dirname(fileURLToPath(import.meta.url));
const TRADING_DIR = resolve(_d, '..', 'trading');

const LEDGER_PATH         = join(TRADING_DIR, 'execution', 'portfolio', 'trade_ledger.jsonl');
const LOGS_DIR            = join(TRADING_DIR, 'logs');
const LEARNING_STATE_PATH = join(TRADING_DIR, 'cache', 'learning_state.json');
const MEMORY_DIR          = null; /* memory dir not applicable in portable repo — set via env MEMORY_DIR if needed */
const MEMORY_INDEX        = MEMORY_DIR ? join(MEMORY_DIR, 'MEMORY.md') : null;

// Confidence-Schwellen (Anzahl echter Trades: Wins + Losses, keine Flats)
const CONF_EMERGING    = 3;   // 3–5 Trades  → learning_state, kein Memory
const CONF_DEVELOPING  = 6;   // 6–14 Trades → learning_state + Memory schreiben
const CONF_ESTABLISHED = 15;  // 15+ Trades  → learning_state + Memory + CLAUDE.md-Hinweis

// Close-Gründe ohne echten Trade-Charakter (Noise, Tests, Artefakte)
const EXCLUDED_REASONS = new Set([
  'no_mark_price',
  'smoke_test_dry_run',
  'smoke_test_check_no_mark',
  'mechanical_fill_no_policy_basis',
  'test_cleanup',
  'thesis_invalid_reopened',
]);

function isExcluded(e) {
  if (!e.reason) return true;
  if (EXCLUDED_REASONS.has(e.reason)) return true;
  if (e.run_id?.startsWith('test') || e.entry_run_id?.startsWith('test')) return true;
  if (e.reason.startsWith('smoke_test') || e.reason.startsWith('test_')) return true;
  // direction_flip ohne PnL = Engine-Artefakt aus der alten Logik
  if (e.reason === 'direction_flip' && !e.realized_pnl_eur) return true;
  return false;
}

// ─── CLI-Parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const daysIdx = argv.indexOf('--days');
  return {
    days:       daysIdx !== -1 && argv[daysIdx + 1] ? parseInt(argv[daysIdx + 1], 10) : null,
    json:       argv.includes('--json'),
    showTrades: argv.includes('--trades'),
    saveLearning: argv.includes('--save-learning'),
    quiet:      argv.includes('--quiet'),
  };
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, 'utf8')
    .trim().split('\n')
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const _logCache = {};
function loadRunLog(runId) {
  if (!runId) return null;
  if (_logCache[runId] !== undefined) return _logCache[runId];
  const p = join(LOGS_DIR, `${runId}.json`);
  if (!existsSync(p)) { _logCache[runId] = null; return null; }
  try { _logCache[runId] = JSON.parse(readFileSync(p, 'utf8')); }
  catch { _logCache[runId] = null; }
  return _logCache[runId];
}

function findCandidate(log, symbol, side) {
  if (!log) return null;
  const dir = side === 'long' ? 'LONG' : 'SHORT';
  const pool = [
    ...(log.long_candidates  || []),
    ...(log.short_candidates || []),
    ...(log.pinned_watchlist || []),
  ];
  return pool.find(c => c.symbol?.toUpperCase() === symbol?.toUpperCase() && c.direction === dir) ?? null;
}

// ─── Stats Accumulator ────────────────────────────────────────────────────────

function makeAcc() {
  return { wins: 0, losses: 0, flat: 0, pnl: 0, pnl_wins: 0, pnl_losses: 0, count: 0 };
}

function addTrade(acc, pnl) {
  acc.count++;
  acc.pnl += pnl;
  if      (pnl >  0.001) { acc.wins++;   acc.pnl_wins   += pnl; }
  else if (pnl < -0.001) { acc.losses++; acc.pnl_losses += pnl; }
  else                   { acc.flat++; }
}

function computeStats(acc) {
  const real  = acc.wins + acc.losses;
  const wr    = real   > 0 ? +(acc.wins / real * 100).toFixed(1)           : null;
  const avgW  = acc.wins   > 0 ? +(acc.pnl_wins   / acc.wins).toFixed(2)   : null;
  const avgL  = acc.losses > 0 ? +(acc.pnl_losses / acc.losses).toFixed(2) : null;
  let exp = null;
  if (acc.wins > 0 && acc.losses > 0) {
    exp = +((avgW * (acc.wins / real)) + (avgL * (acc.losses / real))).toFixed(2);
  }
  return { count: acc.count, wins: acc.wins, losses: acc.losses, flat: acc.flat,
           win_rate_pct: wr, pnl_eur: +acc.pnl.toFixed(2),
           avg_win_eur: avgW, avg_loss_eur: avgL, expectancy_eur: exp };
}

// ─── Classifier Helpers ───────────────────────────────────────────────────────

function reasonCategory(reason) {
  if (!reason) return 'unknown';
  if (reason === 'stop_loss_hit')          return 'SL-hit';
  if (reason.startsWith('profit_take'))    return 'profit-take';
  if (reason.startsWith('sl_proximity'))   return 'SL-proximity';
  if (reason.startsWith('thesis_invalid')) return 'thesis-invalidated';
  if (reason.startsWith('de-risk'))        return 'de-risk';
  if (reason.startsWith('direction_flip')) return 'direction-flip';
  if (reason.startsWith('entry_quality'))  return 'entry-quality-fail';
  return 'other';
}

function rsiBucket(rsi, side) {
  if (rsi == null) return '(RSI unbekannt)';
  if (side === 'long') {
    if (rsi <= 30) return 'LONG RSI≤30  ✓ ideal';
    if (rsi <= 40) return 'LONG RSI 31–40  ✓ ok';
    if (rsi <= 50) return 'LONG RSI 41–50  ~ neutral';
    return             'LONG RSI>50  ✗ nicht oversold';
  } else {
    if (rsi >= 70) return 'SHORT RSI≥70  ✓ ideal';
    if (rsi >= 60) return 'SHORT RSI 60–69  ✓ ok';
    if (rsi >= 50) return 'SHORT RSI 50–59  ~ neutral';
    return             'SHORT RSI<50  ✗ nicht overbought';
  }
}

function confidence(realTradeCount) {
  if (realTradeCount >= CONF_ESTABLISHED) return 'established';
  if (realTradeCount >= CONF_DEVELOPING)  return 'developing';
  if (realTradeCount >= CONF_EMERGING)    return 'emerging';
  return 'insufficient';
}

// ─── Pattern Detection ───────────────────────────────────────────────────────
//
// Jedes Pattern braucht:
//   id          — eindeutiger Schlüssel (Dateiname-sicher)
//   label       — kurze Beschreibung (Memory-Titel)
//   description — vollständige Beschreibung (Memory-Body)
//   confidence  — 'emerging' | 'developing' | 'established'
//   trade_count — Trades die das Muster stützen
//   data        — Rohdaten für Nachvollziehbarkeit
//   recommendation — was sich daraus ergibt
//   severity    — 'info' | 'warning' | 'critical'
//   write_memory — true wenn confidence >= developing
//
// Thresholds sind bewusst konservativ um False Positives zu vermeiden.
// ─────────────────────────────────────────────────────────────────────────────

function detectPatterns(result) {
  const patterns = [];
  const warnings = [];
  const notes    = [];

  const s       = result.overall;
  const bySide  = result.by_side;
  const byRsn   = result.by_close_reason;
  const byRisk  = result.by_risk_level;
  const byRsi   = result.by_rsi_bucket;
  const bySec   = result.by_sector;

  // ── 1. Side-Asymmetrie (Short vs Long) ────────────────────────────────────
  const shortS = bySide.short;
  const longS  = bySide.long;
  if (shortS && longS) {
    const shortReal = shortS.wins + shortS.losses;
    const longReal  = longS.wins  + longS.losses;
    if (shortReal >= 5 && longReal >= 5) {
      const sWr = shortS.win_rate_pct ?? 0;
      const lWr = longS.win_rate_pct  ?? 0;
      const diff = sWr - lWr;
      if (Math.abs(diff) >= 10) {
        const betterSide = diff > 0 ? 'SHORT' : 'LONG';
        const worseSide  = diff > 0 ? 'LONG'  : 'SHORT';
        const worse      = diff > 0 ? longS   : shortS;
        const better     = diff > 0 ? shortS  : longS;
        const totalReal  = shortReal + longReal;
        const conf       = confidence(totalReal);
        patterns.push({
          id:           'side_asymmetry',
          label:        `${betterSide} outperforms ${worseSide}`,
          description:  `${betterSide} WR ${better.win_rate_pct}% (Exp ${better.expectancy_eur ?? '—'} EUR/Trade) vs ${worseSide} WR ${worse.win_rate_pct}% (Exp ${worse.expectancy_eur ?? '—'} EUR/Trade) — Asymmetrie ${Math.abs(diff).toFixed(1)}pp über ${totalReal} Trades`,
          confidence:   conf,
          trade_count:  totalReal,
          data:         { short_wr: sWr, long_wr: lWr, short_exp: shortS.expectancy_eur, long_exp: longS.expectancy_eur, short_real: shortReal, long_real: longReal },
          recommendation: `Qualitätshürde für ${worseSide}-Einsteige erhöhen (Score-Minimum oder zusätzliche K-Bestätigung); ${betterSide}-Kandidaten bevorzugen bei gleichem Score`,
          severity:     Math.abs(diff) >= 20 ? 'critical' : 'warning',
          write_memory: conf !== 'insufficient' && conf !== 'emerging',
        });
        notes.push(`${betterSide}-Seite hat Exp ${better.expectancy_eur ?? '—'} EUR/Trade, ${worseSide}-Seite ${worse.expectancy_eur ?? '—'} EUR/Trade — ${betterSide} bevorzugen`);
      }
    }
  }

  // ── 2. SL-Hit-Drain ───────────────────────────────────────────────────────
  const slHits = byRsn['SL-hit'];
  if (slHits && slHits.count >= 5) {
    const slPct   = +(slHits.count / s.count * 100).toFixed(1);
    const lossShare = s.losses > 0 ? +(slHits.losses / s.losses * 100).toFixed(1) : 0;
    const conf    = confidence(slHits.count);
    patterns.push({
      id:           'sl_drain',
      label:        'SL-Hits dominieren Verluste',
      description:  `${slHits.count} SL-Hits (${slPct}% aller Trades, ${lossShare}% aller Verluste): ${slHits.pnl_eur} EUR. Profit-Takes: ${byRsn['profit-take']?.count ?? 0} Trades, ${byRsn['profit-take']?.pnl_eur ?? 0} EUR`,
      confidence:   conf,
      trade_count:  slHits.count,
      data:         { sl_count: slHits.count, sl_pct: slPct, loss_share_pct: lossShare, sl_pnl: slHits.pnl_eur, profit_take_pnl: byRsn['profit-take']?.pnl_eur ?? 0 },
      recommendation: 'SL-Abstände oder Positionsgrößen anpassen. Verhältnis Profit-Take zu SL-Hit auswerten — manuelle Exits funktionieren besser als SL-Automata',
      severity:     slPct >= 50 ? 'critical' : 'warning',
      write_memory: conf !== 'insufficient' && conf !== 'emerging',
    });
    notes.push(`SL-Hits: ${slHits.count} Trades, ${slHits.pnl_eur} EUR. Profit-Takes: ${byRsn['profit-take']?.pnl_eur ?? 0} EUR — manuelle Exits besser als Auto-SL`);
  }

  // ── 3. Manuelle Exits konsistent profitabel ────────────────────────────────
  const ptS = byRsn['profit-take'];
  if (ptS && ptS.count >= 3 && (ptS.win_rate_pct ?? 0) >= 80) {
    const conf = confidence(ptS.count);
    patterns.push({
      id:           'manual_exits_profitable',
      label:        'Manuelle Profit-Takes profitabel',
      description:  `${ptS.count} Profit-Take-Exits: WR ${ptS.win_rate_pct}%, Exp ${ptS.expectancy_eur ?? '—'} EUR/Trade, Gesamt ${ptS.pnl_eur} EUR`,
      confidence:   conf,
      trade_count:  ptS.count,
      data:         { count: ptS.count, wr: ptS.win_rate_pct, pnl: ptS.pnl_eur },
      recommendation: 'Manuelle Exits bei technischer Erschöpfung (RSI-Überdehnung, MACD-Flip) beibehalten — diese Exits liefern den Edge',
      severity:     'info',
      write_memory: conf !== 'insufficient' && conf !== 'emerging',
    });
  }

  // ── 4. RSI-Inversion bei LONG-Einsteigen ──────────────────────────────────
  // Sammle RSI ≤40 (bestätigt) vs RSI >50 (nicht oversold)
  const lRsiConf = { wins: 0, losses: 0, pnl: 0 };
  const lRsiBad  = { wins: 0, losses: 0, pnl: 0 };
  for (const [bkt, st] of Object.entries(byRsi)) {
    if (!bkt.startsWith('LONG')) continue;
    const target = (bkt.includes('≤30') || bkt.includes('31–40')) ? lRsiConf : lRsiBad;
    target.wins   += st.wins;
    target.losses += st.losses;
    target.pnl    += st.pnl_eur;
  }
  const lConfReal = lRsiConf.wins + lRsiConf.losses;
  const lBadReal  = lRsiBad.wins  + lRsiBad.losses;
  if (lConfReal >= 3 && lBadReal >= 3) {
    const confWr = +(lRsiConf.wins / lConfReal * 100).toFixed(1);
    const badWr  = +(lRsiBad.wins  / lBadReal  * 100).toFixed(1);
    // Inversion: RSI-bestätigte Longs performen schlechter als unbestätigte
    if (badWr > confWr + 10) {
      const totalReal = lConfReal + lBadReal;
      const conf = confidence(totalReal);
      patterns.push({
        id:           'rsi_inversion_long',
        label:        'RSI-bestätigte Long-Einsteige underperformen',
        description:  `LONG RSI≤40 WR ${confWr}% (${lConfReal} Trades) vs LONG RSI>50 WR ${badWr}% (${lBadReal} Trades) — RSI-Bestätigung verbessert Long-Ergebnis nicht`,
        confidence:   conf,
        trade_count:  totalReal,
        data:         { rsi_confirmed_wr: confWr, rsi_unconfirmed_wr: badWr, confirmed_trades: lConfReal, unconfirmed_trades: lBadReal },
        recommendation: 'RSI-Schwelle für LONG überprüfen — evtl. RSI ≤50 statt ≤40 als Einstiegszone; oder Fib-Level als zusätzlichen Filter einsetzen',
        severity:     'info',
        write_memory: conf !== 'insufficient' && conf !== 'emerging',
      });
      notes.push(`RSI-Inversion LONG: RSI≤40 WR ${confWr}% schlechter als RSI>50 WR ${badWr}% — RSI-Schwelle überprüfen`);
    }
  }

  // ── 5. RSI-Inversion bei SHORT-Einsteigen ─────────────────────────────────
  const sRsiConf = { wins: 0, losses: 0, pnl: 0 };
  const sRsiBad  = { wins: 0, losses: 0, pnl: 0 };
  for (const [bkt, st] of Object.entries(byRsi)) {
    if (!bkt.startsWith('SHORT')) continue;
    const target = (bkt.includes('≥70') || bkt.includes('60–69')) ? sRsiConf : sRsiBad;
    target.wins   += st.wins;
    target.losses += st.losses;
    target.pnl    += st.pnl_eur;
  }
  const sConfReal = sRsiConf.wins + sRsiConf.losses;
  const sBadReal  = sRsiBad.wins  + sRsiBad.losses;
  if (sConfReal >= 3 && sBadReal >= 3) {
    const confWr = +(sRsiConf.wins / sConfReal * 100).toFixed(1);
    const badWr  = +(sRsiBad.wins  / sBadReal  * 100).toFixed(1);
    if (badWr > confWr + 10) {
      const totalReal = sConfReal + sBadReal;
      const conf = confidence(totalReal);
      patterns.push({
        id:           'rsi_inversion_short',
        label:        'RSI-bestätigte Short-Einsteige underperformen',
        description:  `SHORT RSI≥60 WR ${confWr}% (${sConfReal} Trades) vs SHORT RSI<50 WR ${badWr}% (${sBadReal} Trades) — RSI-Bestätigung verbessert Short-Ergebnis nicht`,
        confidence:   conf,
        trade_count:  totalReal,
        data:         { rsi_confirmed_wr: confWr, rsi_unconfirmed_wr: badWr, confirmed_trades: sConfReal, unconfirmed_trades: sBadReal },
        recommendation: 'RSI-Schwelle für SHORT überprüfen — Katalysator (K) und Fib-Level könnten RSI als primären Filter ersetzen',
        severity:     'info',
        write_memory: conf !== 'insufficient' && conf !== 'emerging',
      });
    }
  }

  // ── 6. Schwache Sektoren ──────────────────────────────────────────────────
  const weakSectors = [];
  for (const [sector, st] of Object.entries(bySec)) {
    if (sector === '—') continue;
    const real = st.wins + st.losses;
    if (real >= 3 && (st.win_rate_pct ?? 100) === 0) {
      weakSectors.push({ sector, real, pnl: st.pnl_eur });
    }
  }
  if (weakSectors.length > 0) {
    const totalReal = weakSectors.reduce((s, x) => s + x.real, 0);
    const conf = confidence(totalReal);
    patterns.push({
      id:           'sector_weak',
      label:        `Schwache Sektoren: ${weakSectors.map(s => s.sector).join(', ')}`,
      description:  `WR 0% in: ${weakSectors.map(s => `${s.sector} (${s.real} Trades, ${s.pnl} EUR)`).join('; ')}`,
      confidence:   conf,
      trade_count:  totalReal,
      data:         { sectors: weakSectors },
      recommendation: `Kandidaten aus ${weakSectors.map(s => s.sector).join(', ')} kritisch prüfen oder vorübergehend meiden`,
      severity:     'warning',
      write_memory: conf !== 'insufficient' && conf !== 'emerging',
    });
    notes.push(`Schwache Sektoren (WR 0%): ${weakSectors.map(s => s.sector).join(', ')} — erhöhte Vorsicht`);
  }

  // ── 7. Starke Sektoren ────────────────────────────────────────────────────
  const strongSectors = [];
  for (const [sector, st] of Object.entries(bySec)) {
    if (sector === '—') continue;
    const real = st.wins + st.losses;
    if (real >= 4 && (st.win_rate_pct ?? 0) >= 40 && (st.expectancy_eur ?? 0) > 0) {
      strongSectors.push({ sector, real, wr: st.win_rate_pct, exp: st.expectancy_eur });
    }
  }
  if (strongSectors.length > 0) {
    const totalReal = strongSectors.reduce((s, x) => s + x.real, 0);
    const conf = confidence(totalReal);
    patterns.push({
      id:           'sector_strong',
      label:        `Starke Sektoren: ${strongSectors.map(s => s.sector).join(', ')}`,
      description:  `Positive Expectancy in: ${strongSectors.map(s => `${s.sector} WR ${s.wr}%, Exp ${s.exp} EUR/Trade (${s.real} Trades)`).join('; ')}`,
      confidence:   conf,
      trade_count:  totalReal,
      data:         { sectors: strongSectors },
      recommendation: `Kandidaten aus ${strongSectors.map(s => s.sector).join(', ')} bei sonst gleichem Score bevorzugen`,
      severity:     'info',
      write_memory: conf !== 'insufficient' && conf !== 'emerging',
    });
    notes.push(`Starke Sektoren: ${strongSectors.map(s => `${s.sector} Exp +${s.exp} EUR/Trade`).join(', ')}`);
  }

  // ── 8. Negatives Gesamt-Expectancy ────────────────────────────────────────
  if (s.expectancy_eur !== null && s.expectancy_eur < -2 && s.count >= 10) {
    warnings.push({
      id:       'negative_expectancy',
      severity: s.expectancy_eur < -5 ? 'critical' : 'warning',
      message:  `Negatives System-Expectancy: ${s.expectancy_eur} EUR/Trade über ${s.count} Trades — System verliert im Schnitt Geld pro Trade`,
      data:     { expectancy: s.expectancy_eur, trades: s.count, pnl: s.pnl_eur },
      recommendation: 'Entry-Qualität erhöhen (Score-Minimum, K-Anforderung) oder SL-Strategie überarbeiten',
    });
    notes.push(`⚠ Negatives Expectancy: ${s.expectancy_eur} EUR/Trade — Einstiegsqualität überprüfen`);
  }

  // ── 9. Positives Gesamt-Expectancy ───────────────────────────────────────
  if (s.expectancy_eur !== null && s.expectancy_eur > 2 && s.count >= 10) {
    notes.push(`✓ Positives System-Expectancy: +${s.expectancy_eur} EUR/Trade (${s.count} Trades)`);
  }

  // ── 10. R=LOW underperformt wider Erwarten ────────────────────────────────
  const lowRisk = byRisk['LOW'];
  if (lowRisk) {
    const lowReal = lowRisk.wins + lowRisk.losses;
    if (lowReal >= 8 && (lowRisk.win_rate_pct ?? 0) < 30 && (lowRisk.expectancy_eur ?? 0) < -2) {
      warnings.push({
        id:       'low_risk_underperforms',
        severity: 'warning',
        message:  `R=LOW WR ${lowRisk.win_rate_pct}%, Exp ${lowRisk.expectancy_eur} EUR/Trade (${lowReal} Trades) — selbst "sichere" Kandidaten verlieren`,
        data:     { wr: lowRisk.win_rate_pct, exp: lowRisk.expectancy_eur, trades: lowReal },
        recommendation: 'Entry-Timing überprüfen — Risiko-Label allein reicht nicht, K und Fib müssen bestätigen',
      });
      notes.push(`⚠ R=LOW underperformt: WR ${lowRisk.win_rate_pct}% — Risiko-Label allein nicht ausreichend für gute Entries`);
    }
  }

  return { patterns, warnings, notes };
}

// ─── Learning State + Memory Schreiben ───────────────────────────────────────

function saveLearning(result, patterns, warnings, notes) {
  const now = new Date().toISOString();

  // 1. learning_state.json
  const state = {
    generated_at:     now,
    trades_analyzed:  result.trades_analyzed,
    meta_coverage:    result.meta_coverage,
    period:           result.period,
    score_tracking_since: '2026-07-31',
    summary: {
      overall_wr_pct:   result.overall.win_rate_pct,
      overall_exp_eur:  result.overall.expectancy_eur,
      total_pnl_eur:    result.overall.pnl_eur,
      wins:             result.overall.wins,
      losses:           result.overall.losses,
      by_side: {
        short_wr:  result.by_side.short?.win_rate_pct ?? null,
        short_exp: result.by_side.short?.expectancy_eur ?? null,
        long_wr:   result.by_side.long?.win_rate_pct ?? null,
        long_exp:  result.by_side.long?.expectancy_eur ?? null,
      },
    },
    patterns: patterns.map(p => ({
      id: p.id, label: p.label, confidence: p.confidence,
      trade_count: p.trade_count, severity: p.severity,
      description: p.description, recommendation: p.recommendation,
    })),
    warnings: warnings.map(w => ({ id: w.id, severity: w.severity, message: w.message, recommendation: w.recommendation })),
    notes_for_session: notes,
    established_patterns: patterns.filter(p => p.confidence === 'established').map(p => p.id),
  };

  writeFileSync(LEARNING_STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');

  // 2. Memory-Dateien für developing/established Patterns
  const writtenFiles = [];
  for (const p of patterns.filter(p => p.write_memory)) {
    const fileName = `trading_pattern_${p.id}.md`;
    const filePath = join(MEMORY_DIR, fileName);

    const claudeMdNote = p.confidence === 'established'
      ? `\n**CLAUDE.md-Review empfohlen:** Muster ist "established" (${p.trade_count}+ Trades) — Scoring oder Filter-Regeln könnten angepasst werden.`
      : '';

    const content = [
      `---`,
      `name: trading-pattern-${p.id}`,
      `description: ${p.label} — Muster aus Trade-Analytik (${p.trade_count} Trades, Konfidenz: ${p.confidence})`,
      `metadata:`,
      `  type: feedback`,
      `---`,
      ``,
      `${p.description}`,
      ``,
      `**Why:** Statistisch erkannt aus ${p.trade_count} Trades (Konfidenz: ${p.confidence}). Automatisch erkannt durch outcome_analytics.mjs am ${now.slice(0, 10)}.${claudeMdNote}`,
      `**How to apply:** ${p.recommendation}`,
      ``,
    ].join('\n');

    writeFileSync(filePath, content, 'utf8');
    writtenFiles.push({ fileName, filePath, pattern: p });
  }

  // 3. MEMORY.md aktualisieren
  if (writtenFiles.length > 0 && existsSync(MEMORY_INDEX)) {
    let memIndex = readFileSync(MEMORY_INDEX, 'utf8');
    let changed = false;

    for (const { fileName, pattern } of writtenFiles) {
      const lineMarker  = `](${fileName})`;
      const newLine     = `- [Trading Pattern: ${pattern.label}](${fileName}) — ${pattern.description.slice(0, 90).replace(/\n/g, ' ')}`;

      if (memIndex.includes(lineMarker)) {
        // Update existing line
        const lines = memIndex.split('\n');
        const idx   = lines.findIndex(l => l.includes(lineMarker));
        if (idx !== -1 && lines[idx] !== newLine) {
          lines[idx] = newLine;
          memIndex   = lines.join('\n');
          changed    = true;
        }
      } else {
        // Append new line (before trailing newline)
        memIndex = memIndex.trimEnd() + '\n' + newLine + '\n';
        changed  = true;
      }
    }

    if (changed) writeFileSync(MEMORY_INDEX, memIndex, 'utf8');
  }

  return { state_path: LEARNING_STATE_PATH, memories_written: writtenFiles.length };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function run(argv) {
  const { days, json, showTrades, saveLearning: doSave, quiet } = parseArgs(argv);
  const cutoff = days ? new Date(Date.now() - days * 86_400_000) : null;

  const all    = loadLedger();
  const closes = all.filter(e => e.event === 'close' && !isExcluded(e));
  const filt   = cutoff ? closes.filter(e => new Date(e.ts ?? e.timestamp) >= cutoff) : closes;

  // Enrich each close with candidate metadata from entry run log
  const trades = filt.map(c => {
    const pnl  = c.realized_pnl_eur ?? 0;
    const log  = loadRunLog(c.entry_run_id);
    const cand = findCandidate(log, c.symbol, c.side);
    return {
      ts:          c.ts ?? c.timestamp ?? '—',
      symbol:      c.symbol,
      side:        c.side,
      pnl_eur:     +pnl.toFixed(2),
      reason:      c.reason,
      reason_cat:  reasonCategory(c.reason),
      risk_level:  cand?.risk?.risk_level  ?? '—',
      rsi:         cand?.technical?.rsi    ?? null,
      sector:      cand?.sector            ?? '—',
      category:    cand?.category          ?? '—',
      fib_in_zone: cand?.technical?.fib?.in_zone ?? null,
      entry_run:   c.entry_run_id,
      meta_found:  !!cand,
    };
  });

  // Accumulators
  const overall  = makeAcc();
  const byReason = {};
  const bySide   = {};
  const byRisk   = {};
  const byRsi    = {};
  const bySector = {};
  const byCat    = {};

  for (const t of trades) {
    addTrade(overall, t.pnl_eur);
    for (const [map, key] of [
      [byReason, t.reason_cat],
      [bySide,   t.side],
      [byRisk,   t.risk_level],
      [byRsi,    rsiBucket(t.rsi, t.side)],
      [bySector, t.sector],
      [byCat,    t.category],
    ]) {
      if (!map[key]) map[key] = makeAcc();
      addTrade(map[key], t.pnl_eur);
    }
  }

  const result = {
    generated_at:    new Date().toISOString(),
    period:          days ? `last ${days} days` : 'all-time',
    trades_analyzed: trades.length,
    meta_coverage:   `${trades.filter(t => t.meta_found).length}/${trades.length} mit Run-Log`,
    overall:         computeStats(overall),
    by_close_reason: Object.fromEntries(
      Object.entries(byReason).sort((a, b) => b[1].count - a[1].count)
        .map(([k, v]) => [k, computeStats(v)])
    ),
    by_side:         Object.fromEntries(Object.entries(bySide).map(([k, v]) => [k, computeStats(v)])),
    by_risk_level:   Object.fromEntries(
      ['LOW', 'MEDIUM', 'HIGH', 'EXTREME', '—'].filter(k => byRisk[k])
        .map(k => [k, computeStats(byRisk[k])])
    ),
    by_rsi_bucket:   Object.fromEntries(
      Object.entries(byRsi).sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => [k, computeStats(v)])
    ),
    by_sector:       Object.fromEntries(
      Object.entries(bySector).sort((a, b) => b[1].count - a[1].count)
        .map(([k, v]) => [k, computeStats(v)])
    ),
    by_category:     Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, computeStats(v)])),
    trades:          showTrades ? trades : undefined,
  };

  // Pattern detection
  const { patterns, warnings, notes } = detectPatterns(result);
  result.patterns  = patterns;
  result.warnings  = warnings;

  // Save learning state + memories
  let saveResult = null;
  if (doSave) {
    saveResult = saveLearning(result, patterns, warnings, notes);
  }

  // JSON output mode
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  // Quiet mode: only print save summary
  if (quiet) {
    if (saveResult) {
      const memCount  = saveResult.memories_written;
      const patCount  = patterns.length;
      const warnCount = warnings.length;
      process.stderr.write(JSON.stringify({
        info:             'learning_saved',
        trades_analyzed:  trades.length,
        patterns_found:   patCount,
        warnings_found:   warnCount,
        memories_written: memCount,
        state_path:       saveResult.state_path,
      }) + '\n');
    }
    return;
  }

  // ─── Text Report ────────────────────────────────────────────────────────────

  const pad = (s, n) => String(s ?? '—').padStart(n);
  const row = (label, s) => {
    const wr  = s.win_rate_pct != null ? `${pad(s.win_rate_pct, 5)}%` : '     —';
    const pnl = `${pad(s.pnl_eur, 8)} EUR`;
    const exp = s.expectancy_eur != null ? `${pad(s.expectancy_eur, 7)} EUR/T` : '           —';
    const wl  = `W${pad(s.wins, 2)} L${pad(s.losses, 2)}`;
    return `  ${label.padEnd(36)}  ${wl}  WR:${wr}  PnL:${pnl}  Exp:${exp}`;
  };

  const SEP = '═'.repeat(92);

  const out = [
    '',
    SEP,
    ` Trade Outcome Analytics  ·  ${result.period}  ·  ${trades.length} Trades  ·  ${result.generated_at.slice(0, 10)}`,
    ` Meta-Coverage: ${result.meta_coverage}`,
    SEP,
    '',
    '── OVERALL ' + '─'.repeat(81),
    row('Alle Trades', result.overall),
    '',
    '── NACH CLOSE-GRUND ' + '─'.repeat(72),
    ...Object.entries(result.by_close_reason).map(([k, s]) => row(k, s)),
    '',
    '── NACH SEITE ' + '─'.repeat(78),
    ...Object.entries(result.by_side).map(([k, s]) => row(k, s)),
    '',
    '── NACH RISK-LEVEL (aus Entry-Run-Log) ' + '─'.repeat(53),
    ...Object.entries(result.by_risk_level).map(([k, s]) => row(k, s)),
    '',
    '── NACH RSI AM EINSTIEG ' + '─'.repeat(68),
    ...Object.entries(result.by_rsi_bucket).map(([k, s]) => row(k, s)),
    '',
    '── NACH SEKTOR ' + '─'.repeat(77),
    ...Object.entries(result.by_sector).map(([k, s]) => row(k, s)),
    '',
    '── NACH KATEGORIE ' + '─'.repeat(74),
    ...Object.entries(result.by_category).map(([k, s]) => row(k, s)),
  ];

  // Patterns + Warnings
  if (patterns.length > 0 || warnings.length > 0) {
    out.push('', '── ERKANNTE MUSTER ' + '─'.repeat(73));
    for (const p of patterns) {
      const conf = `[${p.confidence.toUpperCase()}]`.padEnd(14);
      const sev  = p.severity === 'critical' ? '🔴' : p.severity === 'warning' ? '🟡' : 'ℹ';
      out.push(`  ${sev} ${conf} ${p.label}`);
      out.push(`     ${p.description}`);
      out.push(`     → ${p.recommendation}`);
    }
    for (const w of warnings) {
      const sev = w.severity === 'critical' ? '🔴' : '🟡';
      out.push(`  ${sev} [WARNING]       ${w.message}`);
      out.push(`     → ${w.recommendation}`);
    }
  }

  if (saveResult) {
    out.push('', '── LEARNING ENGINE ' + '─'.repeat(73));
    out.push(`  learning_state.json geschrieben: ${saveResult.state_path}`);
    out.push(`  Memory-Dateien geschrieben: ${saveResult.memories_written}`);
    const writtenPatterns = patterns.filter(p => p.write_memory);
    for (const p of writtenPatterns) {
      out.push(`    → trading_pattern_${p.id}.md  [${p.confidence}]`);
    }
  }

  out.push(
    '',
    '── HINWEIS ' + '─'.repeat(81),
    '  Score 1–10 + Fib-Tracking aktiv ab 2026-07-31.',
    '  Pre-2026-07-31 Trades: kein score_bounds im Log (Legacy-System).',
    '  Exp = Erwartungswert pro Trade. Positiv = Edge vorhanden.',
    SEP,
    '',
  );

  if (showTrades) {
    out.push('── EINZELTRADES ' + '─'.repeat(76));
    for (const t of trades) {
      const pnl = t.pnl_eur >= 0 ? `+${t.pnl_eur}` : `${t.pnl_eur}`;
      out.push(
        `  ${t.ts.slice(0, 10)} ${t.symbol.padEnd(6)} ${t.side.padEnd(6)} ` +
        `PnL:${pad(pnl, 9)} EUR  R:${pad(t.risk_level, 7)} RSI:${pad(t.rsi?.toFixed(1) ?? '—', 5)} ` +
        `${t.reason_cat.padEnd(22)} ${t.sector}`,
      );
    }
    out.push(SEP, '');
  }

  process.stdout.write(out.join('\n') + '\n');
}

// ─── CLI Guard ────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv);
}
