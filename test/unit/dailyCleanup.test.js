// daily-cleanup module tests — verify the time scheduling helper and the tokens-bought-
// today query. The full runCleanupOnce sweep is exercised in integration: stubbing the
// executor + on-chain reads inline here keeps the test focused on the bookkeeping.
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, insertTrade, updateTrade } from "../../src/core/db.js";
import { _internals } from "../../src/orchestrator/dailyCleanup.js";

const { msUntilNextRun, tokensBoughtToday, TARGET_UTC_HOUR, TARGET_UTC_MIN } = _internals;

describe("dailyCleanup", () => {
  beforeEach(() => db.exec("DELETE FROM trades"));

  describe("tokensBoughtToday", () => {
    const utcDate = () => new Date().toISOString().slice(0, 10);

    const insertBuy = ({ walletId, tokenOut, status = "submitted", at = Date.now() }) => {
      const id = insertTrade({
        wallet_id: walletId,
        dex: "uniswap",
        side: "buy",
        token_in: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        token_out: tokenOut,
        amount_in: "1",
        amount_out_min: "0",
        status: "pending",
        created_at: at,
      });
      updateTrade(id, { status });
      return id;
    };

    test("returns distinct submitted+dry-run buys for the given UTC date", () => {
      const TOK_A = "0x" + "a".repeat(40);
      const TOK_B = "0x" + "b".repeat(40);
      insertBuy({ walletId: "w1", tokenOut: TOK_A });
      insertBuy({ walletId: "w1", tokenOut: TOK_A }); // duplicate same token → 1 entry
      insertBuy({ walletId: "w1", tokenOut: TOK_B, status: "dry-run" });
      insertBuy({ walletId: "w1", tokenOut: "0x" + "c".repeat(40), status: "failed" }); // filtered out
      const out = tokensBoughtToday({ walletId: "w1", date: utcDate() });
      assert.equal(out.length, 2);
      assert.ok(out.includes(TOK_A.toLowerCase()));
      assert.ok(out.includes(TOK_B.toLowerCase()));
    });

    test("returns empty when no buys today", () => {
      assert.deepEqual(tokensBoughtToday({ walletId: "ghost", date: utcDate() }), []);
    });

    test("filters by wallet", () => {
      const T = "0x" + "1".repeat(40);
      insertBuy({ walletId: "w1", tokenOut: T });
      assert.equal(tokensBoughtToday({ walletId: "w2", date: utcDate() }).length, 0);
    });

    test("respects the date argument (older buys ignored)", () => {
      const T = "0x" + "1".repeat(40);
      // 2 days ago, well outside today
      insertBuy({ walletId: "w1", tokenOut: T, at: Date.now() - 2 * 24 * 60 * 60 * 1000 });
      assert.equal(tokensBoughtToday({ walletId: "w1", date: utcDate() }).length, 0);
    });
  });

  describe("msUntilNextRun", () => {
    test("returns time until today's target when called before it", () => {
      // Construct a "now" that's clearly before the target hour
      const now = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).getTime(); // 12:00 UTC
      const ms = msUntilNextRun(now);
      const hoursAhead = ms / 1000 / 60 / 60;
      // From 12:00 UTC to TARGET (default 23:30) = 11.5h
      const expected = (TARGET_UTC_HOUR - 12) + (TARGET_UTC_MIN / 60);
      assert.ok(Math.abs(hoursAhead - expected) < 0.01,
        `expected ~${expected}h, got ${hoursAhead}h`);
    });

    test("rolls over to next day when called after the target", () => {
      const now = new Date(Date.UTC(2026, 0, 1, 23, 45, 0)).getTime(); // 23:45 UTC
      const ms = msUntilNextRun(now);
      const hoursAhead = ms / 1000 / 60 / 60;
      // 23:45 → tomorrow 23:30 = 23h45min
      assert.ok(hoursAhead > 23 && hoursAhead < 24,
        `expected ~23.75h, got ${hoursAhead}h`);
    });

    test("always returns a positive duration", () => {
      // Use the actual current time
      const ms = msUntilNextRun();
      assert.ok(ms > 0);
      assert.ok(ms <= 24 * 60 * 60 * 1000);
    });
  });
});
