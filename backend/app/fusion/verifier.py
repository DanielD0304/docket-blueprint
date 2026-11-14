"""Check every citation quote against the actual page text. Unverifiable atoms are flagged, failed ones dropped."""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from rapidfuzz import fuzz

from .. import pdfutil
from ..config import VERIFY_THRESHOLD
from ..schemas import CaseGraph, Citation, SourceFile


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower()).strip()


def verify(graph: CaseGraph, raw_dir: Path, drop_failed: bool = True) -> dict:
    files: dict[str, SourceFile] = {f.file_id: f for f in graph.files}

    @lru_cache(maxsize=4096)
    def page_text(file_id: str, page: int) -> str | None:
        f = files.get(file_id)
        if not f or f.kind != "pdf" or f.scanned:
            return None
        try:
            path = raw_dir / f.rel_path
            n = pdfutil.page_count(path)
            pages = [p for p in (page - 1, page - 2, page) if 0 <= p < n]  # ±1 page tolerance
            return _norm(" ".join(pdfutil.page_text(str(path), p) for p in pages))
        except Exception:
            return None

    def check(c: Citation) -> None:
        if c.verified is not None:  # tool-generated (FDR rows) are pre-verified
            return
        if c.page is None or not c.quote or c.quote.startswith("IMAGE:"):
            return
        text = page_text(c.file_id, c.page)
        if text is None:
            return
        c.score = float(fuzz.partial_ratio(_norm(c.quote)[:300], text))
        c.verified = c.score >= VERIFY_THRESHOLD

    stats = {"checked": 0, "verified": 0, "failed": 0, "unverifiable": 0, "dropped": 0}

    def judge(atoms: list) -> list:
        kept = []
        for a in atoms:
            for c in a.citations:
                check(c)
                stats["checked"] += 1
                key = {True: "verified", False: "failed", None: "unverifiable"}[c.verified]
                stats[key] += 1
            vals = [c.verified for c in a.citations]
            a.verified = True if any(v is True for v in vals) else (None if any(v is None for v in vals) else False)
            if a.verified is False and drop_failed:
                stats["dropped"] += 1
                continue
            kept.append(a)
        return kept

    graph.events = judge(graph.events)
    graph.anomalies = judge(graph.anomalies)
    graph.facts = judge(graph.facts)
    return stats
