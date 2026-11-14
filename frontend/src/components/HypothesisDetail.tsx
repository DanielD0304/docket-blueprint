import { fmtT } from "../api";
import type { CaseGraph, Hypothesis, HypothesisContribution, Selection } from "../types";
import type { SourceFocus } from "../views/Sources";

export const assessment = (confidence: number) => confidence >= .75 ? "Strong" : confidence >= .4 ? "Moderate" : "Weak";

export function HypothesisDetail({ g, hypothesis: h, onSelect, openSource, onClose }: {
  g: CaseGraph; hypothesis: Hypothesis; onSelect: (s: Selection) => void;
  openSource: (f: SourceFocus) => void; onClose?: () => void;
}) {
  const ids = new Set(h.supporting_anomaly_ids);
  const support = g.anomalies.filter((a) => ids.has(a.id));
  const links = g.causal_edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const byId = new Map(g.anomalies.map((a) => [a.id, a]));
  const contributions: HypothesisContribution[] = [...(h.contributions ?? [])];
  for (const a of support) if (!contributions.some((c) => c.evidence_id === a.id)) {
    contributions.push({ evidence_id: a.id, role: "supports", explanation: "", citations: a.citations });
  }
  return <>
    <div className="insp-head"><span className="h">Explanation and evidence</span>{onClose && <button className="btn" onClick={onClose}>All findings</button>}</div>
    <div className="insp-body hypothesis-detail">
      <div className="label">Proposed explanation · not a finding of cause</div>
      <h2>{h.title}</h2>
      <div className="hyp-assessment">Model assessment: <b>{assessment(h.confidence)}</b>
        <small>Model judgment based on the supplied evidence; not a calibrated probability.</small></div>
      <h3>What this proposes</h3>
      <p className="hyp-narrative">{h.narrative || "No explanation was saved for this hypothesis."}</p>
      <h3>Evidence feeding this explanation <span>({contributions.length})</span></h3>
      <p className="dim">Evidence is shown here even when it has no causal graph edge.</p>
      {!h.contributions?.length && <p className="hyp-legacy">This result lists supporting findings but has no saved per-finding contribution rationales. The explanation above is the model's overall account.</p>}
      {(["supports", "challenges", "context"] as const).map((role) => {
        const items = contributions.filter((c) => c.role === role);
        if (!items.length) return null;
        return <section className={`hyp-feed-group ${role}`} key={role}>
          <h3>{role === "supports" ? "Supports this explanation" : role === "challenges" ? "Challenges this explanation" : "Background / context"}</h3>
          {items.map((c, i) => {
            const a = byId.get(c.evidence_id), e = g.events.find((x) => x.id === c.evidence_id), f = g.facts.find((x) => x.id === c.evidence_id);
            const title = a?.title ?? e?.description ?? (f ? `${f.subject} · ${f.predicate}` : "Retrieved source evidence");
            const cs = c.citations?.length ? c.citations : a?.citations ?? e?.citations ?? f?.citations ?? [];
            const observed = a?.observed ?? e?.description ?? f?.value;
            return <div key={`${c.evidence_id}-${i}`} className="hyp-support">
              <button className="hyp-finding" disabled={!a && !e} onClick={() => {
                if (a) onSelect({ kind: "anomaly", item: a }); else if (e) onSelect({ kind: "event", item: e });
              }}>{title}{a || e ? " ↗" : ""}</button>
              <div className="hyp-contribution"><span className="label">How it feeds in</span>
                <p>{c.explanation || "Listed by the original model as supporting evidence; no individual rationale was saved."}</p></div>
              {observed && <details><summary>What the evidence reports</summary><p>{observed}</p>
                {(a || e) && <span className="dim">{fmtT(a?.time?.t_s ?? e?.time.t_s)} · {a?.certainty ?? e?.certainty}</span>}</details>}
              {cs.slice(0, 4).map((citation, j) => {
                const source = g.files.find((s) => s.file_id === citation.file_id);
                return <details className="hyp-quote" key={j}><summary>{source?.docket_item ? `#${source.docket_item}` : "Source"} {source?.role.replace(/_/g, " ")}{citation.page ? ` · p.${citation.page}` : citation.media_s != null ? ` · ${citation.media_s}s` : " · data"}</summary>
                  <blockquote>{citation.quote}</blockquote><button className="btn" onClick={() => openSource(citation)}>Open source</button></details>;
              })}
            </div>;
          })}
        </section>;
      })}
      {!contributions.length && <p className="dim">No evidence inputs were attached to this hypothesis.</p>}
      {support.length < ids.size && <p className="dim">{ids.size - support.length} referenced findings are unavailable in this case.</p>}
      {links.length > 0 && <><h3>How the findings connect</h3>{links.map((e, i) => <div className="hyp-link" key={i}>
        <b>{byId.get(e.source)?.title}</b><span className="label">{e.relation.replace(/_/g, " ")} →</span>
        <b>{byId.get(e.target)?.title}</b><p>{e.rationale}</p>
      </div>)}</>}
      <h3>Contrary evidence / limitations</h3>
      {h.contradicting_evidence.length ? <ul>{h.contradicting_evidence.map((text, i) => <li key={i}>{text}</li>)}</ul>
        : <p className="dim">The model did not list contrary evidence. That does not establish that none exists.</p>}
      {g.open_questions.length > 0 && <><h3>Open questions for this case</h3><ul>{g.open_questions.map((q, i) => <li key={i}>{q}</li>)}</ul></>}
    </div>
  </>;
}
