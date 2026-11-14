import React from "react";
import { fmtT } from "./api";
import { annotationLifecycle } from "./annotationLifecycle";
import { playRange } from "./data";
import { dt } from "./components/cards";
import { SourceTag } from "./components/SourceTag";
import type { Anomaly, CaseGraph, Citation, Selection } from "./types";
import { assessment } from "./components/HypothesisDetail";
import type { SourceFocus } from "./views/Sources";

const STAGES = ["ingest", "triage", "extract", "verify", "align", "dedup", "investigate", "done"];

export function Header({ g, onHome, actions }: { g: CaseGraph; onHome: () => void; actions?: React.ReactNode }) {
  const idx = STAGES.indexOf(g.stage === "link" ? "investigate" : g.stage);
  const c = g.config;
  return (
    <div className="header">
      <div className="brand" onClick={onHome} title="All cases"><span className="label">Docket</span><b>BLUEPRINT</b></div>
      <div className="hcell"><span className="label">Case</span><span>{c.title}</span></div>
      <div className="hcell"><span className="label">NTSB</span><span>{c.ntsb_id ?? "—"}</span></div>
      <div className="hcell"><span className="label">Aircraft</span><span>{c.aircraft ?? "—"}</span></div>
      <div className="pipeline">
        {STAGES.map((s, i) => (
          <div key={s} className={`stage ${i < idx || g.stage === "done" ? "done" : i === idx ? "active" : ""}`} title={s}>
            <span className="dot" /><span className="sname">{s}</span>
          </div>
        ))}
      </div>
      <div className="hactions">
        {c.blind_mode && <span className="badge" style={{ color: "var(--warn)" }}>Blind</span>}
        {g.stats?.mock && <span className="badge dim">Mock</span>}
        {(g.case_id === "sample" || /synthetic/i.test(c.title)) && <span className="synthetic-banner" title="Generated test data, not from any real accident docket">Synthetic demo data</span>}
        {actions}
      </div>
    </div>
  );
}

const SEV = { critical: 0, significant: 1, minor: 2, info: 3 } as const;

export function Inspector({ g, selected, onSelect, cursor, openSource }: {
  g: CaseGraph; selected: Selection; onSelect: (s: Selection) => void; cursor: number | null; openSource: (f: SourceFocus) => void;
}) {
  return (
    <div className="inspector">
      {selected ? <Detail g={g} selected={selected} onSelect={onSelect} openSource={openSource} /> : <Register g={g} onSelect={onSelect} cursor={cursor} />}
    </div>
  );
}

function Evidence({ g, c, openSource }: { g: CaseGraph; c: Citation; openSource: (f: SourceFocus) => void }) {
  const f = g.files.find((x) => x.file_id === c.file_id);
  const mm = c.media_s != null ? `${Math.floor(c.media_s / 60)}:${String(Math.floor(c.media_s % 60)).padStart(2, "0")}` : null;
  return (
    <div className="evid">
      <div className="quote">“{c.quote}”</div>
      <div className="evid-meta">
        <a onClick={() => openSource({ file_id: c.file_id, page: c.page, media_s: c.media_s })}>
          {f ? `#${f.docket_item ?? "?"} ${f.name.replace(/^\d+\s*-\s*/, "").slice(0, 38)}` : c.file_id}{c.page ? ` · p.${c.page}` : ""}{mm ? ` · ▶ ${mm}` : ""}
        </a>
        <span className={c.verified ? "ok" : c.verified === false ? "bad" : "dim"}>
          {c.verified ? `✓ VERIFIED${c.score ? ` ${Math.round(c.score)}` : ""}` : c.verified === false ? "NOT FOUND" : "UNCHECKED"}
        </span>
      </div>
    </div>
  );
}

function Detail({ g, selected, onSelect, openSource }: { g: CaseGraph; selected: NonNullable<Selection>; onSelect: (s: Selection) => void; openSource: (f: SourceFocus) => void }) {
  const it = selected.item;
  const isA = selected.kind === "anomaly";
  const a = it as Anomaly;
  const byId = new Map(g.anomalies.map((x) => [x.id, x]));
  const rel = isA ? g.causal_edges.filter((e) => e.source === a.id || e.target === a.id) : [];
  return (
    <>
      <div className="insp-head"><span className="h">{isA ? "Anomaly" : "Event"}</span><button className="btn" onClick={() => onSelect(null)}>← Register</button></div>
      <div className="insp-body">
        {isA ? (
          <>
            <div className="insp-title">{a.title} <span className={`badge sev-${a.severity}`}>{a.severity}</span></div>
            <div className="kv">
              <span className="k">Time</span><span>{a.time?.t_s != null ? fmtT(a.time.t_s) : "Unknown — not placed on the timeline"}</span>
              <span className="k">Domain</span><span>{a.domain.replace(/_/g, " ")}</span>
              <span className="k">HFACS</span><span>{a.hfacs_layer?.replace(/_/g, " ") ?? "—"}</span>
              <span className="k">Certainty</span><span>{a.certainty}</span>
              <span className="k">Expected</span><span>{a.expected}</span>
              <span className="k">Observed</span><span>{a.observed}</span>
            </div>
            {rel.length > 0 && <div className="label">Causal links</div>}
            {rel.map((e, i) => {
              const out = e.source === a.id;
              const o = byId.get(out ? e.target : e.source);
              if (!o) return null;
              const d = o.time?.t_s != null && a.time?.t_s != null ? dt(o.time.t_s - a.time.t_s) : o.time?.t_s != null ? fmtT(o.time.t_s) : "time unknown";
              return (
                <div key={i} className="linkrow" onClick={() => onSelect({ kind: "anomaly", item: o })}>
                  <span className="rl">{out ? e.relation.replace(/_/g, " ") : "result of"}</span> <b>{o.title}</b> <span className="ft">{d}</span>
                  <div className="dim">{e.rationale} · {Math.round(e.confidence * 100)}%</div>
                </div>
              );
            })}
          </>
        ) : (
          <>
            <div className="insp-title">{(it as any).description}</div>
            <div className="kv">
              <span className="k">Time</span><span>{fmtT(it.time?.t_s)} <span className="dim">{it.time?.raw} · {it.time?.basis}{it.time?.aligned_by ? ` · ${it.time.aligned_by}` : ""}</span></span>
              <span className="k">Actor</span><span>{(it as any).actor ?? "—"}</span>
              <span className="k">Category</span><span>{(it as any).category}</span>
              <span className="k">Certainty</span><span>{it.certainty}{(it as any).claimed_by ? ` (by ${(it as any).claimed_by})` : ""}</span>
              <span className="k">Sources</span><span>{it.source_files.length} document(s)</span>
              {(it as any).parameters?.map((p: any, i: number) => (
                <React.Fragment key={i}><span className="k">{p.name}</span><span>{p.value} {p.unit ?? ""}</span></React.Fragment>
              ))}
            </div>
          </>
        )}
        <div className="label">Evidence ({it.citations.length})</div>
        {it.citations.map((c, i) => <Evidence key={i} g={g} c={c} openSource={openSource} />)}
      </div>
    </>
  );
}

function Register({ g, onSelect, cursor }: { g: CaseGraph; onSelect: (s: Selection) => void; cursor: number | null }) {
  const list = g.anomalies.slice().sort((a, b) => SEV[a.severity] - SEV[b.severity] || (a.time?.t_s ?? 0) - (b.time?.t_s ?? 0));
  const at = cursor ?? playRange(g)?.[1] ?? 0;
  return (
    <>
      <div className="insp-head"><span className="h">Abnormality register</span><span className="label">{list.length}</span></div>
      <div className="insp-body">
        {g.occurrence_categories.length > 0 && <div className="chips">{g.occurrence_categories.map((c) => <span key={c} className="chip">{c}</span>)}</div>}
        {g.hypotheses.length > 0 && <div className="label">Hypotheses</div>}
        {g.hypotheses.map((h) => (
          <details key={h.id} className="hyp">
            <summary><b>{h.title}</b> <span className="dim">{assessment(h.confidence)} model assessment</span></summary>
            <div className="dim">{h.narrative}</div>
          </details>
        ))}
        <div className="label">Anomalies</div>
        {list.map((a) => {
          const life = annotationLifecycle(a, at);
          const active = life.state === "fresh" || life.state === "current";
          const recent = life.state === "fresh";
          const ageClass = life.state === "cooling" ? "cooling" : life.state === "stale" || life.state === "hidden" || life.state === "context" ? "stale" : "";
          return (
            <div key={a.id} className={`regitem ${active ? "active" : ""} ${recent ? "recent" : ""} ${ageClass}`} onClick={() => onSelect({ kind: "anomaly", item: a })}>
              <div className="ri-top"><span>{a.title}</span><span className={`badge sev-${a.severity}`}>{a.severity}</span></div>
              <div className="dim">{a.time?.t_s != null ? fmtT(a.time.t_s) : "time unknown"} · {a.domain.replace(/_/g, " ")} · {a.certainty}</div>
              <SourceTag g={g} atom={a} />
            </div>
          );
        })}
        {g.open_questions.length > 0 && <div className="label">Open questions</div>}
        {g.open_questions.map((q, i) => <div key={i} className="dim oq">? {q}</div>)}
      </div>
    </>
  );
}
