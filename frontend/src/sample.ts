// SYNTHETIC demo data for UI development without a backend. Not derived from any real accident.
import type { Anomaly, CaseGraph, Event, Lane } from "./types";

export function makeSample(): CaseGraph {
  const T0 = 18 * 3600 + 30 * 60; // 18:30:00 UTC
  const N = 600;
  const lat0 = 29.7, lon0 = -94.9;
  const track = [];
  const S: Record<string, [number, number][]> = {};
  const put = (n: string, t: number, v: number) => (S[n] ??= []).push([t, v]);
  for (let i = 0; i < N; i++) {
    const t = T0 + i;
    const k = i / N;
    const up = i >= 505 && i < 520; // synthetic upset entry
    const a = i < 520 ? 12000 - k * 4000 + Math.sin(i / 40) * 150 : Math.max(0, 7300 - (i - 520) ** 2 * 1.4);
    const p = i < 505 ? 2 + Math.sin(i / 30) : up ? 4 - (i - 505) * 1.2 : -20 - (i - 520) * 0.15;
    track.push({ t_s: t, lat: lat0 + Math.cos(k * 3) * 0.25 * (1 - k * 0.5), lon: lon0 + Math.sin(k * 3) * 0.3, alt_ft: a, gs_kt: 250 + k * 60 });
    put("altitude_ft", t, a);
    put("airspeed_kt", t, 230 + k * 40 + (i > 520 ? (i - 520) * 1.5 : 0));
    put("pitch_deg", t, p);
    put("roll_deg", t, i < 505 ? 4 * Math.sin(i / 25) : 12 * Math.sin(i / 6));
    put("aoa_deg", t, i < 505 ? 3 + Math.sin(i / 30) : up ? 3 + (i - 505) * 0.9 : 1 - (i - 520) * 0.05);
    put("elevator_deg", t, i < 505 ? Math.sin(i / 15) : up ? -(i - 505) * 1.4 : -18 + Math.sin(i) * 2);
    put("stab_trim_deg", t, 4.5 - k * 0.6);
    put("n1_1", t, i < 505 ? 62 + Math.sin(i / 50) * 3 : 98);
    put("n1_2", t, i < 505 ? 61.5 + Math.sin(i / 47) * 3 : 97.4);
    put("flap_deg", t, i < 300 ? 0 : 1);
    put("nz_g", t, i < 505 ? 1 + Math.sin(i / 9) * 0.03 : up ? 1 - (i - 505) * 0.07 : 0.2);
    put("heading_deg", t, (270 + k * 40) % 360);
  }
  let uid = 0;
  const mk = (i: number, lane: Lane, cat: string, actor: string, desc: string): Event => ({
    id: `ev-s${i}-${uid++}`, time: { raw: "", basis: "utc", t_s: T0 + i, uncertainty_s: 1, aligned_by: "sample" }, actor, category: cat, lane,
    description: desc, parameters: [], certainty: "recorded", claimed_by: null,
    citations: [{ file_id: "sample", page: 1, quote: `SYNTHETIC: ${desc}`, verified: true, score: 100 }],
    source_files: ["sample"], corroboration: 1 + (i % 3), verified: true,
  });
  const events: Event[] = [];
  for (let i = 0; i < N; i += 9) {
    const lanes: [Lane, string, string][] = [["cockpit", "crew_comm", "Captain"], ["atc", "atc_comm", "Approach"], ["aircraft", "aircraft_state", "FDR"], ["crew", "crew_action", "First Officer"]];
    const [lane, cat, actor] = lanes[(i / 9) % 4 | 0];
    events.push(mk(i, lane, cat, actor, `${actor} synthetic event #${i}`));
  }
  const disc = (i: number, name: string, from: string, to: string, alert = false) => {
    const e = mk(i, "systems", alert ? "alert_warning" : "system_event", "FDR", `${name}: ${from} → ${to}`);
    e.certainty = "measured"; e.parameters = [{ name, value: to, unit: null }]; return e;
  };
  events.push(
    disc(300, "Flap Position", "UP", "1"),
    disc(10, "Landing Gear", "DOWN", "UP"),
    disc(504, "Go-Around Mode", "OFF", "ENGAGED"),
    disc(506, "Autothrottle", "SPD", "GA"),
    disc(508, "Autopilot Engaged", "ENGAGED", "DISENGAGED"),
    disc(516, "Stick Shaker", "OFF", "ON", true),
    disc(521, "Stick Shaker", "ON", "OFF", true),
    disc(530, "Master Caution", "OFF", "ON", true),
  );
  events.push(mk(-36000, "org", "maintenance", "Records", "Logbook: deferred item on pitch trim indication (synthetic)"));
  events.push(mk(460, "atc", "atc_comm", "Approach", "Approach: descend and maintain 3000 (synthetic)"));
  events.push(mk(-36000, "environment", "environment", "METAR", "METAR: SCT030 BKN050 (synthetic)"));
  const an = (i: number | null, title: string, domain: string, sev: Anomaly["severity"], layer: Anomaly["hfacs_layer"]): Anomaly => ({
    id: `an-s${uid++}`, time: i === null ? null : { raw: "", basis: "utc", t_s: T0 + i, uncertainty_s: 1, aligned_by: "sample" },
    domain, title, expected: "nominal (synthetic)", observed: `${title} (synthetic)`, severity: sev, certainty: "inferred",
    citations: [{ file_id: "sample", page: 2, quote: `SYNTHETIC: ${title}`, verified: true, score: 100 }],
    source_files: ["sample"], hfacs_layer: layer, related_event_ids: [], verified: true,
  });
  const witness = an(540, "Grinding noise from rear section", "structure", "significant", "aircraft_environment");
  witness.certainty = "claimed";
  witness.observed = "Witness on the shore reported a loud grinding noise coming from the back part of the aircraft (synthetic)";
  witness.citations[0].quote = "SYNTHETIC: I heard this grinding noise, it came from the back part of the plane";
  const anomalies = [
    an(240, "Engine 2 vibration rising", "powerplant", "significant", "aircraft_environment"),
    witness,
    an(null, "Training gaps noted", "training_qualification", "significant", "supervision"),
    an(null, "Oversight of hiring", "organizational_oversight", "minor", "organizational"),
    an(-40000, "Short rest period", "human_performance", "significant", "preconditions"),
    an(505, "Unexpected mode change", "aircraft_system", "significant", "aircraft_environment"),
    an(515, "No callout after mode change", "procedural_deviation", "significant", "unsafe_acts"),
    an(525, "Nose-down control input", "flight_path_energy", "critical", "unsafe_acts"),
    an(560, "Extreme descent rate", "flight_path_energy", "critical", "outcome"),
  ];
  const id = (t: string) => anomalies.find((a) => a.title === t)!.id;
  return {
    case_id: "sample", config: { title: "SYNTHETIC SAMPLE", ntsb_id: "SAMPLE", date: "2000-01-01", aircraft: "Generic twinjet", local_utc_offset_h: -6, blind_mode: true },
    status: "done", stage: "done",
    files: Array.from({ length: 24 }, (_, i) => ({
      file_id: `f${i}`, name: `${i + 1} - SYNTHETIC DOCUMENT ${i + 1}.pdf`, rel_path: "", kind: "pdf", ext: ".pdf", size: 1, pages: 10, scanned: false,
      docket_item: i + 1, role: ["cvr_transcript", "fdr_data", "atc", "ops_factual", "weather", "maintenance"][i % 6], priority: (i % 5) + 1,
      excluded: i === 23, exclude_reason: i === 23 ? "blind mode" : null, status: i === 23 ? "skipped" : "done", jobs_total: 2, jobs_done: 2, atoms: 10 + i, summary: null, error: null,
    })),
    clocks: {}, events, anomalies, entities: [], facts: [], conflicts: [],
    causal_edges: [
      { source: id("Oversight of hiring"), target: id("Training gaps noted"), relation: "precondition_of", rationale: "synthetic", confidence: 0.6 },
      { source: id("Training gaps noted"), target: id("No callout after mode change"), relation: "contributed_to", rationale: "synthetic", confidence: 0.5 },
      { source: id("Short rest period"), target: id("No callout after mode change"), relation: "contributed_to", rationale: "synthetic", confidence: 0.4 },
      { source: id("Unexpected mode change"), target: id("Nose-down control input"), relation: "triggered", rationale: "synthetic", confidence: 0.7 },
      { source: id("No callout after mode change"), target: id("Nose-down control input"), relation: "contributed_to", rationale: "synthetic", confidence: 0.5 },
      { source: id("Nose-down control input"), target: id("Extreme descent rate"), relation: "triggered", rationale: "synthetic", confidence: 0.9 },
      { source: id("Engine 2 vibration rising"), target: id("Grinding noise from rear section"), relation: "contributed_to", rationale: "Synthetic: progressive engine damage would produce audible grinding before failure", confidence: 0.5 },
      { source: id("Engine 2 vibration rising"), target: id("Unexpected mode change"), relation: "precondition_of", rationale: "synthetic", confidence: 0.3 },
    ],
    hypotheses: [
      { id: "hy-0", title: "Synthetic hypothesis A", narrative: "Illustrative only.", supporting_anomaly_ids: [id("Unexpected mode change"), id("Nose-down control input")], contradicting_evidence: [], confidence: 0.6 },
      { id: "hy-1", title: "Synthetic hypothesis B", narrative: "Illustrative only.", supporting_anomaly_ids: [id("Short rest period")], contradicting_evidence: ["synthetic"], confidence: 0.3 },
    ],
    open_questions: ["Synthetic open question"], occurrence_categories: ["LOC-I"],
    track, series: Object.entries(S).map(([name, points]) => ({ name, unit: "", source_file: "sample", points })),
    stats: { mock: true },
  };
}
