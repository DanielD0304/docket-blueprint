import { useEffect, useState } from "react";
import { health, listCases, localCase, uploadCase } from "./api";

const ATLAS = {
  title: "Atlas Air 3591", ntsb_id: "DCA19MA086", date: "2019-02-23", aircraft: "Boeing 767-375BCF",
  local_utc_offset_h: -6, blind_mode: true,
};

export function Home({ open, openSample }: { open: (id: string, demoReplay?: boolean) => void; openSample: () => void }) {
  const [cfg, setCfg] = useState<Record<string, any>>(ATLAS);
  const [files, setFiles] = useState<File[]>([]);
  const [path, setPath] = useState("../data/dockets/DCA19MA086");
  const [over, setOver] = useState(false);
  const [cases, setCases] = useState<any[]>([]);
  const [status, setStatus] = useState<string>("checking backend…");
  const [demoMode,setDemoMode] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    health().then((h) => {setDemoMode(!!h.demo);setStatus(`backend online · ${h.mock ? "MOCK extractor (no API key)" : `${h.models.fast} / ${h.models.pro}`}`);})
      .catch(() => setStatus("backend offline — start uvicorn (see README) or open the synthetic sample"));
    listCases().then(setCases).catch(() => {});
  }, []);

  const go = async (fn: () => Promise<{case_id:string;demo?:boolean}>) => {
    setBusy(true);
    try { const result=await fn();open(result.case_id,!!result.demo); } catch (e: any) { setStatus(String(e.message ?? e)); } finally { setBusy(false); }
  };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCfg({ ...cfg, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  return (
    <div className="home">
      <div className="home-box">
        <div className="frame" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div className="label">Sheet 0 — intake</div>
            <div className="h" style={{ fontSize: 26, color: "var(--accent)" }}>Docket Blueprint</div>
            <div className="dim">Drop an NTSB docket. A swarm of Gemini agents reads every document, then fuses one verified timeline, abnormality register and causal graph.</div>
          </div>
          <label className={`drop ${over ? "over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); setFiles(Array.from(e.dataTransfer.files)); }}>
            <input type="file" multiple hidden onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
            <div>
              <div className="h" style={{ fontSize: 16 }}>{files.length ? `${files.length} file(s) ready` : "Drop docket ZIP or files"}</div>
              <div className="dim">{files.length ? files.slice(0, 4).map((f) => f.name).join(", ") : "PDF · CSV · XLSX · images · audio · video"}</div>
            </div>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" disabled={!files.length || busy} onClick={() => go(() => demoMode ? localCase("", cfg) : uploadCase(files, cfg))}>Upload & analyse</button>
            <label className="btn" style={{cursor:"pointer"}}>Choose folder<input type="file" multiple {...{webkitdirectory:"",directory:""}} hidden onChange={e=>setFiles(Array.from(e.target.files??[]))}/></label>
            <button className="btn" onClick={openSample}>Open synthetic sample</button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input style={{ flex: 1, background: "rgba(0,0,0,.2)", border: "1px solid var(--line-dim)", padding: "5px 7px" }} value={path} onChange={(e) => setPath(e.target.value)} />
            <button className="btn" disabled={busy} onClick={() => go(() => localCase(path, cfg))}>Analyse local folder</button>
          </div>
          {demoMode && <div className="label">Recorded demo mode · intake replays the configured case; uploaded files are not analyzed</div>}
          <div className="label">{status}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="frame">
            <div className="panel-head"><span className="h">Case parameters</span></div>
            <div className="form">
              <label className="full">Title<input value={cfg.title} onChange={set("title")} /></label>
              <label>NTSB No.<input value={cfg.ntsb_id} onChange={set("ntsb_id")} /></label>
              <label>Date (UTC)<input value={cfg.date} onChange={set("date")} /></label>
              <label>Aircraft<input value={cfg.aircraft} onChange={set("aircraft")} /></label>
              <label>Local = UTC + h<input type="number" value={cfg.local_utc_offset_h} onChange={set("local_utc_offset_h")} /></label>
              <label className="full" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={cfg.blind_mode} onChange={set("blind_mode")} /> Blind mode — hold out final report as ground truth
              </label>
            </div>
          </div>
          <div className="frame panel" style={{ maxHeight: 260 }}>
            <div className="panel-head"><span className="h">Cases</span><span className="label">{cases.length}</span></div>
            <div className="panel-body">
              {cases.map((c) => (
                <div key={c.case_id} className="list-item" onClick={() => open(c.case_id)}>
                  <div>{c.config.title}</div>
                  <div className="dim" style={{ fontSize: 10 }}>{c.case_id} · {c.status} · {c.stage}</div>
                </div>
              ))}
              {!cases.length && <div className="dim" style={{ padding: 10 }}>No cases yet</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
