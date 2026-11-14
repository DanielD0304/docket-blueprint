import unittest

from app.timeparse import clock_seconds, fmt, to_case_seconds


class ClockSecondsTests(unittest.TestCase):
    def test_formats(self):
        cases = {
            "12:38:57": 12 * 3600 + 38 * 60 + 57,
            "1238:57": 12 * 3600 + 38 * 60 + 57,  # NTSB CVR style HHMM:SS
            "12:38:57.3": 12 * 3600 + 38 * 60 + 57.3,
            "at 12:38 the crew": 12 * 3600 + 38 * 60,
            "7:05:00": 7 * 3600 + 5 * 60,
            "CVR 1238:57.5 CAM": 12 * 3600 + 38 * 60 + 57.5,
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertAlmostEqual(clock_seconds(raw), expected)

    def test_rejects_garbage(self):
        for raw in (None, "", "no time here", "99:99:99", "12:75", "page 12", "N1234"):
            with self.subTest(raw=raw):
                self.assertIsNone(clock_seconds(raw))

    def test_multi_day_hours_allowed(self):
        # 72-h crew histories legitimately go past 24 h
        self.assertEqual(clock_seconds("30:00:00"), 30 * 3600)


class CaseSecondsTests(unittest.TestCase):
    def test_utc_passthrough(self):
        self.assertEqual(to_case_seconds("12:00:00", "utc", -6), (43200, "utc"))

    def test_local_converted_with_offset(self):
        # local = UTC + offset  ->  UTC = local - offset
        t, basis = to_case_seconds("12:00:00", "local", -6)
        self.assertEqual((t, basis), (43200 + 6 * 3600, "local"))

    def test_utc_hint_overrides_basis(self):
        for raw in ("12:00:00 UTC", "12:00:00 zulu", "1200z 12:00:00"):
            with self.subTest(raw=raw):
                self.assertEqual(to_case_seconds(raw, "local", -6), (43200, "utc"))

    def test_unresolved_basis_waits_for_alignment(self):
        self.assertEqual(to_case_seconds("12:00:00", "relative", 0), (None, "relative"))
        self.assertEqual(to_case_seconds("nothing", "utc", 0), (None, "utc"))


class FmtTests(unittest.TestCase):
    def test_fmt(self):
        self.assertEqual(fmt(None), "--:--:--")
        self.assertEqual(fmt(12 * 3600 + 38 * 60 + 57.25), "12:38:57.2")
        self.assertEqual(fmt(86400 + 60), "D+1 00:01:00.0")
        self.assertEqual(fmt(-3600), "D-1 23:00:00.0")

    def test_roundtrip(self):
        for s in (0, 1.5, 3599.9, 45296.0):
            with self.subTest(s=s):
                self.assertAlmostEqual(clock_seconds(fmt(s)), s, places=1)


if __name__ == "__main__":
    unittest.main()
