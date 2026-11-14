export interface GroundSample { t: number; x: number; z: number }

/** Display-only local linear fit. Removes quantization steps while retaining a
 * constant-velocity trajectory, even with irregular sample spacing. The final
 * two minutes remain untouched so the upset is not smoothed away.
 */
export function smoothGroundTrack(points: GroundSample[], halfWindow = 12): GroundSample[] {
  if (points.length < 3) return points.map((p) => ({ ...p }));
  const first = points[0].t, protect = points[points.length - 1].t - 120;
  return points.map((p, i) => {
    const blend = Math.max(0, Math.min(1, (p.t - first) / halfWindow, (protect - p.t) / halfWindow));
    if (!blend) return { ...p };
    let start = i, end = i;
    while (start > 0 && p.t - points[start - 1].t <= halfWindow) start--;
    while (end + 1 < points.length && points[end + 1].t - p.t <= halfWindow) end++;
    let w = 0, wt = 0, wtt = 0, wx = 0, wz = 0, wtx = 0, wtz = 0;
    for (let j = start; j <= end; j++) {
      const q = points[j], dt = q.t - p.t, weight = Math.max(0, 1 - Math.abs(dt) / halfWindow);
      w += weight; wt += weight * dt; wtt += weight * dt * dt;
      wx += weight * q.x; wz += weight * q.z;
      wtx += weight * dt * q.x; wtz += weight * dt * q.z;
    }
    const determinant = w * wtt - wt * wt;
    if (determinant <= 1e-9) return { ...p };
    const x = (wtt * wx - wt * wtx) / determinant, z = (wtt * wz - wt * wtz) / determinant;
    return { t: p.t, x: p.x + blend * (x - p.x), z: p.z + blend * (z - p.z) };
  });
}
