"""Loader tests on small fixtures that reproduce the quirks of real NTSB exports (see AGENTS.md)."""
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from app.tools.table import find_col, load_table, numeric, time_seconds

# 6 metadata lines, header, units row ((CST) = local clock), enum row, sparse data rows.
NTSB_FDR = """NTSB DCA00XX000, Attachment 1 - Flight Data Recorder Tabular Data
Operator: Example Air
Aircraft: Example 767
Recorder: Fixture FDR
Generated for unit tests
Note: synthetic data
Time,Pressure Altitude,Pitch Angle,A/P Engaged
(CST),(ft),(deg),()
,,,"%N(0:0=""Off"",1:1=""Engaged"")"
12:38:00.000,6000,2.5,
12:38:00.016,,,1
12:38:01.000,5980,2.0,
12:38:02.000,5950,-1.5,0
"""

ADSB = """Time,Alt,LatDeg,LonDeg
59:58.0,6000,29.8,-94.9
59:59.5,5990,29.81,-94.91
00:01.0,5980,29.82,-94.92
00:02.0,5970,29.83,-94.93
"""


class TableTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name: str, text: str) -> Path:
        p = self.dir / name
        p.write_text(text, encoding="latin-1")
        return p

    def test_ntsb_fdr_header_units_and_enum_rows_are_stripped(self):
        df = load_table(self.write("fdr.csv", NTSB_FDR))
        self.assertEqual(list(df.columns), ["Time", "Pressure Altitude", "Pitch Angle", "A/P Engaged"])
        self.assertEqual(len(df), 4)
        self.assertEqual(df.attrs["units"]["Time"], "CST")
        self.assertEqual(df.attrs["units"]["Pressure Altitude"], "ft")

    def test_ntsb_fdr_local_clock_detected(self):
        df = load_table(self.write("fdr.csv", NTSB_FDR))
        t, basis, col = time_seconds(df)
        self.assertEqual((basis, col), ("local", "Time"))
        self.assertAlmostEqual(t.iloc[0], 12 * 3600 + 38 * 60)
        self.assertTrue(np.all(np.diff(t.to_numpy()) >= 0))

    def test_sparse_rows_stay_nan_until_forward_filled(self):
        df = load_table(self.write("fdr.csv", NTSB_FDR))
        alt = numeric(df, "Pressure Altitude")
        self.assertTrue(np.isnan(alt.iloc[1]))
        self.assertEqual(alt.ffill().iloc[1], 6000)

    def test_adsb_mmss_recovers_hour_rollover(self):
        df = load_table(self.write("adsb.csv", ADSB))
        t, basis, _ = time_seconds(df)
        self.assertEqual(basis, "mmss")
        self.assertEqual(list(t.round(1)), [3598.0, 3599.5, 3601.0, 3602.0])

    def test_find_col_patterns_and_exclude(self):
        df = pd.DataFrame(columns=["Lat", "LatDeg", "LonDeg", "Pressure Altitude", "Altitude Rate"])
        self.assertEqual(find_col(df, r"^latdeg$", r"lat"), "LatDeg")
        self.assertEqual(find_col(df, r"altitude", exclude=r"rate"), "Pressure Altitude")
        self.assertIsNone(find_col(df, r"airspeed"))

    def test_numeric_seconds_are_subframe_basis(self):
        df = load_table(self.write("sub.csv", "Time,Alt\n0,1\n0.5,2\n1.0,3\n"))
        _, basis, _ = time_seconds(df)
        self.assertEqual(basis, "fdr_subframe")

    def test_no_time_column(self):
        df = load_table(self.write("x.csv", "Alt,Speed\n1,2\n3,4\n"))
        self.assertEqual(time_seconds(df), (None, "unknown", None))


if __name__ == "__main__":
    unittest.main()
