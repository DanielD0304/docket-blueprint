// The single time control: transport + lanes + anomalies + altitude backdrop. Drag to scrub, wheel to zoom.
import * as d3 from "d3";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtT } from "../api";
import { playRange, seriesMap } from "../data";
import type { CaseGraph, Event, Selection } from "../types";
import { useSize } from "../useSize";
import { SourceTag } from "../components/SourceTag";

export interface PlayState { playing: boolean; speed: number }

const LANES: { key: string; label: string; match: (e: Event) => boolean; color: string }[] = [
  { key: "voice", label: "CVR · CREW", match: (e) => e.lane === "cockpit" || e.lane === "crew", color: "var(--ink)" },
  { key: "atc", label: "ATC", match: (e) => e.lane === "atc", color: "var(--line)" },
  { key: "sys", label: "SYSTEMS", match: (e) => e.lane === "systems", color: "var(--warn)" },
  { key: "ac", label: "AIRCRAFT", match: (e) => e.lane === "aircraft", color: "var(--accent)" },
  { key: "env", label: "ENV · ORG", match: (e) => e.lane === "environment" || e.lane === "org", color: "var(--ink-dim)" },
];
const LEFT = 92, LANE_H = 17, AN_H = 22, AXIS_H = 16;
const SPEEDS = [1, 4, 16, 60];

interface Props {
  g: CaseGraph; cursor: number | null; setCursor: (t: number) => void;
  play: PlayState; setPlay: (p: PlayState) => void; selected: Selection; onSelect: (s: Selection) => void;
}

export function TimelineStrip({ g, cursor, setCursor, play, setPlay, selected, onSelect }: Props) {
  const range = useMemo(() => playRange(g), [g]);
  const [ref, { width }] = useSize<HTMLDivElement>();
  const [view, setView] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<{ x: number; e: Event } | null>(null);
  const H = AN_H + LANES.length * LANE_H + AXIS_H + 6;

  // default view: final 15 minutes (or everything if shorter)
  useEffect(() => {
    if (range && !view) setView(range[1] - range[0] > 900 ? [range[1] - 900, range[1] + 10] : [range[0] - 5, range[1] + 5]);
  }, [range, view]);
  const dom = view ?? [0, 1];
  const x = d3.scaleLinear().domain(dom).range([LEFT, Math.max(LEFT + 10, width - 10)]);

  // playback loop
  const cur = useRef(cursor); cur.current = cursor;
  useEffect(() => {
    if (!play.playing || !range) return;
    let raf = 0, last: number | null = null;
    const tick = (now: number) => {
      const dts = last === null ? 0 : (now - last) / 1000;
      last = now;
      let t = (cur.current ?? range[0]) + dts * play.speed;
      if (t >= range[1]) { t = range[1]; setPlay({ ...play, playing: false }); }
      setCursor(t);
      setView((v) => (v && t > v[1] - (v[1] - v[0]) * 0.08 ? [t - (v[1] - v[0]) * 0.5, t + (v[1] - v[0]) * 0.5] : v));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play.playing, play.speed, range?.[0], range?.[1]]);

  const toggle = () => {
    if (!range) return;
    if (!play.playing && (cur.current === null || cur.current >= range[1] - 0.5)) {
      const start = view ? view[0] : range[0];
      setCursor(Math.max(range[0], start));
    }
    setPlay({ ...play, playing: !play.playing });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Space") { e.preventDefault(); toggle(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const anomalies = useMemo(() => g.anomalies.filter((a) => a.time?.t_s != null), [g.anomalies]);
  const jump = (dir: 1 | -1) => {
    const now = cursor ?? range?.[1] ?? 0;
    const ts = anomalies.map((a) => a.time!.t_s!).sort((a, b) => a - b);
    const next = dir > 0 ? ts.find((t) => t > now + 1) : [...ts].reverse().find((t) => t < now - 1);
    if (next !== undefined) {
      setCursor(next - 3);
      if (view && (next < view[0] || next > view[1])) { const w = view[1] - view[0]; setView([next - w / 2, next + w / 2]); }
    }
  };
  const preset = (sec: number | null) => {
    if (!range) return;
    if (sec === null) return setView([range[0] - 5, range[1] + 5]);
    const c = cursor ?? range[1];
    const hi = Math.min(range[1] + 10, Math.max(c + sec * 0.3, range[0] + sec));
    setView([hi - sec, hi]);
  };

  // altitude backdrop
  const alt = useMemo(() => seriesMap(g.series).get("altitude_ft"), [g.series]);
  const altPath = useMemo(() => {
    if (!alt) return "";
    const pts = alt.points.filter(([t]) => t >= dom[0] - 60 && t <= dom[1] + 60);
    if (pts.length < 2) return "";
    const max = d3.max(alt.points, (p) => p[1]) || 1;
    const y = (v: number) => H - AXIS_H - (v / max) * (H - AXIS_H - 4);
    return `M${x(pts[0][0])},${H - AXIS_H} ` + pts.map(([t, v]) => `L${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(" ") + ` L${x(pts[pts.length - 1][0])},${H - AXIS_H} Z`;
  }, [alt, dom[0], dom[1], width]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = g.events.filter((e) => e.time.t_s !== null && e.time.t_s >= dom[0] && e.time.t_s <= dom[1]);
  const anVis = anomalies.filter((a) => a.time!.t_s! >= dom[0] && a.time!.t_s! <= dom[1]);
  const svgRef = useRef<SVGSVGElement>(null);

  const onPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current!; svg.setPointerCapture(e.pointerId);
    const set = (cx: number) => { const r = svg.getBoundingClientRect(); const px = cx - r.left; if (px >= LEFT) setCursor(x.invert(px)); };
    set(e.clientX);
    svg.onpointermove = (ev) => set(ev.clientX);
    svg.onpointerup = () => { svg.onpointermove = null; };
  };
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    const r = svgRef.current!.getBoundingClientRect();
    const t0 = x.invert(e.clientX - r.left);
    const k = e.deltaY > 0 ? 1.25 : 0.8;
    const w = Math.max(10, Math.min((range ? range[1] - range[0] : 3600) * 1.2, (dom[1] - dom[0]) * k));
    const u = (t0 - dom[0]) / (dom[1] - dom[0]);
    setView([t0 - u * w, t0 + (1 - u) * w]);
  };
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const li = Math.floor((py - AN_H) / LANE_H);
    if (li < 0 || li >= LANES.length) return setHover(null);
    let best: Event | null = null, bd = 7;
    for (const ev of visible) if (LANES[li].match(ev)) { const d = Math.abs(x(ev.time.t_s!) - px); if (d < bd) { bd = d; best = ev; } }
    setHover(best ? { x: x(best.time.t_s!), e: best } : null);
  };

  const pct = range && cursor !== null ? ((cursor - range[0]) / (range[1] - range[0] || 1)) * 100 : 100;
  return (
    <div className="strip">
      <div className="strip-head">
        <button className="btn" onClick={() => jump(-1)} title="Previous anomaly">⟨◆</button>
        <button className="btn primary play" onClick={toggle} title="Play / pause (space)">{play.playing ? "❚❚" : "▶"}</button>
        <button className="btn" onClick={() => jump(1)} title="Next anomaly">◆⟩</button>
        <div className="seg">{SPEEDS.map((s) => <button key={s} className={`btn ${play.speed === s ? "active" : ""}`} onClick={() => setPlay({ ...play, speed: s })}>{s}×</button>)}</div>
        <div className="seg">
          <button className="btn" onClick={() => preset(120)}>2 min</button>
          <button className="btn" onClick={() => preset(900)}>15 min</button>
          <button className="btn" onClick={() => preset(null)}>All</button>
        </div>
        <div className="overview" title="Whole recording">
          <div className="ov-fill" style={{ width: `${pct}%` }} />
          {range && view && <div className="ov-win" style={{ left: `${((view[0] - range[0]) / (range[1] - range[0] || 1)) * 100}%`, width: `${((view[1] - view[0]) / (range[1] - range[0] || 1)) * 100}%` }} />}
        </div>
        <div className="clock"><span className="t">{fmtT(cursor ?? range?.[1])}</span><span className="label">UTC · T−{range ? Math.max(0, Math.round(range[1] - (cursor ?? range[1]))) : 0}s</span></div>
      </div>
      <div ref={ref} className="strip-body">
        <svg ref={svgRef} width={width} height={H} onPointerDown={onPointer} onWheel={onWheel} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {altPath && <path d={altPath} fill="rgba(94,225,255,0.07)" stroke="rgba(94,225,255,0.3)" />}
          {LANES.map((l, i) => (
            <g key={l.key}>
              <line x1={LEFT} x2={width - 10} y1={AN_H + (i + 1) * LANE_H} y2={AN_H + (i + 1) * LANE_H} stroke="rgba(142,197,255,0.1)" />
              <text x={8} y={AN_H + i * LANE_H + 12} className="lane-label">{l.label}</text>
            </g>
          ))}
          <text x={8} y={15} className="lane-label" fill="var(--crit)">ANOMALIES</text>
          <g className="axis">
            {x.ticks(Math.max(3, Math.floor(width / 130))).map((tk) => (
              <g key={tk} transform={`translate(${x(tk)},0)`}>
                <line y1={AN_H} y2={H - AXIS_H} strokeDasharray="2 4" />
                <text y={H - 3} textAnchor="middle">{fmtT(tk)}</text>
              </g>
            ))}
          </g>
          {visible.map((e) => {
            const li = LANES.findIndex((l) => l.match(e));
            if (li < 0) return null;
            const xx = x(e.time.t_s!), y0 = AN_H + li * LANE_H;
            const sel = selected?.item.id === e.id;
            return <line key={e.id} x1={xx} x2={xx} y1={y0 + 3} y2={y0 + LANE_H - 3} stroke={sel ? "var(--accent)" : e.category === "alert_warning" ? "var(--warn)" : LANES[li].color}
              strokeWidth={sel ? 3 : 1.4} opacity={cursor !== null && e.time.t_s! > cursor ? 0.3 : 0.9} />;
          })}
          {anVis.map((a) => {
            const xx = x(a.time!.t_s!);
            const col = a.severity === "critical" ? "var(--crit)" : a.severity === "significant" ? "var(--warn)" : "var(--line)";
            const past = cursor === null || a.time!.t_s! <= cursor;
            return (
              <g key={a.id} className="anom" onPointerDown={(ev) => { ev.stopPropagation(); onSelect({ kind: "anomaly", item: a }); }}>
                <polygon points={`${xx},${4} ${xx + 7},${11} ${xx},${18} ${xx - 7},${11}`} fill={past ? col : "var(--paper)"} stroke={col} strokeWidth={1.5} />
                <title>{`${fmtT(a.time!.t_s)} ${a.title}`}</title>
              </g>
            );
          })}
          {cursor !== null && cursor >= dom[0] && cursor <= dom[1] && (
            <g pointerEvents="none">
              <line x1={x(cursor)} x2={x(cursor)} y1={0} y2={H - AXIS_H} stroke="var(--warn)" strokeWidth={2} />
              <path d={`M${x(cursor) - 5},0 L${x(cursor) + 5},0 L${x(cursor)},7 Z`} fill="var(--warn)" />
            </g>
          )}
        </svg>
        {hover && (
          <div className="strip-tip" style={{ left: Math.min(width - 300, Math.max(0, hover.x - 150)) }}>
            <div style={{ marginBottom: 3 }}><SourceTag g={g} atom={hover.e} long /></div>
            <span className="ft">{fmtT(hover.e.time.t_s)}</span><b>{hover.e.actor ? `${hover.e.actor}: ` : ""}</b>{hover.e.description.slice(0, 140)}
          </div>
        )}
      </div>
    </div>
  );
}
