// dailyCounter — verifies the persistent per-wallet daily roundtrip counter.
// `allowance` is sampled once per UTC day and stored in daily_allowances.
// `used` is derived live from the trades table (count of submitted/dry-run buys today).
// This means a daemon restart preserves both — the cap is honored even if the process
// crashes and comes back mid-day.
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  _resetAll,
  canTrade,
  getDailyState,
  recordTrade,
} from "../../src/strategy/dailyCounter.js";
import { db, insertTrade, updateTrade } from "../../src/core/db.js";

const makeWallet = (id, tradesPerDay = [3, 3]) => ({
  id,
  profile: { tradesPerDay },
});

// Helper: insert one row representing a successful buy at "now" so countSubmittedBuysOnDate
// will see it. Replicates the executor's insertTrade + updateTrade(submitted) sequence.
const simulateBuy = ({ walletId, status = "submitted" }) => {
  const id = insertTrade({
    wallet_id: walletId,
    dex: "uniswap",
    side: "buy",
    token_in: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    token_out: "0x0000000000000000000000000000000000000001",
    amount_in: "1000",
    amount_out_min: "0",
    status: "pending",
    created_at: Date.now(),
  });
  updateTrade(id, { status });
  return id;
};

describe("dailyCounter (persistent)", () => {
  beforeEach(() => _resetAll());

  test("canTrade returns true when no buys yet today", () => {
    const w = makeWallet("w1", [4, 4]);
    assert.equal(canTrade({ wallet: w, rng: () => 0 }), true);
    const s = getDailyState({ wallet: w, rng: () => 0 });
    assert.equal(s.allowance, 4);
    assert.equal(s.used, 0);
    assert.equal(s.remaining, 4);
  });

  test("used count grows as submitted buys land in the trades table", () => {
    const w = makeWallet("w1", [2, 2]);
    const rng = () => 0;
    assert.equal(canTrade({ wallet: w, rng }), true);
    simulateBuy({ walletId: "w1" });
    assert.equal(getDailyState({ wallet: w, rng }).used, 1);
    assert.equal(canTrade({ wallet: w, rng }), true);
    simulateBuy({ walletId: "w1" });
    assert.equal(getDailyState({ wallet: w, rng }).used, 2);
    assert.equal(canTrade({ wallet: w, rng }), false);
  });

  test("dry-run buys also count toward the cap", () => {
    const w = makeWallet("w1", [1, 1]);
    const rng = () => 0;
    simulateBuy({ walletId: "w1", status: "dry-run" });
    assert.equal(canTrade({ wallet: w, rng }), false);
  });

  test("failed buys do NOT count toward the cap", () => {
    const w = makeWallet("w1", [1, 1]);
    simulateBuy({ walletId: "w1", status: "failed" });
    assert.equal(canTrade({ wallet: w, rng: () => 0 }), true);
  });

  test("sells do NOT consume slots even if they hit the trades table", () => {
    const w = makeWallet("w1", [1, 1]);
    // Insert a SELL — should NOT count
    const id = insertTrade({
      wallet_id: "w1", dex: "uniswap", side: "sell",
      token_in: "0x0000000000000000000000000000000000000001",
      token_out: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      amount_in: "1000", amount_out_min: "0",
      status: "pending", created_at: Date.now(),
    });
    updateTrade(id, { status: "submitted" });
    assert.equal(canTrade({ wallet: w, rng: () => 0 }), true);
  });

  test("allowance is persisted: a second canTrade call returns the same allowance", () => {
    let n = 0;
    const rng = () => { n += 0.13; return n % 1; };
    const w = makeWallet("w1", [3, 9]);
    const first = getDailyState({ wallet: w, rng }).allowance;
    for (let i = 0; i < 20; i++) {
      assert.equal(getDailyState({ wallet: w, rng }).allowance, first);
    }
  });

  test("simulates a daemon restart: allowance survives, used count recomputed", () => {
    const w = makeWallet("w1", [4, 4]);
    const rng = () => 0;
    // Day-1 activity
    simulateBuy({ walletId: "w1" });
    simulateBuy({ walletId: "w1" });
    const beforeRestart = getDailyState({ wallet: w, rng });
    assert.equal(beforeRestart.used, 2);
    assert.equal(beforeRestart.allowance, 4);

    // "Restart": drop any in-memory caches (we don't have any, but make the intent
    // explicit). The DB stays. A fresh canTrade should see the same allowance + used.
    // Just re-call — no module reload needed because state is in the DB.
    const afterRestart = getDailyState({ wallet: w, rng: () => 0.9 }); // different rng — must not re-sample
    assert.equal(afterRestart.allowance, 4, "allowance must be the stored value, not re-sampled");
    assert.equal(afterRestart.used, 2, "used must reflect the trades table");
    assert.equal(canTrade({ wallet: w, rng: () => 0.9 }), true);
  });

  test("missing wallet id is treated as ineligible (defensive)", () => {
    assert.equal(canTrade({ wallet: null }), false);
    assert.equal(canTrade({ wallet: { profile: {} } }), false);
  });

  test("tradesPerDay=[0,0] never permits a buy", () => {
    const w = makeWallet("w1", [0, 0]);
    assert.equal(canTrade({ wallet: w, rng: () => 0 }), false);
  });

  test("each wallet has independent state in the DB", () => {
    const a = makeWallet("a", [1, 1]);
    const b = makeWallet("b", [3, 3]);
    simulateBuy({ walletId: "a" });
    assert.equal(canTrade({ wallet: a, rng: () => 0 }), false);
    assert.equal(canTrade({ wallet: b, rng: () => 0 }), true);
    assert.equal(getDailyState({ wallet: b, rng: () => 0 }).used, 0);
  });

  test("recordTrade is idempotent and does not double-count", () => {
    // recordTrade is a no-op for counter purposes (used comes from DB). Call it many
    // times and ensure used stays at 0 unless a real trade row exists.
    const w = makeWallet("w1", [4, 4]);
    const rng = () => 0;
    for (let i = 0; i < 10; i++) recordTrade({ wallet: w, rng });
    assert.equal(getDailyState({ wallet: w, rng }).used, 0);
    simulateBuy({ walletId: "w1" });
    assert.equal(getDailyState({ wallet: w, rng }).used, 1);
  });
});
