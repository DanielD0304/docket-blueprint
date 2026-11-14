import { useMemo, useState } from "react";
import type { Anomaly, CausalEdge, HfacsLayer, Hypothesis, Selection } from "../types";
import { useSize } from "../useSize";

const LAYERS: [HfacsLayer, string][] = [
  ["organizational", "ORGANIZATIONAL"], ["supervision", "SUPERVISION"], ["preconditions", "PRECONDITIONS"],
  ["unsafe_acts", "UNSAFE ACTS"], ["aircraft_environment", "AIRCRAFT / ENV"], ["outcome", "OUTCOME"],
];
const NODE_W = 150, NODE_H = 34;

interface Props { anomalies: Anomaly[]; edges: CausalEdge[]; hypotheses: Hypothesis[]; selected: Selection; onSelect: (s: Selection) => void }

/** HFACS-layered causal graph, left (latent conditions) to right (outcome). */
export function CausalGraph({ anomalies, edges, hypotheses, selected, onSelect }: Props) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hyp, setHyp] = useState<string | null>(null);
  const inGraph = useMemo(() => {
    const ids = new Set(edges.flatMap((e) => [e.source, e.target]));
    hypotheses.forEach((h) => h.supporting_anomaly_ids.forEach((i) => ids.add(i)));
    const sev = { critical: 0, significant: 1, minor: 2, info: 3 } as const;
    const list = anomalies.filter((a) => ids.has(a.id));
    return (list.length ? list : anomalies.slice().sort((a, b) => sev[a.severity] - sev[b.severity]).slice(0, 30));
  }, [anomalies, edges, hypotheses]);

  const colW = (width - 40) / LAYERS.length;
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    LAYERS.forEach(([layer], li) => {
      const col = inGraph.filter((a) => (a.hfacs_layer ?? "outcome") === layer)
        .sort((a, b) => (a.time?.t_s ?? -1e12) - (b.time?.t_s ?? -1e12));
      const gap = Math.min(70, (height - 80) / Math.max(1, col.length));
      col.forEach((a, i) => m.set(a.id, { x: 20 + li * colW + (colW - NODE_W) / 2, y: 56 + i * gap }));
    });
    return m;
  }, [inGraph, colW, height]);

  const active = hyp ? new Set(hypotheses.find((h) => h.id === hyp)?.supporting_anomaly_ids ?? []) : null;
  const selId = selected?.item.id;

  return (
    <div className="sheet" ref={ref}>
      <div className="sheet-toolbar" style={{ flexWrap: "wrap", maxWidth: "60%", justifyContent: "flex-end" }}>
        {hypotheses.map((h) => (
          <button key={h.id} className={`btn ${hyp === h.id ? "active" : ""}`} title={h.narrative} onClick={() => setHyp(hyp === h.id ? null : h.id)}>
            {h.title.slice(0, 34)} · {Math.round(h.confidence * 100)}%
          </button>
        ))}
      </div>
      <svg width={width} height={height}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--line)" />
          </marker>
        </defs>
        {LAYERS.map(([k, label], i) => (
          <g key={k}>
            <rect x={20 + i * colW} y={28} width={colW - 6} height={height - 40} fill="none" stroke="var(--line-dim)" strokeDasharray="4 4" />
            <text className="lane-label" x={20 + i * colW + 6} y={44}>{label}</text>
          </g>
        ))}
        {edges.map((e, i) => {
          const a = pos.get(e.source), b = pos.get(e.target);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
          const back = x2 <= x1;
          const d = back
            ? `M${a.x + NODE_W / 2},${a.y + NODE_H} C${a.x + NODE_W / 2},${a.y + NODE_H + 40} ${b.x + NODE_W / 2},${b.y + NODE_H + 40} ${b.x + NODE_W / 2},${b.y + NODE_H}`
            : `M${x1},${y1} C${x1 + 50},${y1} ${x2 - 50},${y2} ${x2},${y2}`;
          const on = !active || (active.has(e.source) && active.has(e.target));
          return (
            <path key={i} d={d} fill="none" stroke={e.relation === "contradicts" ? "var(--crit)" : "var(--line)"}
              strokeWidth={0.8 + e.confidence * 2} opacity={on ? 0.85 : 0.12} markerEnd="url(#arrow)"
              className={on && active ? "flow" : ""}>
              <title>{`${e.relation} (${Math.round(e.confidence * 100)}%): ${e.rationale}`}</title>
            </path>
          );
        })}
        {inGraph.map((a) => {
          const p = pos.get(a.id); if (!p) return null;
          const col = a.severity === "critical" ? "var(--crit)" : a.severity === "significant" ? "var(--warn)" : "var(--line)";
          const on = !active || active.has(a.id);
          return (
            <g key={a.id} transform={`translate(${p.x},${p.y})`} opacity={on ? 1 : 0.25} style={{ cursor: "pointer", transition: "opacity .3s" }}
              onClick={() => onSelect({ kind: "anomaly", item: a })}>
              <rect width={NODE_W} height={NODE_H} fill={selId === a.id ? "rgba(94,225,255,0.18)" : "var(--paper-2)"} stroke={col} strokeWidth={selId === a.id ? 2 : 1} />
              <rect width={3} height={NODE_H} fill={col} />
              <text x={8} y={14} fontSize={10} fill="var(--ink)">{a.title.slice(0, 22)}</text>
              <text x={8} y={27} fontSize={9} fill="var(--ink-dim)">{a.domain.replace(/_/g, " ").slice(0, 24)}</text>
            </g>
          );
        })}
      </svg>
      {!inGraph.length && <div className="empty">Causal graph appears after the LINK stage</div>}
    </div>
  );
}
