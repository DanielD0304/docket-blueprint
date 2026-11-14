import * as d3 from "d3";
import { useMemo } from "react";
import { fmtT } from "../api";
import { valueAt } from "../data";
import { displayPoints } from "../interpolation";
import type { Anomaly, Selection, Series } from "../types";
import { useSize } from "../useSize";

const LEFT = 90, TOP = 20, BOTTOM = 30;
const PREFERRED = ["altitude_ft", "altitude_ft_adsb", "airspeed_kt", "pitch_deg", "roll_deg", "radio_alt_ft"];

interface Props { series: Series[]; unresolvedFiles?: string[]; anomalies: Anomaly[]; cursor: number | null; setCursor: (t: number | null) => void; onSelect: (s: Selection) => void }

/** 2D vertical-profile drawing: stacked parameter bands on a shared UTC axis. */
export function Profile({ series, unresolvedFiles = [], anomalies, cursor, setCursor, onSelect }: Props) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const bands = useMemo(() => {
    const byName = new Map<string, Series>();
    series.forEach((s) => { if (s.clock_basis !== "unresolved" && !unresolvedFiles.includes(s.source_file) && !byName.has(s.name) && s.points.length) byName.set(s.name, s); });
    return PREFERRED.filter((n) => byName.has(n)).map((n) => byName.get(n)!).slice(0, 4);
  }, [series, unresolvedFiles]);

  const allT = bands.flatMap((b) => [b.points[0][0], b.points[b.points.length - 1][0]]);
  const x = d3.scaleLinear().domain(allT.length ? (d3.extent(allT) as [number, number]) : [0, 1]).range([LEFT, width - 16]);
  const bandH = (height - TOP - BOTTOM) / Math.max(1, bands.length);
  const anomT = anomalies.filter((a) => a.time?.t_s != null && a.time.t_s >= x.domain()[0] && a.time.t_s <= x.domain()[1]);

  return (
    <div className="sheet" ref={ref}>
      <svg width={width} height={height}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const mx = e.clientX - r.left; setCursor(mx > LEFT ? x.invert(mx) : null); }}
        onMouseLeave={() => setCursor(null)}>
        {bands.map((b, i) => {
          const y0 = TOP + i * bandH;
          const y = d3.scaleLinear().domain(d3.extent(b.points, (p) => p[1]) as [number, number]).nice().range([y0 + bandH - 8, y0 + 8]);
          const path = d3.line<[number, number]>().x((p) => x(p[0])).y((p) => y(p[1]))(displayPoints(b.points)) ?? "";
          const value = valueAt(b, cursor);
          const cv = cursor !== null && value !== null ? [cursor, value] : null;
          return (
            <g key={b.name}>
              <rect x={LEFT} y={y0} width={width - LEFT - 16} height={bandH} fill="none" stroke="var(--line-dim)" strokeWidth={0.5} />
              <text className="lane-label" x={10} y={y0 + 16}>{b.name.replace(/_/g, " ").toUpperCase()}</text>
              <g className="axis">
                {y.ticks(3).map((t) => (
                  <g key={t}><line x1={LEFT - 4} x2={LEFT} y1={y(t)} y2={y(t)} /><text x={LEFT - 6} y={y(t) + 3} textAnchor="end">{t}</text></g>
                ))}
              </g>
              <path key={`${b.name}-${b.points.length}`} className="draw" d={path} fill="none" stroke="var(--accent)" strokeWidth={1.4} />
              {cv && <g><circle cx={x(cv[0])} cy={y(cv[1])} r={3} fill="var(--warn)" />
                <text x={x(cv[0]) + 6} y={y(cv[1]) - 6} fill="var(--warn)" fontSize={10}>{cv[1].toFixed(1)} {b.unit}</text></g>}
            </g>
          );
        })}
        {anomT.map((a) => (
          <g key={a.id} className="anom" onClick={() => onSelect({ kind: "anomaly", item: a })}>
            <line x1={x(a.time!.t_s!)} x2={x(a.time!.t_s!)} y1={TOP} y2={height - BOTTOM}
              stroke={a.severity === "critical" ? "var(--crit)" : "var(--warn)"} strokeDasharray="2 3" />
            <title>{a.title}</title>
          </g>
        ))}
        <g className="axis">
          {x.ticks(8).map((t) => <text key={t} x={x(t)} y={height - 10} textAnchor="middle">{fmtT(t)}</text>)}
        </g>
        {cursor !== null && <line className="cursor-line" x1={x(cursor)} x2={x(cursor)} y1={TOP} y2={height - BOTTOM} />}
      </svg>
      {!bands.length && <div className="empty">No recorder / track series yet</div>}
      {(unresolvedFiles.length > 0 || series.some((s) => s.clock_basis === "unresolved")) &&
        <div className="profile-clock-note">ADS-B altitude awaits UTC hour alignment; showing resolved recorder clocks.</div>}
    </div>
  );
}
