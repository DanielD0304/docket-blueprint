// Mirrors backend/app/schemas.py (stored models).

export type Lane = "crew" | "cockpit" | "atc" | "aircraft" | "systems" | "environment" | "org";
export type Severity = "info" | "minor" | "significant" | "critical";
export type HfacsLayer =
  | "organizational" | "supervision" | "preconditions" | "unsafe_acts" | "aircraft_environment" | "outcome";

export interface Citation { file_id: string; page: number | null; quote: string; verified: boolean | null; score: number | null; media_s?: number | null }
export interface TimeRef { raw: string; basis: string; t_s: number | null; uncertainty_s: number | null; aligned_by: string | null }
export interface Param { name: string; value: string; unit: string | null }

export interface Event {
  id: string; time: TimeRef; actor: string | null; category: string; lane: Lane; description: string;
  parameters: Param[]; certainty: string; claimed_by: string | null; citations: Citation[];
  source_files: string[]; corroboration: number; verified: boolean | null;
}
export interface AnomalyObservation { start_s: number; end_s: number | null; citations: Citation[] }
export interface Anomaly {
  id: string; time: TimeRef | null; domain: string; title: string; expected: string; observed: string;
  severity: Severity; certainty: string; citations: Citation[]; source_files: string[];
  hfacs_layer: HfacsLayer | null; related_event_ids: string[]; verified: boolean | null;
  observations?: AnomalyObservation[];
}
export interface CausalEdge { source: string; target: string; relation: string; rationale: string; confidence: number; evidence_ids?: string[]; citations?: Citation[] }
export interface HypothesisContribution { evidence_id: string; role: "supports" | "challenges" | "context"; explanation: string; citations?: Citation[] }
export interface Hypothesis { id: string; title: string; narrative: string; supporting_anomaly_ids: string[]; contradicting_evidence: string[]; confidence: number; evidence_ids?: string[]; citations?: Citation[]; contributions?: HypothesisContribution[] }
export interface Conflict { id: string; description: string; atom_ids: string[]; preferred_atom_id: string | null; reason: string }

export type FileStatus = "queued" | "processing" | "done" | "skipped" | "error";
export interface SourceFile {
  file_id: string; name: string; rel_path: string; kind: string; ext: string; size: number; pages: number | null;
  scanned: boolean; docket_item: number | null; role: string; priority: number; excluded: boolean;
  exclude_reason: string | null; status: FileStatus; jobs_total: number; jobs_done: number; atoms: number;
  summary: string | null; error: string | null;
}
export interface TrackPoint { t_s: number | null; lat: number; lon: number; alt_ft: number | null; gs_kt: number | null }
export interface Series { name: string; unit: string; source_file: string; points: [number, number][]; clock_basis?: "utc" | "unresolved" }
export interface InvestigationStep {
  id: string; turn: number; phase: "started" | "question" | "tool_call" | "tool_result" | "conclusion" | "error" | "finished";
  title: string; detail: string; tool: string | null; evidence_ids: string[]; citations: Citation[];
  agent_id?: string; agent_name?: string; parent_step_id?: string | null;
}
export interface InvestigationFinding { id: string; title: string; explanation: string; evidence_ids: string[]; citations: Citation[]; stance: "supports" | "challenges" | "context" }
export interface InvestigationConclusion {
  summary: string; evidence_ids: string[]; findings: InvestigationFinding[]; preferred_hypothesis_id: string | null;
  alternative_hypothesis_ids: string[]; limitations: string[]; citations: Citation[]; status: "supported" | "incomplete";
}
export interface InvestigationAgent {
  id: string; name: string; role: string; status: "queued" | "running" | "done" | "budget_exhausted" | "error";
  turns: number; tool_calls: number; max_turns: number; summary: string; evidence_ids: string[];
  citations: Citation[]; findings: InvestigationFinding[];
}
export interface InvestigationCoverage { eligible_sources: number; total_evidence: number; inspected_evidence: number; inspected_sources: number; pages_read: number; recorder_checks: number }
export interface InvestigationReport {
  status: "running" | "done" | "budget_exhausted" | "error"; model: string; max_turns: number;
  turns: number; tool_calls: number; rejected_claims: number; steps: InvestigationStep[];
  mode?: "single" | "team"; agents?: InvestigationAgent[]; conclusion?: InvestigationConclusion | null; coverage?: InvestigationCoverage | null;
}
export interface CaseConfig { title: string; ntsb_id: string | null; date: string | null; aircraft: string | null; local_utc_offset_h: number; blind_mode: boolean }

export interface CaseGraph {
  case_id: string; config: CaseConfig; status: "created" | "running" | "done" | "error"; stage: string;
  files: SourceFile[]; clocks: Record<string, number>; events: Event[]; anomalies: Anomaly[];
  entities: { id: string; type: string; name: string; aliases: string[]; role: string | null }[];
  facts: { id: string; subject: string; predicate: string; value: string; citations: Citation[] }[];
  conflicts: Conflict[]; causal_edges: CausalEdge[]; hypotheses: Hypothesis[]; open_questions: string[];
  occurrence_categories: string[]; track: TrackPoint[]; series: Series[]; stats: Record<string, any>;
  sensors?: SensorAnalysis[];
  investigation?: InvestigationReport | null;
}

export type Selection = { kind: "event"; item: Event } | { kind: "anomaly"; item: Anomaly } | null;

export interface StreamMsg { seq?: number; type: string; ts?: number; [k: string]: any }

export interface SensorState {
  id: string; label: string; start_s: number; end_s: number; first_row: number; last_row: number;
  samples: number; minimum: number | null; maximum: number | null; median: number | null;
  citations: Citation[]; certainty: string; verified: boolean;
}
export interface SensorFinding {
  id: string; kind: "unusual_change" | "level_outlier" | "sampling_gap"; description: string;
  start_s: number; end_s: number; score: number | null; citations: Citation[]; certainty: string; verified: boolean;
}
export interface SensorAnalysis {
  sensor_id: string; source_file: string; column: string; unit: string;
  kind: "continuous" | "discrete" | "unsupported";
  status: "analyzed" | "insufficient_samples" | "unresolved_clock" | "no_samples" | "unsupported";
  samples: number; cadence_s: number | null; method: string; limitations: string[];
  states: SensorState[]; findings: SensorFinding[]; points: [number, number][]; plot_gaps: [number, number][]; citations: Citation[];
}
