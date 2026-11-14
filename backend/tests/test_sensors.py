import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from app.schemas import CaseConfig, CaseGraph, InvestigatorToolCall, SourceFile
from app.tools.investigation import EvidenceTools
from app.tools.sensors import analyze_sensors


class SensorTests(unittest.TestCase):
    def analyze(self, values, times=None, unit='deg', name='Pitch', resolved=True):
        df = pd.DataFrame({name: values})
        df.attrs['units'] = {name: unit}
        return analyze_sensors(df, np.arange(len(df), dtype=float) if times is None else np.array(times, dtype=float),
                               'fixture', clock_resolved=resolved)[0]

    def test_stable_rising_falling_states(self):
        for values, label in [(np.ones(100), 'stable'), (np.arange(100.), 'rising'), (-np.arange(100.), 'falling')]:
            sensor = self.analyze(values)
            self.assertEqual(sensor.states[0].label, label)
            self.assertTrue(all(s.label == label for s in sensor.states))
            self.assertEqual(sensor.findings, [])

    def test_variable_state(self):
        sensor = self.analyze(np.tile([0., 1., 0., -1., 0.], 20))
        self.assertIn('variable', [s.label for s in sensor.states])

    def test_discrete_states_preserve_initial_value(self):
        sensor = self.analyze(['Off'] * 10 + ['Engaged'] * 20 + ['Off'] * 30, unit='', name='A/P CMD L')
        self.assertEqual(sensor.kind, 'discrete')
        self.assertEqual([(s.label, s.samples) for s in sensor.states], [('Off', 10), ('Engaged', 20), ('Off', 30)])
        self.assertEqual(sensor.states[0].first_row, 1)
        self.assertEqual(sensor.states[-1].last_row, 60)

    def test_sparse_rows_not_sampling_gaps(self):
        v = np.full(400, np.nan); v[::4] = np.arange(100.)
        s = self.analyze(v, np.arange(400.) / 4)
        self.assertEqual(s.samples, 100)
        self.assertEqual(s.cadence_s, 1)
        self.assertFalse(any(f.kind == 'sampling_gap' for f in s.findings))
        self.assertTrue(all((st.first_row - 1) % 4 == 0 for st in s.states))

    def test_gap_splits_even_equal_states(self):
        t = np.r_[np.arange(100.), np.arange(100.) + 200]
        s = self.analyze(np.ones(200), t)
        self.assertEqual(len(s.states), 2)
        self.assertEqual([f.kind for f in s.findings], ['sampling_gap'])
        self.assertFalse(any(st.start_s < 100 and st.end_s >= 200 for st in s.states))

    def test_clock_reset_splits_states(self):
        s = self.analyze(np.ones(200), np.r_[np.arange(100.), np.arange(100.)])
        self.assertEqual(len(s.states), 2)
        self.assertEqual(s.findings, [])

    def test_heading_wrap_not_anomaly(self):
        s = self.analyze((350 + np.arange(100.) * .2) % 360, name='Heading')
        self.assertEqual(s.findings, [])
        self.assertTrue(all(st.label == 'rising' for st in s.states))

    def test_level_and_rate_candidates_with_citations(self):
        v = np.zeros(200); v[100:105] = 20
        s = self.analyze(v)
        self.assertIn('unusual_change', [f.kind for f in s.findings])
        self.assertIn('level_outlier', [f.kind for f in s.findings])
        for f in s.findings:
            self.assertTrue(all(c.verified and "column 'Pitch'" in c.quote for c in f.citations))
            self.assertTrue(f.start_s <= f.end_s)

    def test_step_on_window_edge_separates_plateaus(self):
        s = self.analyze(np.r_[np.zeros(100), np.ones(100) * 20])
        self.assertIn('rising', [st.label for st in s.states])
        stable = [st for st in s.states if st.label == 'stable']
        self.assertTrue(any(st.median == 0 for st in stable))
        self.assertTrue(any(st.median == 20 for st in stable))
        self.assertFalse(any(st.start_s < 100 and st.end_s >= 100 for st in stable))

    def test_unresolved_and_short_inputs(self):
        s = self.analyze(np.arange(100.), resolved=False)
        self.assertEqual(s.status, 'unresolved_clock')
        self.assertEqual(s.states, [])
        self.assertEqual(s.findings, [])
        self.assertEqual(self.analyze([1.]).status, 'insufficient_samples')
        self.assertEqual(self.analyze([np.nan] * 100).status, 'no_samples')

    def test_no_global_sensor_cap_and_roundtrip(self):
        df = pd.DataFrame({f'Sensor {i}': np.r_[np.zeros(100), np.ones(100) * 20] for i in range(45)})
        df.attrs['units'] = {c: 'deg' for c in df.columns}
        sensors = analyze_sensors(df, np.arange(200.), 'fixture', clock_resolved=True)
        self.assertEqual(len(sensors), 45)
        self.assertTrue(all(any(f.kind == 'unusual_change' for f in s.findings) for s in sensors))
        g = CaseGraph(case_id='fixture', config=CaseConfig(), sensors=sensors)
        restored = CaseGraph.model_validate_json(g.model_dump_json())
        self.assertEqual(restored.sensors, sensors)
        self.assertEqual(len({f.id for s in sensors for f in s.findings}), sum(len(s.findings) for s in sensors))

    def test_sensor_window_evidence_and_exclusion(self):
        sensor = self.analyze(np.r_[np.zeros(100), np.ones(100) * 20])
        source = SourceFile(file_id='fixture', name='synthetic.csv', rel_path='synthetic.csv', kind='table', ext='.csv', size=0, sha256='fixture')
        g = CaseGraph(case_id='fixture', config=CaseConfig(), files=[source], sensors=[sensor])
        with tempfile.TemporaryDirectory() as directory:
            tools = EvidenceTools(g, Path(directory))
            result = tools.run(InvestigatorToolCall(tool='sensor_window', series_name=sensor.sensor_id, file_id='fixture', start_s=95, end_s=110))
            self.assertTrue(result['evidence'])
            self.assertTrue(all(x['id'] in tools.seen for x in result['evidence']))
            with self.assertRaises(ValueError):
                tools.run(InvestigatorToolCall(tool='sensor_window', series_name=sensor.sensor_id, start_s=float('nan'), end_s=110))
            source.excluded = True
            tools = EvidenceTools(g, Path(directory))
            self.assertEqual(tools.overview()['sensors'], [])
            self.assertEqual(tools.atoms, {})


if __name__ == '__main__':
    unittest.main()
