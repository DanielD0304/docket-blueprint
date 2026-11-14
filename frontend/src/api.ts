import type { CaseGraph, StreamMsg } from "./types";

export async function health(): Promise<{ ok: boolean; mock: boolean; models: { fast: string; pro: string } }> {
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

export async function uploadCase(files: File[], cfg: Record<string, string | number | boolean>): Promise<string> {
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f, f.name));
  Object.entries(cfg).forEach(([k, v]) => v !== "" && v !== null && fd.append(k, String(v)));
  const r = await fetch("/api/cases", { method: "POST", body: fd });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).case_id;
}

export async function localCase(path: string, config: Record<string, any>): Promise<string> {
  const r = await fetch("/api/cases/local", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, config }),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).case_id;
}

export async function rerunCase(id: string): Promise<void> {
  await fetch(`/api/cases/${id}/rerun`, { method: "POST" });
}

export async function investigateCase(id: string): Promise<string> {
  const r = await fetch(`/api/cases/${id}/fusion-runs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fusion: "investigator", max_turns: 8 }),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).case_id;
}

/** Live progress stream with automatic reconnect.
 * EventSource only retries network errors; when the backend restarts behind the Vite proxy the proxy
 * answers with an HTTP error and the browser closes the stream for good, freezing the UI. We reopen it
 * ourselves (with back-off). The server replays the whole event log on every connect, so messages whose
 * seq we already delivered are skipped; seq numbers stay monotonic across reruns and restarts. */
export function openStream(id: string, onMsg: (m: StreamMsg) => void): () => void {
  let es: EventSource | null = null;
  let lastSeq = 0;
  let closed = false;
  let retry = 0;
  let timer: number | undefined;
  const connect = () => {
    if (closed) return;
    es = new EventSource(`/api/cases/${id}/stream`);
    es.onopen = () => { retry = 0; };
    es.onmessage = (e) => {
      let m: StreamMsg;
      try { m = JSON.parse(e.data); } catch { return; }
      if (typeof m.seq === "number") {
        if (m.seq <= lastSeq) return; // already delivered before a reconnect
        lastSeq = m.seq;
      }
      onMsg(m);
    };
    es.onerror = () => {
      if (es && es.readyState === EventSource.CLOSED) {
        es.close();
        retry++;
        timer = window.setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(retry, 4)));
      }
    };
  };
  connect();
  return () => { closed = true; window.clearTimeout(timer); es?.close(); };
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
