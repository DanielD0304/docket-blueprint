import tempfile
import unittest
import zipfile
from pathlib import Path

from app.ingest.triage import apply_role, heuristic_role
from app.ingest.unzip import safe_extract
from app.schemas import SourceFile


def sf(name: str, kind: str = "pdf", ext: str = ".pdf") -> SourceFile:
    return SourceFile(file_id=name, name=name, rel_path=name, kind=kind, ext=ext, size=1, sha256="0")


class TriageTests(unittest.TestCase):
    def test_filename_roles(self):
        cases = [
            ("Cockpit Voice Recorder - Group Chairman's Factual Report.pdf", "pdf", "cvr_transcript"),
            ("Flight Data Recorder - Tabular Data.csv", "table", "fdr_data"),
            ("Flight Data Recorder Factual Report.pdf", "pdf", "fdr_report"),
            ("FDR attachment.csv", "table", "fdr_data"),  # tabular FDR is data even without 'tabular'
            ("ADS-B Data.csv", "table", "adsb_radar"),
            ("Radar Study.pdf", "pdf", "atc"),  # a radar *report* is a document, not a track
            ("Aircraft Accident Report AAR-20-02.pdf", "pdf", "final_report"),
            ("Party Submission - Boeing.pdf", "pdf", "party_submission"),
            ("FDR Ancillary Data.csv", "table", "ancillary"),
            ("cockpit_photo.jpg", "image", "photo"),
            ("random.csv", "table", "fdr_data"),
            ("random.pdf", "pdf", "other"),
        ]
        for name, kind, role in cases:
            with self.subTest(name=name):
                self.assertEqual(heuristic_role(sf(name, kind)), role)

    def test_ancillary_data_is_excluded(self):
        f = sf("FDR Ancillary Data.csv", "table", ".csv")
        apply_role(f, heuristic_role(f), blind_mode=False)
        self.assertTrue(f.excluded)
        self.assertIn("different aircraft", f.exclude_reason)

    def test_blind_mode_holds_out_final_report(self):
        for blind in (True, False):
            f = sf("Final Report.pdf")
            apply_role(f, heuristic_role(f), blind_mode=blind)
            self.assertEqual(f.excluded, blind)

    def test_media_is_scheduled_after_documents(self):
        f = sf("CVR audio.wav", "audio", ".wav")
        apply_role(f, "cvr_transcript", blind_mode=True)
        self.assertGreaterEqual(f.priority, 3)

    def test_unsupported_kinds_excluded(self):
        f = sf("blob.bin", "other", ".bin")
        apply_role(f, heuristic_role(f), blind_mode=True)
        self.assertTrue(f.excluded)


class SafeExtractTests(unittest.TestCase):
    def test_nested_zip_junk_and_zip_slip(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner = root / "inner.zip"
            with zipfile.ZipFile(inner, "w") as z:
                z.writestr("deep.txt", "deep")
            outer = root / "docket.zip"
            with zipfile.ZipFile(outer, "w") as z:
                z.writestr("a.txt", "a")
                z.writestr("__MACOSX/a.txt", "junk")
                z.writestr("../escape.txt", "evil")
                z.writestr("../out_sibling/escape.txt", "evil")
                z.write(inner, "nested/inner.zip")
            dest = root / "out"
            files = sorted(p.relative_to(dest).as_posix() for p in safe_extract(outer, dest))
            self.assertEqual(files, ["a.txt", "nested/inner/deep.txt"])
            self.assertFalse((root / "escape.txt").exists())
            self.assertFalse((root / "out_sibling").exists())


if __name__ == "__main__":
    unittest.main()
