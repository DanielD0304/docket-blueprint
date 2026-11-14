import { memo, useMemo, useState } from "react";
import { fmtT } from "../api";
import type { CaseGraph, Citation, SensorAnalysis, SensorFinding, SensorState } from "../types";
import "./sensors.css";

const COLORS: Record<string, string> = { stable: "#5ee1ff", rising: "#6ee7a8", falling: "#ffb547", variable: "#bc9cff", insufficient_samples: "#657c98" };
const KINDS = { unusual_change: "Unusual change", level_outlier: "Rare level", sampling_gap: "Sampling gap" };
const fmt = (v: number | null | undefined) => v == null ? "—" : Number(v.toPrecision(5)).toLocaleString();
const color = (label: string) => COLORS[label] ?? ["#89b4ff", "#a69cfa", "#7bcdd1", "#b4ca89", "#d2b3ec"][[...label].reduce((n, c) => n + c.charCodeAt(0), 0) % 5];
const bounds = (s: SensorAnalysis): [number, number] => {
  const times = [...s.states.flatMap((x) => [x.start_s, x.end_s]), ...s.points.map((p) => p[0])];
  return times.length ? [Math.min(...times), Math.max(...times)] : [0, 1];
};

const Spark = memo(function Spark({ sensor }: { sensor: SensorAnalysis }) {
  const pts = sensor.points;
  if (!pts.length) return <div className="sx-mini-states">{sensor.states.slice(0, 60).map((s) => <i key={s.id} style={{ background: color(s.label), flex: Math.max(1, s.samples) }} />)}</div>;
  const [a, b] = bounds(sensor);
  const low = Math.min(...pts.map((p) => p[1])), high = Math.max(...pts.map((p) => p[1]));
  const gaps = sensor.plot_gaps ?? [];
  const path = pts.map(([t, v], i) => `${!i || t <= pts[i - 1][0] || gaps.some(([a, b]) => pts[i - 1][0] <= a && t >= b) ? "M" : "L"}${(t - a) / (b - a || 1) * 160},${27 - (v - low) / (high - low || 1) * 24}`).join(" ");
  return <svg viewBox="0 0 160 30" preserveAspectRatio="none" aria-hidden="true"><path d={path} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" /></svg>;
});

export function Sensors({ g, cursor, setCursor, openSource }: {
  g: CaseGraph; cursor: number | null; setCursor: (t: number) => void; openSource: (c: Citation) => void;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [onlyFindings, setOnlyFindings] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const sensors = g.sensors ?? [];
  const filtered = useMemo(() => sensors.filter((s) =>
    `${s.column} ${s.unit} ${s.source_file}`.toLowerCase().includes(query.toLowerCase()) &&
    (!onlyFindings || s.findings.length > 0)), [sensors, query, onlyFindings]);
  const sensor = filtered.find((s) => s.sensor_id === chosen) ?? filtered.find((s) => /^pitch$/i.test(s.column)) ?? filtered.find((s) => s.kind === "continuous") ?? filtered[0];
  const source = g.files.find((f) => f.file_id === sensor?.source_file);
  const [fullStart, fullEnd] = sensor ? bounds(sensor) : [0, 1];
  const span = Math.max(1, fullEnd - fullStart);
  const windowSize = zoom ? Math.min(zoom, span) : span;
  const windowStart = zoom ? Math.max(fullStart, Math.min(fullEnd - windowSize, (anchor ?? cursor ?? fullEnd) - windowSize / 2)) : fullStart;
  const windowEnd = windowStart + windowSize;
  const x = (t: number) => 62 + (t - windowStart) / windowSize * 904;
  const at = hover ?? cursor;
  const current = sensor?.states.find((s) => at !== null && s.start_s <= at && s.end_s >= at);
  const visibleStates = sensor?.states.filter((s) => s.end_s >= windowStart && s.start_s <= windowEnd) ?? [];
  const findings = sensor?.findings.filter((f) => f.end_s >= windowStart && f.start_s <= windowEnd) ?? [];
  const picked = sensor?.findings.find((f) => f.id === selected) ?? sensor?.states.find((s) => s.id === selected);
  const points = sensor?.points ?? [];
  const chartPoints = points.filter(([t], i) => t >= windowStart && t <= windowEnd ||
    (t < windowStart && points[i + 1]?.[0] >= windowStart) || (t > windowEnd && points[i - 1]?.[0] <= windowEnd));
  const low = chartPoints.length ? Math.min(...chartPoints.map((p) => p[1])) : 0;
  const high = chartPoints.length ? Math.max(...chartPoints.map((p) => p[1])) : 1;
  const pad = Math.max((high - low) * .12, Math.abs(high) * .01, .01);
  const y = (v: number) => 222 - (v - low + pad) / (high - low + pad * 2) * 180;
  const gaps = sensor?.plot_gaps ?? [];
  const path = chartPoints.map(([t, v], i) => {
    const prev = chartPoints[i - 1]?.[0];
    return `${i === 0 || t <= prev || gaps.some(([a, b]) => prev <= a && t >= b) ? "M" : "L"}${x(t)},${y(v)}`;
  }).join(" ");
  const nearest = at == null || !sensor ? undefined : points.reduce<[number, number] | undefined>((best, p) =>
    !best || Math.abs(p[0] - at) < Math.abs(best[0] - at) ? p : best, undefined);
  const displayedValue = current && nearest && Math.abs(nearest[0] - (at ?? 0)) <= Math.max((sensor?.cadence_s ?? 0) * 2, span / Math.max(1, points.length)) ? nearest[1] : null;
  const labels = [...new Set(visibleStates.map((s) => s.label))];
  const jump = (item: SensorState | SensorFinding) => { setSelected(item.id); setCursor(item.start_s); if (zoom) setAnchor(item.start_s); };
  const setRange = (seconds: number) => { setZoom(seconds); setAnchor(cursor ?? fullEnd); };
  const citations = (cs: Citation[]) => cs.map((c, i) => <button key={i} className="sx-source" title={c.quote} onClick={() => openSource(c)}><span>↗</span> Source {i + 1}<small>{c.quote}</small></button>);

  if (!sensors.length) return <div className="sx-empty"><span className="sx-crosshair">⌖</span><h2>Waiting for recorder channels</h2><p>Choose <b>Rerun pipeline</b> to generate sensor states and anomaly candidates.</p></div>;
  return <div className="sx-explorer">
    <aside className="sx-directory">
      <div className="sx-directory-head"><span className="sx-eyebrow">RECORDER / CHANNEL INDEX</span><div className="sx-directory-count"><b>{sensors.length}</b><span>sensor<br />channels</span></div>
        <input aria-label="Find sensor" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="⌕  Find a channel…" />
        <button className={`sx-filter ${onlyFindings ? "active" : ""}`} aria-pressed={onlyFindings} onClick={() => setOnlyFindings(!onlyFindings)}>◈ With findings <span>{sensors.filter((s) => s.findings.length).length}</span></button>
      </div>
      <nav aria-label="Recorder sensors" className="sx-channel-list">{filtered.map((s, i) => <button key={s.sensor_id} className={`sx-channel ${s === sensor ? "active" : ""}`} aria-pressed={s === sensor}
        onClick={() => { setChosen(s.sensor_id); setSelected(null); setHover(null); setZoom(0); }}>
        <span className="sx-channel-top"><small>{String(i + 1).padStart(2, "0")}</small><strong>{s.column}</strong>{s.findings.length > 0 && <em>{s.findings.length}</em>}</span>
        <Spark sensor={s} /><span className="sx-channel-bottom"><span>{s.unit || s.kind}</span><span>{s.states.length} states</span></span>
        <span className="sx-channel-file" title={g.files.find((f) => f.file_id === s.source_file)?.name}>{g.files.find((f) => f.file_id === s.source_file)?.name ?? s.source_file}</span>
      </button>)}{!filtered.length && <p className="sx-muted">No channels match this filter.</p>}</nav>
    </aside>
    <main className="sx-workspace">{sensor ? <>
      <header className="sx-heading"><div><span className="sx-eyebrow">SIGNAL EXPLORER / {sensor.kind.toUpperCase()}</span><h2>{sensor.column}<small>{sensor.unit}</small></h2><p title={source?.name}>{source?.docket_item ? `DOCKET ${source.docket_item} · ` : ""}{source?.name ?? sensor.source_file}</p></div><span className="sx-status"><i />{sensor.status.replaceAll("_", " ")}</span></header>
      <section className="sx-metrics" aria-label="Sensor summary">
        <div><span className="sx-eyebrow">{hover !== null ? "AT POINTER" : "AT PLAYHEAD"}</span><b style={{ color: current ? color(current.label) : undefined }}>{sensor.kind === "continuous" ? fmt(displayedValue) : current?.label ?? "—"}<small>{sensor.unit}</small></b><span>{at == null ? "Select a moment on the chart" : fmtT(at)}{displayedValue !== null ? " · nearest display sample" : ""}</span></div>
        <div><span className="sx-eyebrow">OBSERVED STATE</span><b className="sx-state-value" style={{ color: current ? color(current.label) : undefined }}>{current?.label.replaceAll("_", " ") ?? "No observation"}</b><span>{current ? `${fmtT(current.start_s)} — ${fmtT(current.end_s)}` : "No state asserted between observations"}</span></div>
        <div><span className="sx-eyebrow">NATIVE SAMPLES</span><b>{sensor.samples.toLocaleString()}</b><span>{sensor.cadence_s == null ? "Cadence unavailable" : `${fmt(sensor.cadence_s)} s median cadence`}</span></div>
      </section>
      <section className="sx-chart-card">
        <div className="sx-chart-toolbar"><span className="sx-eyebrow">{points.length ? "RECORDED SIGNAL" : "RECORDED STATES"} <i>UTC</i></span><div className="sx-ranges">{[[0, "Full recording"], [300, "5 min"], [60, "60 sec"]].map(([seconds, label]) => <button key={seconds} className={zoom === seconds ? "active" : ""} onClick={() => setRange(Number(seconds))}>{label}</button>)}</div></div>
        <svg className="sx-chart" viewBox="0 0 1000 335" role="group" aria-label={`${sensor.column}: signal, detected states and findings. Click to set playback time.`}
          onPointerMove={(e) => { const svg = e.currentTarget; const point = svg.createSVGPoint(); point.x = e.clientX; point.y = e.clientY; const matrix = svg.getScreenCTM(); const px = matrix ? point.matrixTransform(matrix.inverse()).x : -1; setHover(px >= 62 && px <= 966 ? windowStart + (px - 62) / 904 * windowSize : null); }}
          onPointerLeave={() => setHover(null)} onClick={() => hover !== null && setCursor(hover)}>
          <defs><clipPath id="sx-clip"><rect x="62" y="32" width="904" height="210" /></clipPath><linearGradient id="sx-fill" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#5ee1ff" stopOpacity=".15" /><stop offset="1" stopColor="#5ee1ff" stopOpacity="0" /></linearGradient></defs>
          {[0, 1, 2, 3, 4].map((i) => <g key={i}><line className="sx-grid" x1="62" x2="966" y1={42 + i * 45} y2={42 + i * 45} />{points.length > 0 && <text x="51" y={46 + i * 45} textAnchor="end">{fmt(high + pad - (high - low + 2 * pad) * i / 4)}</text>}</g>)}
          {[0, 1, 2, 3, 4, 5].map((i) => <g key={i}><line className="sx-grid" x1={62 + i * 904 / 5} x2={62 + i * 904 / 5} y1="32" y2="300" /><text x={62 + i * 904 / 5} y="325" textAnchor="middle">{fmtT(windowStart + i * windowSize / 5)}</text></g>)}
          <g clipPath="url(#sx-clip)">
            {findings.map((f) => <rect key={f.id} x={Math.max(62, x(f.start_s))} y="32" width={Math.max(3, x(Math.min(windowEnd, f.end_s)) - Math.max(62, x(f.start_s)))} height="210" fill={f.kind === "sampling_gap" ? "#7fa3c8" : "#ffb547"} opacity=".09" />)}
            {points.length > 0 ? <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" /> : visibleStates.map((s) => <g key={s.id}><rect x={x(Math.max(windowStart, s.start_s))} y="85" width={Math.max(2, x(Math.min(windowEnd, s.end_s)) - x(Math.max(windowStart, s.start_s)))} height="90" fill={color(s.label)} opacity=".18" /><text x={x(Math.max(windowStart, s.start_s)) + 7} y="135" style={{ fill: color(s.label) }}>{s.label}</text></g>)}
          </g>
          <text x="10" y="266" className="sx-axis-label">STATE</text>
          {visibleStates.map((s) => <rect key={s.id} x={x(Math.max(windowStart, s.start_s))} y="252" width={Math.max(1.5, x(Math.min(windowEnd, s.end_s)) - x(Math.max(windowStart, s.start_s)))} height="18" rx="2" fill={color(s.label)} opacity={current?.id === s.id ? 1 : .55} tabIndex={0} role="button" aria-label={`${s.label} at ${fmtT(s.start_s)}`}
            onClick={(e) => { e.stopPropagation(); jump(s); }} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && jump(s)}><title>{s.label} · {fmtT(s.start_s)}–{fmtT(s.end_s)}</title></rect>)}
          <text x="10" y="295" className="sx-axis-label">FLAGS</text>
          {findings.map((f, i) => <g key={f.id} className="sx-flag" role="button" tabIndex={0} aria-label={`${KINDS[f.kind]} at ${fmtT(f.start_s)}`} onClick={(e) => { e.stopPropagation(); jump(f); }} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && jump(f)}>
            <path d={`M${x(Math.max(windowStart, f.start_s))},280 l6,7 -6,7 -6,-7 z`} fill={f.kind === "sampling_gap" ? "#7fa3c8" : "#ffb547"} /><title>{i + 1}. {KINDS[f.kind]} · {fmtT(f.start_s)}</title></g>)}
          {at !== null && at >= windowStart && at <= windowEnd && <g pointerEvents="none"><line x1={x(at)} x2={x(at)} y1="30" y2="300" stroke="var(--ink)" strokeDasharray="3 4" />{displayedValue !== null && <circle cx={x(nearest![0])} cy={y(displayedValue)} r="4" fill="var(--paper)" stroke="var(--accent)" strokeWidth="2" />}</g>}
        </svg>
        <div className="sx-chart-footer"><div className="sx-legend">{labels.slice(0, 8).map((l) => <span key={l}><i style={{ background: color(l) }} />{l.replaceAll("_", " ")}</span>)}</div><span>Hover to inspect · click to seek</span></div>
      </section>
      <section className="sx-observations"><div className="sx-section-heading"><h3>Detected episodes <span>{findings.length}</span></h3><span>Within visible window</span></div>
        <div className="sx-episodes">{findings.map((f, i) => <button key={f.id} className={`sx-episode ${selected === f.id ? "active" : ""}`} onClick={() => jump(f)}><span className="sx-episode-top"><span>◈ {KINDS[f.kind]}</span><small>{String(i + 1).padStart(2, "0")}</small></span><b>{fmtT(f.start_s)}</b><div className="sx-episode-range"><i style={{ width: `${Math.max(3, Math.min(100, (f.end_s - f.start_s) / windowSize * 100))}%` }} /></div><span>{f.score == null ? "Observed sampling gap" : `${fmt(f.score)}× robust scale`} <em>↗</em></span></button>)}{!findings.length && <div className="sx-quiet"><span>✓</span><div>No candidates in this window<small>Recorded states remain available in the colored strip above.</small></div></div>}</div>
      </section>
      {picked && <section className="sx-evidence"><div className="sx-section-heading"><h3>{"kind" in picked ? KINDS[picked.kind] : `${picked.label} state`}</h3><button className="sx-text-button" onClick={() => setSelected(null)}>Close ×</button></div><p>{"description" in picked ? picked.description : `${picked.samples.toLocaleString()} observed samples · ${fmtT(picked.start_s)}–${fmtT(picked.end_s)}${picked.minimum !== null ? ` · range ${fmt(picked.minimum)} to ${fmt(picked.maximum)} ${sensor.unit}` : ""}`}</p><div className="sx-evidence-sources">{citations(picked.citations)}</div></section>}
      <footer className="sx-method"><span>Native-sample detection · downsampled display · statistical candidates, not fault probabilities</span><details><summary>Method & provenance</summary><p>{sensor.method}</p>{sensor.limitations.map((l) => <p key={l}>{l}</p>)}{citations(sensor.citations)}</details></footer>
    </> : <div className="sx-empty"><span className="sx-crosshair">⌕</span><h2>No matching channels</h2><p>Try another sensor name or clear the findings filter.</p></div>}</main>
  </div>;
}
