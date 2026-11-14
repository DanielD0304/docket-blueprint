import assert from "node:assert/strict";
import test from "node:test";
import { buildActivityGraph } from "../src/views/activityGraph.ts";

const citation = (file_id) => ({ file_id, page: 1, quote: `Exact quote from ${file_id}`, verified: true, score: 100 });
const step = (id, phase, agent_id, extra = {}) => ({ id, phase, agent_id, agent_name: agent_id,
  turn: 1, title: id, detail: "", tool: null, evidence_ids: [], citations: [], ...extra });
const fixture = () => ({
  files: ["a", "b"].map((file_id) => ({ file_id, name: `${file_id}.pdf`, role: "systems", docket_item: file_id })),
  hypotheses: [{ id: "h1", title: "Candidate explanation", narrative: "Supported candidate", supporting_anomaly_ids: ["ev-a"], evidence_ids: ["ev-a"], citations: [citation("a")] }],
  investigation: {
    status: "done", agents: [
      { id: "sequence", name: "Sequence", findings: [{ id: "f-a", title: "Sequence finding", explanation: "Observed sequence", evidence_ids: ["ev-a"], citations: [citation("a")], stance: "supports" }] },
      { id: "systems", name: "Systems", findings: [{ id: "f-b", title: "Systems finding", explanation: "Separate observation", evidence_ids: ["ev-b"], citations: [citation("b")], stance: "challenges" }] },
    ],
    steps: [
      step("call-a", "tool_call", "sequence", { tool: "read_page" }),
      step("call-b", "tool_call", "systems", { tool: "read_page" }),
      step("result-b", "tool_result", "systems", { tool: "read_page", parent_step_id: "call-b", evidence_ids: ["ev-b"], citations: [citation("b")] }),
      step("result-a", "tool_result", "sequence", { tool: "read_page", parent_step_id: "call-a", evidence_ids: ["ev-a"], citations: [citation("a")] }),
      step("hypothesis", "conclusion", "lead", { title: "Candidate explanation", evidence_ids: ["ev-a"], citations: [citation("a")] }),
    ],
  },
});

test("interleaved agents retain actual source-to-tool and evidence-to-result links", () => {
  const graph = buildActivityGraph(fixture());
  const edges = new Set(graph.edges.map((e) => `${e.source}>${e.target}`));
  assert.ok(edges.has("source:a>tool:sequence:read_page"));
  assert.ok(edges.has("source:b>tool:systems:read_page"));
  assert.ok(!edges.has("source:a>tool:systems:read_page"));
  assert.ok(edges.has("tool:sequence:read_page>finding:sequence:f-a"));
  assert.ok(edges.has("finding:sequence:f-a>hypothesis:h1"));
  assert.ok(!edges.has("finding:systems:f-b>hypothesis:h1"));
  assert.equal(graph.nodes.some((n) => n.kind === "conclusion"), false, "never manufacture an overall conclusion");
});

test("replay does not reveal hypothesis outputs before their conclusion event", () => {
  const g = fixture(); g.investigation.steps = g.investigation.steps.slice(0, -1);
  assert.equal(buildActivityGraph(g).nodes.some((n) => n.kind === "hypothesis"), false);
});

test("agent filter keeps only that agent's reads and evidence-connected results", () => {
  const graph = buildActivityGraph(fixture(), "systems");
  assert.ok(graph.nodes.some((n) => n.id === "source:b"));
  assert.ok(!graph.nodes.some((n) => n.id === "source:a"));
  assert.ok(!graph.nodes.some((n) => n.id === "hypothesis:h1"));
});

test("legacy single-agent traces retain evidence provenance without specialist reports", () => {
  const g = fixture(); delete g.investigation.agents;
  g.investigation.steps = [
    step("call", "tool_call", undefined, { tool: "search_evidence" }),
    step("result", "tool_result", undefined, { evidence_ids: ["ev-a"], citations: [citation("a")] }),
    step("link", "conclusion", undefined, { title: "A → B", evidence_ids: ["ev-a"], citations: [citation("a")] }),
    step("hypothesis", "conclusion", undefined, { title: "Candidate explanation", evidence_ids: ["ev-a"] }),
  ];
  const graph = buildActivityGraph(g);
  assert.ok(graph.edges.some((e) => e.source === "source:a" && e.target === "tool:lead:search_evidence"));
  assert.ok(graph.nodes.some((n) => n.id === "finding:link"));
  assert.ok(graph.nodes.some((n) => n.id === "hypothesis:h1"));
});
