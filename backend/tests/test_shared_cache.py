"""A second run of the same docket must reuse Gemini extractions from the shared cache."""
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from app import store as store_mod
from app.schemas import CaseConfig


class SharedCacheTests(TestCase):
    def test_new_case_hits_shared_cache_and_stays_self_contained(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with patch.object(store_mod, "CASES_DIR", root / "cases"), \
                 patch.object(store_mod, "ATOM_CACHE_DIR", root / "atom_cache"):
                a, b, c = (store_mod.CaseStore(n) for n in ("run-a", "run-b", "run-c"))
                for s in (a, b, c):
                    s.create(CaseConfig())
                payload = {"summary": "s", "events": [], "anomalies": [], "entities": [], "facts": []}
                key = "abc123-p0-19-o-6"

                self.assertIsNone(b.load_atoms("abc123-p0-19", key))             # nothing cached yet
                a.save_atoms("abc123-p0-19", payload, key)
                self.assertEqual(b.load_atoms("abc123-p0-19", key), payload)      # new run: shared hit
                self.assertTrue((b.atoms_dir / "abc123-p0-19.json").exists())      # copied into the case
                self.assertIsNone(c.load_atoms("abc123-p0-19", "abc123-p0-19-o0"))  # other time offset: miss

    def test_case_local_results_backfill_the_shared_cache(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with patch.object(store_mod, "CASES_DIR", root / "cases"), \
                 patch.object(store_mod, "ATOM_CACHE_DIR", root / "atom_cache"):
                old, new = store_mod.CaseStore("old-run"), store_mod.CaseStore("new-run")
                old.create(CaseConfig()); new.create(CaseConfig())
                payload = {"summary": "old", "events": [], "anomalies": [], "entities": [], "facts": []}
                old.save_atoms("f-p0-9", payload)                  # written before the shared cache existed
                old.load_atoms("f-p0-9", "f-p0-9-o0")              # re-run of the old case backfills
                self.assertEqual(new.load_atoms("f-p0-9", "f-p0-9-o0"), payload)
