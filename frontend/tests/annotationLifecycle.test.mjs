import assert from "node:assert/strict";
import test from "node:test";
import { annotationLifecycle } from "../src/annotationLifecycle.ts";

const point = (t) => ({ time: { t_s: t } });
const observation = (start_s, end_s = null) => ({ start_s, end_s, citations: [] });

test("point observations fade at 15 minutes and disappear at 30", () => {
  assert.equal(annotationLifecycle(point(0), 0).state, "fresh");
  assert.equal(annotationLifecycle(point(0), 299).state, "current");
  assert.equal(annotationLifecycle(point(0), 300).state, "cooling");
  assert.equal(annotationLifecycle(point(0), 899).state, "cooling");
  assert.equal(annotationLifecycle(point(0), 900).state, "stale");
  assert.equal(annotationLifecycle(point(0), 1799).state, "stale");
  assert.equal(annotationLifecycle(point(0), 1800).state, "hidden");
});

test("future recurrence does not refresh the popup until playback reaches it", () => {
  const a = { ...point(0), observations: [observation(0), observation(1900)] };
  assert.equal(annotationLifecycle(a, 1801).state, "hidden");
  assert.equal(annotationLifecycle(a, 1900).state, "fresh");
  assert.equal(annotationLifecycle(a, 2800).state, "stale");
});

test("a documented ongoing condition stays visible and ages from its end", () => {
  const a = { ...point(0), observations: [observation(0, 4000)] };
  assert.equal(annotationLifecycle(a, 2000).state, "current");
  assert.equal(annotationLifecycle(a, 2000).ongoing, true);
  assert.equal(annotationLifecycle(a, 4899).state, "cooling");
  assert.equal(annotationLifecycle(a, 4900).state, "stale");
  assert.equal(annotationLifecycle(a, 5800).state, "hidden");
});

test("separate intervals do not imply continuity through the gap", () => {
  const a = { ...point(0), observations: [observation(0, 5), observation(4000, 5000)] };
  assert.equal(annotationLifecycle(a, 2000).state, "hidden");
  assert.equal(annotationLifecycle(a, 4500).ongoing, true);
});

test("scrubbing backward restores the annotation state without a wall clock timer", () => {
  assert.equal(annotationLifecycle(point(100), 2000).state, "hidden");
  assert.equal(annotationLifecycle(point(100), 101).state, "fresh");
  assert.equal(annotationLifecycle(point(100), 99).state, "hidden");
});

test("untimed context has no invented age or ongoing state", () => {
  assert.equal(annotationLifecycle({ time: null }, 100000).state, "context");
  assert.equal(annotationLifecycle({ time: null }, 100000).ongoing, false);
});
