"""HTTP smoke tests against the FastAPI app (no LLM, isolated DATA_DIR via conftest)."""
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import main
from app.config import DOCKETS_DIR
from app.schemas import CaseConfig
from app.store import CaseStore


def setUpModule():
    from app.config import DATA_DIR
    if "docket-blueprint-test-" not in str(DATA_DIR):  # set by conftest.py
        raise unittest.SkipTest("writes cases: run with pytest so DATA_DIR is an isolated temp dir")


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)

    def test_health(self):
        body = self.client.get("/api/health").json()
        self.assertTrue(body["ok"])
        self.assertTrue(body["mock"])  # conftest strips the key: tests can never hit Gemini

    def test_list_cases_is_json_list(self):
        r = self.client.get("/api/cases")
        self.assertEqual(r.status_code, 200)
        self.assertIsInstance(r.json(), list)

    def test_unknown_case_404(self):
        self.assertEqual(self.client.get("/api/cases/does-not-exist").status_code, 404)
        self.assertEqual(self.client.post("/api/cases/does-not-exist/rerun").status_code, 404)
        self.assertEqual(self.client.get("/api/cases/does-not-exist/files/x").status_code, 404)

    def test_created_case_without_graph(self):
        CaseStore("api-test-created").create(CaseConfig(title="API test"))
        body = self.client.get("/api/cases/api-test-created").json()
        self.assertEqual(body["status"], "created")
        self.assertEqual(body["config"]["title"], "API test")

    def test_local_case_rejects_missing_folder(self):
        r = self.client.post("/api/cases/local", json={"path": str(DOCKETS_DIR / "no-such-docket-xyz")})
        self.assertEqual(r.status_code, 400)

    def test_local_case_rejects_folders_outside_data_dir(self):
        with tempfile.TemporaryDirectory() as td, patch("app.main._start") as start:
            r = self.client.post("/api/cases/local", json={"path": td})
            r_up = self.client.post("/api/cases/local", json={"path": str(DOCKETS_DIR / ".." / ".." / "..")})
        self.assertEqual((r.status_code, r_up.status_code), (403, 403))
        start.assert_not_called()

    def test_local_case_short_name_starts_pipeline(self):
        (DOCKETS_DIR / "TEST00").mkdir(parents=True, exist_ok=True)
        with patch("app.main._start") as start:
            r = self.client.post("/api/cases/local", json={"path": "TEST00", "config": {"title": "Local"}})
        self.assertEqual(r.status_code, 200)
        start.assert_called_once_with(r.json()["case_id"])

    def test_cors_only_allows_the_dev_ui(self):
        ok = self.client.get("/api/health", headers={"Origin": "http://localhost:5173"})
        evil = self.client.get("/api/health", headers={"Origin": "https://evil.example"})
        self.assertEqual(ok.headers.get("access-control-allow-origin"), "http://localhost:5173")
        self.assertNotIn("access-control-allow-origin", evil.headers)

    def test_fusion_run_validates_turn_budget(self):
        r = self.client.post("/api/cases/x/fusion-runs", json={"fusion": "team", "max_turns": 99})
        self.assertEqual(r.status_code, 422)


if __name__ == "__main__":
    unittest.main()
