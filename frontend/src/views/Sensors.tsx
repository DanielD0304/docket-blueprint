import { useMemo, useState } from "react";
import { fmtT } from "../api";
import type { CaseGraph, Citation } from "../types";
import "./sensors.css";

export function Sensors({ g, cursor, setCursor, openSource }: {
  g: CaseGraph; cursor: number | null; setCursor: (t: number) => void; openSource: (c: Citation) => void;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [onlyFindings, setOnlyFindings] = useState(false);
  const sensors = g.sensors ?? [];
  const filtered = useMemo(() => sensors.filter((s) =>
    `${s.column} ${s.unit} ${s.source_file}`.toLowerCase().includes(query.toLowerCase()) &&
    (!onlyFindings || s.findings.length > 0)), [sensors, query, onlyFindings]);
  const sensor = filtered.find((s) => s.sensor_id === chosen) ?? filtered[0];
  const current = sensor?.states.find((s) => cursor !== null && s.start_s <= cursor && s.end_s >= cursor);
  const source = g.files.find((f) => f.file_id === sensor?.source_file);
  const points = sensor?.points ?? [];
  const loT = Math.min(...(sensor?.states.map((s) => s.start_s) ?? [0]));
  const hiT = Math.max(...(sensor?.states.map((s) => s.end_s) ?? [1]));
  const min = points.length ? Math.min(...points.map((p) => p[1])) : 0;
  const max = points.length ? Math.max(...points.map((p) => p[1])) : 1;
  const x = (t: number) => 45 + (t - loT) / (hiT - loT || 1) * 900;
  const y = (v: number) => 145 - (v - min) / (max - min || 1) * 120;
  const gaps = sensor?.plot_gaps ?? [];
  const path = points.map(([t, v], i) => {
    const prev = points[i - 1]?.[0];
    const split = i === 0 || t <= prev || gaps.some(([start, end]) => prev <= start && t >= end);
    return `${split ? "M" : "L"}${x(t)},${y(v)}`;
  }).join(" ");
  const evidence = (cs: Citation[]) => cs.map((c, i) => <button key={i} className="btn sensor-source"
    title={c.quote} onClick={() => openSource(c)}>Source · {c.quote}</button>);

  if (!sensors.length) return <div className="empty">No per-sensor analysis saved. Choose Rerun pipeline to analyze recorder channels. Rerun fusion uses previously saved evidence.</div>;
  return <div className="sensor-view">
    <aside className="sensor-list">
      <label>Find sensor<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Column, unit or source" /></label>
      <label><input type="checkbox" checked={onlyFindings} onChange={(e) => setOnlyFindings(e.target.checked)} /> With findings</label>
      <p>{filtered.length} / {sensors.length} sensors</p>
      {filtered.map((s) => <button key={s.sensor_id} className={`sensor-choice ${s === sensor ? "active" : ""}`} onClick={() => setChosen(s.sensor_id)}>
        <strong>{s.column}</strong><span>{s.unit || s.kind} · {s.states.length} states · {s.findings.length} findings</span>
        <small>{g.files.find((f) => f.file_id === s.source_file)?.name ?? s.source_file}</small>
      </button>)}
    </aside>
    <main className="sensor-detail">
      {!sensor ? <p>No matching sensors.</p> : <>
        <h2>{sensor.column} {sensor.unit && `(${sensor.unit})`}</h2>
        <p>{source?.name ?? sensor.source_file} · {sensor.samples.toLocaleString()} samples · {sensor.cadence_s == null ? "cadence unknown" : `${sensor.cadence_s.toPrecision(3)} s cadence`} · {sensor.status.replaceAll("_", " ")}</p>
        <p>At cursor: <strong>{current?.label ?? "no observed state"}</strong></p>
        {points.length > 0 && <svg className="sensor-plot" viewBox="0 0 980 185" role="img" aria-label={`${sensor.column} recorded samples; display downsampled`}>
          <text x="2" y="30">{max.toPrecision(4)}</text><text x="2" y="148">{min.toPrecision(4)}</text>
          <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.4" />
          {cursor !== null && cursor >= loT && cursor <= hiT && <line x1={x(cursor)} x2={x(cursor)} y1="10" y2="150" stroke="var(--warn)" />}
          <text x="45" y="177">{fmtT(loT)}</text><text x="945" y="177" textAnchor="end">{fmtT(hiT)}</text>
        </svg>}
        <p className="sensor-note">States and findings use native samples. The plot is downsampled; statistical rarity is not a fault probability.</p>
        <details><summary>Method, limitations and provenance</summary><p>{sensor.method}</p>{sensor.limitations.map((l) => <p key={l}>{l}</p>)}{evidence(sensor.citations)}</details>
        <h3>Findings ({sensor.findings.length})</h3>
        {!sensor.findings.length && <p>No candidates from the configured detectors.</p>}
        {sensor.findings.map((f) => <article key={f.id}>
          <button className="btn" onClick={() => setCursor(f.start_s)}>{fmtT(f.start_s)}–{fmtT(f.end_s)} · {f.kind.replaceAll("_", " ")}</button>
          <p>{f.description}</p>{evidence(f.citations)}
        </article>)}
        <h3>Observed states ({sensor.states.length})</h3>
        <div className="sensor-states">{sensor.states.map((s) => <details key={s.id} className={s === current ? "active" : ""}>
          <summary>{fmtT(s.start_s)}–{fmtT(s.end_s)} · {s.label} · {s.samples} samples</summary>
          <button className="btn" onClick={() => setCursor(s.start_s)}>Go to interval</button>
          {s.minimum !== null && <p>Min {s.minimum.toPrecision(5)} · median {s.median?.toPrecision(5)} · max {s.maximum?.toPrecision(5)} {sensor.unit}</p>}
          {evidence(s.citations)}
        </details>)}</div>
      </>}
    </main>
  </div>;
}
