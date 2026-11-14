// Sources: live agent swarm over every docket file, the run log, and a preview (PDF / video / audio)
// whose extracted evidence links back into the media at the right moment.
import { useEffect, useMemo, useRef, useState } from "react";
import { fileUrl, fmtT } from "../api";
import type { CaseGraph, Selection, SourceFile } from "../types";
import type { LiveState } from "../useCase";

export interface SourceFocus { file_id: string; page?: number | null; media_s?: number | null }

const RANK = { processing: 0, queued: 1, done: 2, error: 3, skipped: 4 } as const;
const fmtMedia = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function Sources({ live, focus, setFocus, onSelect }: { live: LiveState; focus: SourceFocus | null; setFocus: (f: SourceFocus | null) => void; onSelect: (s: Selection) => void }) {
  const g = live.graph as CaseGraph;
  const [filter, setFilter] = useState("all");
  const roles = useMemo(() => ["all", ...Array.from(new Set(g.files.map((f) => f.role))).sort()], [g.files]);
  const files = g.files.filter((f) => filter === "all" || f.role === filter)
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.priority - b.priority || (a.docket_item ?? 999) - (b.docket_item ?? 999));
  const running = Object.values(live.jobs).filter((j) => j.status === "running").length;
  const done = g.files.filter((f) => f.status === "done").length;
  const active = g.files.filter((f) => !f.excluded).length;
  const sel = focus ? g.files.find((f) => f.file_id === focus.file_id) ?? null : null;

  return (
    <div className="sources">
      <div className="src-left">
        <div className="src-stats">
          <div><span className="label">Files</span><b>{done}/{active}</b></div>
          <div><span className="label">Agents</span><b>{running}</b></div>
          <div><span className="label">Events</span><b>{g.events.length}</b></div>
          <div><span className="label">Anomalies</span><b style={{ color: "var(--warn)" }}>{g.anomalies.length}</b></div>
          {live.usage && <div><span className="label">LLM</span><b>{live.usage.calls}</b><small>{Math.round(live.usage.input_tokens / 1000)}k in</small></div>}
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="src-filter">
            {roles.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
          </select>
        </div>
        <div className="src-grid">
          {files.map((f) => (
            <div key={f.file_id} className={`card doc ${f.status} ${sel?.file_id === f.file_id ? "sel" : ""}`} onClick={() => setFocus({ file_id: f.file_id })}
              title={f.summary ?? f.exclude_reason ?? f.error ?? f.name}>
              <div className="row"><span className="name">{f.docket_item ? `#${f.docket_item} ` : ""}{f.name.replace(/^\d+\s*-\s*/, "").replace(/\.[^.]+$/, "")}</span><b>{f.atoms || ""}</b></div>
              <div className="row role"><span>{kindIcon(f)} {f.role.replace(/_/g, " ")}{f.pages ? ` · ${f.pages}p` : ""}{f.scanned ? " · scan" : ""}</span><span>{f.excluded ? "held out" : f.status}</span></div>
              {f.jobs_total > 0 && <div className="bar"><i style={{ width: `${(100 * f.jobs_done) / f.jobs_total}%` }} /></div>}
            </div>
          ))}
        </div>
        <div className="src-log">
          {live.log.slice(-200).reverse().map((l, i) => (
            <div key={live.log.length - i} className={`line ${l.kind}`}><span className="dim">{new Date(l.ts).toLocaleTimeString()} </span>{l.text}</div>
          ))}
          {!live.log.length && <div className="dim">Run log appears here while agents work. Use “Replay swarm” to re-watch a finished run.</div>}
        </div>
      </div>
      <div className="src-right">
        {sel ? <Preview g={g} f={sel} focus={focus!} setFocus={setFocus} onSelect={onSelect} /> : <div className="empty">Select a document to preview it and its extracted evidence</div>}
      </div>
    </div>
  );
}

function kindIcon(f: SourceFile) {
  return { pdf: "▤", table: "▦", image: "▣", audio: "♫", video: "▶", text: "≡" }[f.kind] ?? "·";
}

function Preview({ g, f, focus, setFocus, onSelect }: { g: CaseGraph; f: SourceFile; focus: SourceFocus; setFocus: (f: SourceFocus) => void; onSelect: (s: Selection) => void }) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const url = fileUrl(g.case_id, f.file_id);
  useEffect(() => {
    if (media.current && focus.media_s != null) { media.current.currentTime = focus.media_s; media.current.play().catch(() => {}); }
  }, [focus.media_s, f.file_id]);
  const atoms = useMemo(() => [
    ...g.anomalies.filter((a) => a.source_files.includes(f.file_id)).map((a) => ({ kind: "anomaly" as const, item: a })),
    ...g.events.filter((e) => e.source_files.includes(f.file_id)).map((e) => ({ kind: "event" as const, item: e })),
  ], [g, f.file_id]);
  return (
    <div className="preview">
      <div className="pv-head">
        <b>{f.docket_item ? `#${f.docket_item} ` : ""}{f.name}</b>
        <a className="btn" href={url} target="_blank" rel="noreferrer">Open ↗</a>
      </div>
      {f.summary && <div className="pv-sum">{f.summary}</div>}
      <div className="pv-media">
        {f.kind === "video" && <video ref={media} src={url} controls preload="metadata" />}
        {f.kind === "audio" && <audio ref={media} src={url} controls preload="metadata" />}
        {f.kind === "pdf" && <iframe key={`${f.file_id}-${focus.page ?? 1}`} src={`${url}#page=${focus.page ?? 1}`} title={f.name} />}
        {f.kind === "image" && <img src={url} alt={f.name} />}
        {f.kind === "table" && <div className="dim" style={{ padding: 12 }}>Tabular recorder data: analysed numerically (see Flight view and profile).</div>}
      </div>
      <div className="pv-atoms">
        <div className="label">Extracted from this source ({atoms.length})</div>
        {atoms.slice(0, 300).map(({ kind, item }) => {
          const c = item.citations.find((x) => x.file_id === f.file_id);
          const ms = c?.media_s;
          return (
            <div key={item.id} className={`feeditem ${kind === "anomaly" ? `sev-${(item as any).severity}` : ""}`} onClick={() => {
              onSelect({ kind, item } as Selection);
              if (ms != null) setFocus({ file_id: f.file_id, media_s: ms });
              else if (c?.page) setFocus({ file_id: f.file_id, page: c.page });
            }}>
              <span className="ft">{ms != null ? `▶ ${fmtMedia(ms)}` : item.time?.t_s != null ? fmtT(item.time.t_s) : c?.page ? `p.${c.page}` : "—"}</span>
              <span className="fx">{kind === "anomaly" ? <b>{(item as any).title}: </b> : null}{kind === "anomaly" ? (item as any).observed : (item as any).description}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
