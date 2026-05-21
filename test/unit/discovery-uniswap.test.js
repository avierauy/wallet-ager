// Tests the pure handler. Stubs publicClient.readContract (metadata + pool liquidity) and the
// global fetch (honeypot.is). Same isolation pattern as the virtuals discovery test.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../src/core/db.js";
import { _listAll, _resetStaticCache, getActive } from "../../src/core/tokenRegistry.js";

const rpc = await import("../../src/core/rpc.js");
const { handlePoolCreated } = await import("../../src/discovery/uniswap.js");

const WETH = "0x4200000000000000000000000000000000000006";
const NEW_TOKEN = "0x" + "1".repeat(40);
const RUG_TOKEN = "0x" + "2".repeat(40);
const POOL = "0x" + "3".repeat(40);

const originalRead = rpc.publicClient.readContract;
const originalFetch = globalThis.fetch;
const restore = () => {
  rpc.publicClient.readContract = originalRead;
  globalThis.fetch = originalFetch;
};

const stubReads = ({ liquidity = 10n ** 18n, symbol = "FRESH", decimals = 18, metadataThrows = false }) => {
  rpc.publicClient.readContract = async ({ functionName }) => {
    if (functionName === "liquidity") return liquidity;
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

describe("uniswap V3 discovery handler", () => {
  beforeEach(() => {
    db.exec("DELETE FROM discovered_tokens; DELETE FROM token_safety");
    _resetStaticCache();
  });
  afterEach(restore);

  test("non-WETH pair is skipped (cheap filter, no rpc/fetch)", async () => {
    let touched = false;
    rpc.publicClient.readContract = async () => { touched = true; return 0n; };
    globalThis.fetch = async () => { touched = true; return { ok: true, json: async () => ({}) }; };
    const result = await handlePoolCreated({
      token0: "0x" + "a".repeat(40),
      token1: "0x" + "b".repeat(40),
      fee: 3000,
      pool: POOL,
    });
    assert.equal(result.skipped, "not-weth-pair");
    assert.equal(touched, false, "skipped before any rpc/fetch");
  });

  test("WETH pair with empty liquidity is skipped", async () => {
    stubReads({ liquidity: 0n });
    const result = await handlePoolCreated({ token0: WETH, token1: NEW_TOKEN, fee: 3000, pool: POOL });
    assert.equal(result.skipped, "no-liquidity");
    assert.equal(_listAll().length, 0);
  });

  test("safe token registered as ACTIVE", async () => {
    stubReads({ symbol: "FRESH" });
    stubHoneypot(safeVerdict);
    const result = await handlePoolCreated({ token0: WETH, token1: NEW_TOKEN, fee: 500, pool: POOL });
    assert.equal(result.added, true);
    assert.equal(result.status, "active");

    const row = _listAll().find((t) => t.address.toLowerCase() === NEW_TOKEN.toLowerCase());
    assert.ok(row);
    assert.equal(row.symbol, "FRESH");
    assert.deepEqual(row.tradeableOn, ["uniswap"]);
    assert.equal(row.source, "uniswap-v3-fee500");
  });

  test("honeypot is recorded as UNSAFE and excluded from active set", async () => {
    stubReads({ symbol: "RUG" });
    stubHoneypot(honeypotVerdict);
    const result = await handlePoolCreated({ token0: RUG_TOKEN, token1: WETH, fee: 10000, pool: POOL });
    assert.equal(result.status, "unsafe");

    assert.ok(_listAll().some((t) => t.address.toLowerCase() === RUG_TOKEN.toLowerCase()));
    assert.ok(!getActive().some((t) => t.address.toLowerCase() === RUG_TOKEN.toLowerCase()));
  });

  test("metadata-read failure skips without registry write", async () => {
    stubReads({ metadataThrows: true });
    stubHoneypot(safeVerdict);
    const result = await handlePoolCreated({ token0: WETH, token1: NEW_TOKEN, fee: 3000, pool: POOL });
    assert.equal(result.skipped, "no-metadata");
    assert.equal(_listAll().length, 0);
  });
});
