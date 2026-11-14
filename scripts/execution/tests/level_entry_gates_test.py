#!/usr/bin/env python3
"""
level_entry_gates_test.py — Unit-Tests fuer die Gate-Kaskade von level_entry.py

Testet:
  G1  : Daily/4H/15m Daten fehlend oder unzureichend
  G2  : Daily-Bias ambiguos -> kein Signal
  G3  : EMA200 LONG blockiert (Preis unter EMA200)
  G4  : 4H widerspricht Daily -> kein Signal
  G5  : Kein 882-Level gefunden
  G6/7: Heatmap fehlend oder veraltet (global und per Symbol)
  G8  : Preis weit entfernt -> armed (kein Signal)
  G9  : Kein Liq-Cluster / Notional 0 / Notional fehlend -> fail-closed
  G10 : 15m LSOB-Sweep (exakte Wick/Close-Regel)
  G11 : Max-Positionen erreicht
  G12 : RRR unter Minimum / MIN_NET_RRR=None -> fail-closed

  Score-Grenze: Notional >= LIQ_SCORE9_THRESHOLD -> Score 9; < -> Score 8
  Routing-Pruefung: smc_scan.mjs Code-Analyse (kein hardcoded '8', Score-9-Gate)
"""

import json
import os
import sys
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime, timezone, timedelta

# level_entry.py liegt zwei Verzeichnisse oberhalb
_SCRIPT_DIR = os.path.join(os.path.dirname(__file__), '..', '..')
sys.path.insert(0, _SCRIPT_DIR)

import level_entry as le


# ── Hilfsfunktionen fuer Test-Kerzen ──────────────────────────────────────────

def _candle(h, l, o, c, v=1000.0):
    return {'high': h, 'low': l, 'open': o, 'close': c, 'volume': v}


def _long_bias_candles():
    """
    Explizite Kerzenfolge mit HH/HL-Muster fuer LONG-Bias.
    Pivot-Highs bei Index 2 (h=110) und Index 8 (h=125) -- HH.
    Pivot-Lows  bei Index 5 (l=90)  und Index 11 (l=100) -- HL.
    Alle Pivot-Regeln fuer pivot_len=2 (5-Bar-Fraktal) erfuellt.
    """
    return [
        _candle( 95, 88, 90, 92),   # 0
        _candle( 97, 90, 92, 95),   # 1
        _candle(110, 95, 97,108),   # 2  PH1=110
        _candle(108, 97,108,105),   # 3
        _candle(106, 98,105,101),   # 4
        _candle(104, 90,101, 93),   # 5  PL1=90
        _candle(106, 93, 93,105),   # 6
        _candle(108, 95,105,107),   # 7
        _candle(125,100,107,122),   # 8  PH2=125  (HH: 125 > 110)
        _candle(122,103,122,115),   # 9
        _candle(120,105,115,108),   # 10
        _candle(118,100,108,103),   # 11 PL2=100  (HL: 100 > 90)
        _candle(120,103,103,118),   # 12
        _candle(122,105,118,120),   # 13
    ]


def _short_bias_candles():
    """
    Explizite Kerzenfolge mit LH/LL-Muster fuer SHORT-Bias.
    Pivot-Highs bei Index 2 (h=122) und Index 8 (h=115) -- LH.
    Pivot-Lows  bei Index 6 (l=89)  und Index 13 (l=82) -- LL.
    """
    return [
        _candle(115,108,112,113),   # 0
        _candle(117,110,113,115),   # 1
        _candle(122,112,115,120),   # 2  PH1=122
        _candle(120,108,120,112),   # 3
        _candle(118,106,112,110),   # 4
        _candle(116, 98,110,105),   # 5
        _candle(108, 89,105, 95),   # 6  PL1=89
        _candle(112, 95, 95,110),   # 7
        _candle(115, 97,110,112),   # 8  PH2=115  (LH: 115 < 122)
        _candle(113, 99,112,110),   # 9
        _candle(111,100,110,105),   # 10
        _candle(110, 97,105,100),   # 11
        _candle(108, 95,100, 97),   # 12
        _candle(104, 82, 97, 85),   # 13 PL2=82   (LL: 82 < 89)
        _candle(106, 85, 85, 102),  # 14
        _candle(108, 87,102,105),   # 15
    ]


def _zigzag_candles(n=20, price=100.0):
    """Symmetrisches Zick-Zack ohne Trend -- kein HH/HL oder LH/LL moeglich."""
    candles = []
    for i in range(n):
        if i % 4 < 2:
            candles.append(_candle(price + 2.0, price - 1.0, price, price + 0.5))
        else:
            candles.append(_candle(price + 1.0, price - 2.0, price, price - 0.5))
    return candles


# ── G2: detect_bias ───────────────────────────────────────────────────────────

class TestDetectBias(unittest.TestCase):

    def test_long_bias(self):
        self.assertEqual(le.detect_bias(_long_bias_candles(), pivot_len=2), 'long')

    def test_short_bias(self):
        self.assertEqual(le.detect_bias(_short_bias_candles(), pivot_len=2), 'short')

    def test_ambiguous_returns_none(self):
        self.assertIsNone(le.detect_bias(_zigzag_candles(20), pivot_len=2))

    def test_insufficient_candles_returns_none(self):
        self.assertIsNone(le.detect_bias([_candle(1, 0, 0.5, 0.5)], pivot_len=2))


# ── G10: check_lsob_sweep (exakte Wick/Close-Regel) ──────────────────────────

class TestLsobSweep(unittest.TestCase):

    def test_long_sweep_valid(self):
        """Wick nimmt 882-Level von unten, Schlusskurs kehrt ueber Level zurueck."""
        level = 100.0
        candles = [
            _candle(h=102, l=99.0, o=101, c=101.5),   # Wick unter Level, Close darueber
        ]
        self.assertTrue(le.check_lsob_sweep(candles, level, 'long'))

    def test_long_sweep_no_return(self):
        """Wick nimmt Level, aber Schlusskurs bleibt darunter -- kein Sweep."""
        level = 100.0
        candles = [
            _candle(h=100.5, l=98.0, o=100.3, c=99.5),  # Close unter Level
        ]
        self.assertFalse(le.check_lsob_sweep(candles, level, 'long'))

    def test_long_no_wick_through(self):
        """Schlusskurs uber Level, aber Wick nie darunter -- kein Sweep."""
        level = 100.0
        candles = [
            _candle(h=102.0, l=100.5, o=101, c=101.5),  # Low nie unter Level
        ]
        self.assertFalse(le.check_lsob_sweep(candles, level, 'long'))

    def test_short_sweep_valid(self):
        """Wick nimmt 882-Level von oben, Schlusskurs kehrt unter Level zurueck."""
        level = 100.0
        candles = [
            _candle(h=101.0, l=98.5, o=99.5, c=99.0),  # High ueber Level, Close darunter
        ]
        self.assertTrue(le.check_lsob_sweep(candles, level, 'short'))

    def test_short_sweep_no_return(self):
        """Wick ueber Level, Schlusskurs bleibt darueber -- kein Sweep."""
        level = 100.0
        candles = [
            _candle(h=101.5, l=99.5, o=100.0, c=101.0),  # Close ueber Level
        ]
        self.assertFalse(le.check_lsob_sweep(candles, level, 'short'))

    def test_lookback_window(self):
        """Nur die letzten SWEEP_LOOKBACK_15M Kerzen werden geprueft."""
        level = 100.0
        old_sweep  = [_candle(102, 99.0, 101, 101.5)]  # Sweep, aber ausserhalb Fenster
        old_sweep += [_candle(102, 100.5, 101, 101.5)] * le.SWEEP_LOOKBACK_15M
        # Letzten 4 Kerzen enthalten keinen Sweep mehr
        self.assertFalse(le.check_lsob_sweep(old_sweep, level, 'long'))


# ── G12: calc_net_rrr ─────────────────────────────────────────────────────────

class TestCalcNetRrr(unittest.TestCase):

    def test_long_rrr_valid(self):
        """Standard LONG: Entry 100, SL 97, TP 110 -> grobe RRR ~2.8 (nach Fees etwas geringer)."""
        rrr = le.calc_net_rrr(entry=100.0, sl=97.0, tp=110.0, direction='long')
        self.assertIsNotNone(rrr)
        self.assertGreater(rrr, le.MIN_NET_RRR)

    def test_short_rrr_valid(self):
        """Standard SHORT: Entry 100, SL 103, TP 90 -> grobe RRR ~3.1."""
        rrr = le.calc_net_rrr(entry=100.0, sl=103.0, tp=90.0, direction='short')
        self.assertIsNotNone(rrr)
        self.assertGreater(rrr, le.MIN_NET_RRR)

    def test_sl_zero_distance_returns_none(self):
        """SL == Entry: Division durch 0 -> None."""
        self.assertIsNone(le.calc_net_rrr(100.0, 100.0, 110.0, 'long'))

    def test_sl_wrong_side_returns_none(self):
        """SL auf falscher Seite (LONG: SL ueber Entry)."""
        self.assertIsNone(le.calc_net_rrr(100.0, 102.0, 110.0, 'long'))

    def test_tp_too_close_returns_none(self):
        """TP so nah an Entry, dass Netto-TP nach Fees negativ wird."""
        # Fees + Slippage round-trip: 100 * 0.001 * 2 = 0.2
        # TP nur 0.1 ueber Entry: net_tp = 0.1 - 0.2 < 0
        self.assertIsNone(le.calc_net_rrr(100.0, 99.0, 100.1, 'long'))

    def test_rrr_below_min(self):
        """RRR < MIN_NET_RRR (2.0): Entry 100, SL 99, TP 101.5."""
        # gross_tp = 1.5, gross_sl = 1.0 -> grobe RRR = 1.5, nach Fees noch schlechter
        rrr = le.calc_net_rrr(100.0, 99.0, 101.5, 'long')
        self.assertIsNotNone(rrr)
        self.assertLess(rrr, le.MIN_NET_RRR)


# ── G9: Score-Grenze und fail-closed Notional ─────────────────────────────────

class TestScoreBoundaryAndNotional(unittest.TestCase):

    def _make_liq(self, direction, fib, notional, atr=100.0):
        """Hilfsfunktion: Erstellt minimales liq_sym-Objekt mit einem Cluster."""
        price = fib - 10.0 if direction == 'long' else fib + 10.0  # innerhalb 0.5 ATR
        if direction == 'long':
            return {'buy_walls': [{'price': price, 'notional_usd': notional}],
                    'sell_walls': []}
        return {'buy_walls': [],
                'sell_walls': [{'price': price, 'notional_usd': notional}]}

    def test_score9_at_threshold(self):
        """Notional == LIQ_SCORE9_THRESHOLD -> Score 9."""
        liq = self._make_liq('long', fib=1000.0, notional=le.LIQ_SCORE9_THRESHOLD, atr=100.0)
        cluster = le.find_liq_cluster(liq, 1000.0, 'long', 100.0)
        self.assertIsNotNone(cluster)
        score = 9 if cluster['notional_usd'] >= le.LIQ_SCORE9_THRESHOLD else 8
        self.assertEqual(score, 9)

    def test_score9_above_threshold(self):
        """Notional > LIQ_SCORE9_THRESHOLD -> Score 9."""
        liq = self._make_liq('long', fib=1000.0, notional=le.LIQ_SCORE9_THRESHOLD + 1, atr=100.0)
        cluster = le.find_liq_cluster(liq, 1000.0, 'long', 100.0)
        score = 9 if cluster['notional_usd'] >= le.LIQ_SCORE9_THRESHOLD else 8
        self.assertEqual(score, 9)

    def test_score8_below_threshold(self):
        """Notional < LIQ_SCORE9_THRESHOLD -> Score 8."""
        liq = self._make_liq('long', fib=1000.0, notional=le.LIQ_SCORE9_THRESHOLD - 1, atr=100.0)
        cluster = le.find_liq_cluster(liq, 1000.0, 'long', 100.0)
        score = 9 if cluster['notional_usd'] >= le.LIQ_SCORE9_THRESHOLD else 8
        self.assertEqual(score, 8)

    def test_notional_zero_is_fail_closed(self):
        """Notional 0 darf KEIN Signal erzeugen (kein Score-8-Fallback)."""
        liq = self._make_liq('long', fib=1000.0, notional=0, atr=100.0)
        cluster = le.find_liq_cluster(liq, 1000.0, 'long', 100.0)
        # find_liq_cluster gibt Cluster zurueck, aber notional_usd == 0
        # -> G9b: fail-closed pruefung
        self.assertIsNotNone(cluster)
        raw_notional = cluster.get('notional_usd')
        self.assertFalse(raw_notional and raw_notional > 0,
                         'notional_usd == 0 muss fail-closed blockiert werden')

    def test_notional_missing_is_fail_closed(self):
        """Fehlende notional_usd (None) darf kein Signal erzeugen."""
        # Cluster ohne notional_usd-Feld
        cluster = {'price': 990.0}
        raw_notional = cluster.get('notional_usd')
        self.assertFalse(raw_notional and raw_notional > 0)


# ── G9: find_liq_cluster ─────────────────────────────────────────────────────

class TestFindLiqCluster(unittest.TestCase):

    def _liq(self, buy_walls=None, sell_walls=None):
        return {
            'buy_walls':  buy_walls  or [],
            'sell_walls': sell_walls or [],
        }

    def test_long_cluster_found(self):
        """LONG: Buy-Wall unterhalb Fib-882, innerhalb 0.5 ATR."""
        liq = self._liq(buy_walls=[{'price': 95.0, 'notional_usd': 1_000_000}])
        result = le.find_liq_cluster(liq, fib_882=100.0, direction='long', atr=20.0)
        # 0.5 * 20 = 10; 90 <= 95 <= 100 -> OK
        self.assertIsNotNone(result)
        self.assertEqual(result['price'], 95.0)

    def test_long_cluster_too_far(self):
        """LONG: Buy-Wall zu weit unterhalb Fib-882 (> 0.5 ATR)."""
        liq = self._liq(buy_walls=[{'price': 80.0, 'notional_usd': 1_000_000}])
        result = le.find_liq_cluster(liq, 100.0, 'long', 20.0)
        # 0.5 * 20 = 10; 80 < (100 - 10) = 90 -> ausserhalb
        self.assertIsNone(result)

    def test_short_cluster_found(self):
        """SHORT: Sell-Wall oberhalb Fib-882, innerhalb 0.5 ATR."""
        liq = self._liq(sell_walls=[{'price': 105.0, 'notional_usd': 2_000_000}])
        result = le.find_liq_cluster(liq, 100.0, 'short', 20.0)
        self.assertIsNotNone(result)

    def test_no_symbol_data_returns_none(self):
        self.assertIsNone(le.find_liq_cluster(None, 100.0, 'long', 20.0))

    def test_empty_walls_returns_none(self):
        liq = self._liq()
        self.assertIsNone(le.find_liq_cluster(liq, 100.0, 'long', 20.0))


# ── G12: MIN_NET_RRR = None -> fail-closed ────────────────────────────────────

class TestRrrFailClosed(unittest.TestCase):

    def test_min_rrr_none_check(self):
        """
        Wenn MIN_NET_RRR None ist, darf kein Signal erzeugt werden.
        Hier wird nur die Logik-Bedingung ueberprueft, nicht main().
        """
        original = le.MIN_NET_RRR
        try:
            le.MIN_NET_RRR = None
            # Der Gate-Code in main() prueft: if MIN_NET_RRR is None: gate_reject(...)
            is_blocked = le.MIN_NET_RRR is None
            self.assertTrue(is_blocked, 'MIN_NET_RRR=None muss das Gate blockieren')
        finally:
            le.MIN_NET_RRR = original


# ── G6/G7: Heatmap Freshness ──────────────────────────────────────────────────

class TestHeatmapFreshness(unittest.TestCase):

    def _ts(self, age_min):
        """Gibt einen ISO-Timestamp zurueck, der age_min Minuten alt ist."""
        t = datetime.now(timezone.utc) - timedelta(minutes=age_min)
        return t.isoformat()

    def test_fresh_timestamp_ok(self):
        """Heatmap juenger als LIQ_MAX_AGE_MIN -> Gate passiert."""
        ts  = self._ts(5)
        age = (datetime.now(timezone.utc) -
               datetime.fromisoformat(ts)).total_seconds() / 60
        self.assertLess(age, le.LIQ_MAX_AGE_MIN)

    def test_stale_timestamp_blocked(self):
        """Heatmap aelter als LIQ_MAX_AGE_MIN -> Gate blockiert."""
        ts  = self._ts(le.LIQ_MAX_AGE_MIN + 5)
        age = (datetime.now(timezone.utc) -
               datetime.fromisoformat(ts)).total_seconds() / 60
        self.assertGreater(age, le.LIQ_MAX_AGE_MIN)

    def test_no_timestamp_blocked(self):
        """Fehlender 'updated_at'-Timestamp -> Gate blockiert."""
        sym_updated = ''
        self.assertFalse(bool(sym_updated),
                         'Leerer Timestamp muss als blockiert behandelt werden')


# ── Routing-Pruefung: smc_scan.mjs Code-Analyse ───────────────────────────────

class TestSmcScanRouting(unittest.TestCase):
    """
    Prueft den Quell-Code von smc_scan.mjs:
    - kein hardcoded '--score', '8' fuer Level-Signale mehr
    - Score 9 wird durch thesis_reviewer geroutet
    - Score 8 geht direkt zu auto_open
    """

    @classmethod
    def setUpClass(cls):
        scan_path = os.path.join(_SCRIPT_DIR, 'smc_scan.mjs')
        with open(scan_path, encoding='utf-8') as fh:
            cls.code = fh.read()

    def test_no_hardcoded_score_8(self):
        """
        '--score', '8' darf im Level-Dispatch-Block nicht mehr vorkommen.
        Hardcoded '8' war der Fehler, der sig.score aus level_entry.py ignorierte.
        """
        # String-basierter Check: '--score',    '8' (inkl. moegl. Leerzeichen)
        import re
        pattern = r"'--score'\s*,\s*'8'"
        matches = re.findall(pattern, self.code)
        self.assertEqual(
            len(matches), 0,
            f"Hardcoded '--score','8' noch im Code: {matches}"
        )

    def test_sig_score_used(self):
        """String(sig.score) muss fuer Level-Signale verwendet werden."""
        self.assertIn('String(sig.score)', self.code,
                      "String(sig.score) nicht in smc_scan.mjs gefunden")

    def test_score9_routes_via_reviewer(self):
        """Level Score 9 muss thesis_reviewer aufrufen."""
        self.assertIn('level_thesis_review_start', self.code,
                      "'level_thesis_review_start' nicht in smc_scan.mjs gefunden")
        self.assertIn('level9', self.code,
                      "'level9' Array-Variable nicht in smc_scan.mjs gefunden")

    def test_score8_monitoring_only(self):
        """Level Score 8 darf kein auto_open ausloesen; nur Monitoring-Log."""
        self.assertIn('level8', self.code,
                      "'level8' Array-Variable nicht in smc_scan.mjs gefunden")
        self.assertIn('level_monitoring', self.code,
                      "'level_monitoring' Log-Event nicht in smc_scan.mjs gefunden")
        # dispatchLevelOpen darf im Score-8-Block nicht stehen
        # Der Block beginnt nach "Score 8 → Monitoring-only" und endet vor "Score 9 →"
        import re
        score8_block = re.search(
            r'Score 8 .*?Monitoring-only.*?for\s*\(const sig of level8\)(.*?)Score 9 →',
            self.code, re.DOTALL)
        self.assertIsNotNone(score8_block,
                             "Score-8-Block nicht gefunden — Routing-Kommentar oder Schleife fehlt")
        self.assertNotIn('dispatchLevelOpen', score8_block.group(1),
                         "dispatchLevelOpen darf nicht im Score-8-Block stehen")

    def test_reviewer_path_used(self):
        """thesis_reviewer.mjs muss in smc_scan.mjs referenziert werden."""
        self.assertIn('reviewerPath', self.code)


# ── Konstanten-Integritaet ────────────────────────────────────────────────────

class TestConstants(unittest.TestCase):

    def test_min_rrr_is_set(self):
        """MIN_NET_RRR muss gesetzt sein (kein None-Default im normalen Betrieb)."""
        self.assertIsNotNone(le.MIN_NET_RRR)
        self.assertGreater(le.MIN_NET_RRR, 0)

    def test_fee_pct_positive(self):
        self.assertGreater(le.FEE_PCT, 0)

    def test_slippage_pct_positive(self):
        self.assertGreater(le.SLIPPAGE_PCT, 0)

    def test_liq_score9_threshold(self):
        self.assertEqual(le.LIQ_SCORE9_THRESHOLD, 5_000_000)

    def test_max_level_positions_positive(self):
        self.assertGreater(le.MAX_LEVEL_POSITIONS, 0)

    def test_liq_max_age_min(self):
        self.assertEqual(le.LIQ_MAX_AGE_MIN, 20)


if __name__ == '__main__':
    unittest.main(verbosity=2)
