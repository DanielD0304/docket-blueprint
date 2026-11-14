import { useEffect, useRef, useState } from "react";
import type { CaseGraph, InvestigationStep } from "../types";
import type { SourceFocus } from "./Sources";

const PHASES = ["Question", "Tools", "Evidence", "Conclusion"];
const phaseIndex = (s?: InvestigationStep) => s?.phase === "question" ? 0 : s?.phase === "tool_call" ? 1
  : s?.phase === "tool_result" ? 2 : s?.phase === "conclusion" || s?.phase === "finished" ? 3 : -1;

export function Investigation({ g, setFocus }: { g: CaseGraph; setFocus: (f: SourceFocus) => void }) {
  const report = g.investigation;
  const steps = report?.steps ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => { tail.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [steps.length]);
  const active = steps.find((s) => s.id === selected) ?? steps[steps.length - 1];
  if (!report) return null;
  return <section className="investigation" aria-label="Investigator activity">
    <div className="invest-head"><b>LEAD INVESTIGATOR</b><span>{report.status.replace(/_/g, " ")}</span>
      <span>Turn {report.turns}/{report.max_turns} · {report.tool_calls} tools</span></div>
    <div className="invest-phases">{PHASES.map((p, i) => <span key={p} className={phaseIndex(active) === i ? "active" : ""}>
      <i />{p}{i < PHASES.length - 1 && <b>→</b>}</span>)}</div>
    <div className="invest-body">
      <div className="invest-steps">{steps.map((s) => <button key={s.id} className={`invest-step ${s.phase} ${active?.id === s.id ? "active" : ""}`}
        onClick={() => setSelected(s.id)}><small>{s.turn || "·"} / {s.phase.replace(/_/g, " ")}</small><span>{s.title}</span></button>)}<div ref={tail} /></div>
      <div className="invest-detail" key={active?.id}>
        {active && <><b>{active.title}</b><p>{active.detail || "Inspecting the available evidence."}</p>
          {active.citations.map((c, i) => {
            const source = g.files.find((f) => f.file_id === c.file_id);
            return <button className="invest-evidence" key={`${c.file_id}-${c.page}-${i}`}
              onClick={() => setFocus({ file_id: c.file_id, page: c.page, media_s: c.media_s })}>
              <span>{source?.docket_item ? `#${source.docket_item}` : "Source"} · {c.page ? `p.${c.page}` : c.media_s != null ? `${c.media_s}s` : "data"} ↗</span>
              <q>{c.quote}</q></button>;
          })}</>}
      </div>
    </div>
  </section>;
}
