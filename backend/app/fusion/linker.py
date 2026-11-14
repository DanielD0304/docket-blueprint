"""Lead-investigator agent: HFACS layering, causal edges, competing hypotheses, open questions."""
from __future__ import annotations

import json

from ..agents.extractor import case_brief
from ..agents.llm import get_llm
from ..agents.prompts import LINKER_PROMPT
from ..config import MODEL_PRO
from ..schemas import CaseGraph, CausalEdge, Hypothesis, LinkerOutput
from ..timeparse import fmt

DEFAULT_LAYER = {
    "organizational_oversight": "organizational", "design_certification": "organizational",
    "training_qualification": "supervision", "maintenance_airworthiness": "supervision",
    "human_performance": "preconditions", "environment": "preconditions",
    "procedural_deviation": "unsafe_acts", "atc_communication": "unsafe_acts",
    "aircraft_system": "aircraft_environment", "powerplant": "aircraft_environment", "structure": "aircraft_environment",
    "flight_path_energy": "outcome", "survival": "outcome",
}
SEV_RANK = {"critical": 0, "significant": 1, "minor": 2, "info": 3}


def _mock_link(graph: CaseGraph) -> LinkerOutput:
    timed = sorted([a for a in graph.anomalies if a.time and a.time.t_s is not None], key=lambda a: a.time.t_s)
    edges = [{"source": a.id, "target": b.id, "relation": "precondition_of", "rationale": "[mock] temporal order",
              "confidence": 0.2} for a, b in zip(timed, timed[1:])][:30]
    return LinkerOutput.model_validate({
        "edges": edges,
        "hypotheses": [{"title": "[mock] hypothesis", "narrative": "Run with a Gemini key for real reasoning.",
                        "supporting_anomaly_ids": [a.id for a in timed[:5]], "confidence": 0.1}],
        "open_questions": ["[mock] Which anomalies are causal vs incidental?"],
    })


async def link(graph: CaseGraph) -> dict:
    for a in graph.anomalies:
        a.hfacs_layer = DEFAULT_LAYER.get(a.domain)  # type: ignore[assignment]
    anoms = sorted(graph.anomalies, key=lambda a: (SEV_RANK[a.severity], (a.time.t_s if a.time and a.time.t_s else 1e12)))[:150]
    if not anoms:
        return {"edges": 0}
    llm = get_llm()
    if llm.mock:
        out = _mock_link(graph)
    else:
        payload = {
            "anomalies": [{"id": a.id, "t": fmt(a.time.t_s) if a.time else None, "domain": a.domain, "title": a.title,
                           "expected": a.expected, "observed": a.observed, "severity": a.severity,
                           "certainty": a.certainty, "sources": len(a.source_files)} for a in anoms],
            "key_events": [{"id": e.id, "t": fmt(e.time.t_s), "lane": e.lane, "actor": e.actor, "what": e.description}
                           for e in sorted([e for e in graph.events if e.time.t_s is not None and e.category in
                                            ("alert_warning", "system_event", "crew_action", "atc_comm", "impact")],
                                           key=lambda e: e.time.t_s)[:250]],
        }
        out = await llm.structured(model=MODEL_PRO, system=LINKER_PROMPT + case_brief(graph.config),
                                   parts=[json.dumps(payload, ensure_ascii=False)], schema=LinkerOutput, temperature=0.3)

    ids = {a.id for a in graph.anomalies}
    by_id = {a.id: a for a in graph.anomalies}
    for l in out.layers:
        if l.anomaly_id in by_id:
            by_id[l.anomaly_id].hfacs_layer = l.layer
    graph.causal_edges = [CausalEdge(**e.model_dump()) for e in out.edges if e.source in ids and e.target in ids]
    graph.hypotheses = [Hypothesis(id=f"hy-{i}", **h.model_dump()) for i, h in enumerate(out.hypotheses)]
    for h in graph.hypotheses:
        h.supporting_anomaly_ids = [x for x in h.supporting_anomaly_ids if x in ids]
    graph.open_questions = out.open_questions
    graph.occurrence_categories = out.occurrence_categories
    return {"edges": len(graph.causal_edges), "hypotheses": len(graph.hypotheses)}
