import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../src/core/db.js";
import {
  _listAll,
  _resetStaticCache,
  add,
  getActive,
  markExpired,
  markUnsafe,
  STATUS,
} from "../../src/core/tokenRegistry.js";

const CHAIN = "base"; // matches the test env

const reset = () => {
  db.exec("DELETE FROM discovered_tokens");
  _resetStaticCache();
};

const newToken = (overrides = {}) => ({
  address: "0x" + "1".repeat(40),
  symbol: "FRESH",
  decimals: 18,
  tradeableOn: ["uniswap"],
  source: "test",
  status: STATUS.ACTIVE,
  ...overrides,
});

describe("tokenRegistry", () => {
  beforeEach(reset);

  test("getActive returns static tokens from tokens.json by default", () => {
    const tokens = getActive({ chain: CHAIN });
    assert.ok(tokens.length > 0, "expected tokens.example.json to populate the static set");
    for (const t of tokens) {
      assert.ok(t.address);
      assert.ok(Array.isArray(t.tradeableOn));
    }
  });

  test("add() persists a discovered token and getActive includes it", () => {
    const before = getActive({ chain: CHAIN }).length;
    add(newToken({ address: "0x" + "a".repeat(40), symbol: "NEW1" }));
    const after = getActive({ chain: CHAIN });
    assert.equal(after.length, before + 1);
    assert.ok(after.some((t) => t.symbol === "NEW1"));
  });

  test("getActive does NOT include pending tokens", () => {
    add(newToken({ address: "0x" + "b".repeat(40), symbol: "PEND", status: STATUS.PENDING }));
    const active = getActive({ chain: CHAIN });
    assert.ok(!active.some((t) => t.symbol === "PEND"));
  });

  test("markUnsafe transitions a token out of active", () => {
    const addr = "0x" + "c".repeat(40);
    add(newToken({ address: addr, symbol: "BAD" }));
    assert.ok(getActive({ chain: CHAIN }).some((t) => t.symbol === "BAD"));
    markUnsafe({ address: addr, chain: CHAIN, reason: "test" });
    assert.ok(!getActive({ chain: CHAIN }).some((t) => t.symbol === "BAD"));
  });

  test("markExpired transitions a token out of active", () => {
    const addr = "0x" + "d".repeat(40);
    add(newToken({ address: addr, symbol: "OLD" }));
    markExpired({ address: addr, chain: CHAIN, reason: "ttl" });
    assert.ok(!getActive({ chain: CHAIN }).some((t) => t.symbol === "OLD"));
  });

  test("static tokens shadow discovered entries with the same address", () => {
    // Pick the first address from the static set and re-discover it with a different symbol.
    const stat = getActive({ chain: CHAIN });
    const collision = stat[0];
    add({
      address: collision.address,
      symbol: "SHADOWED",
      decimals: collision.decimals,
      tradeableOn: collision.tradeableOn,
      source: "test",
      status: STATUS.ACTIVE,
    });
    const after = getActive({ chain: CHAIN });
    const matching = after.filter((t) => t.address.toLowerCase() === collision.address.toLowerCase());
    assert.equal(matching.length, 1, "expected exactly one entry per address");
    assert.equal(matching[0].symbol, collision.symbol, "expected static entry to win");
  });

  test("add() rejects empty tradeableOn", () => {
    assert.throws(() =>
      add({
        address: "0x" + "e".repeat(40),
        symbol: "X",
        decimals: 18,
        tradeableOn: [],
        source: "test",
      })
    );
  });

  test("_listAll returns rows regardless of status", () => {
    add(newToken({ address: "0x" + "f".repeat(40), symbol: "ACT" }));
    add(newToken({ address: "0x" + "9".repeat(40), symbol: "PND", status: STATUS.PENDING }));
    const all = _listAll({ chain: CHAIN });
    assert.equal(all.length, 2);
    const symbols = all.map((t) => t.symbol).sort();
    assert.deepEqual(symbols, ["ACT", "PND"]);
  });
});
