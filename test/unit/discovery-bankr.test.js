// Bankr discovery via Doppler Airlock. Stubs publicClient.readContract + global.fetch.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../src/core/db.js";
import { _listAll, _resetStaticCache, getActive } from "../../src/core/tokenRegistry.js";

const rpc = await import("../../src/core/rpc.js");
const { handleAirlockCreate } = await import("../../src/discovery/bankr.js");

const WETH = "0x4200000000000000000000000000000000000006";
const NATIVE_ZERO = "0x0000000000000000000000000000000000000000";
const NEW_TOKEN = "0x" + "1".repeat(40);
const RUG_TOKEN = "0x" + "2".repeat(40);
const POOL = "0x" + "3".repeat(40);
const INITIALIZER = "0x" + "9".repeat(40);

const originalRead = rpc.publicClient.readContract;
const originalFetch = globalThis.fetch;
const restore = () => {
  rpc.publicClient.readContract = originalRead;
  globalThis.fetch = originalFetch;
};

const stubReads = ({ symbol = "DOPPLER", decimals = 18, metadataThrows = false } = {}) => {
  rpc.publicClient.readContract = async ({ functionName }) => {
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

describe("bankr airlock discovery", () => {
  beforeEach(() => {
    db.exec("DELETE FROM discovered_tokens; DELETE FROM token_safety");
    _resetStaticCache();
  });
  afterEach(restore);

  test("non-WETH numeraire is skipped (cheap filter)", async () => {
    let touched = false;
    rpc.publicClient.readContract = async () => { touched = true; return null; };
    globalThis.fetch = async () => { touched = true; return { ok: true, json: async () => ({}) }; };
    const result = await handleAirlockCreate({
      asset: NEW_TOKEN,
      numeraire: "0x" + "c".repeat(40),
      initializer: INITIALIZER,
      poolOrHook: POOL,
    });
    assert.equal(result.skipped, "non-weth-numeraire");
    assert.equal(touched, false);
  });

  test("WETH numeraire + safe token registered with doppler-* source", async () => {
    stubReads({ symbol: "BNKR" });
    stubHoneypot(safeVerdict);
    const result = await handleAirlockCreate({
      asset: NEW_TOKEN, numeraire: WETH, initializer: INITIALIZER, poolOrHook: POOL,
    });
    assert.equal(result.added, true);
    const row = _listAll().find((t) => t.address.toLowerCase() === NEW_TOKEN.toLowerCase());
    assert.ok(row);
    // Initializer is unknown to the test config, so it should land as doppler-unknown.
    assert.equal(row.source, "doppler-unknown");
    assert.deepEqual(row.tradeableOn, ["uniswap"]);
  });

  test("native numeraire (address(0)) also accepted as ETH", async () => {
    stubReads({ symbol: "BNKR2" });
    stubHoneypot(safeVerdict);
    const result = await handleAirlockCreate({
      asset: NEW_TOKEN, numeraire: NATIVE_ZERO, initializer: INITIALIZER, poolOrHook: POOL,
    });
    assert.equal(result.added, true);
  });

  test("honeypot flagged via post-Doppler safety check", async () => {
    stubReads({ symbol: "RUG" });
    stubHoneypot(honeypotVerdict);
    await handleAirlockCreate({
      asset: RUG_TOKEN, numeraire: WETH, initializer: INITIALIZER, poolOrHook: POOL,
    });
    assert.ok(!getActive().some((t) => t.address.toLowerCase() === RUG_TOKEN.toLowerCase()));
    assert.ok(_listAll().some((t) => t.address.toLowerCase() === RUG_TOKEN.toLowerCase()));
  });
});
