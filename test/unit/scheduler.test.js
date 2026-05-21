import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { initialDelayMs, isWithinActiveHours, nextDelayMs } from "../../src/strategy/scheduler.js";

const mulberry32 = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("isWithinActiveHours", () => {
  test("regular window (10-18)", () => {
    assert.ok(isWithinActiveHours(12, [10, 18]));
    assert.ok(isWithinActiveHours(10, [10, 18]));
    assert.ok(!isWithinActiveHours(9, [10, 18]));
    assert.ok(!isWithinActiveHours(18, [10, 18]));
    assert.ok(!isWithinActiveHours(20, [10, 18]));
  });

  test("overnight wrap (22-3)", () => {
    assert.ok(isWithinActiveHours(22, [22, 3]));
    assert.ok(isWithinActiveHours(23, [22, 3]));
    assert.ok(isWithinActiveHours(0, [22, 3]));
    assert.ok(isWithinActiveHours(2, [22, 3]));
    assert.ok(!isWithinActiveHours(3, [22, 3]));
    assert.ok(!isWithinActiveHours(12, [22, 3]));
  });
});

describe("nextDelayMs", () => {
  test("produces delays roughly matching daily trade count over the active window", () => {
    const profile = { tradesPerDay: [4, 4], activeHoursUtc: [0, 24] };
    const rng = mulberry32(1);
    const samples = Array.from({ length: 1000 }, () => nextDelayMs({ profile, rng }));
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    const expectedMean = (24 * 60 * 60 * 1000) / 4;
    assert.ok(Math.abs(mean - expectedMean) / expectedMean < 0.1, `mean ${mean} far from expected ${expectedMean}`);
  });

  test("respects overnight window length (22-3 = 5 hours)", () => {
    const profile = { tradesPerDay: [4, 4], activeHoursUtc: [22, 3] };
    const rng = mulberry32(2);
    const samples = Array.from({ length: 1000 }, () => nextDelayMs({ profile, rng }));
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    const expectedMean = (5 * 60 * 60 * 1000) / 4;
    assert.ok(Math.abs(mean - expectedMean) / expectedMean < 0.1);
  });
});

describe("initialDelayMs", () => {
  test("returns a value in [0, window/4]", () => {
    const profile = { activeHoursUtc: [0, 24] };
    const rng = mulberry32(3);
    const max = (24 * 60 * 60 * 1000) / 4;
    for (let i = 0; i < 100; i++) {
      const d = initialDelayMs({ profile, rng });
      assert.ok(d >= 0 && d <= max);
    }
  });
});
