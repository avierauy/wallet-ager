import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ethFloatToWei,
  sampleLognormal,
  samplePick,
  sampleUniform,
  sampleUniformInt,
  sampleWeighted,
} from "../../src/strategy/randomizer.js";

// Deterministic seeded RNG using mulberry32 — keeps tests reproducible.
const mulberry32 = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("sampleUniform", () => {
  test("stays within [lo, hi)", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = sampleUniform([5, 10], rng);
      assert.ok(v >= 5 && v < 10);
    }
  });
});

describe("sampleUniformInt", () => {
  test("returns integer in [lo, hi] inclusive", () => {
    const rng = mulberry32(42);
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(sampleUniformInt([3, 5], rng));
    assert.deepEqual([...seen].sort(), [3, 4, 5]);
  });
});

describe("sampleWeighted", () => {
  test("approximately respects weights over many samples", () => {
    const rng = mulberry32(123);
    const counts = { a: 0, b: 0, c: 0 };
    const N = 10_000;
    for (let i = 0; i < N; i++) counts[sampleWeighted({ a: 50, b: 30, c: 20 }, rng)]++;
    assert.ok(Math.abs(counts.a / N - 0.5) < 0.02);
    assert.ok(Math.abs(counts.b / N - 0.3) < 0.02);
    assert.ok(Math.abs(counts.c / N - 0.2) < 0.02);
  });

  test("throws on zero total weight", () => {
    assert.throws(() => sampleWeighted({ a: 0, b: 0 }, () => 0.5));
  });
});

describe("samplePick", () => {
  test("picks an element of the array", () => {
    const rng = mulberry32(7);
    const arr = ["x", "y", "z"];
    for (let i = 0; i < 100; i++) assert.ok(arr.includes(samplePick(arr, rng)));
  });

  test("throws on empty array", () => {
    assert.throws(() => samplePick([], () => 0.5));
  });
});

describe("sampleLognormal", () => {
  test("skews toward the low end of the range", () => {
    const rng = mulberry32(99);
    const mid = (0.001 + 0.01) / 2;
    let belowMid = 0;
    for (let i = 0; i < 5000; i++) if (sampleLognormal([0.001, 0.01], rng) < mid) belowMid++;
    assert.ok(belowMid / 5000 > 0.6, `expected >60% below mid, got ${belowMid / 5000}`);
  });
});

describe("ethFloatToWei", () => {
  test("converts whole ETH exactly", () => {
    assert.equal(ethFloatToWei(1), 1_000_000_000_000_000_000n);
  });

  test("converts fractional ETH exactly", () => {
    assert.equal(ethFloatToWei(0.001), 1_000_000_000_000_000n);
    assert.equal(ethFloatToWei(0.0005), 500_000_000_000_000n);
  });
});
