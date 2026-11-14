// Causal graph as a layered DAG: columns = causal depth (root causes left → outcomes right),
// rows ordered by barycenter to reduce crossings. Hover a node to trace its upstream causes and downstream effects.
import * as d3 from "d3";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtT } from "../api";
import type { Anomaly, CausalEdge, HfacsLayer, Hypothesis, Selection } from "../types";
import { useSize } from "../useSize";

const W = 210, H = 54, COL_GAP = 110, ROW_GAP = 18, PAD = 40;
export const HFACS: Record<HfacsLayer, { label: string; color: string }> = {
  organizational: { label: "Organizational", color: "#c79bff" },
  supervision: { label: "Supervision", color: "#8ec5ff" },
  preconditions: { label: "Preconditions", color: "#5ee1ff" },
  unsafe_acts: { label: "Unsafe acts", color: "#ffb547" },
  aircraft_environment: { label: "Aircraft / env.", color: "#6ee7a8" },
  outcome: { label: "Outcome", color: "#ff5d5d" },
};
const SEV = { critical: "var(--crit)", significant: "var(--warn)", minor: "var(--line)", info: "var(--ink-dim)" };

interface Props { anomalies: Anomaly[]; edges: CausalEdge[]; hypotheses: Hypothesis[]; selected: Selection; onSelect: (s: Selection) => void }

interface Laid { a: Anomaly; rank: number; x: number; y: number }

function layout(anomalies: Anomaly[], edges: CausalEdge[]) {
  const byId = new Map(anomalies.map((a) => [a.id, a]));
  const es = edges.filter((e) => byId.has(e.source) && byId.has(e.target) && e.source !== e.target);
  const ids = Array.from(new Set(es.flatMap((e) => [e.source, e.target])));
  const out = new Map<string, string[]>(), inn = new Map<string, string[]>();
  ids.forEach((i) => { out.set(i, []); inn.set(i, []); });
  // drop back-edges (cycles) with a DFS so ranking terminates
  const state = new Map<string, number>();
  const keep: CausalEdge[] = [];
  const adj = new Map<string, CausalEdge[]>();
  es.forEach((e) => adj.set(e.source, [...(adj.get(e.source) ?? []), e]));
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const e of adj.get(u) ?? []) {
      const s = state.get(e.target) ?? 0;
      if (s === 1) continue; // back edge
      keep.push(e);
      if (s === 0) dfs(e.target);
    }
    state.set(u, 2);
  };
  ids.forEach((i) => { if (!state.get(i)) dfs(i); });
  keep.forEach((e) => { out.get(e.source)!.push(e.target); inn.get(e.target)!.push(e.source); });
  // longest-path rank from roots
  const rank = new Map<string, number>();
  const visit = (u: string): number => {
    if (rank.has(u)) return rank.get(u)!;
    rank.set(u, 0);
    const r = Math.max(0, ...inn.get(u)!.map((p) => visit(p) + 1));
    rank.set(u, r);
    return r;
  };
  ids.forEach(visit);
  const cols: string[][] = [];
  ids.forEach((i) => { const r = rank.get(i)!; (cols[r] ??= []).push(i); });
  // initial order: by time, then barycenter sweeps
  const t = (i: string) => byId.get(i)!.time?.t_s ?? -1e12;
  cols.forEach((c) => c.sort((a, b) => t(a) - t(b)));
  const pos = new Map<string, number>();
  const setPos = () => cols.forEach((c) => c.forEach((id, k) => pos.set(id, k)));
  setPos();
  for (let sweep = 0; sweep < 6; sweep++) {
    const order = sweep % 2 === 0 ? cols.slice(1) : cols.slice(0, -1).reverse();
    for (const c of order) {
      const bc = (id: string) => {
        const nb = sweep % 2 === 0 ? inn.get(id)! : out.get(id)!;
        return nb.length ? nb.reduce((s, n) => s + pos.get(n)!, 0) / nb.length : pos.get(id)!;
      };
      c.sort((a, b) => bc(a) - bc(b));
      setPos();
    }
  }
  const maxRows = Math.max(1, ...cols.map((c) => c.length));
  const laid = new Map<string, Laid>();
  cols.forEach((c, r) => {
    const off = ((maxRows - c.length) * (H + ROW_GAP)) / 2;
    c.forEach((id, k) => laid.set(id, { a: byId.get(id)!, rank: r, x: PAD + r * (W + COL_GAP), y: PAD + 30 + off + k * (H + ROW_GAP) }));
  });
  return { laid, edges: keep, inn, out, nCols: cols.length, width: PAD * 2 + cols.length * W + (cols.length - 1) * COL_GAP, height: PAD * 2 + 30 + maxRows * (H + ROW_GAP) };
}

export function CausalGraph({ anomalies, edges, hypotheses, selected, onSelect }: Props) {
  const [ref, size] = useSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [hyp, setHyp] = useState<string | null>(null);
  const [tf, setTf] = useState(d3.zoomIdentity);
  const L = useMemo(() => layout(anomalies, edges), [anomalies, edges]);
  const unlinked = anomalies.filter((a) => !L.laid.has(a.id));

  // fit to view on data change, then free zoom/pan
  useEffect(() => {
    if (!svgRef.current) return;
    const k = Math.min(1.2, (size.width - 20) / L.width, (size.height - 20) / L.height);
    const init = d3.zoomIdentity.translate((size.width - L.width * k) / 2, Math.max(10, (size.height - L.height * k) / 2)).scale(k);
    const z = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.2, 3]).on("zoom", (e) => setTf(e.transform));
    d3.select(svgRef.current).call(z).call(z.transform, init);
  }, [L, size.width, size.height]);

  // causal chain highlight: everything upstream and downstream of the hovered node
  const chain = useMemo(() => {
    const focus = hover ?? (selected?.kind === "anomaly" ? selected.item.id : null);
    if (hyp) return new Set(hypotheses.find((h) => h.id === hyp)?.supporting_anomaly_ids ?? []);
    if (!focus || !L.laid.has(focus)) return null;
    const s = new Set([focus]);
    const walk = (id: string, nb: Map<string, string[]>) => nb.get(id)?.forEach((n) => { if (!s.has(n)) { s.add(n); walk(n, nb); } });
    walk(focus, L.inn); walk(focus, L.out);
    return s;
  }, [hover, selected, hyp, hypotheses, L]);

  const selId = selected?.item.id;
  const colLabel = (r: number) => (r === 0 ? "Root causes" : r === L.nCols - 1 ? "Outcome" : `Causal step ${r}`);

  return (
    <div className="sheet causal" ref={ref}>
      <div className="causal-bar">
        <span className="label">Hypotheses</span>
        {hypotheses.map((h) => (
          <button key={h.id} className={`btn ${hyp === h.id ? "active" : ""}`} title={h.narrative} onClick={() => setHyp(hyp === h.id ? null : h.id)}>
            {h.title.slice(0, 40)} · {Math.round(h.confidence * 100)}%
          </button>
        ))}
        <span className="spacer" />
        {Object.entries(HFACS).map(([k, v]) => <span key={k} className="legend"><i style={{ background: v.color }} />{v.label}</span>)}
      </div>
      <svg ref={svgRef} width={size.width} height={size.height}>
        <defs>
          <marker id="cg-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M0,1 L10,5 L0,9 z" fill="var(--line)" />
          </marker>
          <marker id="cg-arrow-hl" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M0,1 L10,5 L0,9 z" fill="var(--warn)" />
          </marker>
        </defs>
        <g transform={tf.toString()}>
          {Array.from({ length: L.nCols }, (_, r) => (
            <g key={r}>
              <text x={PAD + r * (W + COL_GAP)} y={PAD} className="lane-label">{colLabel(r).toUpperCase()}</text>
              {r < L.nCols - 1 && <text x={PAD + r * (W + COL_GAP) + W + COL_GAP / 2} y={PAD} textAnchor="middle" className="lane-label">→</text>}
            </g>
          ))}
          {L.edges.map((e, i) => {
            const a = L.laid.get(e.source)!, b = L.laid.get(e.target)!;
            const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2;
            const mx = (x1 + x2) / 2;
            const on = !chain || (chain.has(e.source) && chain.has(e.target));
            const hl = chain && on;
            const d = b.rank > a.rank
              ? `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
              : `M${x1},${y1} C${x1 + 60},${y1 - 80} ${x2 - 60},${y2 - 80} ${x2},${y2}`;
            return (
              <g key={i} opacity={on ? 1 : 0.1}>
                <path d={d} fill="none" stroke={e.relation === "contradicts" ? "var(--crit)" : hl ? "var(--warn)" : "var(--line)"}
                  strokeWidth={0.8 + e.confidence * 1.4} strokeDasharray={e.confidence < 0.4 ? "4 3" : undefined}
                  markerEnd={`url(#${hl ? "cg-arrow-hl" : "cg-arrow"})`} className={hl ? "flow" : ""} />
                {hl && <text x={mx} y={(y1 + y2) / 2 - 4} textAnchor="middle" className="edge-label">{e.relation.replace(/_/g, " ")} · {Math.round(e.confidence * 100)}%</text>}
                <title>{`${a.a.title} —${e.relation.replace(/_/g, " ")}→ ${b.a.title}\n${e.rationale}`}</title>
              </g>
            );
          })}
          {[...L.laid.values()].map(({ a, x, y }) => {
            const on = !chain || chain.has(a.id);
            const layer = HFACS[(a.hfacs_layer ?? "outcome") as HfacsLayer];
            return (
              <g key={a.id} transform={`translate(${x},${y})`} opacity={on ? 1 : 0.22} className="cg-node"
                onMouseEnter={() => setHover(a.id)} onMouseLeave={() => setHover(null)} onClick={() => onSelect({ kind: "anomaly", item: a })}>
                <rect width={W} height={H} fill={selId === a.id ? "rgba(94,225,255,0.16)" : "var(--paper-2)"} stroke={SEV[a.severity]} strokeWidth={selId === a.id || hover === a.id ? 2 : 1} />
                <rect width={4} height={H} fill={layer.color} />
                <foreignObject x={10} y={4} width={W - 14} height={H - 8}>
                  <div className="cg-text">
                    <b>{a.title}</b>
                    <span>{a.time?.t_s != null ? fmtT(a.time.t_s) : "latent"} · {layer.label}{a.certainty === "claimed" ? " · claim" : ""}</span>
                  </div>
                </foreignObject>
              </g>
            );
          })}
        </g>
      </svg>
      {unlinked.length > 0 && L.laid.size > 0 && <div className="overlay-note">{unlinked.length} anomalies without causal links (see register) · scroll to zoom · drag to pan</div>}
      {!L.laid.size && <div className="empty">No causal links yet: they appear after the LINK stage</div>}
    </div>
  );
}
