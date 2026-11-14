"""Single source of truth for all data structures.

Two families:
  * LLM-facing models (prefix LLM*, plus Extraction / Triage / LinkerOutput) — kept simple
    so they work as Gemini `response_schema` (no dicts, no datetimes).
  * Stored models (Event, Anomaly, ... CaseGraph) — what the pipeline persists and the UI reads.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

DocRole = Literal[
    "cvr_transcript", "fdr_report", "fdr_data", "adsb_radar", "ops_factual", "hp_factual",
    "interview", "atc", "weather", "maintenance", "systems", "powerplants", "structures",
    "materials", "performance", "survival", "photo", "video", "audio", "manual", "simulation",
    "party_submission", "final_report", "docket_index", "other",
]
TimeBasis = Literal["utc", "local", "cvr_elapsed", "fdr_subframe", "relative", "unknown"]
EventCategory = Literal[
    "crew_action", "crew_comm", "atc_comm", "aircraft_state", "system_event", "alert_warning",
    "environment", "maintenance", "organizational", "impact", "post_impact",
]
Certainty = Literal["measured", "recorded", "reported", "inferred", "claimed"]
AnomalyDomain = Literal[
    "human_performance", "procedural_deviation", "aircraft_system", "powerplant", "structure",
    "flight_path_energy", "environment", "atc_communication", "maintenance_airworthiness",
    "training_qualification", "organizational_oversight", "design_certification", "survival",
]
Severity = Literal["info", "minor", "significant", "critical"]
HfacsLayer = Literal[
    "organizational", "supervision", "preconditions", "unsafe_acts", "aircraft_environment", "outcome",
]
Relation = Literal["precondition_of", "contributed_to", "triggered", "masked", "mitigated", "contradicts"]
EntityType = Literal["person", "aircraft", "component", "organization", "location", "other"]
Lane = Literal["crew", "cockpit", "atc", "aircraft", "systems", "environment", "org"]


# ---------------------------------------------------------------- LLM-facing

class LLMCitation(BaseModel):
    page: int | None = Field(None, description="1-based page number within the attached PDF")
    quote: str = Field(description="Verbatim excerpt (max ~300 chars) copied exactly from the document; for audio/video: verbatim speech or a precise description of what is seen/heard")
    media_time: str | None = Field(None, description="For audio/video only: position in the file as M:SS or H:MM:SS")


class LLMTime(BaseModel):
    raw: str = Field("", description="Time exactly as written, e.g. '1238:57 CST', '18:38:30 UTC', 'about 5 minutes later'")
    basis: TimeBasis = "unknown"


class Param(BaseModel):
    name: str
    value: str
    unit: str | None = None


class LLMEvent(BaseModel):
    time: LLMTime
    actor: str | None = Field(None, description="Who/what acted: 'Captain', 'First Officer', 'Houston Approach', 'Autopilot', 'Left engine'")
    category: EventCategory
    description: str
    parameters: list[Param] = []
    certainty: Certainty
    claimed_by: str | None = Field(None, description="For interviews/claims: who said it")
    citations: list[LLMCitation]


class LLMAnomaly(BaseModel):
    time: LLMTime | None = None
    domain: AnomalyDomain
    title: str = Field(description="Short label, <= 8 words")
    expected: str = Field(description="What SOP / manual / normal operation would be")
    observed: str = Field(description="What actually happened, per the document")
    severity: Severity
    certainty: Certainty
    citations: list[LLMCitation]


class LLMEntity(BaseModel):
    type: EntityType
    name: str
    aliases: list[str] = []
    role: str | None = None


class LLMFact(BaseModel):
    subject: str
    predicate: str
    value: str
    citations: list[LLMCitation]


class Extraction(BaseModel):
    summary: str = Field(description="2-3 sentence summary of what this document section contributes")
    events: list[LLMEvent] = []
    anomalies: list[LLMAnomaly] = []
    entities: list[LLMEntity] = []
    facts: list[LLMFact] = []


class Triage(BaseModel):
    doc_role: DocRole
    time_basis: TimeBasis
    priority: int = Field(description="1 = most important for reconstructing the accident sequence, 5 = least")
    title: str
    notes: str = ""


class LLMEdge(BaseModel):
    source: str = Field(description="anomaly id")
    target: str = Field(description="anomaly id")
    relation: Relation
    rationale: str
    confidence: float = Field(description="0..1")
    evidence_ids: list[str] = Field([], description="IDs returned by investigator tools supporting this relationship")


class LLMLayer(BaseModel):
    anomaly_id: str
    layer: HfacsLayer


class LLMHypothesisContribution(BaseModel):
    evidence_id: str
    role: Literal["supports", "challenges", "context"]
    explanation: str = Field(description="Explain specifically how this evidence supports, challenges, or contextualizes this hypothesis")


class LLMHypothesis(BaseModel):
    title: str
    narrative: str
    supporting_anomaly_ids: list[str]
    contradicting_evidence: list[str] = []
    confidence: float = Field(description="0..1")
    evidence_ids: list[str] = Field([], description="IDs returned by investigator tools supporting or challenging this hypothesis")
    contributions: list[LLMHypothesisContribution] = []


class LinkerOutput(BaseModel):
    layers: list[LLMLayer] = []
    edges: list[LLMEdge] = []
    hypotheses: list[LLMHypothesis] = []
    open_questions: list[str] = []
    occurrence_categories: list[str] = Field([], description="ICAO CICTT codes, e.g. LOC-I, CFIT, SCF-PP")


class InvestigatorToolCall(BaseModel):
    tool: Literal["list_sources", "search_evidence", "inspect_evidence", "timeline_window", "read_page", "recorder_window"]
    query: str = ""
    evidence_ids: list[str] = []
    file_id: str = ""
    page: int = 1
    series_name: str = ""
    start_s: float | None = None
    end_s: float | None = None


class InvestigatorDecision(BaseModel):
    question: str = Field(description="Short public investigation objective, not private reasoning")
    action: Literal["research", "conclude"]
    tools: list[InvestigatorToolCall] = []
    conclusion: LinkerOutput | None = None


# ---------------------------------------------------------------- stored

class Citation(BaseModel):
    file_id: str
    page: int | None = None
    media_s: float | None = None  # position in an audio/video file
    quote: str = ""
    verified: bool | None = None  # None = could not check (scan, no text layer)
    score: float | None = None


class TimeRef(BaseModel):
    raw: str = ""
    basis: TimeBasis = "unknown"
    t_s: float | None = None  # seconds since 00:00 UTC on the accident date
    uncertainty_s: float | None = None
    aligned_by: str | None = None


class Event(BaseModel):
    id: str
    time: TimeRef
    actor: str | None = None
    category: EventCategory
    lane: Lane
    description: str
    parameters: list[Param] = []
    certainty: Certainty
    claimed_by: str | None = None
    citations: list[Citation]
    source_files: list[str]
    corroboration: int = 1
    verified: bool | None = None


class AnomalyObservation(BaseModel):
    start_s: float
    end_s: float | None = None  # only set when a source/tool establishes duration
    citations: list[Citation]


class Anomaly(BaseModel):
    id: str
    time: TimeRef | None = None
    domain: AnomalyDomain
    title: str
    expected: str
    observed: str
    severity: Severity
    certainty: Certainty
    citations: list[Citation]
    source_files: list[str]
    hfacs_layer: HfacsLayer | None = None
    related_event_ids: list[str] = []
    verified: bool | None = None
    observations: list[AnomalyObservation] = []


class Entity(BaseModel):
    id: str
    type: EntityType
    name: str
    aliases: list[str] = []
    role: str | None = None
    source_files: list[str] = []


class Fact(BaseModel):
    id: str
    subject: str
    predicate: str
    value: str
    citations: list[Citation]
    verified: bool | None = None


class CausalEdge(BaseModel):
    source: str
    target: str
    relation: Relation
    rationale: str
    confidence: float
    evidence_ids: list[str] = []
    citations: list[Citation] = []


class HypothesisContribution(BaseModel):
    evidence_id: str
    role: Literal["supports", "challenges", "context"]
    explanation: str
    citations: list[Citation] = []


class Hypothesis(BaseModel):
    id: str
    title: str
    narrative: str
    supporting_anomaly_ids: list[str]
    contradicting_evidence: list[str] = []
    confidence: float
    evidence_ids: list[str] = []
    citations: list[Citation] = []
    contributions: list[HypothesisContribution] = []


class InvestigationStep(BaseModel):
    id: str
    turn: int
    phase: Literal["started", "question", "tool_call", "tool_result", "conclusion", "error", "finished"]
    title: str
    detail: str = ""
    tool: str | None = None
    evidence_ids: list[str] = []
    citations: list[Citation] = []


class InvestigationReport(BaseModel):
    status: Literal["running", "done", "budget_exhausted", "error"] = "running"
    model: str
    max_turns: int
    turns: int = 0
    tool_calls: int = 0
    rejected_claims: int = 0
    steps: list[InvestigationStep] = []


class Conflict(BaseModel):
    id: str
    description: str
    atom_ids: list[str]
    preferred_atom_id: str | None = None
    reason: str = ""


FileKind = Literal["pdf", "table", "image", "audio", "video", "text", "archive", "other"]
FileStatus = Literal["queued", "processing", "done", "skipped", "error"]


class SourceFile(BaseModel):
    file_id: str
    name: str
    rel_path: str
    kind: FileKind
    ext: str
    size: int
    sha256: str
    pages: int | None = None
    text_chars_per_page: float | None = None
    scanned: bool = False
    docket_item: int | None = None
    role: DocRole = "other"
    priority: int = 3
    excluded: bool = False
    exclude_reason: str | None = None
    status: FileStatus = "queued"
    jobs_total: int = 0
    jobs_done: int = 0
    atoms: int = 0
    summary: str | None = None
    error: str | None = None


class TrackPoint(BaseModel):
    t_s: float | None = None
    lat: float
    lon: float
    alt_ft: float | None = None
    gs_kt: float | None = None


class Series(BaseModel):
    name: str
    unit: str = ""
    source_file: str
    points: list[tuple[float, float]]  # (t_s, value)
    clock_basis: Literal["utc", "unresolved"] = "utc"


class CaseConfig(BaseModel):
    title: str = "Untitled case"
    ntsb_id: str | None = None
    date: str | None = None  # YYYY-MM-DD (UTC date of the accident)
    aircraft: str | None = None
    local_utc_offset_h: float = 0.0  # e.g. -6 for CST
    blind_mode: bool = True  # exclude final report / probable cause documents


class CaseGraph(BaseModel):
    case_id: str
    config: CaseConfig
    status: Literal["created", "running", "done", "error"] = "created"
    stage: str = "created"
    files: list[SourceFile] = []
    clocks: dict[str, float] = {}  # file_id -> applied offset (s)
    events: list[Event] = []
    anomalies: list[Anomaly] = []
    entities: list[Entity] = []
    facts: list[Fact] = []
    conflicts: list[Conflict] = []
    causal_edges: list[CausalEdge] = []
    hypotheses: list[Hypothesis] = []
    open_questions: list[str] = []
    occurrence_categories: list[str] = []
    track: list[TrackPoint] = []
    series: list[Series] = []
    stats: dict = {}
    investigation: InvestigationReport | None = None
