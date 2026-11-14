import type { Anomaly } from "./types";

export const FADE_AFTER_S = 15 * 60;
export const HIDE_AFTER_S = 30 * 60;
export const COOL_AFTER_S = 5 * 60;

/** Playback-time lifecycle. Unknown duration is never assumed to mean ongoing. */
export function annotationLifecycle(a: Anomaly, t: number): {
  state: "fresh" | "current" | "cooling" | "stale" | "hidden" | "context";
  lastSeen: number | null; ongoing: boolean;
} {
  const observations = a.observations?.length ? a.observations :
    a.time?.t_s != null ? [{ start_s: a.time.t_s, end_s: null }] : [];
  if (!observations.length) return { state: "context", lastSeen: null, ongoing: false };
  const noticed = observations.filter((o) => Number.isFinite(o.start_s) && o.start_s <= t);
  if (!noticed.length) return { state: "hidden", lastSeen: null, ongoing: false };
  const ongoing = noticed.some((o) => o.end_s != null && Number.isFinite(o.end_s) && o.end_s >= t && o.end_s >= o.start_s);
  const lastSeen = Math.max(...noticed.map((o) => o.end_s != null && Number.isFinite(o.end_s) && o.end_s >= o.start_s
    ? Math.min(t, o.end_s) : o.start_s));
  const age = t - lastSeen;
  return { state: ongoing ? "current" : age >= HIDE_AFTER_S ? "hidden" : age >= FADE_AFTER_S ? "stale" : age >= COOL_AFTER_S ? "cooling" : age < 12 ? "fresh" : "current",
    lastSeen, ongoing };
}
