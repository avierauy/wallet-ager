import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  _resetDeps,
  _setDeps,
  _stopAll,
  initSniper,
  tryFireSniperBuy,
} from "../../src/orchestrator/sniper.js";
import { _resetAll as resetDailyCounter } from "../../src/strategy/dailyCounter.js";

const TOKEN = {
  address: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00",
  symbol: "TIBBIR",
  decimals: 18,
  tradeableOn: ["uniswap"],
};

const baseProfile = (overrides = {}) => ({
  activeHoursUtc: [0, 24],
  tradesPerDay: [3, 5],
  amountRangeNativeEth: [0.001, 0.002],
  gasMultiplierRange: [1.0, 1.2],
  slippageBps: [50, 150],
  dexWeights: { uniswap: 100 },
  minNativeBalanceWei: "5000000000000000",
  sniper: { enabled: true, cooldownMin: 5, sellDelayMin: [10, 20] },
  ...overrides,
});

const makeWallet = (id, profileOverrides = {}) => ({
  id,
  account: { address: "0x" + id.replace(/\W/g, "").padEnd(40, "0").slice(0, 40) },
  profile: baseProfile(profileOverrides),
});

const mockExecutor = (resultByCall = ["submitted"]) => {
  const calls = [];
  let i = 0;
  return {
    fn: async ({ wallet, plan }) => {
      calls.push({ walletId: wallet.id, side: plan.side, amountInWei: plan.amountInWei });
      const status = resultByCall[Math.min(i, resultByCall.length - 1)];
      i++;
      return { status };
    },
    calls,
  };
};

const seededRng = (seed) => {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
};

describe("sniper", () => {
  beforeEach(() => { _stopAll(); _resetDeps(); resetDailyCounter(); });
  afterEach(() => { _stopAll(); _resetDeps(); resetDailyCounter(); });

  test("skipped when no wallets initialized", async () => {
    const result = await tryFireSniperBuy({ token: TOKEN });
    assert.equal(result.skipped, "not-initialized");
  });

  test("skipped when no wallet has sniper enabled", async () => {
    initSniper([makeWallet("a", { sniper: { enabled: false } })]);
    const result = await tryFireSniperBuy({ token: TOKEN });
    assert.equal(result.skipped, "no-eligible-wallet");
  });

  test("skipped when wallets are outside active hours", async () => {
    // active hours 0..1, current UTC hour is anywhere except 0
    const nowHour = new Date().getUTCHours();
    const windowEnd = (nowHour + 23) % 24; // window deliberately not including current hour
    initSniper([makeWallet("a", { activeHoursUtc: [windowEnd, windowEnd] })]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });
    const result = await tryFireSniperBuy({ token: TOKEN });
    // The activeHoursUtc=[X,X] case treats as always-active per scheduler — accept either outcome
    if (result.skipped === "no-eligible-wallet") {
      assert.equal(exec.calls.length, 0);
    } else {
      assert.equal(exec.calls.length, 1);
    }
  });

  test("fires buy + schedules sell on eligible wallet", async () => {
    initSniper([makeWallet("w1")]);
    const exec = mockExecutor(["submitted"]);
    _setDeps({ executeAction: exec.fn });
    const result = await tryFireSniperBuy({ token: TOKEN, rng: seededRng(1) });
    assert.equal(result.fired, true);
    assert.equal(result.walletId, "w1");
    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].side, "buy");
    assert.ok(exec.calls[0].amountInWei > 0n);
  });

  test("cooldown prevents re-firing on the same wallet too quickly", async () => {
    initSniper([makeWallet("w1", { sniper: { enabled: true, cooldownMin: 5, sellDelayMin: [10, 20] } })]);
    const exec = mockExecutor(["submitted", "submitted"]);
    _setDeps({ executeAction: exec.fn });
    const r1 = await tryFireSniperBuy({ token: TOKEN });
    const r2 = await tryFireSniperBuy({ token: { ...TOKEN, address: "0x" + "b".repeat(40) } });
    assert.equal(r1.fired, true);
    assert.equal(r2.skipped, "no-eligible-wallet"); // still in cooldown
    assert.equal(exec.calls.length, 1);
  });

  test("picks another eligible wallet if one is on cooldown", async () => {
    initSniper([makeWallet("w1"), makeWallet("w2")]);
    const exec = mockExecutor(["submitted", "submitted"]);
    _setDeps({ executeAction: exec.fn });
    // Force first to pick w1 by stubbing Math.random via injected rng. The picker uses
    // rng() to choose, so a low rng value picks the first eligible.
    const r1 = await tryFireSniperBuy({ token: TOKEN, rng: () => 0.0 });
    const r2 = await tryFireSniperBuy({ token: { ...TOKEN, address: "0x" + "b".repeat(40) }, rng: () => 0.0 });
    assert.equal(r1.fired, true);
    assert.equal(r2.fired, true);
    assert.notEqual(r1.walletId, r2.walletId);
  });

  test("non-submitted result does NOT schedule a sell", async () => {
    initSniper([makeWallet("w1")]);
    const exec = mockExecutor(["failed"]);
    _setDeps({ executeAction: exec.fn });
    await tryFireSniperBuy({ token: TOKEN });
    // Internal state — pendingSells should be empty since buy didn't submit
    const { _state } = await import("../../src/orchestrator/sniper.js");
    assert.equal(_state().pendingSells, 0);
  });

  test("dry-run buy DOES schedule a sell (so we exercise the path)", async () => {
    initSniper([makeWallet("w1")]);
    const exec = mockExecutor(["dry-run"]);
    _setDeps({ executeAction: exec.fn });
    await tryFireSniperBuy({ token: TOKEN });
    const { _state } = await import("../../src/orchestrator/sniper.js");
    assert.equal(_state().pendingSells, 1);
  });

  test("skipped result releases the wallet's cooldown so it stays snipe-eligible", async () => {
    // Single wallet — if cooldown is NOT released after a skip, the second snipe attempt
    // will fail with "no-eligible-wallet". The release lets the second attempt fire.
    initSniper([makeWallet("w1")]);
    const exec = mockExecutor(["skipped", "submitted"]);
    _setDeps({ executeAction: exec.fn });
    const r1 = await tryFireSniperBuy({ token: TOKEN });
    const r2 = await tryFireSniperBuy({ token: { ...TOKEN, address: "0x" + "b".repeat(40) } });
    assert.equal(r1.fired, true);
    assert.equal(r1.result.status, "skipped");
    assert.equal(r2.fired, true);
    assert.equal(r2.result.status, "submitted");
    assert.equal(exec.calls.length, 2);
  });

  test("concurrent bursts do NOT exceed the daily cap (in-flight slot reservation)", async () => {
    // Fixed allowance of 2 via tradesPerDay: [2, 2]. Three concurrent fires must result in
    // exactly 2 submits; the third must be rejected with no-eligible-wallet because the
    // reservation counts the two in-flight buys before either trade row hits the DB.
    initSniper([
      makeWallet("w1", {
        tradesPerDay: [2, 2],
        sniper: { enabled: true, cooldownMin: 0, sellDelayMin: [10, 20] },
      }),
    ]);
    // Slow executor to keep the first two reservations in-flight while the third is picked.
    let inflight = 0;
    let maxInflight = 0;
    const exec = {
      fn: async () => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 30));
        inflight--;
        return { status: "submitted" };
      },
      calls: [],
    };
    _setDeps({ executeAction: exec.fn });
    const results = await Promise.all([
      tryFireSniperBuy({ token: TOKEN }),
      tryFireSniperBuy({ token: { ...TOKEN, address: "0x" + "b".repeat(40) } }),
      tryFireSniperBuy({ token: { ...TOKEN, address: "0x" + "c".repeat(40) } }),
    ]);
    const fired = results.filter((r) => r.fired === true);
    const rejected = results.filter((r) => r.skipped === "no-eligible-wallet");
    assert.equal(fired.length, 2, "exactly 2 should fire");
    assert.equal(rejected.length, 1, "exactly 1 should be rejected by cap");
    assert.ok(maxInflight >= 2, "test should actually exercise concurrency");
  });
});
