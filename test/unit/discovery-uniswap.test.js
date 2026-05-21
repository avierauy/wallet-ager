// Covers the V2, V3, and V4 handlers. Stubs publicClient.readContract (metadata + liquidity)
// and global.fetch (honeypot.is) so tests stay offline.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../src/core/db.js";
import { _listAll, _resetStaticCache, getActive } from "../../src/core/tokenRegistry.js";

const rpc = await import("../../src/core/rpc.js");
const {
  handleV2PairCreated,
  handleV3PoolCreated,
  handleV4Initialize,
} = await import("../../src/discovery/uniswap.js");

const WETH = "0x4200000000000000000000000000000000000006";
const NATIVE_ZERO = "0x0000000000000000000000000000000000000000";
const NEW_TOKEN = "0x" + "1".repeat(40);
const RUG_TOKEN = "0x" + "2".repeat(40);
const POOL = "0x" + "3".repeat(40);
const PAIR = "0x" + "4".repeat(40);

const originalRead = rpc.publicClient.readContract;
const originalFetch = globalThis.fetch;
const restore = () => {
  rpc.publicClient.readContract = originalRead;
  globalThis.fetch = originalFetch;
};

const stubReads = ({
  liquidity = 10n ** 18n,
  reserves = [10n ** 18n, 10n ** 18n, 0n],
  symbol = "FRESH",
  decimals = 18,
  metadataThrows = false,
} = {}) => {
  rpc.publicClient.readContract = async ({ functionName }) => {
    if (functionName === "liquidity") return liquidity;
    if (functionName === "getReserves") return reserves;
    if (functionName === "symbol") {
      if (metadataThrows) throw new Error("rpc down");
      return symbol;
    }
    if (functionName === "decimals") {
      if (metadataThrows) throw new Error("rpc down");
      return decimals;
    }
    throw new Error("unexpected readContract: " + functionName);
  };
};

const stubHoneypot = (verdict) => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => verdict, text: async () => JSON.stringify(verdict),
  });
};
const safeVerdict = {
  simulationSuccess: true,
  honeypotResult: { isHoneypot: false },
  simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0 },
  summary: { riskLevel: 1 },
};
const honeypotVerdict = {
  simulationSuccess: true,
  honeypotResult: { isHoneypot: true, honeypotReason: "blacklisted" },
  simulationResult: { buyTax: 0, sellTax: 100, transferTax: 0 },
  summary: { riskLevel: 9 },
};

describe("uniswap V2 handler", () => {
  beforeEach(() => {
    db.exec("DELETE FROM discovered_tokens; DELETE FROM token_safety");
    _resetStaticCache();
  });
  afterEach(restore);

  test("non-WETH pair: skipped with no rpc/fetch", async () => {
    let touched = false;
    rpc.publicClient.readContract = async () => { touched = true; return 0n; };
    globalThis.fetch = async () => { touched = true; return { ok: true, json: async () => ({}) }; };
    const result = await handleV2PairCreated({
      token0: "0x" + "a".repeat(40), token1: "0x" + "b".repeat(40), pair: PAIR,
    });
    assert.equal(result.skipped, "not-weth-pair");
    assert.equal(touched, false);
  });

  test("WETH pair, empty reserves: skipped", async () => {
    stubReads({ reserves: [0n, 0n, 0n] });
    const result = await handleV2PairCreated({ token0: WETH, token1: NEW_TOKEN, pair: PAIR });
    assert.equal(result.skipped, "no-liquidity");
  });

  test("safe V2 token registered with source=uniswap-v2", async () => {
    stubReads({ symbol: "V2FRESH" });
    stubHoneypot(safeVerdict);
    const result = await handleV2PairCreated({ token0: WETH, token1: NEW_TOKEN, pair: PAIR });
    assert.equal(result.added, true);
    const row = _listAll().find((t) => t.address.toLowerCase() === NEW_TOKEN.toLowerCase());
    assert.ok(row);
    assert.equal(row.source, "uniswap-v2");
  });
});

describe("uniswap V3 handler", () => {
  beforeEach(() => {
    db.exec("DELETE FROM discovered_tokens; DELETE FROM token_safety");
    _resetStaticCache();
  });
  afterEach(restore);

  test("safe V3 token registered with fee-tagged source", async () => {
    stubReads({ symbol: "V3FRESH" });
    stubHoneypot(safeVerdict);
    const result = await handleV3PoolCreated({ token0: WETH, token1: NEW_TOKEN, fee: 500, pool: POOL });
    assert.equal(result.added, true);
    const row = _listAll().find((t) => t.address.toLowerCase() === NEW_TOKEN.toLowerCase());
    assert.equal(row.source, "uniswap-v3-fee500");
  });

  test("honeypot recorded as UNSAFE", async () => {
    stubReads({ symbol: "RUG" });
    stubHoneypot(honeypotVerdict);
    await handleV3PoolCreated({ token0: WETH, token1: RUG_TOKEN, fee: 3000, pool: POOL });
    assert.ok(!getActive().some((t) => t.address.toLowerCase() === RUG_TOKEN.toLowerCase()));
  });
});

describe("uniswap V4 handler", () => {
  beforeEach(() => {
    db.exec("DELETE FROM discovered_tokens; DELETE FROM token_safety");
    _resetStaticCache();
  });
  afterEach(restore);

  test("native ETH (currency0=address(0)) paired with token registers correctly", async () => {
    stubReads({ symbol: "V4FRESH" });
    stubHoneypot(safeVerdict);
    const result = await handleV4Initialize({
      currency0: NATIVE_ZERO, currency1: NEW_TOKEN, fee: 3000, hooks: NATIVE_ZERO, pool: POOL,
    });
    assert.equal(result.added, true);
    const row = _listAll().find((t) => t.address.toLowerCase() === NEW_TOKEN.toLowerCase());
    assert.equal(row.source, "uniswap-v4-fee3000");
  });

  test("non-native pair: skipped", async () => {
    const result = await handleV4Initialize({
      currency0: "0x" + "a".repeat(40), currency1: "0x" + "b".repeat(40),
      fee: 3000, hooks: NATIVE_ZERO, pool: POOL,
    });
    assert.equal(result.skipped, "not-weth-pair");
  });

  test("native vs native (both zero): skipped", async () => {
    const result = await handleV4Initialize({
      currency0: NATIVE_ZERO, currency1: NATIVE_ZERO,
      fee: 3000, hooks: NATIVE_ZERO, pool: POOL,
    });
    assert.equal(result.skipped, "both-native");
  });
});
