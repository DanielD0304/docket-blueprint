import assert from "node:assert/strict";
import test from "node:test";
import { smoothGroundTrack } from "../src/flightPath.ts";

test("normal-flight quantization steps are smoothed without touching source data", () => {
  const points = Array.from({ length: 301 }, (_, i) => ({ t: i * 2,
    x: Math.round(i * 2 * 210 / 133) * 133, z: Math.round(i * 2 * -40 / 76) * 76 }));
  const original = JSON.stringify(points), smoothed = smoothGroundTrack(points);
  const roughness = (ps) => ps.slice(10, 200).reduce((sum, p, j) => {
    const i = j + 10;
    return sum + (ps[i + 1].x - 2 * p.x + ps[i - 1].x) ** 2
      + (ps[i + 1].z - 2 * p.z + ps[i - 1].z) ** 2;
  }, 0);
  assert.ok(roughness(smoothed) < roughness(points) * .2);
  assert.equal(JSON.stringify(points), original);
  points.forEach((p, i) => { if (p.t >= 480) assert.deepEqual(smoothed[i], p); });
  assert.deepEqual(smoothed[0], points[0]);
});

test("constant velocity survives smoothing with irregular sample times", () => {
  const points = [0, 1, 3, 8, 11, 16, 20, 26, 38, 50, 90, 300].map((t) => ({ t, x: t * 2 + 40, z: -t * 3 + 10 }));
  smoothGroundTrack(points).forEach((p, i) => {
    assert.ok(Math.abs(p.x - points[i].x) < 1e-8);
    assert.ok(Math.abs(p.z - points[i].z) < 1e-8);
  });
});
