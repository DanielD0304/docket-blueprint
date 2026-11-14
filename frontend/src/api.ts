import type { CaseGraph, StreamMsg } from "./types";

export async function health(): Promise<{ ok: boolean; mock: boolean; demo?: boolean; demo_case_id?: string | null; models: { fast: string; pro: string } }> {
  const r = await fetch("/api/health");
  if (!r.ok) throw new Error("backend offline");
  return r.json();
}

export async function listCases(): Promise<{ case_id: string; config: any; status: string; stage: string }[]> {
  const r = await fetch("/api/cases");
  return r.ok ? r.json() : [];
}

export async function getCase(id: string): Promise<CaseGraph> {
  const r = await fetch(`/api/cases/${id}`);
  if (!r.ok) throw new Error(`case ${id} not found`);
  return r.json();
}

export async function getEvents(id: string): Promise<StreamMsg[]> {
  const r = await fetch(`/api/cases/${id}/events`);
  return r.ok ? r.json() : [];
}

export interface IntakeResult { case_id: string; demo?: boolean }

export async function uploadCase(files: File[], cfg: Record<string, string | number | boolean>): Promise<IntakeResult> {
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f, f.name));
  Object.entries(cfg).forEach(([k, v]) => v !== "" && v !== null && fd.append(k, String(v)));
  const r = await fetch("/api/cases", { method: "POST", body: fd });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function localCase(path: string, config: Record<string, any>): Promise<IntakeResult> {
  const r = await fetch("/api/cases/local", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, config }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function rerunCase(id: string): Promise<void> {
  const r=await fetch(`/api/cases/${id}/rerun`, { method: "POST" });
  if(!r.ok)throw new Error(await r.text());
}

export async function investigateCase(id: string): Promise<string> {
  const r = await fetch(`/api/cases/${id}/fusion-runs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fusion: "team", max_turns: 8 }),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).case_id;
}

export function openStream(id: string, onMsg: (m: StreamMsg) => void): () => void {
  const es = new EventSource(`/api/cases/${id}/stream`);
  es.onmessage = (e) => {
    try { onMsg(JSON.parse(e.data)); } catch { /* ignore */ }
  };
  return () => es.close();
}

export const fileUrl = (caseId: string, fileId: string, page?: number | null) =>
  `/api/cases/${caseId}/files/${fileId}${page ? `#page=${page}` : ""}`;

export function fmtT(t: number | null | undefined): string {
  if (t === null || t === undefined || !isFinite(t)) return "--:--:--";
  const day = Math.floor(t / 86400);
  let r = t - day * 86400;
  const h = Math.floor(r / 3600); r -= h * 3600;
  const m = Math.floor(r / 60); const s = r - m * 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${day ? `D${day > 0 ? "+" : ""}${day} ` : ""}${p(h)}:${p(m)}:${p(Math.floor(s))}`;
}
