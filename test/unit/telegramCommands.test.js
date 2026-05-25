import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  handleStatus,
  handleWallets,
  handleRecent,
  handlePause,
  handleResume,
  handleHelp,
  handleUnknown,
} from "../../src/notify/telegramCommands.js";
import { db, insertTrade, updateTrade, upsertDailyAllowance } from "../../src/core/db.js";
import { _testDispatch } from "../../src/notify/telegramBot.js";
import { _reset as resetRuntime, isPaused, setPaused } from "../../src/util/runtimeState.js";

const reset = () => {
  db.exec("DELETE FROM trades; DELETE FROM daily_allowances; DELETE FROM approvals");
  resetRuntime();
};

describe("telegramCommands — pure handlers", () => {
  beforeEach(reset);

  test("handleStatus shows uptime, pause flag, and today's totals", () => {
    const out = handleStatus({
      startedAt: Date.now() - 65 * 60 * 1000,
      paused: false,
      version: "13.7.0",
      walletCount: 3,
      enabledSniperCount: 2,
      sniperState: { pendingSells: 1, cooldowns: 0 },
      dailyTotals: { buys_submitted: 5, buys_failed: 1, sells_submitted: 4, sells_failed: 2 },
    });
    assert.match(out, /1h 5m/);
    assert.match(out, /paused: ✅ no/);
    assert.match(out, /wallets: 3/);
    assert.match(out, /pending sells: 1/);
    assert.match(out, /buys: 5 ✓ 1 ✗/);
    assert.match(out, /sells: 4 ✓ 2 ✗/);
  });

  test("handleStatus shows paused state when set", () => {
    const out = handleStatus({
      startedAt: Date.now(), paused: true, walletCount: 1, enabledSniperCount: 1,
    });
    assert.match(out, /🛑 YES/);
  });

  test("handleWallets shows per-wallet cap and today counts", () => {
    const out = handleWallets({
      wallets: [
        {
          id: "w-abc",
          address: "0x" + "a".repeat(40),
          dailyState: { used: 2, allowance: 5, remaining: 3 },
          todayCounts: { buy_submitted: 2, sell_submitted: 1 },
        },
      ],
    });
    assert.match(out, /w\\-abc/);
    assert.match(out, /cap: 2\/5 \\\(3 left\\\)/);
    assert.match(out, /today: 2 buy \\\| 1 sell/);
  });

  test("handleRecent renders trades", () => {
    const out = handleRecent({
      trades: [
        { side: "buy", dex: "uniswap", status: "submitted",
          token_out: "0x" + "b".repeat(40), tx_hash: "0x" + "c".repeat(64),
          created_at: Date.now() },
      ],
      explorer: "https://basescan.org",
    });
    assert.match(out, /✓/);
    assert.match(out, /buy uniswap/);
  });

  test("handleRecent shows empty state when no trades", () => {
    assert.match(handleRecent({ trades: [] }), /no recent trades/);
  });

  test("handlePause + handleResume return labeled messages", () => {
    assert.match(handlePause(), /paused/);
    assert.match(handleResume(), /resumed/);
  });

  test("handleHelp lists all commands", () => {
    const out = handleHelp();
    for (const cmd of ["/status", "/wallets", "/recent", "/pause", "/resume"]) {
      assert.ok(out.includes(cmd), `expected ${cmd} in help`);
    }
  });

  test("handleUnknown echoes the command and points to /help", () => {
    const out = handleUnknown("/foo");
    assert.match(out, /\/foo/);
    assert.match(out, /\/help/);
  });
});

describe("telegramBot dispatch — full pipeline", () => {
  beforeEach(reset);

  test("/pause toggles runtime paused flag, /resume clears it", async () => {
    await _testDispatch({ text: "/pause", wallets: [] });
    assert.equal(isPaused(), true);
    await _testDispatch({ text: "/resume", wallets: [] });
    assert.equal(isPaused(), false);
  });

  test("/status renders without throwing on empty state", async () => {
    const out = await _testDispatch({ text: "/status", wallets: [] });
    assert.match(out, /wallet/);
    assert.match(out, /uptime/);
  });

  test("/wallets aggregates today's counts from DB", async () => {
    const TOK = "0x" + "1".repeat(40);
    const id = insertTrade({
      wallet_id: "w1", dex: "uniswap", side: "buy",
      token_in: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", token_out: TOK,
      amount_in: "1000", amount_out_min: "0", status: "pending", created_at: Date.now(),
    });
    updateTrade(id, { status: "submitted" });
    upsertDailyAllowance({
      wallet_id: "w1", date: new Date().toISOString().slice(0, 10), allowance: 5,
    });
    const wallets = [{
      id: "w1",
      account: { address: "0x" + "a".repeat(40) },
      profile: { tradesPerDay: [5, 5] },
    }];
    const out = await _testDispatch({ text: "/wallets", wallets });
    assert.match(out, /w1/);
    assert.match(out, /cap: 1\/5/);
    assert.match(out, /1 buy/);
  });

  test("/recent returns the most recent trade", async () => {
    const TOK = "0x" + "2".repeat(40);
    const id = insertTrade({
      wallet_id: "w1", dex: "uniswap", side: "buy",
      token_in: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", token_out: TOK,
      amount_in: "1000", amount_out_min: "0", status: "pending", created_at: Date.now(),
    });
    updateTrade(id, { status: "submitted", tx_hash: "0x" + "d".repeat(64) });
    const out = await _testDispatch({ text: "/recent", wallets: [] });
    assert.match(out, /buy uniswap/);
  });

  test("unknown command returns the unknown handler text", async () => {
    const out = await _testDispatch({ text: "/nope", wallets: [] });
    assert.match(out, /unknown command/);
  });

  test("/help is reachable", async () => {
    const out = await _testDispatch({ text: "/help", wallets: [] });
    assert.match(out, /\/status/);
  });
});
