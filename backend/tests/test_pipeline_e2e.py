"""End-to-end: synthetic docket -> full CaseRunner pipeline (mock LLM, no network) -> case graph invariants.

The fixture is synthetic and lives in a temp dir, never in <DATA_DIR>/cases (see AGENTS.md).
"""
import asyncio
import math
import tempfile
import unittest
from pathlib import Path

from app.orchestrator import CaseRunner
from app.schemas import CaseConfig
from app.store import CaseStore

T0 = 12 * 3600 + 30 * 60  # 12:30:00 UTC
UPSET_ROW = 500  # level flight, then a steep nose-down descent with unloading


def setUpModule():
    from app.config import DATA_DIR
    if "docket-blueprint-test-" not in str(DATA_DIR):  # set by conftest.py
        raise unittest.SkipTest("writes cases: run with pytest so DATA_DIR is an isolated temp dir")


def _fdr_csv(path: Path, n: int = 600, dt: float = 0.5) -> None:
    rows = ["NTSB TEST00, Attachment 1 - Flight Data Recorder Tabular Data (SYNTHETIC)"] + ["synthetic fixture"] * 5 + [
        "Time,Pressure Altitude,Pitch Angle,Computed Airspeed,Roll Angle,Magnetic Heading,Vertical Acceleration",
        "(UTC),(ft),(deg),(kts),(deg),(deg),(g)", ",,,,,,"]
    for i in range(n):
        t = T0 + i * dt
        up = i > UPSET_ROW
        alt = 6000 - (i - UPSET_ROW) * 60 if up else 6000
        pitch = -20 * min(1, (i - UPSET_ROW) / 20) if up else 2.0
        rows.append(f"{int(t // 3600):02d}:{int(t % 3600 // 60):02d}:{t % 60:06.3f},{alt},{pitch:.2f},"
                    f"{230 + 5 * math.sin(i / 30):.1f},{3 * math.sin(i / 50):.2f},{120 + i * .01:.1f},{.2 if up else 1.0}")
    path.write_text("\n".join(rows) + "\n", encoding="latin-1")


class PipelineE2ETests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        docket = Path(cls.tmp.name)
        _fdr_csv(docket / "Flight Data Recorder - Tabular Data.csv")
        _fdr_csv(docket / "FDR Ancillary Data - other aircraft.csv", n=50)
        store = CaseStore("e2e-synthetic")
        store.create(CaseConfig(title="Synthetic E2E", date="2019-02-23", blind_mode=True), raw_dir=docket)
        cls.graph = asyncio.run(CaseRunner("e2e-synthetic").run())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_run_completes_in_mock_mode(self):
        self.assertEqual(self.graph.status, "done")
        self.assertTrue(self.graph.stats["mock"])
        self.assertEqual(self.graph.stats["llm"]["calls"], 0)

    def test_ancillary_recorder_data_never_reaches_timeline(self):
        by_name = {f.name: f for f in self.graph.files}
        anc = by_name["FDR Ancillary Data - other aircraft.csv"]
        self.assertTrue(anc.excluded)
        used = {fid for a in self.graph.anomalies for fid in a.source_files}
        self.assertNotIn(anc.file_id, used)

    def test_recorder_series_are_on_the_utc_case_clock(self):
        alt = next(s for s in self.graph.series if s.name == "altitude_ft")
        self.assertAlmostEqual(alt.points[0][0], T0)
        self.assertEqual(alt.points[0][1], 6000)

    def test_upset_is_detected_as_measured_anomaly(self):
        self.assertTrue(self.graph.anomalies)
        upset_t = T0 + UPSET_ROW * .5
        near = [a for a in self.graph.anomalies if a.time.t_s is not None and abs(a.time.t_s - upset_t) < 30]
        self.assertTrue(near, "no anomaly within 30 s of the synthetic upset")
        for a in self.graph.anomalies:
            self.assertEqual(a.certainty, "measured")

    def test_every_atom_carries_a_citation(self):
        """Repository rule: no UI item without provenance."""
        file_ids = {f.file_id for f in self.graph.files}
        for kind in ("events", "anomalies", "facts"):
            for atom in getattr(self.graph, kind):
                with self.subTest(kind=kind, id=atom.id):
                    self.assertTrue(atom.citations, f"{kind} {atom.id} has no citation")
                    for c in atom.citations:
                        self.assertIn(c.file_id, file_ids)
                        self.assertTrue(c.quote.strip())

    def test_graph_is_persisted_and_reloadable(self):
        reloaded = CaseStore("e2e-synthetic").load_graph()
        self.assertEqual(reloaded.model_dump_json(), self.graph.model_dump_json())


if __name__ == "__main__":
    unittest.main()
