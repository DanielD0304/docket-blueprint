import { useEffect, useMemo, useRef, useState } from "react";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY, type SimulationNodeDatum } from "d3";
import type { CaseGraph } from "../types";
import type { SourceFocus } from "./Sources";
import { useSize } from "../useSize";
import { buildActivityGraph, TOOL_NAMES, type ActivityNode } from "./activityGraph";
import "./agentActivity.css";

type Particle = SimulationNodeDatum & { id: string; item: ActivityNode };
const COLORS: Record<string,string> = { source:"#719fcb", tool:"#5ee1ff", finding:"#ffbd69", hypothesis:"#bba4ff", conclusion:"#8aefbb" };

export function AgentActivity({ g, openSource, externalPlayback = false }: { externalPlayback?: boolean; g: CaseGraph; openSource: (f: SourceFocus) => void; replay: () => void }) {
  const report = g.investigation;
  const steps = report?.steps ?? [];
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [manualPlayback,setManualPlayback] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [zoom, setZoom] = useState(.65);
  const [pan, setPan] = useState({x:0,y:0});
  const [ref,size] = useSize<HTMLDivElement>();
  const [frame,setFrame] = useState(0);
  const particles = useRef(new Map<string,Particle>());
  const dragging = useRef<{id?:string;x:number;y:number;px:number;py:number}|null>(null);
  const simulation = useRef<ReturnType<typeof forceSimulation<Particle>> | null>(null);
  const live = (g.status === "running" || externalPlayback) && !manualPlayback;
  const count = live ? steps.length : Math.min(cursor,steps.length);
  useEffect(()=>{setCursor(0);setPlaying(true);setManualPlayback(false);setSelection(null);particles.current.clear();},[g.case_id]);
  useEffect(()=>{if(!playing || live || !steps.length)return;const timer=window.setInterval(()=>setCursor(n=>Math.min(steps.length,n+1)),230);return()=>clearInterval(timer);},[playing,live,steps.length]);
  const visible = useMemo(()=>{
    const trace=steps.slice(0,count), titles=new Set(trace.filter(s=>s.phase==="conclusion").map(s=>s.title));
    return {...g,investigation:report?{...report,steps:trace,agents:report.agents?.map(a=>({...a,findings:a.findings.filter(f=>titles.has(f.title))})),conclusion:trace.some(s=>s.phase==="conclusion" && /overall|audited/i.test(s.title))?report.conclusion:null}:null};
  },[g,count]);
  const graph=useMemo(()=>{
    const raw=buildActivityGraph(visible), aliases=new Map<string,string>(), groups=new Map<string,ActivityNode>();
    for(const n of raw.nodes){
      const id=n.kind==="tool"?`agent:${n.agentId??"lead"}`:n.id;aliases.set(n.id,id);
      const prior=groups.get(id);
      if(prior){prior.steps.push(...n.steps);prior.evidenceIds=[...new Set([...prior.evidenceIds,...n.evidenceIds])];prior.citations.push(...n.citations);prior.detail=n.detail;}
      else groups.set(id,{...n,id,title:n.kind==="tool"?(n.agentName??"Investigator"):n.title,steps:[...n.steps],evidenceIds:[...n.evidenceIds],citations:[...n.citations]});
    }
    const edges=new Map(raw.edges.map(e=>{const source=aliases.get(e.source)!,target=aliases.get(e.target)!,id=`${source}>${target}`;return [id,{...e,id,source,target}];}));
    return {nodes:[...groups.values()],edges:[...edges.values()]};
  },[visible]);
  useEffect(()=>{
    const ids=new Set(graph.nodes.map(n=>n.id));
    for(const id of particles.current.keys())if(!ids.has(id))particles.current.delete(id);
    for(const item of graph.nodes){const old=particles.current.get(item.id);if(old)old.item=item;else{
      const neighbor=graph.edges.find(e=>e.target===item.id && particles.current.has(e.source));
      const anchor=neighbor?particles.current.get(neighbor.source):undefined;
      const angle=particles.current.size*2.39996;
      particles.current.set(item.id,{id:item.id,item,x:(anchor?.x??0)+Math.cos(angle)*70,y:(anchor?.y??0)+Math.sin(angle)*70});
    }}
    simulation.current?.stop();
    const sim=forceSimulation([...particles.current.values()])
      .force("links",forceLink<Particle,any>(graph.edges.map(e=>({...e}))).id(n=>n.id).distance(105).strength(.13))
      .force("charge",forceManyBody().strength(-380)).force("collision",forceCollide<Particle>(n=>n.item.kind==="conclusion"?70:48))
      .force("center",forceCenter(0,0)).force("x",forceX(0).strength(.035)).force("y",forceY(0).strength(.035)).alpha(.6).alphaDecay(.035)
      .on("tick",()=>setFrame(n=>n+1));
    simulation.current=sim;return()=>{sim.stop();};
  },[graph]);
  const nodes=[...particles.current.values()];
  const active=graph.nodes.find(n=>n.id===selection);
  const latest=steps[count-1];
  const recent=new Set((live || count<steps.length) ? latest?.evidence_ids??[] : []);
  const connected=new Set(selection?[selection]:[]);
  if(selection)for(const e of graph.edges)if(e.source===selection||e.target===selection){connected.add(e.source);connected.add(e.target);}
  const width=Math.max(500,size.width),height=Math.max(350,size.height);
  const fit=()=>{const ns=[...particles.current.values()];const extent=Math.max(350,...ns.map(n=>Math.abs(n.x??0)*2),...ns.map(n=>Math.abs(n.y??0)*2*width/height));setZoom(Math.max(.45,Math.min(1,width/(extent+180))));setPan({x:0,y:0});};
  return <div className="activity-graph-view living-graph">
    <header className="activity-graph-header"><div><span className="activity-eyebrow">Investigation in motion</span><h2>Follow the evidence</h2></div>
      <div className="living-legend">{Object.entries(COLORS).map(([k,c])=><span key={k}><i style={{background:c}}/>{k}</span>)}</div>

    </header>
    <div className={`living-main ${active?"with-detail":""}`}>
      <div className="living-canvas" ref={ref}>
        <svg width="100%" height="100%" viewBox={`${-width/2} ${-height/2} ${width} ${height}`} data-frame={frame}
          onWheel={e=>{setZoom(z=>Math.max(.15,Math.min(2,z*Math.exp(-e.deltaY*.001))));}}
          onPointerDown={e=>{const el=(e.target as Element).closest("[data-node]");const id=el?.getAttribute("data-node")??undefined;if(id)setSelection(id);dragging.current={id,x:e.clientX,y:e.clientY,px:pan.x,py:pan.y};e.currentTarget.setPointerCapture(e.pointerId);}}
          onPointerMove={e=>{const d=dragging.current;if(!d)return;const dx=e.clientX-d.x,dy=e.clientY-d.y;if(d.id){const n=particles.current.get(d.id);if(n){n.fx=(n.x??0)+dx/zoom;n.fy=(n.y??0)+dy/zoom;d.x=e.clientX;d.y=e.clientY;simulation.current?.alpha(.25).restart();}}else setPan({x:d.px+dx,y:d.py+dy});}}
          onPointerUp={()=>{const d=dragging.current;if(d?.id){const n=particles.current.get(d.id);if(n){n.fx=null;n.fy=null;}}dragging.current=null;}}>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {graph.edges.map(e=>{const a=particles.current.get(e.source),b=particles.current.get(e.target);if(!a||!b)return null;const lit=selection?(connected.has(e.source)&&connected.has(e.target)):b.item.evidenceIds.some(id=>recent.has(id));return <g key={e.id} className={`living-link ${lit?"lit":""}`} style={{opacity:selection&&!lit? .08:1}}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={e.challenge?"#ffbd69":"#7cb6d7"}/>{lit&&<circle r="3" fill="#c8f5ff"><animateMotion dur="1.7s" repeatCount="indefinite" path={`M${a.x},${a.y} L${b.x},${b.y}`}/></circle>}</g>;})}
            {nodes.map(n=>{const r=n.item.kind==="conclusion"?32:n.item.kind==="tool"?23:15;const hot=n.item.evidenceIds.some(id=>recent.has(id));return <g key={n.id} data-node={n.id} className={`living-node ${hot?"hot":""}`} transform={`translate(${n.x??0},${n.y??0})`} opacity={selection&&!connected.has(n.id)? .2:1} onClick={()=>setSelection(n.id)} role="button" tabIndex={0} aria-label={n.item.title} onKeyDown={e=>{if(e.key==="Enter")setSelection(n.id);}}>
              <title>{n.item.agentName?`${n.item.agentName}: `:""}{n.item.title}</title><circle className="node-halo" r={r+10} fill="none" stroke={COLORS[n.item.kind]}/><circle r={r} fill={COLORS[n.item.kind]} fillOpacity=".2" stroke={COLORS[n.item.kind]} strokeWidth={selection===n.id?3:1.5}/>
              <text textAnchor="middle" dy="5" fill={COLORS[n.item.kind]} fontSize="12">{n.item.kind==="source"?"▤":n.item.kind==="tool"?"◎":n.item.kind==="conclusion"?"★":"◆"}</text>
              <text textAnchor="middle" y={r+23} className={`living-label ${n.item.kind==="tool" || n.item.kind==="conclusion" || connected.has(n.id) || hot ? "show-label":""}`}>{n.item.title.length>34?n.item.title.slice(0,32)+"…":n.item.title}</text>
              {n.item.agentName&&n.item.kind!=="tool"&&<text textAnchor="middle" y={r+38} className="living-agent">{n.item.agentName}</text>}
            </g>;})}
          </g>
        </svg>
        {!nodes.length&&<div className="living-start">{steps.length?"The investigation begins…":"Waiting for the first recorded action…"}</div>}
        <div className="living-controls"><button className="btn" onClick={()=>setZoom(z=>Math.max(.2,z*.85))}>−</button><button className="btn" onClick={()=>setZoom(z=>Math.min(2,z*1.15))}>+</button><button className="btn" onClick={fit}>Fit graph</button>{active&&<button className="btn" onClick={()=>setSelection(null)}>Clear selection</button>}</div>
      </div>
      {active&&<div className="living-detail"><button className="btn" onClick={()=>setSelection(null)}>Close details ×</button><ActivityDetail node={active} g={g} openSource={openSource}/></div>}
    </div>
    <footer className="living-transport"><button className="btn" onClick={()=>{setManualPlayback(true);if(count>=steps.length){setCursor(0);setPlaying(true);}else{setCursor(count);setPlaying(!playing);}}}>{playing&&count<steps.length?"Pause":"Play"}</button><input aria-label="Investigation progress" type="range" min="0" max={steps.length} value={count} onChange={e=>{setManualPlayback(true);setPlaying(false);setCursor(Number(e.target.value));}}/><span>{count}/{steps.length}</span><button className="btn" onClick={()=>{setManualPlayback(true);setCursor(steps.length);setPlaying(false);}}>Show result</button></footer>
    <div className="living-caption"><b>{latest?.agent_name??"Investigator"}</b><span>{latest?.title??"Nodes appear as evidence is read. Drag nodes to explore; scroll to zoom."}</span></div>
  </div>;
}

function ActivityDetail({ node, g, openSource }: { node?: ActivityNode; g: CaseGraph; openSource: (f: SourceFocus) => void }) {
  const [showAllQuotes, setShowAllQuotes] = useState(false);
  useEffect(() => { setShowAllQuotes(false); }, [node?.id]);
  if (!node) return <aside className="activity-node-detail"><span className="activity-eyebrow">Evidence inspector</span><h3>Follow the investigation</h3><p>Select a source, a tool or a result to see what was read and how its evidence connects.</p></aside>;
  const calls = node.steps.filter((s) => s.phase === "tool_call");
  return <aside className="activity-node-detail" aria-label="Selected activity node">
    <span className="activity-eyebrow">{node.agentName ?? node.kind.replace(/_/g, " ")}</span><h3>{node.title}</h3>
    {node.status === "reading" && <span className="activity-detail-status">Reading evidence…</span>}
    {node.detail && <p className="activity-node-explanation">{node.detail}</p>}
    {node.kind === "tool" && calls.length > 0 && <div className="activity-call-list"><h4>Recorded calls ({calls.length})</h4>{calls.map((step) => <details key={step.id}>
      <summary>Turn {step.turn} · {TOOL_NAMES[step.tool ?? ""] ?? step.tool}</summary><pre>{formatArguments(step.detail)}</pre>
    </details>)}</div>}
    {node.citations.length > 0 && <section className="activity-proof"><h4>Source evidence <span>{node.citations.length}</span></h4>
      {(showAllQuotes ? node.citations : node.citations.slice(0, 5)).map((citation, i) => {
        const file = g.files.find((f) => f.file_id === citation.file_id);
        return <button key={`${citation.file_id}-${citation.page}-${i}`} onClick={() => openSource(citation)}>
          <span>{file?.docket_item ? `#${file.docket_item}` : "Source"} · {file?.role.replace(/_/g, " ") ?? "evidence"}{citation.page ? ` · p.${citation.page}` : citation.media_s != null ? ` · ${citation.media_s}s` : " · data"} ↗</span>
          <q>{citation.quote}</q></button>;
      })}
      {node.citations.length > 5 && <button className="activity-more" onClick={() => setShowAllQuotes(!showAllQuotes)}>{showAllQuotes ? "Show fewer passages" : `Show all ${node.citations.length} passages`}</button>}
    </section>}
    {node.kind === "conclusion" && g.investigation?.conclusion?.limitations.length ? <section><h4>Still unresolved</h4><ul>{g.investigation.conclusion.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul></section> : null}
    {!node.citations.length && node.kind !== "tool" && <p className="activity-limitation">No source passages were attached to this recorded step.</p>}
  </aside>;
}

function formatArguments(detail: string) {
  try { return JSON.stringify(JSON.parse(detail), null, 2); } catch { return detail; }
}
