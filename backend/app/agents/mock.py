"""Offline stand-in for the LLM extractor (no API key / MOCK_LLM=1).

Regex-based: any line containing a clock time becomes an event, any line with anomaly keywords becomes an
anomaly. Quotes are real text, so the verifier, time aligner and UI can be exercised end-to-end for free.
"""
from __future__ import annotations

import re

from ..schemas import Extraction, LLMAnomaly, LLMCitation, LLMEvent, LLMTime
from ..timeparse import _HMS

ANOMALY_WORDS = re.compile(
    r"stall|stick shaker|warning|go.?around|deviat|did not|failed|failure|crack|fatigue|exceed|"
    r"unable|incorrect|not (?:follow|comply|perform)|disorient|startle|nose.?down|overspeed", re.I)
DOMAIN_GUESS = [
    (r"fatigue|sleep|rest|startle|disorient", "human_performance"),
    (r"train|check ?ride|proficien", "training_qualification"),
    (r"crack|fracture|corrosion", "structure"),
    (r"engine|n1|n2|egt", "powerplant"),
    (r"stall|pitch|airspeed|descent|altitude|overspeed", "flight_path_energy"),
    (r"controller|clearance|readback|frequency", "atc_communication"),
    (r"weather|wind|turbulence|convect|icing", "environment"),
    (r"maintenance|deferred|mel\b|logbook", "maintenance_airworthiness"),
]
DEFAULT_BASIS = {"atc": "utc", "fdr_report": "utc", "fdr_data": "utc", "cvr_transcript": "local",
                 "weather": "utc", "adsb_radar": "utc"}


def _category(line: str, role: str) -> str:
    l = line.lower()
    if re.search(r"\brdo|approach|center|tower|houston|\batc\b", l):
        return "atc_comm"
    if re.search(r"\b(cam|hot|int)\b", l) or role == "cvr_transcript":
        return "crew_comm"
    if re.search(r"warning|shaker|gpws|alert", l):
        return "alert_warning"
    return "aircraft_state"


def mock_extract(pages: list[str], role: str, max_events: int = 60, max_anoms: int = 12) -> Extraction:
    events, anomalies = [], []
    for pi, text in enumerate(pages, start=1):
        for line in (ln.strip() for ln in text.splitlines()):
            if len(line) < 12:
                continue
            if len(events) < max_events and _HMS.search(line):
                events.append(LLMEvent(
                    time=LLMTime(raw=_HMS.search(line).group(0), basis=DEFAULT_BASIS.get(role, "unknown")),
                    category=_category(line, role), description=line[:200], certainty="reported",
                    citations=[LLMCitation(page=pi, quote=line[:300])]))
            if len(anomalies) < max_anoms and ANOMALY_WORDS.search(line):
                domain = next((d for p, d in DOMAIN_GUESS if re.search(p, line, re.I)), "procedural_deviation")
                m = _HMS.search(line)
                anomalies.append(LLMAnomaly(
                    time=LLMTime(raw=m.group(0), basis=DEFAULT_BASIS.get(role, "unknown")) if m else None,
                    domain=domain, title=ANOMALY_WORDS.search(line).group(0).title(), expected="(mock) normal operation",
                    observed=line[:200], severity="significant", certainty="inferred",
                    citations=[LLMCitation(page=pi, quote=line[:300])]))
    return Extraction(summary=f"[mock] {len(events)} timed lines, {len(anomalies)} keyword hits", events=events,
                      anomalies=anomalies)
