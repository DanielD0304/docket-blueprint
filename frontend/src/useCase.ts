// Live case state: applies SSE progress messages to a CaseGraph so every sheet updates as agents finish.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { getCase, getEvents, openStream } from "./api";
import type { Anomaly, CaseGraph, Event, StreamMsg } from "./types";

export interface JobState { job_id: string; file_id: string; status: string; kind?: string; pages?: number[] | null; ms?: number }
export interface LogLine { ts: number; kind: "stage" | "job" | "fusion" | "error" | "info"; text: string }

export interface LiveState {
  graph: CaseGraph | null;
  jobs: Record<string, JobState>;
  log: LogLine[];
  usage: { calls: number; input_tokens: number; output_tokens: number; errors: number } | null;
  fusion: Record<string, any>;
  fresh: Set<string>; // ids that just arrived (for pop-in animation)
  mode: "idle" | "live" | "replay" | "static";
}

type Action =
  | { type: "init"; graph: CaseGraph; mode: LiveState["mode"] }
  | { type: "msg"; msg: StreamMsg }
  | { type: "batch"; msgs: StreamMsg[] };

const empty = (g: CaseGraph): CaseGraph => ({
  ...g, events: [], anomalies: [], track: [], series: [], causal_edges: [], hypotheses: [], open_questions: [], investigation: null,
  files: g.files.map((f) => ({ ...f, status: f.excluded ? "skipped" : "queued", jobs_done: 0, atoms: 0 })),
});

function pushLog(log: LogLine[], line: LogLine): LogLine[] {
  const next = log.length > 300 ? log.slice(-250) : log.slice();
  next.push(line);
  return next;
}

function apply(s: LiveState, m: StreamMsg): LiveState {
  if (!s.graph) return s;
  const g = s.graph;
  const ts = (m.ts ?? Date.now() / 1000) * 1000;
  switch (m.type) {
    case "stage":
      return { ...s, graph: { ...g, stage: m.stage, status: m.stage === "done" ? "done" : "running" },
        log: pushLog(s.log, { ts, kind: "stage", text: `▶ STAGE ${String(m.stage).toUpperCase()}` }) };
    case "files":
    case "plan":
      return { ...s, graph: { ...g, files: m.files } };
    case "file": {
      const files = g.files.map((f) => (f.file_id === m.file.file_id ? m.file : f));
      return { ...s, graph: { ...g, files }, usage: m.usage ?? s.usage };
    }
    case "job": {
      const jobs = { ...s.jobs, [m.job_id]: { ...s.jobs[m.job_id], ...m } as JobState };
      let log = s.log;
      if (m.status === "done") {
        const f = g.files.find((x) => x.file_id === m.file_id);
        log = pushLog(log, { ts, kind: "job", text: `✓ ${f?.name?.slice(0, 48) ?? m.file_id} ${m.pages ? `p${m.pages.join("-")}` : ""} → ${m.n_events} ev / ${m.n_anomalies} anom${m.cached ? " (cache)" : ""}` });
      } else if (m.status === "error") {
        log = pushLog(log, { ts, kind: "error", text: `✗ ${m.job_id}: ${m.error}` });
      }
      return { ...s, jobs, log };
    }
    case "atoms": {
      const fresh = new Set<string>();
      const evIds = new Set(g.events.map((e) => e.id));
      const anIds = new Set(g.anomalies.map((a) => a.id));
      const events = g.events.concat((m.events as Event[]).filter((e) => !evIds.has(e.id) && (fresh.add(e.id), true)));
      const anomalies = g.anomalies.concat((m.anomalies as Anomaly[]).filter((a) => !anIds.has(a.id) && (fresh.add(a.id), true)));
      return { ...s, fresh, graph: { ...g, events, anomalies, track: g.track.concat(m.track ?? []), series: g.series.concat(m.series ?? []) } };
    }
    case "fusion":
      return { ...s, fusion: { ...s.fusion, [m.step]: m.result },
        log: pushLog(s.log, { ts, kind: "fusion", text: `◆ ${String(m.step).toUpperCase()} ${JSON.stringify(m.result).slice(0, 120)}` }) };
    case "clock_sync":
      return { ...s, graph: { ...g, series: m.series, events: m.events, track: m.track, clocks: m.clocks } };
    case "investigator": {
      const prior = g.investigation;
      const steps = [...(prior?.steps ?? []).filter((x) => x.id !== m.step.id), m.step];
      return { ...s, graph: { ...g, investigation: {
        model: prior?.model ?? "Gemini", max_turns: m.max_turns, turns: m.turns,
        tool_calls: m.tool_calls, rejected_claims: prior?.rejected_claims ?? 0, status: m.status, steps,
      } }, log: pushLog(s.log, { ts, kind: "fusion", text: `◇ ${m.step.title}` }) };
    }
    case "done":
      return { ...s, graph: { ...g, status: "done", stats: m.stats }, log: pushLog(s.log, { ts, kind: "info", text: "■ CASE COMPLETE" }) };
    case "error":
      return { ...s, graph: { ...g, status: "error" }, log: pushLog(s.log, { ts, kind: "error", text: `✗ ${m.error}` }) };
    default:
      return s;
  }
}

function reducer(s: LiveState, a: Action): LiveState {
  if (a.type === "init") return { ...s, graph: a.graph, mode: a.mode, jobs: {}, log: [], fresh: new Set(), fusion: {} };
  if (a.type === "msg") return apply(s, a.msg);
  return a.msgs.reduce(apply, s);
}

const initial: LiveState = { graph: null, jobs: {}, log: [], usage: null, fusion: {}, fresh: new Set(), mode: "idle" };

export function useCase(caseId: string | null, sample?: CaseGraph) {
  const [state, dispatch] = useReducer(reducer, initial);
  const timers = useRef<number[]>([]);
  const stopAll = () => { timers.current.forEach(clearTimeout); timers.current = []; };

  const loadFinal = useCallback(async (id: string) => {
    const g = await getCase(id);
    dispatch({ type: "init", graph: g, mode: "static" });
  }, []);

  useEffect(() => {
    stopAll();
    if (sample) { dispatch({ type: "init", graph: sample, mode: "static" }); return; }
    if (!caseId) return;
    let close: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const g = await getCase(caseId);
      if (cancelled) return;
      if (g.status === "done") { dispatch({ type: "init", graph: g, mode: "static" }); return; }
      dispatch({ type: "init", graph: empty({ ...g, files: g.files ?? [] } as CaseGraph), mode: "live" });
      // Buffer the burst of history so React renders once, then go live.
      let buffer: StreamMsg[] = [];
      let flush: number | null = null;
      close = openStream(caseId, (m) => {
        if (m.type === "done") {
          buffer.push(m);
          dispatch({ type: "batch", msgs: buffer }); buffer = [];
          setTimeout(() => loadFinal(caseId), 300); // swap in the fused + verified graph
          return;
        }
        buffer.push(m);
        if (flush === null) flush = window.setTimeout(() => { dispatch({ type: "batch", msgs: buffer }); buffer = []; flush = null; }, 120);
      });
    })().catch(console.error);
    return () => { cancelled = true; close?.(); stopAll(); };
  }, [caseId, sample, loadFinal]);

  /** Re-play the recorded event log compressed into `seconds` — offline demo of the swarm. */
  const replay = useCallback(async (seconds = 25, investigationOnly = false) => {
    if (!caseId) return;
    stopAll();
    const [g, allMsgs] = await Promise.all([getCase(caseId), getEvents(caseId)]);
    const msgs = investigationOnly ? allMsgs.filter((m) => m.type === "investigator") : allMsgs;
    dispatch({ type: "init", graph: investigationOnly ? { ...g, investigation: null } : empty(g), mode: "replay" });
    if (!msgs.length) return;
    const t0 = msgs[0].ts ?? 0, t1 = msgs[msgs.length - 1].ts ?? 1;
    const span = Math.max(0.001, t1 - t0);
    msgs.forEach((m, i) => {
      const at = (((m.ts ?? t0) - t0) / span) * seconds * 1000 * 0.6 + (i / msgs.length) * seconds * 1000 * 0.4;
      timers.current.push(window.setTimeout(() => dispatch({ type: "msg", msg: m }), at));
    });
    timers.current.push(window.setTimeout(() => loadFinal(caseId), seconds * 1000 + 500));
  }, [caseId, loadFinal]);

  return { ...state, replay };
}
