// Reusable instrument / card pieces for the flight view.
import { fmtT } from "../api";
import { stateAt, valueAt, window_, type DiscreteIndex, type SeriesMap, type ZoneId } from "../data";
import type { Event } from "../types";

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const f = (v: number | null | undefined, d = 0, unit = "") => (v === null || v === undefined || !isFinite(v) ? "—" : `${v.toFixed(d)}${unit}`);

export function dt(sec: number): string {
  const a = Math.abs(sec);
  const s = a < 60 ? `${Math.round(a)} s` : a < 3600 ? `${Math.floor(a / 60)} min ${Math.round(a % 60)} s` : `${(a / 3600).toFixed(1)} h`;
  return sec < 0 ? `${s} earlier` : `${s} later`;
}

export function Spark({ pts, t, span = 90 }: { pts: [number, number][]; t: number | null; span?: number }) {
  if (pts.length < 2 || t === null) return null;
  const t0 = t - span, ys = pts.map((p) => p[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys), r = hi - lo || 1;
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${(((x - t0) / span) * 100).toFixed(1)},${(18 - ((y - lo) / r) * 16).toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className="spark" viewBox="0 0 100 20" preserveAspectRatio="none">
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
      <circle cx={((lx - t0) / span) * 100} cy={18 - ((ly - lo) / r) * 16} r={1.8} fill="var(--warn)" />
    </svg>
  );
}

export function ADI({ pitch, roll, fpa, size = 120 }: { pitch: number; roll: number; fpa: number | null; size?: number }) {
  const k = 2.4;
  return (
    <svg className="adi" width={size} height={size} viewBox="-80 -80 160 160">
      <defs><clipPath id="adi-clip"><circle r={70} /></clipPath></defs>
      <g clipPath="url(#adi-clip)">
        <g transform={`rotate(${-roll}) translate(0 ${clamp(pitch, -60, 60) * k})`}>
          <rect x={-200} y={-400} width={400} height={400} fill="rgba(94,225,255,0.18)" />
          <rect x={-200} y={0} width={400} height={400} fill="rgba(255,181,71,0.16)" />
          <line x1={-200} x2={200} y1={0} y2={0} stroke="var(--ink)" strokeWidth={1.2} />
          {[-40, -30, -20, -10, 10, 20, 30, 40].map((d) => (
            <g key={d}>
              <line x1={-(d % 20 ? 10 : 20)} x2={d % 20 ? 10 : 20} y1={-d * k} y2={-d * k} stroke="var(--ink)" strokeWidth={0.8} />
              {d % 20 === 0 && <text x={24} y={-d * k + 3} fontSize={8} fill="var(--ink-dim)">{Math.abs(d)}</text>}
            </g>
          ))}
        </g>
        {fpa !== null && (
          <g transform={`translate(0 ${clamp((pitch - fpa) * k, -60, 60)})`}>
            <circle r={4} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
            <path d="M-10 0 L-4 0 M4 0 L10 0 M0 -4 L0 -9" stroke="var(--accent)" strokeWidth={1.5} />
          </g>
        )}
      </g>
      <circle r={70} fill="none" stroke="var(--line)" />
      {[-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].map((d) => (
        <line key={d} x1={0} x2={0} y1={-70} y2={d % 30 ? -65 : -60} stroke="var(--line)" transform={`rotate(${d})`} />
      ))}
      <g transform={`rotate(${-roll})`}><path d="M0 -58 L-4 -50 L4 -50 Z" fill="var(--warn)" /></g>
      <path d="M-40 0 L-14 0 L-14 6 M40 0 L14 0 L14 6" fill="none" stroke="var(--warn)" strokeWidth={3} />
      <circle r={2.5} fill="var(--warn)" />
    </svg>
  );
}

const AUTOFLIGHT_RE = /autopilot|a\/p|\bap\b|autothrot|a\/t|go.?around|toga|\bmode|flight dir|lnav|vnav/i;

function chips(di: DiscreteIndex, re: RegExp, t: number | null) {
  const out: JSX.Element[] = [];
  di.forEach((_, name) => {
    if (!re.test(name)) return;
    const s = stateAt(di, new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`), t);
    if (!s) return;
    const fresh = t !== null && s.changed !== null && t - s.changed < 6;
    out.push(<span key={name} className={`chip ${fresh ? "fresh" : ""}`} title={`${name} since ${fmtT(s.changed)}`}>{name.slice(0, 18)} <b>{s.value}</b></span>);
  });
  return out.length ? <div className="chips">{out.slice(0, 5)}</div> : null;
}

/** Live content of one system card. Returns null if the zone has nothing to show. */
export function ZoneBody({ id, t, sm, di, last }: { id: ZoneId; t: number | null; sm: SeriesMap; di: DiscreteIndex; last: Event | null }) {
  const v = (n: string) => valueAt(sm.get(n), t);
  const row = (k: string, val: string, bad = false) => <div className="zrow" key={k}><span>{k}</span><b className={bad ? "bad" : ""}>{val}</b></div>;
  const lastLine = last && <div className="zlast" title={last.description}><span className="ft">{fmtT(last.time.t_s)}</span>{last.description}</div>;
  switch (id) {
    case "airdata": {
      const sh = stateAt(di, /shak|stall/i, t);
      const on = !!sh && /on|1|active|true/i.test(sh.value);
      return <>
        <div className="zgrid">{row("IAS", f(v("airspeed_kt"), 0, " kt"))}{row("AoA", f(v("aoa_deg"), 1, "°"), (v("aoa_deg") ?? 0) > 12)}{row("MACH", f(v("mach"), 3))}{row("SHAKER", on ? "ACTIVE" : sh?.value ?? "—", on)}</div>
        <Spark pts={window_(sm.get("airspeed_kt"), t)} t={t} /></>;
    }
    case "autoflight": return chips(di, AUTOFLIGHT_RE, t) ?? lastLine ?? <div className="dim">No autoflight data</div>;
    case "engines": {
      const n1 = [1, 2, 3, 4].map((k) => v(`n1_${k}`)).filter((x): x is number => x !== null);
      return <>{n1.length ? n1.map((x, i) => (
        <div key={i} className="n1"><span>ENG {i + 1}</span><div className="bar"><i style={{ width: `${clamp(x, 0, 110) / 1.1}%` }} /></div><b>{x.toFixed(1)}%</b></div>
      )) : lastLine ?? <div className="dim">No N1 / EPR data</div>}</>;
    }
    case "empennage": return <>
      <div className="zgrid">{row("ELEV", f(v("elevator_deg"), 1, "°"))}{row("STAB", f(v("stab_trim_deg"), 1, "°"))}{row("COLUMN", f(v("column_deg"), 1, "°"))}{row("FLAPS", f(v("flap_deg"), 0, "°"))}</div>
      <Spark pts={window_(sm.get("elevator_deg") ?? sm.get("pitch_deg"), t)} t={t} /></>;
    case "gear": {
      const gs = stateAt(di, /gear/i, t);
      return <div className="zgrid">{row("GEAR", gs?.value ?? "—")}{row("RAD ALT", f(v("radio_alt_ft"), 0, " ft"))}</div>;
    }
    default: return lastLine;
  }
}
