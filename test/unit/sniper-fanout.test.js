// v13.13 sniper fanout — N random eligible wallets snipe each fresh launch with random
// stagger. Per-source config: clanker/doppler/virtuals/uniswap each have independent N + range.
//
// We set the env BEFORE importing config / sniper so the values are loaded fresh. Each test
// file runs in its own Node process under `node --test`, so this env setup does not leak
// into other test files.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

process.env.SNIPER_FANOUT_CLANKER = "3";
process.env.SNIPER_FANOUT_CLANKER_STAGGER_MS = "10-50";
process.env.SNIPER_FANOUT_DOPPLER = "2";
process.env.SNIPER_FANOUT_DOPPLER_STAGGER_MS = "0-0";
process.env.SNIPER_FANOUT_VIRTUALS = "1";
process.env.SNIPER_FANOUT_VIRTUALS_STAGGER_MS = "0-0";
process.env.SNIPER_FANOUT_UNISWAP = "1";
process.env.SNIPER_FANOUT_UNISWAP_STAGGER_MS = "0-0";

const {
  _resetDeps, _setDeps, _state, _stopAll, initSniper, tryFireSniperBuy,
} = await import("../../src/orchestrator/sniper.js");
const { _resetAll: resetDailyCounter } = await import("../../src/strategy/dailyCounter.js");

const baseProfile = (overrides = {}) => ({
  activeHoursUtc: [0, 24],
  tradesPerDay: [10, 10], // generous cap so fanout=3 fits
  amountRangeNativeEth: [0.001, 0.002],
  gasMultiplierRange: [1.0, 1.2],
  slippageBps: [50, 150],
  dexWeights: { uniswap: 100 },
  minNativeBalanceWei: "5000000000000000",
  sniper: { enabled: true, cooldownMin: 5, sellDelayMin: [10, 20] },
  ...overrides,
});

const makeWallet = (id) => ({
  id,
  account: { address: "0x" + id.replace(/\W/g, "").padEnd(40, "0").slice(0, 40) },
  profile: baseProfile(),
});

const mockExecutor = () => {
  const calls = [];
  return {
    fn: async ({ wallet, plan }) => {
      calls.push({ walletId: wallet.id, side: plan.side, at: Date.now() });
      return { status: "submitted" };
    },
    calls,
  };
};

const CLANKER_TOKEN = {
  address: "0x" + "a".repeat(40), symbol: "CLNK", decimals: 18,
  tradeableOn: ["uniswap"], source: "clanker-v4",
};
const DOPPLER_TOKEN = {
  address: "0x" + "b".repeat(40), symbol: "DOPP", decimals: 18,
  tradeableOn: ["uniswap"], source: "doppler-bankr",
};
const UNI_TOKEN = {
  address: "0x" + "c".repeat(40), symbol: "GEN", decimals: 18,
  tradeableOn: ["uniswap"], source: "uniswap-v3",
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("sniper fanout (v13.13)", () => {
  beforeEach(() => { _stopAll(); _resetDeps(); resetDailyCounter(); });
  afterEach(() => { _stopAll(); _resetDeps(); resetDailyCounter(); });

  test("clanker source picks N=3 distinct wallets and schedules staggered fires", async () => {
    initSniper([makeWallet("w1"), makeWallet("w2"), makeWallet("w3"), makeWallet("w4")]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });

    const result = await tryFireSniperBuy({ token: CLANKER_TOKEN });

    assert.equal(result.fanout, 3, "N=3 wallets scheduled");
    assert.equal(result.scheduled.length, 3);
    const ids = new Set(result.scheduled.map((s) => s.walletId));
    assert.equal(ids.size, 3, "wallets must be distinct");
    // Stagger range 10-50ms → all delays in that band.
    for (const s of result.scheduled) {
      assert.ok(s.delayMs >= 10 && s.delayMs <= 50, `delay ${s.delayMs} in [10,50]`);
    }
    // Wait for the longest possible stagger + executor overhead so all 3 fires execute.
    await wait(150);
    assert.equal(exec.calls.length, 3, "all 3 fires executed");
    const calledIds = new Set(exec.calls.map((c) => c.walletId));
    assert.deepEqual(calledIds, ids, "executor called for exactly the scheduled wallets");
  });

  test("doppler source picks N=2 without stagger (fires immediately in background)", async () => {
    initSniper([makeWallet("w1"), makeWallet("w2"), makeWallet("w3")]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });

    const result = await tryFireSniperBuy({ token: DOPPLER_TOKEN });

    assert.equal(result.fanout, 2);
    assert.deepEqual(result.scheduled.map((s) => s.delayMs), [0, 0]);
    // 0 delay → setTimeout-free path, but fires still async (background via fireOneSniperBuy).
    await wait(20);
    assert.equal(exec.calls.length, 2);
  });

  test("virtuals + uniswap sources default to N=1 (backwards-compat synchronous path)", async () => {
    initSniper([makeWallet("w1"), makeWallet("w2")]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });

    const virtuals = { ...UNI_TOKEN, source: "virtuals-Launched" };
    const r1 = await tryFireSniperBuy({ token: virtuals });
    assert.equal(r1.fired, true, "single-wallet path returns { fired }");
    assert.equal(r1.walletId, exec.calls[0].walletId);

    const r2 = await tryFireSniperBuy({ token: UNI_TOKEN });
    assert.equal(r2.fired, true);
    // Both fired against distinct wallets (cooldown blocks reuse).
    assert.notEqual(r1.walletId, r2.walletId);
  });

  test("fewer eligible wallets than N → fires what's available, no error", async () => {
    // Only 2 wallets exist but clanker wants N=3 — should fire 2 gracefully.
    initSniper([makeWallet("w1"), makeWallet("w2")]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });

    const result = await tryFireSniperBuy({ token: CLANKER_TOKEN });

    assert.equal(result.fanout, 2, "scheduled the 2 that were eligible");
    await wait(150);
    assert.equal(exec.calls.length, 2);
  });

  test("slots + cooldown reserved at PICK time, not at fire time (race protection)", async () => {
    // Two concurrent Clanker discoveries with 4 wallets total. fanout=3 each → 6 total slots
    // requested. But only 4 wallets exist, so the second call must see the first 3 already
    // reserved (in cooldown) and fall back to the remaining 1 wallet.
    initSniper([makeWallet("w1"), makeWallet("w2"), makeWallet("w3"), makeWallet("w4")]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });

    const TOKEN_A = { ...CLANKER_TOKEN, address: "0x" + "a".repeat(40) };
    const TOKEN_B = { ...CLANKER_TOKEN, address: "0x" + "b".repeat(40) };

    // Fire both BACK-TO-BACK in the same microtask — the second must see slots from the first.
    const [r1, r2] = await Promise.all([
      tryFireSniperBuy({ token: TOKEN_A }),
      tryFireSniperBuy({ token: TOKEN_B }),
    ]);

    const totalScheduled = r1.fanout + r2.fanout;
    assert.equal(totalScheduled, 4, "all 4 wallets used across the two discoveries");
    const allIds = new Set([
      ...r1.scheduled.map((s) => s.walletId),
      ...r2.scheduled.map((s) => s.walletId),
    ]);
    assert.equal(allIds.size, 4, "no wallet picked twice across concurrent discoveries");
  });

  test("if fanout > eligibleAfterReserve, second discovery gets skipped cleanly", async () => {
    // 3 wallets, clanker wants 3 → first call consumes all. Second call sees nothing eligible.
    initSniper([makeWallet("w1"), makeWallet("w2"), makeWallet("w3")]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });

    const r1 = await tryFireSniperBuy({ token: CLANKER_TOKEN });
    const r2 = await tryFireSniperBuy({
      token: { ...CLANKER_TOKEN, address: "0x" + "f".repeat(40) },
    });

    assert.equal(r1.fanout, 3);
    assert.equal(r2.skipped, "no-eligible-wallet", "all wallets in cooldown after first fanout");
  });

  test("fanout fires register pending sells per wallet (each fire schedules its own sell)", async () => {
    initSniper([makeWallet("w1"), makeWallet("w2"), makeWallet("w3"), makeWallet("w4")]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });

    await tryFireSniperBuy({ token: CLANKER_TOKEN });
    await wait(150);

    assert.equal(_state().pendingSells, 3, "3 pending sells (one per fired wallet)");
  });
});
