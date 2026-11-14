"""Synthetic fixtures stay out of real case storage."""
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from app.schemas import Anomaly, SourceFile
from app.tools.discovery import discover_changes
from app.tools.fdr import analyze_fdr


class DiscoveryTests(unittest.TestCase):
    def frame(self, values, unit="deg", column="Pitch"):
        df = pd.DataFrame({column: values})
        df.attrs["units"] = {column: unit}
        return df

    def test_step_with_row_provenance(self):
        v = np.zeros(200)
        v[100:] = 20
        hits = discover_changes(self.frame(v), np.arange(200.))
        self.assertTrue(hits)
        self.assertTrue(any(h.start <= 99 and h.end >= 100 for h in hits))
        self.assertTrue(all(np.isfinite(h.score) for h in hits))

    def test_flat_and_smooth_trend_are_not_anomalies(self):
        for v in (np.ones(200), np.arange(200.) * .1):
            self.assertEqual(discover_changes(self.frame(v), np.arange(200.)), [])

    def test_sparse_native_rows(self):
        v = np.full(800, np.nan)
        v[::4] = np.r_[np.zeros(100), np.ones(100) * 20]
        hits = discover_changes(self.frame(v), np.arange(800.) / 4)
        self.assertTrue(hits)
        self.assertTrue(all(h.start % 4 == 0 and h.end % 4 == 0 for h in hits))

    def test_no_bridging_gap_or_clock_reset(self):
        v = np.r_[np.zeros(100), np.ones(100) * 20]
        for t in (np.r_[np.arange(100.), np.arange(100.) + 1000],
                  np.r_[np.arange(100.), np.arange(100.)]):
            self.assertEqual(discover_changes(self.frame(v), t), [])

    def test_circular_heading_wrap(self):
        v = (350 + np.arange(200.) * .2) % 360
        self.assertEqual(discover_changes(self.frame(v, column="Heading"), np.arange(200.)), [])

    def test_short_missing_and_discrete_inputs(self):
        for df in (self.frame(np.zeros(20)), self.frame(np.full(200, np.nan)),
                   self.frame(np.r_[np.zeros(100), np.ones(100)], unit="")):
            self.assertEqual(discover_changes(df, np.arange(float(len(df)))), [])

    def test_end_to_end_local_clock_and_serialization(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'fdr.csv'
            lines = ['Time,Pitch', '(CST),(deg)', ',']
            lines += [f'12:{i // 60:02d}:{i % 60:02d},{0 if i < 100 else 20}' for i in range(200)]
            path.write_text('\n'.join(lines))
            sf = SourceFile(file_id='fixture', name=path.name, rel_path=path.name,
                            kind='table', ext='.csv', size=path.stat().st_size, sha256='fixture')
            out = analyze_fdr(path, sf, -6)
            self.assertEqual(out['sensors'][0]['column'], 'Pitch')
            self.assertTrue(out['sensors'][0]['states'])
            self.assertTrue(out['sensors'][0]['findings'])
            hits = [Anomaly(**a) for a in out['anomalies'] if '-discovery-' in a['id']]
            self.assertTrue(hits)
            for hit in hits:
                self.assertGreaterEqual(hit.time.t_s, 18 * 3600)
                self.assertEqual(hit.certainty, 'measured')
                self.assertEqual(hit.severity, 'info')
                self.assertTrue(all(c.verified and 'rows' in c.quote for c in hit.citations))
                self.assertGreaterEqual(hit.observations[0].end_s, hit.observations[0].start_s)

    def test_fusion_keeps_distinct_channels(self):
        from app.fusion.dedup import _merge_anomalies
        base = dict(domain='aircraft_system', expected='recording baseline',
                    observed='shared statistical detector description ' * 10,
                    severity='info', certainty='measured', citations=[], source_files=['f'])
        items = [Anomaly(id=f'an-f-discovery-{i}', title=f'Unusual change: {column}', **base)
                 for i, column in enumerate(['Pitch', 'Roll'])]
        self.assertEqual(len(_merge_anomalies(items)), 2)


if __name__ == '__main__':
    unittest.main()
