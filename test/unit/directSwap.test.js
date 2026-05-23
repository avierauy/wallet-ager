// directSwap unit tests — covers the dispatcher's error cases and the isDirectSwappable
// predicate. Full buy flow (V2/V3/V4 calldata + actual broadcast) is exercised by the daemon
// against live RPC; deep unit testing here would require DI for walletClientFor which is
// blocked by ESM's read-only module bindings.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buyDirect, isDirectSwappable, isSellDirectSwappable, sellDirect } from "../../src/adapters/directSwap.js";

describe("directSwap", () => {
  describe("isDirectSwappable", () => {
    test("rejects null/undefined", () => {
      assert.equal(isDirectSwappable(null), false);
      assert.equal(isDirectSwappable(undefined), false);
    });
    test("rejects pending metadata (Clanker/Doppler awaiting enrichment)", () => {
      assert.equal(isDirectSwappable({ version: "v4", pending: true }), false);
    });
    test("rejects unknown versions (e.g. v4-or-v3 ambiguity)", () => {
      assert.equal(isDirectSwappable({ version: "v4-or-v3" }), false);
      assert.equal(isDirectSwappable({ version: "bonding-curve" }), false);
    });
    test("accepts v2, v3, v4", () => {
      assert.equal(isDirectSwappable({ version: "v2" }), true);
      assert.equal(isDirectSwappable({ version: "v3" }), true);
      assert.equal(isDirectSwappable({ version: "v4" }), true);
    });
  });

  describe("buyDirect dispatcher errors", () => {
    const ACCOUNT = { address: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" };

    test("throws on null poolMetadata", async () => {
      await assert.rejects(
        buyDirect({ account: ACCOUNT, poolMetadata: null, amountInWei: 1n, slippageBps: 100 }),
        /poolMetadata is required/
      );
    });
    test("throws on unsupported version", async () => {
      await assert.rejects(
        buyDirect({
          account: ACCOUNT,
          poolMetadata: { version: "v4-or-v3" },
          amountInWei: 1n,
          slippageBps: 100,
        }),
        /unsupported version/
      );
    });
  });

  describe("isSellDirectSwappable", () => {
    test("v3 and v4 (non-pending) are supported on the sell path", () => {
      assert.equal(isSellDirectSwappable({ version: "v4" }), true);
      assert.equal(isSellDirectSwappable({ version: "v3" }), true);
      assert.equal(isSellDirectSwappable({ version: "v2" }), false);
      assert.equal(isSellDirectSwappable({ version: "v4", pending: true }), false);
      assert.equal(isSellDirectSwappable({ version: "v3", pending: true }), false);
      assert.equal(isSellDirectSwappable(null), false);
    });
  });

  describe("sellDirect dispatcher errors", () => {
    const ACCOUNT = { address: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" };
    test("throws on null poolMetadata", async () => {
      await assert.rejects(
        sellDirect({ account: ACCOUNT, poolMetadata: null, amountInWei: 1n, slippageBps: 100 }),
        /poolMetadata is required/
      );
    });
    test("throws on unsupported version (V2 sell not wired)", async () => {
      await assert.rejects(
        sellDirect({ account: ACCOUNT, poolMetadata: { version: "v2" }, amountInWei: 1n, slippageBps: 100 }),
        /unsupported version/
      );
    });
  });
});
