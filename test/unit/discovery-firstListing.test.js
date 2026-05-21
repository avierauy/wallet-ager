// Covers the "first listing" filter and the PENDING state added in the discovery fix.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../src/core/db.js";
import { _listAll, _resetStaticCache, getActive } from "../../src/core/tokenRegistry.js";

const rpc = await import("../../src/core/rpc.js");
const { handleV3PoolCreated } = await import("../../src/discovery/uniswap.js");

const WETH = "0x4200000000000000000000000000000000000006";
const TOKEN = "0x" + "1".repeat(40);
const NEW_POOL = "0x" + "2".repeat(40);
const EXISTING_V3 = "0x" + "3".repeat(40);

const originalRead = rpc.publicClient.readContract;
const originalFetch = globalThis.fetch;
const ZERO = "0x0000000000000000000000000000000000000000";

const restore = () => {
  rpc.publicClient.readContract = originalRead;
  globalThis.fetch = originalFetch;
};

const stubFactoryReads = ({ existingV3Fee = null, existingV3PoolAt = EXISTING_V3 } = {}) => {
  rpc.publicClient.readContract = async ({ functionName, args }) => {
    if (functionName === "liquidity") return 10n ** 18n;
    if (functionName === "getReserves") return [10n ** 18n, 10n ** 18n, 0n];
    if (functionName === "symbol") return "FRESH";
    if (functionName === "decimals") return 18;
    if (functionName === "getPair") return ZERO;
    if (functionName === "getPool") {
      const [, , fee] = args;
      if (existingV3Fee && Number(fee) === existingV3Fee) return existingV3PoolAt;
      return ZERO;
    }
    throw new Error("unexpected readContract: " + functionName);
  };
};

describe("first-listing filter (uniswap V3 path)", () => {
  beforeEach(() => {
    db.exec("DELETE FROM discovered_tokens; DELETE FROM token_safety");
    _resetStaticCache();
  });
  afterEach(restore);

  test("token with no other pools is registered (fresh listing)", async () => {
    stubFactoryReads({}); // no existing pools
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        simulationSuccess: true,
        honeypotResult: { isHoneypot: false },
        simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0 },
      }),
      text: async () => "",
    });
    const result = await handleV3PoolCreated({ token0: WETH, token1: TOKEN, fee: 500, pool: NEW_POOL });
    assert.equal(result.added, true);
    assert.equal(result.status, "active");
  });

  test("token with an existing V3 pool at a different fee is skipped", async () => {
    // Existing fee 3000 pool, new event is for fee 500
    stubFactoryReads({ existingV3Fee: 3000 });
    let honeypotCalled = false;
    globalThis.fetch = async () => { honeypotCalled = true; return { ok: true, status: 200, json: async () => ({}), text: async () => "" }; };

    const result = await handleV3PoolCreated({ token0: WETH, token1: TOKEN, fee: 500, pool: NEW_POOL });
    assert.equal(result.skipped, "already-tradeable-elsewhere");
    assert.equal(result.existing.where, "v3-fee3000");
    assert.equal(honeypotCalled, false, "should not have called honeypot.is");
    assert.equal(_listAll().length, 0);
  });

  test("excludes the current pool from the existence check (no false self-match)", async () => {
    // Factory returns the same pool address for our fee tier — that's just the event we're handling
    stubFactoryReads({ existingV3Fee: 500, existingV3PoolAt: NEW_POOL });
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        simulationSuccess: true,
        honeypotResult: { isHoneypot: false },
        simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0 },
      }),
      text: async () => "",
    });
    const result = await handleV3PoolCreated({ token0: WETH, token1: TOKEN, fee: 500, pool: NEW_POOL });
    assert.equal(result.added, true);
  });
});

describe("PENDING state on honeypot 404", () => {
  beforeEach(() => {
    db.exec("DELETE FROM discovered_tokens; DELETE FROM token_safety");
    _resetStaticCache();
  });
  afterEach(restore);

  test("honeypot.is 404 → token registered as PENDING (not UNSAFE)", async () => {
    stubFactoryReads({});
    globalThis.fetch = async () => ({
      ok: false, status: 404,
      json: async () => ({ code: 404, error: "pair not found" }),
      text: async () => JSON.stringify({ code: 404, error: "pair not found" }),
    });

    const result = await handleV3PoolCreated({ token0: WETH, token1: TOKEN, fee: 500, pool: NEW_POOL });
    assert.equal(result.added, true);
    assert.equal(result.status, "pending");

    const row = _listAll().find((t) => t.address.toLowerCase() === TOKEN.toLowerCase());
    assert.ok(row);
    // Pending tokens are NOT in the active set (planner doesn't see them yet)
    assert.ok(!getActive().some((t) => t.address.toLowerCase() === TOKEN.toLowerCase()));
  });

  test("real network failure (500) → still UNSAFE (fail-safe preserved)", async () => {
    stubFactoryReads({});
    globalThis.fetch = async () => ({
      ok: false, status: 503,
      json: async () => ({}), text: async () => "service unavailable",
    });
    const result = await handleV3PoolCreated({ token0: WETH, token1: TOKEN, fee: 500, pool: NEW_POOL });
    assert.equal(result.status, "unsafe");
  });
});
