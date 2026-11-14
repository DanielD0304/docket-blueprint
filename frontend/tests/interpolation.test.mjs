import assert from "node:assert/strict";
import test from "node:test";
import { interpolate, displayPoints } from "../src/interpolation.ts";

test("smooth interpolation retains all recorded samples", () => {
  const points = [[0, 4], [3, 8], [40, -15], [100, 3]];
  for (const [t, value] of points) assert.equal(interpolate(points, t).value, value);
});

test("uneven sparse segments never overshoot or introduce peaks", () => {
  const points = [[0, 4], [.1, 8], [40, -15], [200, 3], [200.1, 2]];
  for (let i = 1; i < points.length; i++) {
    const [t0, v0] = points[i - 1], [t1, v1] = points[i];
    for (let j = 0; j <= 100; j++) {
      const { value } = interpolate(points, t0 + (t1 - t0) * j / 100);
      assert.ok(value >= Math.min(v0, v1) && value <= Math.max(v0, v1));
    }
  }
});

test("velocity is continuous through an interior sample", () => {
  const points = [[0, 0], [10, 12], [100, 25]];
  const a = interpolate(points, 10 - 1e-6), b = interpolate(points, 10 + 1e-6);
  assert.ok(Math.abs(a.slope - b.slope) < 1e-5);
});

test("two samples interpolate linearly and render samples leave originals intact", () => {
  const points = [[0, 10], [100, 20]];
  const original = JSON.stringify(points);
  assert.equal(interpolate(points, 50).value, 15);
  const drawn = displayPoints(points);
  assert.ok(drawn.length > points.length);
  assert.equal(JSON.stringify(points), original);
  assert.equal(drawn[0], points[0]);
  assert.equal(drawn.at(-1), points.at(-1));
});

test("empty, single-point and duplicate-time input stay finite", () => {
  assert.equal(interpolate([], 2), null);
  assert.equal(interpolate([[10, 3]], 20).value, 3);
  assert.ok(Number.isFinite(interpolate([[0, 2], [0, 4]], 0).value));
});
