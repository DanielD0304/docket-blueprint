// Derived, time-indexed views of the case graph used by the playback-driven sheets.
import type { Anomaly, CaseGraph, Event, Series } from "./types";

export type SeriesMap = Map<string, Series>;

export function seriesMap(series: Series[]): SeriesMap {
  const m = new Map<string, Series>();
  for (const s of series) if (s.points.length && !m.has(s.name)) m.set(s.name, s);
  if (!m.has("altitude_ft") && m.has("altitude_ft_adsb")) m.set("altitude_ft", m.get("altitude_ft_adsb")!);
  return m;
}

/** Linear interpolation at t; null outside the series' range (+-5 s tolerance). */
export function valueAt(s: Series | undefined, t: number | null): number | null {
  if (!s || t === null || !s.points.length) return null;
  const p = s.points;
  if (t < p[0][0] - 5 || t > p[p.length - 1][0] + 5) return null;
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p[mid][0] <= t) lo = mid; else hi = mid; }
  const [t0, v0] = p[lo], [t1, v1] = p[hi];
  if (t1 === t0 || t <= t0) return v0;
  if (t >= t1) return v1;
  return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

/** Values in [t - span, t] for sparklines. */
export function window_(s: Series | undefined, t: number | null, span = 90): [number, number][] {
  if (!s || t === null) return [];
  return s.points.filter(([x]) => x >= t - span && x <= t);
}

export function vsAt(m: SeriesMap, t: number | null): number | null {
  const direct = valueAt(m.get("vs_fpm"), t);
  if (direct !== null) return direct;
  const a = m.get("altitude_ft");
  if (!a || t === null) return null;
  const v1 = valueAt(a, t + 2), v0 = valueAt(a, t - 2);
  return v1 !== null && v0 !== null ? ((v1 - v0) / 4) * 60 : null;
}

/** Discrete FDR states (autopilot, stick shaker, gear, flaps...) reconstructed from transition events. */
export type DiscreteIndex = Map<string, { t: number; from: string; to: string }[]>;

export function discreteIndex(events: Event[]): DiscreteIndex {
  const idx: DiscreteIndex = new Map();
  for (const e of events) {
    if (e.certainty !== "measured" || e.time.t_s === null || !e.parameters.length) continue;
    const m = e.description.match(/^(.*?):\s*(.*?)\s*→\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key)!.push({ t: e.time.t_s, from: m[2], to: m[3] });
  }
  idx.forEach((v) => v.sort((a, b) => a.t - b.t));
  return idx;
}

export function stateAt(idx: DiscreteIndex, pattern: RegExp, t: number | null): { name: string; value: string; changed: number | null } | null {
  for (const [name, list] of idx) {
    if (!pattern.test(name)) continue;
    if (t === null) return { name, value: list[list.length - 1].to, changed: list[list.length - 1].t };
    let value = list[0].from, changed: number | null = null;
    for (const x of list) { if (x.t <= t) { value = x.to; changed = x.t; } else break; }
    return { name, value, changed };
  }
  return null;
}

// ---------------------------------------------------------------- aircraft zones

export type ZoneId =
  | "airdata" | "autoflight" | "cockpit" | "empennage" | "engines" | "wings" | "gear" | "structure" | "comms" | "environment";

export const ZONES: { id: ZoneId; label: string; sub: string }[] = [
  { id: "airdata", label: "AIR DATA · STALL PROTECTION", sub: "pitot-static · AoA · stick shaker" },
  { id: "autoflight", label: "AUTOFLIGHT", sub: "autopilot · autothrottle · modes" },
  { id: "cockpit", label: "FLIGHT DECK · CREW", sub: "CVR · crew actions · human factors" },
  { id: "empennage", label: "EMPENNAGE · PITCH CONTROL", sub: "elevator · stabilizer trim · rudder" },
  { id: "engines", label: "POWERPLANTS", sub: "N1 · thrust · engine events" },
  { id: "wings", label: "WINGS · HIGH LIFT", sub: "flaps · slats · spoilers · roll" },
  { id: "gear", label: "LANDING GEAR", sub: "gear · radio altitude" },
  { id: "structure", label: "STRUCTURE · MAINTENANCE", sub: "airframe · records · MEL" },
  { id: "comms", label: "COMMS · ATC", sub: "clearances · readbacks · radar" },
  { id: "environment", label: "ENVIRONMENT", sub: "weather · terrain · light" },
];

const RULES: [ZoneId, RegExp][] = [
  ["autoflight", /autopilot|a\/p\b|\bap\b|autothrot|a\/t\b|go.?around|\btoga\b|\bmode\b|\bfma\b|\bfmc\b|\blnav|\bvnav|flight director/i],
  ["airdata", /airspeed|pitot|static port|angle of attack|\baoa\b|stall|stick.?shak|air data|\bias\b|\bcas\b|mach/i],
  ["engines", /engine|\bn1\b|\bn2\b|\begt\b|thrust|throttle|powerplant|fuel|fan blade|\bepr\b/i],
  ["empennage", /elevator|stabili[sz]er|\btrim\b|column|yoke|rudder|pitch control|tail/i],
  ["wings", /flap|slat|spoiler|speedbrake|aileron|\bwing|\bbank|\broll\b|icing/i],
  ["gear", /\bgear\b|radio alt|radar alt|wheel|brake/i],
  ["structure", /crack|fatigue|corrosion|structur|fuselage|logbook|maintenance|\bmel\b|deferred|inspection|airworth/i],
  ["comms", /\batc\b|controller|approach|center|tower|clearance|readback|frequency|transponder|radar contact|radio/i],
  ["environment", /weather|metar|wind|turbulence|convect|cloud|visibility|precip|thunder|sunset|night|terrain/i],
];

const DOMAIN_ZONE: Record<string, ZoneId> = {
  human_performance: "cockpit", procedural_deviation: "cockpit", training_qualification: "cockpit",
  organizational_oversight: "cockpit", powerplant: "engines", structure: "structure",
  maintenance_airworthiness: "structure", atc_communication: "comms", environment: "environment",
  design_certification: "structure", survival: "structure",
};
const LANE_ZONE: Record<string, ZoneId> = { cockpit: "cockpit", crew: "cockpit", atc: "comms", environment: "environment", org: "structure" };

export function zoneOfText(text: string): ZoneId | null {
  for (const [z, re] of RULES) if (re.test(text)) return z;
  return null;
}

export function zoneOfEvent(e: Event): ZoneId {
  const txt = `${e.description} ${e.parameters.map((p) => p.name).join(" ")}`;
  if (e.lane === "atc") return "comms";
  if (e.lane === "environment") return "environment";
  return zoneOfText(txt) ?? LANE_ZONE[e.lane] ?? (e.category === "alert_warning" ? "airdata" : "cockpit");
}

export function zoneOfAnomaly(a: Anomaly): ZoneId {
  if (a.domain === "flight_path_energy") return zoneOfText(`${a.title} ${a.observed}`) ?? "airdata";
  return zoneOfText(`${a.title} ${a.observed}`) ?? DOMAIN_ZONE[a.domain] ?? "cockpit";
}

export interface ZoneData { events: Event[]; anomalies: Anomaly[] }

export function byZone(g: CaseGraph): Record<ZoneId, ZoneData> {
  const out = Object.fromEntries(ZONES.map((z) => [z.id, { events: [], anomalies: [] }])) as unknown as Record<ZoneId, ZoneData>;
  for (const e of g.events) out[zoneOfEvent(e)].events.push(e);
  for (const a of g.anomalies) out[zoneOfAnomaly(a)].anomalies.push(a);
  for (const z of ZONES) {
    out[z.id].events.sort((a, b) => (a.time.t_s ?? -1e12) - (b.time.t_s ?? -1e12));
  }
  return out;
}

// ---------------------------------------------------------------- provenance

const KIND_BY_ROLE: Record<string, string> = {
  fdr_data: "FDR", fdr_report: "FDR REPORT", cvr_transcript: "CVR", atc: "ATC", adsb_radar: "RADAR/ADS-B",
  ops_factual: "OPS REPORT", hp_factual: "HUMAN PERF.", interview: "INTERVIEW", weather: "WEATHER", maintenance: "MAINTENANCE",
  systems: "SYSTEMS REPORT", powerplants: "ENGINES REPORT", structures: "STRUCTURES", materials: "LAB REPORT",
  performance: "PERFORMANCE STUDY", party_submission: "PARTY CLAIM", manual: "MANUAL", simulation: "SIMULATOR",
  photo: "PHOTO", video: "VIDEO", audio: "AUDIO", survival: "SURVIVAL", other: "DOCUMENT",
};

export interface SourceInfo { kind: string; item: string; title: string; where: string; verified: boolean | null; n: number; tool: boolean }

/** Human-readable origin of an event / anomaly: which docket document, where in it, and how it was obtained. */
export function sourceOf(g: CaseGraph, atom: { source_files: string[]; citations: { file_id: string; page: number | null; media_s?: number | null; verified: boolean | null }[]; certainty: string }): SourceInfo {
  const c = atom.citations[0];
  const f = g.files.find((x) => x.file_id === (c?.file_id ?? atom.source_files[0]));
  if (!f) {
    const synthetic = g.case_id === "sample";
    return { kind: synthetic ? "SYNTHETIC" : "UNKNOWN", item: "", title: synthetic ? "synthetic demo data" : "unknown source", where: "", verified: c?.verified ?? null, n: atom.source_files.length, tool: false };
  }
  const kind = f.ext === ".ppb" ? "RADAR" : f.role === "adsb_radar" && f.kind === "table" ? "ADS-B" : KIND_BY_ROLE[f.role] ?? "DOCUMENT";
  const where = c?.media_s != null ? `▶ ${Math.floor(c.media_s / 60)}:${String(Math.floor(c.media_s % 60)).padStart(2, "0")}` : c?.page ? `p.${c.page}` : f.kind === "table" || f.ext === ".ppb" ? "data" : "";
  return {
    kind, item: f.docket_item ? `#${f.docket_item}` : "", title: f.name.replace(/^\d+\s*-\s*/, "").replace(/\.[^.]+$/, ""),
    where, verified: c?.verified ?? null, n: atom.source_files.length,
    tool: atom.certainty === "measured" && (f.kind === "table" || f.ext === ".ppb"),
  };
}

export function sourceLine(s: SourceInfo): string {
  return [s.kind, s.item, s.where].filter(Boolean).join(" ") + (s.n > 1 ? ` +${s.n - 1}` : "");
}

/** Time range for playback: recorder coverage if present, else timed events. */
export function playRange(g: CaseGraph): [number, number] | null {
  const ts: number[] = [];
  g.series.forEach((s) => { if (s.points.length) ts.push(s.points[0][0], s.points[s.points.length - 1][0]); });
  if (!ts.length) {
    g.events.forEach((e) => e.time.t_s !== null && ts.push(e.time.t_s));
    g.anomalies.forEach((a) => a.time?.t_s != null && ts.push(a.time.t_s));
  }
  if (!ts.length) return null;
  const hi = Math.max(...ts);
  const lo = Math.max(Math.min(...ts), hi - 4 * 3600); // keep playback to the last 4 h
  return [lo, hi];
}
