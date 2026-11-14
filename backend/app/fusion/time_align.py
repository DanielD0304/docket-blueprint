"""Put every source onto one UTC clock.

Sources whose times are already UTC (ATC, FDR, METAR) or local (converted with the case offset) are
references. Other sources (CVR elapsed, unknown basis) get an offset from *anchor pairs*: the same radio
call / alert seen in both a reference source and the unaligned source. Offset = robust median.
Also reports residual offsets between reference sources (e.g. CVR local vs ATC UTC) as clock diagnostics.

TODO: LLM anchor proposer for semantic matches the string matcher misses; FDR mic-key discrete <-> radio calls.
"""
from __future__ import annotations

from collections import defaultdict
from statistics import median

from rapidfuzz import fuzz

from ..schemas import CaseGraph, Event
from ..timeparse import clock_seconds

ANCHOR_CATEGORIES = {"atc_comm", "alert_warning", "impact"}


def _norm(s: str) -> str:
    return " ".join(s.lower().replace("[", " ").replace("]", " ").split())


def local_seconds(atom) -> float | None:
    """Time on the source's own clock: a parsed clock string, or the position inside an audio/video file."""
    s = clock_seconds(atom.time.raw) if atom.time else None
    if s is not None:
        return s
    for c in atom.citations:
        if c.media_s is not None:
            return c.media_s
    return None


def align(graph: CaseGraph) -> dict:
    by_file: dict[str, list[Event]] = defaultdict(list)
    for e in graph.events:
        by_file[e.source_files[0]].append(e)

    refs = [e for e in graph.events if e.time.t_s is not None and e.category in ANCHOR_CATEGORIES]
    report: dict = {"aligned_files": {}, "unaligned_events": 0}

    for fid, evs in by_file.items():
        pending = [e for e in evs if e.time.t_s is None and local_seconds(e) is not None]
        if not pending:
            continue
        offsets = []
        for e in pending:
            if e.category not in ANCHOR_CATEGORIES:
                continue
            raw_s = local_seconds(e)
            best, best_score = None, 0.0
            for r in refs:
                if r.source_files[0] == fid:
                    continue
                sc = fuzz.token_set_ratio(_norm(e.description), _norm(r.description))
                if sc > best_score:
                    best, best_score = r, sc
            if best is not None and best_score >= 80:
                offsets.append(best.time.t_s - raw_s)  # type: ignore[operator]
        if not offsets:
            report["unaligned_events"] += len(pending)
            continue
        off = median(offsets)
        spread = median([abs(o - off) for o in offsets]) if len(offsets) > 1 else 5.0
        graph.clocks[fid] = off
        for e in pending:
            e.time.t_s = local_seconds(e) + off  # type: ignore[operator]
            e.time.uncertainty_s = max(1.0, spread)
            e.time.aligned_by = f"anchors:{len(offsets)}"
        report["aligned_files"][fid] = {"offset_s": off, "anchors": len(offsets), "spread_s": spread}

    # anomalies inherit times from their file's clock
    for a in graph.anomalies:
        if a.time and a.time.t_s is None:
            raw_s = local_seconds(a)
            fid = a.source_files[0]
            if raw_s is not None and fid in graph.clocks:
                a.time.t_s = raw_s + graph.clocks[fid]
                a.time.aligned_by = "file_clock"

    # diagnostics: disagreement between reference sources on the same anchor
    diag = []
    for i, a in enumerate(refs):
        for b in refs[i + 1:]:
            if a.source_files[0] != b.source_files[0] and a.category == b.category == "atc_comm":
                if fuzz.token_set_ratio(_norm(a.description), _norm(b.description)) >= 90:
                    diag.append(abs(a.time.t_s - b.time.t_s))  # type: ignore[operator]
    if diag:
        report["reference_clock_disagreement_s"] = {"median": median(diag), "n": len(diag)}
    return report
