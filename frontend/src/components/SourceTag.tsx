import { sourceOf, type SourceInfo } from "../data";
import type { CaseGraph } from "../types";

const COLORS: Record<string, string> = {
  FDR: "#5ee1ff", "FDR REPORT": "#5ee1ff", CVR: "#e6f1ff", ATC: "#8ec5ff", "RADAR/ADS-B": "#8ec5ff", RADAR: "#8ec5ff", "ADS-B": "#8ec5ff",
  INTERVIEW: "#ffb547", "PARTY CLAIM": "#c79bff", VIDEO: "#6ee7a8", AUDIO: "#6ee7a8", WEATHER: "#7fd3c7", SIMULATOR: "#c79bff",
  SYNTHETIC: "#ff5d5d",
};

/** Compact provenance chip: source type · docket item · page/media time · verification. */
export function SourceTag({ g, atom, info, long }: { g: CaseGraph; atom?: Parameters<typeof sourceOf>[1]; info?: SourceInfo; long?: boolean }) {
  const s = info ?? sourceOf(g, atom!);
  const col = COLORS[s.kind] ?? "#7fa3c8";
  const how = s.tool ? "computed from recorder data" : s.verified ? "quote verified in source" : s.verified === false ? "quote NOT found" : "not verifiable (scan/media)";
  return (
    <span className="srctag" style={{ color: col }} title={`${s.kind} ${s.item} ${s.title}${s.where ? ` · ${s.where}` : ""}\n${how}${s.n > 1 ? `\ncorroborated by ${s.n} documents` : ""}`}>
      <b>{s.kind}</b>
      {s.item && <span>{s.item}</span>}
      {long && <span className="st-title">{s.title}</span>}
      {s.where && <span>{s.where}</span>}
      {s.n > 1 && <span>+{s.n - 1}</span>}
      <i className={s.tool || s.verified ? "ok" : s.verified === false ? "bad" : "dim"}>{s.tool ? "⚙" : s.verified ? "✓" : s.verified === false ? "✗" : "?"}</i>
    </span>
  );
}
