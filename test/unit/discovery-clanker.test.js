// Clanker discovery handler. Same stubbing pattern as the other discovery tests:
// publicClient.readContract for liquidity/quotes (skipped here since Clanker uses pre-event
// symbol), publicClient.call for safety eth_call.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../src/core/db.js";
import { _listAll, _resetStaticCache, getActive } from "../../src/core/tokenRegistry.js";

const sim = await import("../../src/safety/simulation.js");
const { handleTokenCreated } = await import("../../src/discovery/clanker.js");

const WETH = "0x4200000000000000000000000000000000000006";
const TOKEN = "0xCC11ABCDef0123456789ABCDef0123456789ABCD";
const POOL_ID = "0xaaa1111111111111111111111111111111111111111111111111111111111111";
const POOL_HOOK = "0x0000000000000000000000000000000000000000";

const restore = () => sim._resetDeps();

const stubSimulation = (verdict) => {
  sim._setDeps({
    quote: async () => ({
      methodParameters: { to: "0xR", calldata: "0xdead", value: "0" },
      quote: { quotient: { toString: () => "100000000000000" } },
    }),
    publicClient: { call: async () => ({ data: "0x" }) },
  });
  // override the simulateRoundtrip itself via checkToken — actually simulation uses _setDeps
  // for the underlying primitives. The check is on the safety/index.js dispatcher which goes
  // through simulation when SAFETY_PROVIDER=simulation. The .env.test pins honeypot, so we
  // stub global.fetch for those tests. For clanker, since the test env uses honeypot path:
};

const stubFetch = (verdict) => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => verdict, text: async () => JSON.stringify(verdict),
  });
};
const originalFetch = globalThis.fetch;
const restoreFetch = () => { globalThis.fetch = originalFetch; };

const safeVerdict = {
  simulationSuccess: true,
  honeypotResult: { isHoneypot: false },
  simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0 },
  summary: { riskLevel: 1 },
};

describe("clanker discovery handler", () => {
  beforeEach(() => {
    db.exec("DELETE FROM discovered_tokens; DELETE FROM token_safety");
    _resetStaticCache();
  });
  afterEach(() => { restore(); restoreFetch(); });

  test("non-WETH paired token is skipped", async () => {
    const result = await handleTokenCreated({
      tokenAddress: TOKEN, tokenSymbol: "X",
      pairedToken: "0x" + "9".repeat(40),
      poolId: POOL_ID, poolHook: POOL_HOOK,
    });
    assert.equal(result.skipped, "non-weth-paired-token");
  });

  test("WETH-paired token registered as ACTIVE with source clanker-v4", async () => {
    stubFetch(safeVerdict);
    const result = await handleTokenCreated({
      tokenAddress: TOKEN, tokenSymbol: "CLNK",
      pairedToken: WETH, poolId: POOL_ID, poolHook: POOL_HOOK,
    });
    assert.equal(result.added, true);
    assert.equal(result.status, "active");
    const row = _listAll().find((t) => t.address.toLowerCase() === TOKEN.toLowerCase());
    assert.ok(row);
    assert.equal(row.symbol, "CLNK");
    assert.equal(row.source, "clanker-v4");
    assert.deepEqual(row.tradeableOn, ["uniswap"]);
  });
});
