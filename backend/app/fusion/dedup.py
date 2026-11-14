"""Merge the same event / anomaly reported by several documents; resolve entity aliases.

Deterministic first pass (time window + text similarity). TODO: LLM adjudication for borderline pairs
and a Conflict Detector agent for merged atoms whose parameters disagree.
"""
from __future__ import annotations

from rapidfuzz import fuzz

from ..schemas import Anomaly, AnomalyObservation, CaseGraph, Conflict, Entity, Event

WINDOW_S = 3.0
SIM = 85


def _merge_events(events: list[Event]) -> tuple[list[Event], list[Conflict]]:
    timed = sorted([e for e in events if e.time.t_s is not None], key=lambda e: e.time.t_s)
    untimed = [e for e in events if e.time.t_s is None]
    merged: list[Event] = []
    conflicts: list[Conflict] = []
    for e in timed:
        target = None
        for m in reversed(merged):
            if e.time.t_s - m.time.t_s > WINDOW_S:  # type: ignore[operator]
                break
            if m.lane == e.lane and fuzz.token_set_ratio(m.description, e.description) >= SIM:
                target = m
                break
        if target is None:
            merged.append(e)
            continue
        target.citations += e.citations
        target.source_files = sorted(set(target.source_files) | set(e.source_files))
        target.corroboration = len(target.source_files)
        # parameter disagreement -> conflict
        tp = {p.name.lower(): p.value for p in target.parameters}
        for p in e.parameters:
            if p.name.lower() in tp and tp[p.name.lower()] != p.value:
                conflicts.append(Conflict(id=f"cf-{len(conflicts)}", atom_ids=[target.id, e.id],
                                          description=f"{p.name}: {tp[p.name.lower()]} vs {p.value}",
                                          reason="same event, different values across sources"))
    return merged + untimed, conflicts


def _merge_anomalies(anoms: list[Anomaly]) -> list[Anomaly]:
    out: list[Anomaly] = []
    for a in anoms:
        if not a.observations and a.time and a.time.t_s is not None:
            a.observations = [AnomalyObservation(start_s=a.time.t_s, citations=list(a.citations))]
        twin = next((o for o in out if o.domain == a.domain and
                     fuzz.token_set_ratio(o.title + " " + o.observed, a.title + " " + a.observed) >= SIM), None)
        if twin is None:
            out.append(a)
            continue
        twin.citations += a.citations
        # Keep individual observations: merging citations must not erase recurrences
        # or imply that a problem was continuous between distant observations.
        twin.observations += a.observations
        twin.source_files = sorted(set(twin.source_files) | set(a.source_files))
        sev = ["info", "minor", "significant", "critical"]
        if sev.index(a.severity) > sev.index(twin.severity):
            twin.severity = a.severity
    return out


def _merge_entities(ents: list[Entity]) -> list[Entity]:
    out: list[Entity] = []
    for e in ents:
        names = {e.name.lower(), *(x.lower() for x in e.aliases)}
        twin = next((o for o in out if o.type == e.type and
                     names & {o.name.lower(), *(x.lower() for x in o.aliases)}), None)
        if twin is None:
            out.append(e)
        else:
            twin.aliases = sorted(set(twin.aliases) | set(e.aliases) | ({e.name} - {twin.name}))
            twin.source_files = sorted(set(twin.source_files) | set(e.source_files))
            twin.role = twin.role or e.role
    return out


def dedup(graph: CaseGraph) -> dict:
    n_ev, n_an, n_en = len(graph.events), len(graph.anomalies), len(graph.entities)
    graph.events, conflicts = _merge_events(graph.events)
    graph.conflicts += conflicts
    graph.anomalies = _merge_anomalies(graph.anomalies)
    graph.entities = _merge_entities(graph.entities)
    return {"events": [n_ev, len(graph.events)], "anomalies": [n_an, len(graph.anomalies)],
            "entities": [n_en, len(graph.entities)], "conflicts": len(conflicts)}
