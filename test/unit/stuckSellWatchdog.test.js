// stuck-sell watchdog — verify the DB query identifies buys with no matching sell, older
// than MIN_AGE_MS. Full sweep is exercised in integration; here we stub the bookkeeping.
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, insertTrade, updateTrade } from "../../src/core/db.js";
import { _internals } from "../../src/orchestrator/stuckSellWatchdog.js";

const { findStuckBuys, MIN_AGE_MS } = _internals;

describe("stuckSellWatchdog.findStuckBuys", () => {
  beforeEach(() => db.exec("DELETE FROM trades"));

  const utcDate = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

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

  const insertSell = ({ walletId, tokenIn, status = "submitted", at = Date.now() }) => {
    const id = insertTrade({
      wallet_id: walletId,
      dex: "uniswap",
      side: "sell",
      token_in: tokenIn,
      token_out: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      amount_in: "1",
      amount_out_min: "0",
      status: "pending",
      created_at: at,
    });
    updateTrade(id, { status });
    return id;
  };

  test("returns buys older than MIN_AGE_MS with no matching sell", () => {
    const TOK = "0x" + "a".repeat(40);
    const now = Date.now();
    const oldAt = now - MIN_AGE_MS - 60_000;
    insertBuy({ walletId: "w1", tokenOut: TOK, at: oldAt });
    const out = findStuckBuys({ walletId: "w1", date: utcDate(now), nowMs: now });
    assert.deepEqual(out, [TOK.toLowerCase()]);
  });

  test("skips buys younger than MIN_AGE_MS (still in sniper retry window)", () => {
    const TOK = "0x" + "a".repeat(40);
    const now = Date.now();
    insertBuy({ walletId: "w1", tokenOut: TOK, at: now - 60_000 });
    const out = findStuckBuys({ walletId: "w1", date: utcDate(now), nowMs: now });
    assert.deepEqual(out, []);
  });

  test("skips buys that already have a matching submitted sell", () => {
    const TOK = "0x" + "b".repeat(40);
    const now = Date.now();
    const oldAt = now - MIN_AGE_MS - 60_000;
    insertBuy({ walletId: "w1", tokenOut: TOK, at: oldAt });
    insertSell({ walletId: "w1", tokenIn: TOK, at: oldAt + 1000 });
    const out = findStuckBuys({ walletId: "w1", date: utcDate(now), nowMs: now });
    assert.deepEqual(out, []);
  });

  test("includes dry-run buys (treated same as submitted for ageing)", () => {
    const TOK = "0x" + "c".repeat(40);
    const now = Date.now();
    const oldAt = now - MIN_AGE_MS - 60_000;
    insertBuy({ walletId: "w1", tokenOut: TOK, status: "dry-run", at: oldAt });
    const out = findStuckBuys({ walletId: "w1", date: utcDate(now), nowMs: now });
    assert.deepEqual(out, [TOK.toLowerCase()]);
  });

  test("ignores failed buys (no real position on-chain)", () => {
    const TOK = "0x" + "d".repeat(40);
    const now = Date.now();
    const oldAt = now - MIN_AGE_MS - 60_000;
    insertBuy({ walletId: "w1", tokenOut: TOK, status: "failed", at: oldAt });
    const out = findStuckBuys({ walletId: "w1", date: utcDate(now), nowMs: now });
    assert.deepEqual(out, []);
  });

  test("scopes by wallet — w1's stuck buys are not w2's problem", () => {
    const TOK = "0x" + "e".repeat(40);
    const now = Date.now();
    const oldAt = now - MIN_AGE_MS - 60_000;
    insertBuy({ walletId: "w1", tokenOut: TOK, at: oldAt });
    const out = findStuckBuys({ walletId: "w2", date: utcDate(now), nowMs: now });
    assert.deepEqual(out, []);
  });

  test("a failed sell does NOT mark the position as closed — watchdog still picks it up", () => {
    const TOK = "0x" + "f".repeat(40);
    const now = Date.now();
    const oldAt = now - MIN_AGE_MS - 60_000;
    insertBuy({ walletId: "w1", tokenOut: TOK, at: oldAt });
    insertSell({ walletId: "w1", tokenIn: TOK, status: "failed", at: oldAt + 1000 });
    const out = findStuckBuys({ walletId: "w1", date: utcDate(now), nowMs: now });
    assert.deepEqual(out, [TOK.toLowerCase()]);
  });

  test("deduplicates when wallet bought the same token twice", () => {
    const TOK = "0x" + "1".repeat(40);
    const now = Date.now();
    const oldAt = now - MIN_AGE_MS - 60_000;
    insertBuy({ walletId: "w1", tokenOut: TOK, at: oldAt });
    insertBuy({ walletId: "w1", tokenOut: TOK, at: oldAt + 100 });
    const out = findStuckBuys({ walletId: "w1", date: utcDate(now), nowMs: now });
    assert.deepEqual(out, [TOK.toLowerCase()]);
  });
});
