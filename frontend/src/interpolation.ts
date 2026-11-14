// Shape-preserving cubic Hermite interpolation for display only. Every original
// sample is retained, and each interpolated segment stays within its endpoints.
export type Sample = [number, number];
const slopes = new WeakMap<Sample[], number[]>();
const dense = new WeakMap<Sample[], Sample[]>();
const angles = new WeakMap<Sample[], Sample[]>();

export function interpolateHeading(points: Sample[], t: number): number | null {
  let unwrapped = angles.get(points);
  if (!unwrapped) {
    let previous = points[0]?.[1] ?? 0;
    unwrapped = points.map(([time, value], i) => {
      previous = i ? previous + ((value - previous) % 360 + 540) % 360 - 180 : value;
      return [time, previous];
    });
    angles.set(points, unwrapped);
  }
  const result = interpolate(unwrapped, t);
  return result ? (result.value % 360 + 360) % 360 : null;
}

function tangents(points: Sample[]): number[] {
  const cached = slopes.get(points);
  if (cached) return cached;
  const h = points.slice(1).map((p, i) => p[0] - points[i][0]);
  const d = h.map((dt, i) => dt > 0 ? (points[i + 1][1] - points[i][1]) / dt : 0);
  const m = points.map((_, i) => {
    if (!i) return d[0] ?? 0;
    if (i === points.length - 1) return d[i - 1] ?? 0;
    const a = d[i - 1], b = d[i];
    if (!a || !b || Math.sign(a) !== Math.sign(b) || h[i - 1] <= 0 || h[i] <= 0) return 0;
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    return (w1 + w2) / (w1 / a + w2 / b);
  });
  slopes.set(points, m);
  return m;
}

export function interpolate(points: Sample[], t: number): { value: number; slope: number; gap: number; index: number } | null {
  if (!points.length || !Number.isFinite(t)) return null;
  if (points.length === 1) return { value: points[0][1], slope: 0, gap: 0, index: 0 };
  const time = Math.max(points[0][0], Math.min(points[points.length - 1][0], t));
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid][0] <= time) lo = mid; else hi = mid; }
  const [t0, v0] = points[lo], [t1, v1] = points[hi], h = t1 - t0;
  if (h <= 0) return { value: v1, slope: 0, gap: 0, index: lo };
  const m = tangents(points), u = (time - t0) / h, u2 = u * u, u3 = u2 * u;
  const value = (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * h * m[lo]
    + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * h * m[hi];
  const slope = ((6 * u2 - 6 * u) * v0 + (3 * u2 - 4 * u + 1) * h * m[lo]
    + (-6 * u2 + 6 * u) * v1 + (3 * u2 - 2 * u) * h * m[hi]) / h;
  return { value: Math.max(Math.min(v0, v1), Math.min(Math.max(v0, v1), value)), slope, gap: h, index: lo };
}

/** Add render samples to sparse segments; never modify the source array. */
export function displayPoints(points: Sample[]): Sample[] {
  const cached = dense.get(points);
  if (cached) return cached;
  const out: Sample[] = [];
  points.forEach((p, i) => {
    out.push(p);
    const next = points[i + 1];
    if (!next || next[0] - p[0] < 2) return;
    for (let step = 1; step < 5; step++) {
      const t = p[0] + (next[0] - p[0]) * step / 5;
      out.push([t, interpolate(points, t)!.value]);
    }
  });
  dense.set(points, out);
  return out;
}
