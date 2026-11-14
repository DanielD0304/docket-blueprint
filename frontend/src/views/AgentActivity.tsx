import type { CaseGraph } from "../types";
import type { SourceFocus } from "./Sources";
import { Investigation } from "./Investigation";

export function AgentActivity({ g, openSource, replay }: { g: CaseGraph; openSource: (f: SourceFocus) => void; replay: () => void }) {
  return <div className="agent-activity">
    <div className="activity-head"><div><h2>Investigator activity</h2>
      <p>Follow the questions, tool calls, evidence reads and connections recorded during this run.</p></div>
      <button className="btn" disabled={!g.investigation?.steps.length} onClick={replay}>Replay recorded activity</button></div>
    <Investigation g={g} setFocus={openSource} expanded />
  </div>;
}
