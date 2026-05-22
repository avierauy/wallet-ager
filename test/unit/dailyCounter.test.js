// dailyCounter — verifies the per-wallet, per-day round-trip counter that gates buys across
// both sniper and aging mode. Allowance is sampled once per UTC day and stable; sells never
// consume slots.
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  _resetAll,
  _state,
  canTrade,
  getDailyState,
  recordTrade,
} from "../../src/strategy/dailyCounter.js";

const makeWallet = (id, tradesPerDay = [3, 3]) => ({
  id,
  profile: { tradesPerDay },
});

describe("dailyCounter", () => {
  beforeEach(() => _resetAll());

  test("canTrade returns true when state hasn't been initialized yet", () => {
    const w = makeWallet("w1", [4, 4]); // deterministic allowance = 4
    assert.equal(canTrade({ wallet: w, rng: () => 0 }), true);
    const s = getDailyState({ wallet: w, rng: () => 0 });
    assert.equal(s.allowance, 4);
    assert.equal(s.used, 0);
    assert.equal(s.remaining, 4);
  });

  test("recordTrade increments used; canTrade flips when allowance reached", () => {
    const w = makeWallet("w1", [2, 2]);
    const rng = () => 0;
    assert.equal(canTrade({ wallet: w, rng }), true);
    recordTrade({ wallet: w, rng });
    assert.equal(canTrade({ wallet: w, rng }), true); // 1/2 used
    recordTrade({ wallet: w, rng });
    assert.equal(canTrade({ wallet: w, rng }), false); // 2/2 used
    const s = getDailyState({ wallet: w, rng });
    assert.equal(s.used, 2);
    assert.equal(s.remaining, 0);
  });

  test("allowance is stable across calls within the same day", () => {
    // Use a varying rng so we'd see a re-sample if there were a bug. Allowance must stay.
    let n = 0;
    const rng = () => { n += 0.13; return n % 1; };
    const w = makeWallet("w1", [3, 9]);
    const first = getDailyState({ wallet: w, rng }).allowance;
    for (let i = 0; i < 50; i++) {
      assert.equal(getDailyState({ wallet: w, rng }).allowance, first);
    }
  });

  test("tradesPerDay=[0,0] never permits a buy", () => {
    const w = makeWallet("w1", [0, 0]);
    assert.equal(canTrade({ wallet: w, rng: () => 0 }), false);
  });

  test("each wallet has independent state", () => {
    const a = makeWallet("a", [1, 1]);
    const b = makeWallet("b", [3, 3]);
    const rng = () => 0;
    recordTrade({ wallet: a, rng });
    assert.equal(canTrade({ wallet: a, rng }), false);
    assert.equal(canTrade({ wallet: b, rng }), true);
    assert.equal(getDailyState({ wallet: b, rng }).used, 0);
  });

  test("missing wallet id is treated as ineligible (defensive)", () => {
    assert.equal(canTrade({ wallet: null }), false);
    assert.equal(canTrade({ wallet: { profile: {} } }), false);
  });

  test("_state exposes current map for diagnostics", () => {
    const w = makeWallet("w1", [4, 4]);
    canTrade({ wallet: w, rng: () => 0 });
    recordTrade({ wallet: w, rng: () => 0 });
    const dump = _state();
    assert.ok(dump.w1);
    assert.equal(dump.w1.used, 1);
    assert.equal(dump.w1.allowance, 4);
  });
});
