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
export interface Anomaly {
  id: string; time: TimeRef | null; domain: string; title: string; expected: string; observed: string;
  severity: Severity; certainty: string; citations: Citation[]; source_files: string[];
  hfacs_layer: HfacsLayer | null; related_event_ids: string[]; verified: boolean | null;
}
export interface CausalEdge { source: string; target: string; relation: string; rationale: string; confidence: number }
export interface Hypothesis { id: string; title: string; narrative: string; supporting_anomaly_ids: string[]; contradicting_evidence: string[]; confidence: number }
export interface Conflict { id: string; description: string; atom_ids: string[]; preferred_atom_id: string | null; reason: string }

export type FileStatus = "queued" | "processing" | "done" | "skipped" | "error";
export interface SourceFile {
  file_id: string; name: string; rel_path: string; kind: string; ext: string; size: number; pages: number | null;
  scanned: boolean; docket_item: number | null; role: string; priority: number; excluded: boolean;
  exclude_reason: string | null; status: FileStatus; jobs_total: number; jobs_done: number; atoms: number;
  summary: string | null; error: string | null;
}
export interface TrackPoint { t_s: number | null; lat: number; lon: number; alt_ft: number | null; gs_kt: number | null }
export interface Series { name: string; unit: string; source_file: string; points: [number, number][] }
export interface CaseConfig { title: string; ntsb_id: string | null; date: string | null; aircraft: string | null; local_utc_offset_h: number; blind_mode: boolean }

export interface CaseGraph {
  case_id: string; config: CaseConfig; status: "created" | "running" | "done" | "error"; stage: string;
  files: SourceFile[]; clocks: Record<string, number>; events: Event[]; anomalies: Anomaly[];
  entities: { id: string; type: string; name: string; aliases: string[]; role: string | null }[];
  facts: { id: string; subject: string; predicate: string; value: string; citations: Citation[] }[];
  conflicts: Conflict[]; causal_edges: CausalEdge[]; hypotheses: Hypothesis[]; open_questions: string[];
  occurrence_categories: string[]; track: TrackPoint[]; series: Series[]; stats: Record<string, any>;
}

export type Selection = { kind: "event"; item: Event } | { kind: "anomaly"; item: Anomaly } | null;

export interface StreamMsg { seq?: number; type: string; ts?: number; [k: string]: any }
