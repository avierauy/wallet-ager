// v13.15 sniper fanout (universal config) — N random eligible wallets snipe each launch with
// random stagger, regardless of discovery source. Per-wallet cooldown prevents cross-source
// overlap, so a single global knob suffices.
//
// We set the env BEFORE importing config / sniper so the values are loaded fresh. Each test
// file runs in its own Node process under `node --test`, so this env setup does not leak
// into other test files.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

process.env.SNIPER_FANOUT = "3";
process.env.SNIPER_FANOUT_STAGGER_MS = "10-50";

const {
  _resetDeps, _setDeps, _state, _stopAll, initSniper, tryFireSniperBuy,
} = await import("../../src/orchestrator/sniper.js");
const { _resetAll: resetDailyCounter } = await import("../../src/strategy/dailyCounter.js");

const baseProfile = (overrides = {}) => ({
  activeHoursUtc: [0, 24],
  tradesPerDay: [10, 10],
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

describe("sniper fanout (v13.15 — universal config)", () => {
  // Default: funded wallets (1 ETH) so the v13.23 sniper balance gate passes for every fanout fire.
  beforeEach(() => { _stopAll(); _resetDeps(); resetDailyCounter(); _setDeps({ publicClient: { getBalance: async () => 10n ** 18n } }); });
  afterEach(() => { _stopAll(); _resetDeps(); resetDailyCounter(); });

  test("picks N=3 distinct wallets for a clanker discovery and schedules staggered fires", async () => {
    initSniper([makeWallet("w1"), makeWallet("w2"), makeWallet("w3"), makeWallet("w4")]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });

    const result = await tryFireSniperBuy({ token: CLANKER_TOKEN });

    assert.equal(result.fanout, 3, "N=3 wallets scheduled");
    assert.equal(result.scheduled.length, 3);
    const ids = new Set(result.scheduled.map((s) => s.walletId));
    assert.equal(ids.size, 3, "wallets must be distinct");
    for (const s of result.scheduled) {
      assert.ok(s.delayMs >= 10 && s.delayMs <= 50, `delay ${s.delayMs} in [10,50]`);
    }
    await wait(150);
    assert.equal(exec.calls.length, 3, "all 3 fires executed");
    const calledIds = new Set(exec.calls.map((c) => c.walletId));
    assert.deepEqual(calledIds, ids, "executor called for exactly the scheduled wallets");
  });

  test("same N applies regardless of source (clanker, doppler, uniswap, virtuals)", async () => {
    initSniper([makeWallet("w1"), makeWallet("w2"), makeWallet("w3"), makeWallet("w4")]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });

    // Doppler discovery: also picks 3 (same universal config). Cooldown ensures these are
    // DIFFERENT wallets from a hypothetical concurrent Clanker pick (covered by next test).
    const r1 = await tryFireSniperBuy({ token: DOPPLER_TOKEN });
    assert.equal(r1.fanout, 3, "Doppler also picks N=3 (universal config)");

    _stopAll(); resetDailyCounter();
    initSniper([makeWallet("w1"), makeWallet("w2"), makeWallet("w3"), makeWallet("w4")]);
    _setDeps({ executeAction: exec.fn });
    const r2 = await tryFireSniperBuy({ token: UNI_TOKEN });
    assert.equal(r2.fanout, 3, "generic uniswap source also picks N=3");
  });

  test("cooldown prevents cross-source overlap: clanker picks 3, doppler picks 1 from remaining", async () => {
    // 4 wallets, fanout=3. First Clanker discovery reserves 3 wallets immediately via
    // sniperState.set in pick time. Second discovery (different source, fired right after)
    // must see those 3 as in-cooldown and pick only from the 1 remaining wallet.
    initSniper([makeWallet("w1"), makeWallet("w2"), makeWallet("w3"), makeWallet("w4")]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });

    const [r1, r2] = await Promise.all([
      tryFireSniperBuy({ token: CLANKER_TOKEN }),
      tryFireSniperBuy({ token: DOPPLER_TOKEN }),
    ]);

    const total = r1.fanout + (r2.fanout ?? 0);
    assert.equal(total, 4, "all 4 wallets fired exactly once across both discoveries");
    const allIds = new Set([
      ...r1.scheduled.map((s) => s.walletId),
      ...(r2.scheduled?.map((s) => s.walletId) ?? []),
    ]);
    assert.equal(allIds.size, 4, "no wallet picked twice across the two discoveries");
  });

  test("fewer eligible wallets than N → fires what's available, no error", async () => {
    initSniper([makeWallet("w1"), makeWallet("w2")]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });

    const result = await tryFireSniperBuy({ token: CLANKER_TOKEN });

    assert.equal(result.fanout, 2, "scheduled the 2 that were eligible");
    await wait(150);
    assert.equal(exec.calls.length, 2);
  });

  test("if all wallets in cooldown, second discovery gets skipped cleanly", async () => {
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

  test("fanout fires register pending sells per wallet (one sell per fired wallet)", async () => {
    initSniper([makeWallet("w1"), makeWallet("w2"), makeWallet("w3"), makeWallet("w4")]);
    const exec = mockExecutor();
    _setDeps({ executeAction: exec.fn });

    await tryFireSniperBuy({ token: CLANKER_TOKEN });
    await wait(150);

    assert.equal(_state().pendingSells, 3, "3 pending sells (one per fired wallet)");
  });
});
