import assert from "node:assert/strict";
import test from "node:test";
import { suspectAirspeedRuns } from "../src/profileQuality.ts";

test("flag a sustained 0/384 signature but preserve ordinary zero or high speeds", () => {
  const points = Array.from({ length: 16 }, (_, i) => [i, i % 4 ? 0 : 384]);
  assert.deepEqual(suspectAirspeedRuns(points), [{ start: 0, end: 15, firstSample: 1, lastSample: 16 }]);
  assert.deepEqual(suspectAirspeedRuns(points.map(([t]) => [t, 384])), []);
  assert.deepEqual(suspectAirspeedRuns(points.map(([t]) => [t, 0])), []);
  assert.deepEqual(suspectAirspeedRuns([[0, 380], [1, 390], [2, 400], [3, 410]]), []);
});

test("do not connect short suspicious runs across missing time", () => {
  const points = [[0, 384], [1, 0], [2, 384], [3, 0], [100, 384], [101, 0], [102, 384], [103, 0]];
  assert.deepEqual(suspectAirspeedRuns(points), []);
});
