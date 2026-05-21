import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { valueOf } from "../../src/core/balanceTracker.js";

const A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";

const buildPrices = () => {
  const m = new Map();
  // 1 unit of token A (18 decimals) = 0.5 ETH
  m.set(A.toLowerCase(), { probeAmount: 10n ** 18n, ethValue: 5n * 10n ** 17n });
  // 1 unit of token B (6 decimals, USDC-like) = 0.0003 ETH
  m.set(B.toLowerCase(), { probeAmount: 10n ** 6n, ethValue: 3n * 10n ** 14n });
  return m;
};

describe("valueOf", () => {
  test("scales linearly: 2 units of A → 1 ETH", () => {
    const prices = buildPrices();
    assert.equal(valueOf(A, 2n * 10n ** 18n, prices), 10n ** 18n);
  });

  test("respects token decimals: 1000 USDC (6dp) → 0.3 ETH", () => {
    const prices = buildPrices();
    assert.equal(valueOf(B, 1000n * 10n ** 6n, prices), 3n * 10n ** 17n);
  });

  test("zero balance returns zero without lookup", () => {
    const prices = new Map(); // empty
    assert.equal(valueOf(A, 0n, prices), 0n);
  });

  test("missing price returns 0 (conservative)", () => {
    const prices = new Map();
    assert.equal(valueOf("0xnotInMap", 10n ** 18n, prices), 0n);
  });

  test("null price entry returns 0", () => {
    const prices = new Map([[A.toLowerCase(), null]]);
    assert.equal(valueOf(A, 10n ** 18n, prices), 0n);
  });

  test("address lookup is case-insensitive", () => {
    const prices = buildPrices();
    assert.equal(valueOf(A.toUpperCase(), 10n ** 18n, prices), 5n * 10n ** 17n);
  });
});
