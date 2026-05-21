import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { planAction } from "../../src/strategy/planner.js";

const mulberry32 = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const TOKENS = [
  {
    address: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00",
    symbol: "TIBBIR",
    decimals: 18,
    tradeableOn: ["uniswap", "virtuals"],
  },
  {
    address: "0x479e864957dbb19f780c37ac7f7e3bfbba23c45a",
    symbol: "POLYHERMES",
    decimals: 18,
    tradeableOn: ["virtuals"],
  },
  {
    address: "0x7c5290cae29659fe87f57d41234a5b68de237ba3",
    symbol: "EKIDEN",
    decimals: 18,
    tradeableOn: ["bankr", "uniswap"],
  },
];

const PROFILE = {
  activeHoursUtc: [0, 24],
  tradesPerDay: [3, 5],
  amountRangeNativeEth: [0.0005, 0.003],
  gasMultiplierRange: [1.0, 1.4],
  slippageBps: [50, 150],
  dexWeights: { uniswap: 50, bankr: 30, virtuals: 20 },
  minNativeBalanceWei: "5000000000000000",
};

describe("planAction", () => {
  test("returns null when native balance is at or below min reserve", () => {
    const action = planAction({
      profile: PROFILE,
      tokens: TOKENS,
      balances: {},
      nativeBalance: 5_000_000_000_000_000n, // == min
      rng: mulberry32(1),
    });
    assert.equal(action, null);
  });

  test("picks a buy when wallet holds no token", () => {
    const action = planAction({
      profile: PROFILE,
      tokens: TOKENS,
      balances: {},
      nativeBalance: 10n ** 17n,
      rng: mulberry32(2),
    });
    assert.equal(action.side, "buy");
    assert.ok(action.amountInWei > 0n);
  });

  test("selected token is always tradeable on the selected DEX", () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 200; i++) {
      const action = planAction({
        profile: PROFILE,
        tokens: TOKENS,
        balances: {},
        nativeBalance: 10n ** 17n,
        rng,
      });
      assert.ok(action.token.tradeableOn.includes(action.dex), `token ${action.token.symbol} not tradeable on ${action.dex}`);
    }
  });

  test("amount stays within profile range when buying", () => {
    const rng = mulberry32(4);
    const lo = 500_000_000_000_000n; // 0.0005 ETH
    const hi = 3_000_000_000_000_000n; // 0.003 ETH
    for (let i = 0; i < 200; i++) {
      const action = planAction({
        profile: PROFILE,
        tokens: TOKENS,
        balances: {},
        nativeBalance: 10n ** 17n,
        rng,
      });
      if (action?.side !== "buy") continue;
      assert.ok(action.amountInWei >= lo && action.amountInWei <= hi, `out of range: ${action.amountInWei}`);
    }
  });

  test("sell amount equals full balance (no fractional sells)", () => {
    const rng = mulberry32(5);
    const balance = 1_000_000_000_000_000_000n; // 1 TIBBIR
    let sawSell = false;
    for (let i = 0; i < 500; i++) {
      const action = planAction({
        profile: PROFILE,
        tokens: TOKENS,
        balances: { "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00": balance },
        nativeBalance: 10n ** 17n,
        rng,
      });
      if (action?.side === "sell") {
        sawSell = true;
        assert.equal(action.amountInWei, balance, `expected full-balance sell, got ${action.amountInWei}`);
      }
    }
    assert.ok(sawSell, "expected at least one sell across 500 iterations");
  });

  test("slippage and gasMultiplier stay within profile ranges", () => {
    const rng = mulberry32(6);
    for (let i = 0; i < 100; i++) {
      const action = planAction({
        profile: PROFILE,
        tokens: TOKENS,
        balances: {},
        nativeBalance: 10n ** 17n,
        rng,
      });
      assert.ok(action.slippageBps >= 50 && action.slippageBps <= 150);
      assert.ok(action.gasMultiplier >= 1.0 && action.gasMultiplier <= 1.4);
    }
  });
});
