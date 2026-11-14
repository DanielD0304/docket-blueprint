"""Read-only, bounded evidence tools for the fusion investigator.

Only eligible case sources can be accessed. Recorder arithmetic stays here, on
the cached/downsampled profile series; it is never delegated to the model.
"""
from __future__ import annotations

import math
from pathlib import Path
from statistics import mean

from rapidfuzz import fuzz

from .. import pdfutil
from ..schemas import CaseGraph, Citation, InvestigatorToolCall


class EvidenceTools:
    def __init__(self, graph: CaseGraph, raw_dir: Path):
        self.graph = graph
        self.raw_dir = raw_dir.resolve()
        self.files = {f.file_id: f for f in graph.files if not f.excluded}
        self.atoms = {
            a.id: a for group in (graph.events, graph.anomalies, graph.facts) for a in group
            if any(c.file_id in self.files and c.verified is not False and c.quote for c in a.citations)
        }
        for sensor in graph.sensors:
            if sensor.source_file in self.files:
                self.atoms.update({a.id: a for a in [*sensor.states, *sensor.findings]
                                   if any(c.verified is not False and c.quote for c in a.citations)})
        # Only evidence actually returned by a tool can support the final output.
        self.seen: dict[str, list[Citation]] = {}

    def citations(self, atom) -> list[Citation]:
        return [c for c in atom.citations if c.file_id in self.files and c.verified is not False and c.quote]

    def _item(self, atom) -> dict:
        cs = self.citations(atom)[:4]
        self.seen[atom.id] = cs
        fields = atom.model_dump(exclude={"citations", "parameters", "source_files"})
        for k, v in fields.items():
            if isinstance(v, str):
                fields[k] = v[:1600]
        return {**fields, "citations": [c.model_dump() for c in cs[:4]]}

    def overview(self) -> dict:
        return {
            "counts": {"events": len(self.graph.events), "anomalies": len(self.graph.anomalies),
                       "facts": len(self.graph.facts), "conflicts": len(self.graph.conflicts)},
            "anomaly_index": [
                {"id": a.id, "title": a.title, "severity": a.severity, "domain": a.domain,
                 "t_s": a.time.t_s if a.time else None}
                for a in sorted(self.graph.anomalies, key=lambda a: (
                    {"critical": 0, "significant": 1, "minor": 2, "info": 3}[a.severity], a.id))[:150]
                if a.id in self.atoms
            ],
            "conflicts": [c.model_dump() for c in self.graph.conflicts[:20]],
            "sensors": [{"sensor_id": s.sensor_id, "file_id": s.source_file, "column": s.column,
                         "kind": s.kind, "status": s.status, "states": len(s.states),
                         "findings": len(s.findings)} for s in self.graph.sensors if s.source_file in self.files],
            "series": [{"name": s.name, "file_id": s.source_file, "unit": s.unit,
                        "start_s": s.points[0][0] if s.points else None,
                        "end_s": s.points[-1][0] if s.points else None}
                       for s in self.graph.series if s.source_file in self.files and s.clock_basis == "utc"],
        }

    def run(self, call: InvestigatorToolCall) -> dict:
        if call.tool == "list_sources":
            return {"sources": [{"file_id": f.file_id, "name": f.name, "role": f.role,
                                  "pages": f.pages, "scanned": f.scanned, "status": f.status,
                                  "error": f.error, "summary": (f.summary or "")[:500]}
                                 for f in self.files.values()][:200]}
        if call.tool == "search_evidence":
            if not call.query.strip():
                raise ValueError("query is required")
            candidates = [a for a in self.atoms.values()
                          if not call.file_id or any(c.file_id == call.file_id for c in self.citations(a))]
            terms = call.query.lower().split()
            def rank(a):
                text = " ".join(str(getattr(a, k, "")) for k in
                                ("title", "observed", "expected", "description", "subject", "predicate", "value", "label")).lower()
                return (sum(t in text for t in terms), fuzz.WRatio(call.query.lower(), text))
            candidates.sort(key=lambda a: (*rank(a), a.id), reverse=True)
            return {"evidence": [self._item(a) for a in candidates[:8] if rank(a)[0] > 0 or rank(a)[1] >= 65]}
        if call.tool == "inspect_evidence":
            return {"evidence": [self._item(self.atoms[i]) for i in call.evidence_ids[:8] if i in self.atoms],
                    "unavailable_ids": [i for i in call.evidence_ids[:8] if i not in self.atoms]}
        if call.tool == "timeline_window":
            if (call.start_s is None or call.end_s is None
                    or not all(map(math.isfinite, (call.start_s, call.end_s)))
                    or call.end_s < call.start_s or call.end_s - call.start_s > 7200):
                raise ValueError("An ordered UTC window of at most 7200 seconds is required")
            items = [a for a in self.atoms.values() if getattr(a, "time", None) and a.time.t_s is not None
                     and a.time.aligned_by != "mmss" and call.start_s <= a.time.t_s <= call.end_s
                     and (not call.file_id or any(c.file_id == call.file_id for c in self.citations(a)))]
            items.sort(key=lambda a: (a.time.t_s, a.id))
            return {"evidence": [self._item(a) for a in items[:20]], "total": len(items),
                    "truncated": len(items) > 20, "note": "Narrow the window if results are truncated."}
        if call.tool == "read_page":
            return self.read_page(call.file_id, call.page)
        if call.tool == "recorder_window":
            return self.recorder_window(call)
        if call.tool == "sensor_window":
            if (call.start_s is None or call.end_s is None
                    or not all(map(math.isfinite, (call.start_s, call.end_s)))
                    or not 0 <= call.end_s - call.start_s <= 7200):
                raise ValueError("An ordered finite UTC window of at most 7200 seconds is required")
            matches = [s for s in self.graph.sensors if s.source_file in self.files
                       and (not call.file_id or s.source_file == call.file_id)
                       and call.series_name in (s.sensor_id, s.column)]
            if len(matches) != 1:
                raise ValueError("Select an exact sensor_id or column and file_id from the overview")
            sensor = matches[0]
            items = [x for x in [*sensor.findings, *sensor.states]
                     if x.start_s <= call.end_s and x.end_s >= call.start_s]
            return {"sensor_id": sensor.sensor_id, "column": sensor.column, "unit": sensor.unit,
                    "status": sensor.status, "limitations": sensor.limitations,
                    "evidence": [self._item(x) for x in items[:40]], "total": len(items), "truncated": len(items) > 40}
        raise ValueError("unknown tool")

    def read_page(self, file_id: str, page: int) -> dict:
        f = self.files.get(file_id)
        if not f or f.kind != "pdf":
            raise ValueError("file_id must identify an eligible PDF")
        path = (self.raw_dir / f.rel_path).resolve()
        if not path.is_relative_to(self.raw_dir):
            raise ValueError("source path is outside the docket")
        if page < 1 or page > pdfutil.page_count(path):
            raise ValueError("page outside document")
        text = pdfutil.page_text(str(path), page - 1)[:12000]
        if not text.strip():
            return {"file_id": file_id, "page": page, "text": "", "limitation": "No text layer; no OCR performed."}
        passages = []
        for i in range(0, len(text), 300):
            eid = f"page:{file_id}:{page}:{i // 300 + 1}"
            citation = Citation(file_id=file_id, page=page, quote=text[i:i + 300], verified=True, score=100)
            self.seen[eid] = [citation]
            passages.append({"evidence_id": eid, "citations": [citation.model_dump()]})
        return {"file_id": file_id, "page": page, "passages": passages, "truncated": len(text) == 12000}

    def recorder_window(self, call: InvestigatorToolCall) -> dict:
        if call.start_s is None or call.end_s is None or not all(map(math.isfinite, (call.start_s, call.end_s))):
            raise ValueError("finite start_s and end_s in UTC seconds are required")
        if call.end_s < call.start_s or call.end_s - call.start_s > 7200:
            raise ValueError("window must be ordered and no longer than 7200 seconds")
        matches = [s for s in self.graph.series if s.name == call.series_name and s.source_file in self.files and s.clock_basis == "utc"
                   and (not call.file_id or s.source_file == call.file_id)]
        if len(matches) != 1:
            raise ValueError("select an exact series_name and file_id from the overview")
        s = matches[0]
        points = [(i, t, v) for i, (t, v) in enumerate(s.points)
                  if math.isfinite(t) and math.isfinite(v) and call.start_s <= t <= call.end_s]
        if not points:
            return {"samples": 0, "limitation": "No cached profile samples in this window."}
        values = [v for _, _, v in points]
        eid = f"series:{s.source_file}:{s.name}:{call.start_s:g}:{call.end_s:g}"
        quote = (f"Cached profile series {s.name}, sample rows {points[0][0] + 1}-{points[-1][0] + 1}; "
                 f"UTC seconds {points[0][1]:g}-{points[-1][1]:g}; n={len(points)}; "
                 f"min={min(values):g}, max={max(values):g}, mean={mean(values):g} {s.unit}")
        c = Citation(file_id=s.source_file, quote=quote, verified=True, score=100)
        self.seen[eid] = [c]
        return {"evidence_id": eid, "certainty": "measured", "samples": len(points), "unit": s.unit,
                "first": points[0][1:], "last": points[-1][1:], "min": min(values), "max": max(values),
                "mean": mean(values), "citations": [c.model_dump()],
                "limitation": "Computed from cached, downsampled profile samples, not full-resolution recorder rows. "
                              "Cannot establish exact peak values or transition times."}
