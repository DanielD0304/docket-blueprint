import type { Sample } from "./interpolation";

export interface SuspectRun { start: number; end: number; firstSample: number; lastSample: number }

/** Flag the repeated 0/384-kt signature present in the recorder export. This is
 * a display-quality flag, not a claim about aircraft speed or system failure.
 * Keep original samples available through the Profile raw-data toggle.
 */
export function suspectAirspeedRuns(points: Sample[]): SuspectRun[] {
  const runs: SuspectRun[] = [];
  let start = -1, zeros = 0, high = 0;
  const finish = (end: number) => {
    if (start >= 0 && end - start + 1 >= 8 && zeros >= 2 && high >= 2) {
      runs.push({ start: points[start][0], end: points[end][0], firstSample: start + 1, lastSample: end + 1 });
    }
    start = -1; zeros = high = 0;
  };
  points.forEach(([t, v], i) => {
    if (i && t - points[i - 1][0] > 15) finish(i - 1);
    if (v === 0 || v === 384) {
      if (start < 0) start = i;
      if (v === 0) zeros++; else high++;
    } else finish(i - 1);
  });
  finish(points.length - 1);
  return runs;
}
