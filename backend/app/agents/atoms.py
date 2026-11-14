"""Convert LLM extractions into stored, citation-carrying atoms."""
from __future__ import annotations

from ..schemas import Anomaly, Citation, Entity, Event, Extraction, Fact, LLMCitation, LLMTime, SourceFile, TimeRef
from ..timeparse import to_case_seconds

LANE_BY_CATEGORY = {
    "crew_action": "crew", "crew_comm": "cockpit", "atc_comm": "atc", "aircraft_state": "aircraft",
    "system_event": "systems", "alert_warning": "systems", "environment": "environment",
    "maintenance": "org", "organizational": "org", "impact": "aircraft", "post_impact": "aircraft",
}


def media_seconds(s: str | None) -> float | None:
    """'1:23' -> 83, '1:02:03' -> 3723, '83' -> 83."""
    if not s:
        return None
    try:
        parts = [float(p) for p in s.strip().split(":")]
    except ValueError:
        return None
    out = 0.0
    for p in parts:
        out = out * 60 + p
    return out


def _cites(cs: list[LLMCitation], f: SourceFile, page_offset: int) -> list[Citation]:
    media = f.kind in ("audio", "video")
    return [Citation(file_id=f.file_id, page=None if media else ((c.page + page_offset) if c.page else None),
                     media_s=media_seconds(c.media_time) if media else None, quote=c.quote.strip()[:400])
            for c in cs if c.quote and c.quote.strip()]


def _time(t: LLMTime | None, offset_h: float) -> TimeRef | None:
    if t is None:
        return None
    t_s, basis = to_case_seconds(t.raw, t.basis, offset_h)
    return TimeRef(raw=t.raw, basis=basis, t_s=t_s, uncertainty_s=1.0 if t_s is not None else None)  # type: ignore[arg-type]


def to_atoms(ext: Extraction, f: SourceFile, job_id: str, page_offset: int, offset_h: float) -> dict:
    """page_offset: document page index (0-based) of the chunk's first page; LLM pages are 1-based in-chunk,
    so document page (1-based) = llm_page + page_offset."""
    advocacy = f.role == "party_submission"
    events, anomalies, entities, facts = [], [], [], []
    if f.role == "simulation":
        # simulator re-enactments are evidence about behaviour, not part of the accident timeline
        for i, e in enumerate(ext.events):
            cites = _cites(e.citations, f, page_offset)
            if cites:
                facts.append(Fact(id=f"fa-{job_id}-s{i}", subject="simulator observation", predicate=e.time.raw or "during run",
                                  value=e.description, citations=cites))
        ext = ext.model_copy(update={"events": []})
    for i, e in enumerate(ext.events):
        cites = _cites(e.citations, f, page_offset)
        if not cites:
            continue
        events.append(Event(
            id=f"ev-{job_id}-{i}", time=_time(e.time, offset_h) or TimeRef(), actor=e.actor, category=e.category,
            lane=LANE_BY_CATEGORY.get(e.category, "aircraft"), description=e.description, parameters=e.parameters,
            certainty="claimed" if advocacy else e.certainty, claimed_by=e.claimed_by, citations=cites,
            source_files=[f.file_id],
        ))
    for i, a in enumerate(ext.anomalies):
        cites = _cites(a.citations, f, page_offset)
        if not cites:
            continue
        anomalies.append(Anomaly(
            id=f"an-{job_id}-{i}", time=_time(a.time, offset_h), domain=a.domain, title=a.title,
            expected=a.expected, observed=a.observed, severity=a.severity,
            certainty="claimed" if advocacy else a.certainty, citations=cites, source_files=[f.file_id],
        ))
    for i, en in enumerate(ext.entities):
        entities.append(Entity(id=f"en-{job_id}-{i}", type=en.type, name=en.name, aliases=en.aliases,
                               role=en.role, source_files=[f.file_id]))
    for i, fa in enumerate(ext.facts):
        cites = _cites(fa.citations, f, page_offset)
        if cites:
            facts.append(Fact(id=f"fa-{job_id}-{i}", subject=fa.subject, predicate=fa.predicate,
                              value=fa.value, citations=cites))
    return {
        "summary": ext.summary,
        "events": [x.model_dump() for x in events],
        "anomalies": [x.model_dump() for x in anomalies],
        "entities": [x.model_dump() for x in entities],
        "facts": [x.model_dump() for x in facts],
    }
