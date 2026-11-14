import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { investigateCase, rerunCase } from "./api";
import { Home } from "./Home";
import { Header, Inspector } from "./panels";
import { makeSample } from "./sample";
import { CausalGraph } from "./sheets/CausalGraph";
import { Profile } from "./sheets/Profile";
import type { Selection } from "./types";
import { useCase } from "./useCase";
import { FlightView } from "./views/FlightView";
import { Sources, type SourceFocus } from "./views/Sources";
import { TimelineStrip, type PlayState } from "./views/TimelineStrip";

type View = "flight" | "profile" | "causal" | "sources";
const VIEWS: [View, string][] = [["flight", "Flight"], ["profile", "Profile"], ["causal", "Causal graph"], ["sources", "Sources"]];

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
  const [cursor, setCursor] = useState<number | null>(() => {
    const m = location.hash.match(/[&#]t=([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  });
  const [play, setPlay] = useState<PlayState>({ playing: false, speed: 4 });
  const [focus, setFocus] = useState<SourceFocus | null>(null);
  const [inspOpen, setInspOpen] = useState(true);

  useEffect(() => {
    const onHash = () => {
      setCaseId(readHash()); setSampleOn(location.hash.includes("sample"));
      setView((location.hash.match(/view=(\w+)/)?.[1] as View) ?? null);
      const at = location.hash.match(/[&#]t=([\d.]+)/);
      setCursor(at ? parseFloat(at[1]) : null);
      setPlay((p) => ({ ...p, playing: false }));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const g = live.graph;
  // While agents run, start on Sources; once done, on Flight.
  const autoView: View = g && g.status !== "done" && live.mode === "live" ? "sources" : "flight";
  const current = view ?? autoView;
  const playing = useRef(play.playing); playing.current = play.playing;

  const select = useCallback((s: Selection) => {
    setSelected(s);
    setInspOpen(true);
    const t = s?.item.time?.t_s;
    if (t != null && !playing.current) setCursor(t);
  }, []);
  const openSource = useCallback((f: SourceFocus) => { setFocus(f); setView("sources"); }, []);

  const open = (id: string) => { location.hash = `case=${encodeURIComponent(id)}`; };
  const home = () => { location.hash = ""; setSelected(null); };

  if ((!caseId && !sampleOn) || !g) return <Home open={open} openSample={() => (location.hash = "sample")} />;

  const actions = !sampleOn && (
    <>
      <button className="btn" onClick={() => { setView("sources"); live.replay(25); }} title="Replay the recorded swarm run">Replay swarm</button>
      {g.investigation && <button className="btn" onClick={() => { setView("sources"); live.replay(35, true); }}>Replay investigation</button>}
      {g.status === "done" && <button className="btn" onClick={() => investigateCase(g.case_id).then((id) => { setView("sources"); open(id); }).catch((e) => alert(e.message))}
        title="New investigation from base extractions; original case preserved">Investigate again</button>}
      <button className="btn" onClick={() => rerunCase(g.case_id).then(() => location.reload())} title="Re-run pipeline (extraction cached)">Re-run</button>
    </>
  );

  return (
    <div className={`console ${inspOpen ? "" : "no-insp"}`}>
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
          {current === "profile" && <Profile series={g.series} unresolvedFiles={[...new Set(g.events.filter((e) => e.time.aligned_by === "mmss" && g.clocks[e.source_files[0]] == null).map((e) => e.source_files[0]))]} anomalies={g.anomalies} cursor={cursor} setCursor={(t) => t !== null && !play.playing && setCursor(t)} onSelect={select} />}
          {current === "causal" && <CausalGraph anomalies={g.anomalies} edges={g.causal_edges} hypotheses={g.hypotheses} selected={selected} onSelect={select} />}
          {current === "sources" && <Sources live={live} focus={focus} setFocus={setFocus} onSelect={select} />}
        </div>
        <TimelineStrip g={g} cursor={cursor} setCursor={setCursor} play={play} setPlay={setPlay} selected={selected} onSelect={select} />
      </div>
      {inspOpen && <Inspector g={g} selected={selected} onSelect={select} cursor={cursor} openSource={openSource} />}
    </div>
  );
}
