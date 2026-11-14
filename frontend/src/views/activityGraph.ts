import type { CaseGraph, Citation, InvestigationStep } from "../types";

export interface ActivityNode {
  id: string; lane: number; kind: "source" | "tool" | "finding" | "hypothesis" | "conclusion";
  title: string; subtitle: string; detail: string; agentId?: string; agentName?: string;
  evidenceIds: string[]; citations: Citation[]; steps: InvestigationStep[];
  status?: string; stance?: string; preferred?: boolean;
}
export interface ActivityEdge { id: string; source: string; target: string; label: string; challenge: boolean }
export const TOOL_NAMES: Record<string, string> = {
  list_sources: "Index sources", search_evidence: "Search evidence", inspect_evidence: "Inspect findings",
  read_page: "Read source pages", recorder_window: "Check recorder data", timeline_window: "Compare the sequence",
};
const uniq = <T,>(items: T[]) => [...new Set(items)];
export const uniqueCitations = (citations: Citation[]) => [...new Map(citations.map((c) => [
  `${c.file_id}/${c.page}/${c.media_s}/${c.quote}`, c,
])).values()];

/** Links represent recorded reads and shared cited evidence, never invented causal reasoning. */
export function buildActivityGraph(g: CaseGraph, agentFilter: string | null = null) {
  const report = g.investigation;
  const steps = report?.steps ?? [];
  const nodes = new Map<string, ActivityNode>();
  const edges = new Map<string, ActivityEdge>();
  const agentNames = new Map((report?.agents ?? []).map((a) => [a.id, a.name]));
  const latestCall = new Map<string, string>();
  const latestQuestion = new Map<string, string>();
  const callGroups = new Map<string, string>();
  const addEdge = (source: string, target: string, label: string, challenge = false) => {
    const id = `${source}>${target}`;
    edges.set(id, { id, source, target, label, challenge });
  };
  const agentFor = (step: InvestigationStep) => step.agent_id ?? "lead";
  for (const step of steps) {
    const agent = agentFor(step);
    if (agentFilter && agent !== agentFilter) continue;
    if (step.phase === "question") latestQuestion.set(agent, step.title);
    if (step.phase === "tool_call") {
      const id = `tool:${agent}:${step.tool ?? "tool"}`;
      const node = nodes.get(id) ?? {
        id, lane: 1, kind: "tool", title: TOOL_NAMES[step.tool ?? ""] ?? step.title,
        subtitle: "", detail: "", agentId: agent, agentName: step.agent_name ?? agentNames.get(agent) ?? "Lead investigator",
        evidenceIds: [], citations: [], steps: [], status: "reading",
      } as ActivityNode;
      node.steps.push(step); node.detail = latestQuestion.get(agent) ?? step.detail; node.status = "reading";
      nodes.set(id, node); latestCall.set(agent, id); callGroups.set(step.id, id);
    }
    if (step.phase === "tool_result" || (step.phase === "error" && step.tool)) {
      const id = (step.parent_step_id && callGroups.get(step.parent_step_id)) || latestCall.get(agent);
      const node = id ? nodes.get(id) : undefined;
      if (!node) continue;
      node.steps.push(step); node.evidenceIds = uniq([...node.evidenceIds, ...step.evidence_ids]);
      node.citations = uniqueCitations([...node.citations, ...step.citations]);
      node.status = step.phase === "error" ? "error" : "done";
      if (!node.detail) node.detail = step.detail;
      for (const citation of step.citations) {
        const sourceId = `source:${citation.file_id}`;
        const file = g.files.find((f) => f.file_id === citation.file_id);
        const source = nodes.get(sourceId) ?? {
          id: sourceId, lane: 0, kind: "source", title: file?.name.replace(/^\d+\s*-\s*/, "").replace(/\.[^.]+$/, "") ?? citation.file_id,
          subtitle: file?.docket_item ? `SOURCE #${file.docket_item}` : "SOURCE", detail: file?.role.replace(/_/g, " ") ?? "Recorded source",
          evidenceIds: [], citations: [], steps: [],
        } as ActivityNode;
        source.citations = uniqueCitations([...source.citations, citation]); source.steps.push(step);
        nodes.set(sourceId, source); addEdge(sourceId, node.id, "read");
      }
    }
  }
  for (const node of nodes.values()) if (node.kind === "tool") {
    const calls = node.steps.filter((s) => s.phase === "tool_call").length;
    node.subtitle = `${calls} ${calls === 1 ? "call" : "calls"} · ${node.evidenceIds.length} evidence items`;
  }

  for (const agent of report?.agents ?? []) {
    if (agentFilter && agent.id !== agentFilter) continue;
    if (agent.id === "lead") continue; // final synthesis findings belong on the result side
    for (const finding of agent.findings) {
      nodes.set(`finding:${agent.id}:${finding.id}`, {
        id: `finding:${agent.id}:${finding.id}`, lane: 2, kind: "finding", title: finding.title,
        subtitle: agent.name, detail: finding.explanation, agentId: agent.id, agentName: agent.name,
        evidenceIds: finding.evidence_ids, citations: finding.citations, steps: [], stance: finding.stance,
      });
    }
  }
  if (!(report?.agents?.length)) for (const step of steps) {
    if (step.phase !== "conclusion" || !step.title.includes("→")) continue;
    const agent = agentFor(step);
    if (agentFilter && agent !== agentFilter) continue;
    nodes.set(`finding:${step.id}`, {
      id: `finding:${step.id}`, lane: 2, kind: "finding", title: step.title, subtitle: "Proposed connection",
      detail: step.detail, evidenceIds: step.evidence_ids, citations: step.citations, steps: [step], agentId: agent,
    });
  }

  const visibleTitles = new Set(steps.filter((s) => s.phase === "conclusion").map((s) => s.title));
  for (const hypothesis of g.hypotheses) {
    if (!visibleTitles.has(hypothesis.title)) continue;
    nodes.set(`hypothesis:${hypothesis.id}`, {
      id: `hypothesis:${hypothesis.id}`, lane: 3, kind: "hypothesis", title: hypothesis.title,
      subtitle: "Hypothesis", detail: hypothesis.narrative,
      evidenceIds: uniq([...(hypothesis.evidence_ids ?? []), ...hypothesis.supporting_anomaly_ids]),
      citations: hypothesis.citations ?? [], steps: [], preferred: report?.conclusion?.preferred_hypothesis_id === hypothesis.id,
    });
  }
  for (const step of steps) {
    if (step.phase !== "conclusion" || step.title.includes("→") ||
      g.hypotheses.some((h) => h.title === step.title) || (step.agent_id && step.agent_id !== "lead")) continue;
    if ((report?.agents ?? []).some((a) => a.findings.some((f) => f.title === step.title))) continue;
    nodes.set(`output:${step.id}`, { id: `output:${step.id}`, lane: 3, kind: "finding", title: step.title,
      subtitle: "Recorded output", detail: step.detail, evidenceIds: step.evidence_ids,
      citations: step.citations, steps: [step], agentId: agentFor(step) });
  }
  if (report?.conclusion) {
    for (const finding of report.conclusion.findings) nodes.set(`result-finding:${finding.id}`, {
      id: `result-finding:${finding.id}`, lane: 3, kind: "finding", title: finding.title,
      subtitle: "Synthesis finding", detail: finding.explanation, agentId: "lead", agentName: "Lead investigator",
      evidenceIds: finding.evidence_ids, citations: finding.citations, steps: [], stance: finding.stance,
    });
    nodes.set("conclusion", {
      id: "conclusion", lane: 3, kind: "conclusion", title: "Investigation conclusion",
      subtitle: report.conclusion.status === "supported" ? "Supported synthesis" : "Incomplete synthesis",
      detail: report.conclusion.summary, evidenceIds: report.conclusion.evidence_ids,
      citations: report.conclusion.citations, steps: [], preferred: true, status: report.conclusion.status,
    });
  }

  const tools = [...nodes.values()].filter((n) => n.kind === "tool");
  const findings = [...nodes.values()].filter((n) => n.lane === 2);
  const results = [...nodes.values()].filter((n) => n.lane === 3);
  const sharesEvidence = (a: ActivityNode, b: ActivityNode) => a.evidenceIds.some((id) => b.evidenceIds.includes(id));
  for (const tool of tools) for (const finding of findings) if (
    (!finding.agentId || finding.agentId === tool.agentId) && sharesEvidence(tool, finding)) {
    addEdge(tool.id, finding.id, "evidence used", finding.stance === "challenges");
  }
  for (const finding of findings) for (const result of results) if (sharesEvidence(finding, result)) {
    addEdge(finding.id, result.id, "cited evidence", finding.stance === "challenges");
  }
  for (const tool of tools) for (const result of results) if (sharesEvidence(tool, result) &&
    !findings.some((f) => (!f.agentId || f.agentId === tool.agentId) && sharesEvidence(tool, f) && sharesEvidence(f, result))) {
    addEdge(tool.id, result.id, "cited evidence");
  }
  if (agentFilter) {
    const connected = new Set([...edges.values()].flatMap((e) => [e.source, e.target]));
    for (const [id, node] of nodes) if (node.lane === 3 && !connected.has(id)) nodes.delete(id);
  }
  const ordered = [...nodes.values()].sort((a, b) => a.lane === 3 && b.lane === 3
    ? Number(b.id === "conclusion") - Number(a.id === "conclusion") || Number(!!b.preferred) - Number(!!a.preferred)
      || Number(b.kind === "hypothesis") - Number(a.kind === "hypothesis") : 0);
  return { nodes: ordered, edges: [...edges.values()].filter((e) => nodes.has(e.source) && nodes.has(e.target)) };
}
