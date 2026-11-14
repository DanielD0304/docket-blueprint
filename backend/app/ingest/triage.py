"""Classify each file's role in the docket. Filename heuristics first (NTSB titles are descriptive),
LLM triage on the first pages only when heuristics say 'other'."""
from __future__ import annotations

import re
from pathlib import Path

from .. import pdfutil
from ..schemas import SourceFile

# Order matters: first match wins.
RULES: list[tuple[str, str]] = [
    (r"final report|accident report|aar-?\d|board meeting|probable cause|abstract|preliminary report", "final_report"),
    (r"party submission|submission", "party_submission"),
    (r"ancillary", "ancillary"),
    (r"simulator", "simulation"),
    (r"cwsu|briefing", "weather"),
    (r"docket index|item list", "docket_index"),
    (r"cockpit voice|\bcvr\b", "cvr_transcript"),
    (r"(flight data recorder|\bfdr\b).*(tabular|data|attachment 1)|tabular data", "fdr_data"),
    (r"flight data recorder|\bfdr\b", "fdr_report"),
    (r"\bads ?b\b|radar", "adsb_radar"),  # names are normalised first: "ADS-B" -> "ads b"
    (r"air traffic|\batc\b|atis", "atc"),
    (r"human performance|\bhp\b", "hp_factual"),
    (r"interview", "interview"),
    (r"operations|ops_|\bops\b|training|crm|flight crew", "ops_factual"),
    (r"meteorolog|weather|metar", "weather"),
    (r"maintenance", "maintenance"),
    (r"powerplant|engine", "powerplants"),
    (r"systems", "systems"),
    (r"structur|wreckage", "structures"),
    (r"material|metallurg|fractograph", "materials"),
    (r"performance study|airplane performance|aircraft performance", "performance"),
    (r"survival|arff|medical|toxicolog|autopsy", "survival"),
    (r"manual|\bfcom\b|\bafm\b|\bqrh\b|procedure", "manual"),
]

# 1 = timeline skeleton, process first.
PRIORITY = {
    "cvr_transcript": 1, "fdr_data": 1, "atc": 1, "adsb_radar": 1, "ops_factual": 1,
    "fdr_report": 2, "performance": 2, "hp_factual": 2, "weather": 2, "systems": 2,
    "maintenance": 3, "powerplants": 3, "structures": 3, "materials": 3, "interview": 3,
    "manual": 4, "party_submission": 4, "survival": 5, "photo": 5, "video": 5, "audio": 5,
    "docket_index": 5, "final_report": 5, "other": 4,
}

KIND_ROLE = {"image": "photo", "video": "video", "audio": "audio"}

BLIND_EXCLUDE = {"final_report"}


def heuristic_role(sf: SourceFile) -> str:
    name = re.sub(r"[_\-]+", " ", sf.name.lower())
    for pattern, role in RULES:
        if re.search(pattern, name):
            if role == "fdr_data" and sf.kind != "table":
                role = "fdr_report"
            elif role == "fdr_report" and sf.kind == "table":
                role = "fdr_data"
            elif role == "adsb_radar" and sf.kind == "pdf":
                role = "atc"
            return role
    if sf.kind in KIND_ROLE:
        return KIND_ROLE[sf.kind]
    if sf.kind == "table":
        return "fdr_data"
    return "other"


def first_pages_text(path: Path, n: int = 3, max_chars: int = 6000) -> str:
    text = "\n".join(pdfutil.texts(path, 0, min(n, pdfutil.page_count(path)) - 1))
    return text[:max_chars]


def apply_role(sf: SourceFile, role: str, blind_mode: bool) -> None:
    if role == "ancillary":
        # Ancillary recorder data comes from *other* aircraft (e.g. a flight through the same weather);
        # feeding it in as this aircraft's FDR would corrupt the timeline.
        sf.role, sf.priority = "other", 5
        sf.excluded, sf.exclude_reason = True, "ancillary data from a different aircraft"
        return
    sf.role = role  # type: ignore[assignment]
    sf.priority = PRIORITY.get(role, 4)
    if sf.kind in ("audio", "video"):
        sf.priority = max(sf.priority, 3)  # media is slow + expensive: after the documents
    if role == "simulation":
        sf.priority = 5
    if blind_mode and role in BLIND_EXCLUDE:
        sf.excluded, sf.exclude_reason = True, "blind mode: held out as ground truth"
    if sf.ext == ".ppb":
        sf.role, sf.priority = "adsb_radar", 4  # parsed by tools/radar.py after the ADS-B CSV
    elif sf.kind in ("archive", "other"):
        sf.excluded, sf.exclude_reason = True, f"{sf.ext or sf.kind} not supported"
