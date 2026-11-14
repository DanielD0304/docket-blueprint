import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { investigateCase, rerunCase } from "./api";
import { Home } from "./Home";
import { Header, Inspector } from "./panels";
import { makeSample } from "./sample";
import { CausalGraph } from "./sheets/CausalGraph";
import { Profile } from "./sheets/Profile";
import { Sensors } from "./views/Sensors";
import type { Selection } from "./types";
import { useCase } from "./useCase";
import { FlightView } from "./views/FlightView";
import { Hypotheses } from "./views/Hypotheses";
import { AgentActivity } from "./views/AgentActivity";
import { Sources, type SourceFocus } from "./views/Sources";
import { TimelineStrip, type PlayState } from "./views/TimelineStrip";

type View = "sensors" | "flight" | "profile" | "causal" | "hypotheses" | "activity" | "sources";
const VIEWS: [View, string][] = [["flight", "Flight"], ["profile", "Profile"], ["sensors", "Sensors"], ["causal", "Causal graph"], ["hypotheses", "Hypotheses"], ["activity", "Agent activity"], ["sources", "Sources"]];

function readHash(): string | null {
  const m = location.hash.match(/case=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function App() {
  const [caseId, setCaseId] = useState<string | null>(readHash());
  const [sampleOn, setSampleOn] = useState(location.hash.includes("sample"));
  const sample = useMemo(() => (sampleOn ? makeSample() : undefined), [sampleOn]);
  const live = useCase(sampleOn ? null : caseId, sample);
  const [view, setView] = useState<View | null>(() => (location.hash.match(/view=(\w+)/)?.[1] as View) ?? null);
  const [selected, setSelected] = useState<Selection>(null);
  const [hypothesisId, setHypothesisId] = useState<string | null | undefined>(undefined);
  const [cursor, setCursor] = useState<number | null>(() => {
    const m = location.hash.match(/[&#]t=([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  });
  const [play, setPlay] = useState<PlayState>({ playing: false, speed: 4 });
  const [focus, setFocus] = useState<SourceFocus | null>(null);
  const [demoPlayback,setDemoPlayback] = useState(false);
  const autoReplayed = useRef<string | null>(null);
  const [inspOpen, setInspOpen] = useState(true);

  useEffect(() => {
    const onHash = () => {
      setCaseId(readHash()); setSampleOn(location.hash.includes("sample"));
      setView((location.hash.match(/view=(\w+)/)?.[1] as View) ?? null);
      const at = location.hash.match(/[&#]t=([\d.]+)/);
      setCursor(at ? parseFloat(at[1]) : null);
      setPlay((p) => ({ ...p, playing: false }));
      setHypothesisId(undefined); setSelected(null);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const g = live.graph;
  // While agents run, start on Sources; once done, on Flight.
  const autoView: View = g && g.status !== "done" && live.mode === "live" ? "sources" : "flight";
  const current = view ?? autoView;
  const hypothesis = current === "hypotheses"
    ? g?.hypotheses.find((h) => h.id === hypothesisId) ?? g?.hypotheses[0] : undefined;
  const playing = useRef(play.playing); playing.current = play.playing;

  const select = useCallback((s: Selection) => {
    setSelected(s);
    setInspOpen(true);
    const t = s?.item.time?.t_s;
    if (t != null && !playing.current) setCursor(t);
  }, []);
  const openSource = useCallback((f: SourceFocus) => { setFocus(f); setView("sources"); }, []);

  const replayDemo = useCallback(() => {
    setDemoPlayback(true);setView("sources");
    void live.replay(18,false,phase=>setView(phase)).catch(e=>alert(e.message));
  },[live.replay]);
  useEffect(()=>{
    if(!caseId)autoReplayed.current=null;
    if(caseId && g?.case_id === caseId && g.status === "done" && live.mode === "static" && location.hash.includes("demoReplay=1") && autoReplayed.current!==caseId){
      autoReplayed.current=caseId;replayDemo();
    }
  },[caseId,g?.case_id,g?.status,live.mode,replayDemo]);
  const open = (id: string, demoReplay = false) => { location.hash = `case=${encodeURIComponent(id)}${demoReplay?"&view=sources&demoReplay=1":""}`; };
  const home = () => { location.hash = ""; setSelected(null); };

  if ((!caseId && !sampleOn) || !g) return <Home open={open} openSample={() => (location.hash = "sample")} />;

  const actions = !sampleOn && (
    <>
      {location.hash.includes("demoReplay=1") && <span className="label" title="This is the configured recorded case; uploaded files are not analyzed">Recorded demo</span>}
      <button className="btn" disabled={live.mode === "replay" || g.status !== "done" || !g.files.length} onClick={replayDemo} title="Replay recorded sources, then the investigator graph; no model calls">{live.mode === "replay" ? "Replaying demo…" : "Replay demo"}</button>
      {g.status === "done" && <button className="btn" onClick={() => investigateCase(g.case_id).then((id) => { setView("activity"); open(id); }).catch((e) => alert(e.message))}
        title="Rerun the investigator team using saved evidence. Creates a separate case; does not refresh sensor detection.">Rerun fusion</button>}
      <button className="btn" disabled={g.status === "running" || live.mode === "replay"} onClick={() => rerunCase(g.case_id).then(() => location.reload()).catch(e=>alert(e.message))} title="Rerun the pipeline, refresh outdated sensor detection, and reuse valid extraction caches.">Rerun pipeline</button>
    </>
  );

  const showInspector = inspOpen && (!(current === "activity" || current === "hypotheses" || current === "sensors") || selected !== null);
  return (
    <div className={`console ${showInspector ? "" : "no-insp"}`}>
      <Header g={g} onHome={home} actions={actions} />
      <div className="center">
        <div className="tabs">
          {VIEWS.map(([k, label]) => (
            <button key={k} className={`tab ${current === k ? "active" : ""}`} onClick={() => setView(k)}>
              {label}{k === "sources" && g.status === "running" ? " ●" : ""}
            </button>
          ))}
          <span className="spacer" />
          <button className="tab" onClick={() => setInspOpen(!inspOpen)}>{inspOpen ? "Hide inspector ⇥" : "⇤ Inspector"}</button>
        </div>
        <div className="viewport frame">
          {current === "flight" && <FlightView g={g} cursor={cursor} selected={selected} onSelect={select} speed={play.speed} />}
          {current === "profile" && <Profile series={g.series} unresolvedFiles={[...new Set(g.events.filter((e) => e.time.aligned_by === "mmss" && g.clocks[e.source_files[0]] == null).map((e) => e.source_files[0]))]} anomalies={g.anomalies} cursor={cursor} setCursor={(t) => t !== null && !play.playing && setCursor(t)} onSelect={select} openSource={(id) => openSource({ file_id: id })} />}
          {current === "sensors" && <Sensors g={g} cursor={cursor} setCursor={(t) => { setPlay((p) => ({ ...p, playing: false })); setCursor(t); }} openSource={openSource} />}
          {current === "causal" && <CausalGraph anomalies={g.anomalies} edges={g.causal_edges} hypotheses={g.hypotheses} selected={selected} onSelect={select}
            hypothesisId={null} onHypothesisSelect={(id) => { setHypothesisId(id); setSelected(null); setView("hypotheses"); }} />}
          {current === "hypotheses" && <Hypotheses g={g} hypothesisId={hypothesis?.id ?? null} onChoose={(id) => { setHypothesisId(id); setSelected(null); }} onSelect={select} openSource={openSource} />}
          {current === "activity" && <AgentActivity externalPlayback={demoPlayback} g={g} openSource={openSource} replay={() => live.replay(35, true)} />}
          {current === "sources" && <Sources live={live} focus={focus} setFocus={setFocus} onSelect={select} />}
        </div>
        {current !== "activity" && <TimelineStrip g={g} cursor={cursor} setCursor={setCursor} play={play} setPlay={setPlay} selected={selected} onSelect={select} />}
      </div>
      {showInspector && <Inspector g={g} selected={selected} onSelect={select} cursor={cursor} openSource={openSource} />}
    </div>
  );
}
