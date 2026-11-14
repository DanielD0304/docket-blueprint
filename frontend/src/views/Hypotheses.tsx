import { HypothesisDetail, assessment } from "../components/HypothesisDetail";
import type { CaseGraph, Selection } from "../types";
import type { SourceFocus } from "./Sources";

export function Hypotheses({ g, hypothesisId, onChoose, onSelect, openSource }: {
  g: CaseGraph; hypothesisId: string | null; onChoose: (id: string) => void;
  onSelect: (s: Selection) => void; openSource: (f: SourceFocus) => void;
}) {
  const active = g.hypotheses.find((h) => h.id === hypothesisId) ?? g.hypotheses[0];
  if (!active) return <div className="empty">No hypotheses yet. They are produced during investigation.</div>;
  return <div className="hypotheses-view">
    <nav className="hypotheses-list" aria-label="Choose a hypothesis">
      <div className="label">Competing explanations</div>
      <p className="dim">Explore the evidence for each explanation, including findings without graph links.</p>
      {g.hypotheses.map((h, i) => <button key={h.id} className={`hypothesis-choice btn ${h.id === active.id ? "active" : ""}`}
        aria-pressed={h.id === active.id} onClick={() => onChoose(h.id)}>
        <span className="label">Hypothesis {i + 1}</span><b>{h.title}</b>
        <small>{assessment(h.confidence)} model assessment · {h.supporting_anomaly_ids.length} supporting findings</small>
      </button>)}
    </nav>
    <div className="hypothesis-workspace">{g.investigation?.conclusion && <section style={{padding:"20px 24px",borderBottom:"1px solid var(--line-dim)",maxWidth:900}}><div className="label">Overall investigation conclusion</div><p style={{fontSize:16,lineHeight:1.65}}>{g.investigation.conclusion.summary}</p>{g.investigation.conclusion.limitations.length > 0 && <details><summary>Limitations and uncertainty</summary><ul>{g.investigation.conclusion.limitations.map((x,i)=><li key={i}>{x}</li>)}</ul></details>}</section>}<HypothesisDetail key={active.id} g={g} hypothesis={active} onSelect={onSelect} openSource={openSource} /></div>
  </div>;
}
