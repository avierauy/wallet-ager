import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fmt } from "../../src/util/format.js";

describe("fmt", () => {
  test("returns '?' for null/undefined", () => {
    assert.equal(fmt(null, 18), "?");
    assert.equal(fmt(undefined, 18), "?");
  });

  test("renders integer-valued amounts without a decimal point", () => {
    assert.equal(fmt(10n ** 18n, 18), "1");
    assert.equal(fmt(5n * 10n ** 18n, 18), "5");
    assert.equal(fmt(0n, 18), "0");
  });

  test("renders fractional amounts and trims trailing zeros", () => {
    assert.equal(fmt(10n ** 15n, 18), "0.001"); // 0.001 ETH
    assert.equal(fmt(500_000_000_000_000n, 18), "0.0005");
    assert.equal(fmt(1_234_500_000_000_000_000n, 18), "1.2345");
  });

  test("caps fractional digits at maxFrac (default 6) and trims after", () => {
    assert.equal(fmt(1_234_567_890_123_456_789n, 18), "1.234567");
    assert.equal(fmt(1_234_567_890_123_456_789n, 18, 4), "1.2345");
  });

  test("respects non-18 decimals (e.g. USDC, 6)", () => {
    assert.equal(fmt(1_000_000n, 6), "1");
    assert.equal(fmt(1_234_560n, 6), "1.23456");
    assert.equal(fmt(123n, 6), "0.000123");
  });

  test("accepts numeric strings as input", () => {
    assert.equal(fmt("1000000000000000000", 18), "1");
  });
});
