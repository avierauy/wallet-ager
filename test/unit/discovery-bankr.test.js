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
const originalSimulate = rpc.publicClient.simulateContract;
const originalFetch = globalThis.fetch;
const restore = () => {
  rpc.publicClient.readContract = originalRead;
  rpc.publicClient.simulateContract = originalSimulate;
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
    // V3 probe (token0/token1/fee) — fail so we fall through to V4 path
    if (["token0", "token1", "fee"].includes(functionName)) {
      throw new Error("not a V3 pool");
    }
    throw new Error("unexpected readContract: " + functionName);
  };
  // V4 Quoter probe — fail every candidate so handler falls back to pending=true.
  // Tests that need a successful quote can override this stub themselves.
  rpc.publicClient.simulateContract = async () => { throw new Error("PoolNotInitialized"); };
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

  test("Doppler tokens skip honeypot probe — trusted launchpad template", async () => {
    // Doppler uses standard ERC20 templates with no rug surface. The discovery handler must
    // NOT call honeypot.is — the templated contract is trusted regardless of any external
    // verdict. (P2: when the V4 probes fail, the row lands as PENDING and only becomes
    // ACTIVE after the poll's onReady confirms the pool is swappable. Safety bypass is
    // independent of the active-vs-pending lifecycle.)
    stubReads({ symbol: "RUG" });
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => honeypotVerdict }; };

    const result = await handleAirlockCreate({
      asset: RUG_TOKEN, numeraire: WETH, initializer: INITIALIZER, poolOrHook: POOL,
    });

    assert.equal(result.added, true);
    assert.equal(fetchCalled, false, "honeypot.is must not be called for Doppler tokens");
    const row = _listAll().find((t) => t.address.toLowerCase() === RUG_TOKEN.toLowerCase());
    assert.ok(row, "token should be registered");
  });

  test("poolMetadata is recorded with version + initializer hint", async () => {
    stubReads({ symbol: "META" });
    await handleAirlockCreate({
      asset: NEW_TOKEN, numeraire: WETH, initializer: INITIALIZER, poolOrHook: POOL,
    });
    const row = _listAll().find((t) => t.address.toLowerCase() === NEW_TOKEN.toLowerCase());
    assert.ok(row.poolMetadata, "poolMetadata should be persisted");
    assert.equal(row.poolMetadata.version, "v4-or-v3");
    assert.equal(row.poolMetadata.pending, true);
    assert.equal(row.poolMetadata.poolOrHook?.toLowerCase(), POOL.toLowerCase());
  });

  test("V3/V4 probes failed → row inserted as PENDING (poll still in flight)", async () => {
    // Both V3 probe (token0/token1/fee) and V4 Quoter brute-force fail per stubReads. The
    // handler enters the polling branch which must insert as PENDING — not ACTIVE — so the
    // planner's getActive() does not yield this token to the aging scheduler before the
    // V4 hook has confirmed the pool is swappable. The onTimeout in P1 then promotes to
    // EXPIRED, and the onReady promotes to ACTIVE.
    stubReads({ symbol: "PEND" });
    await handleAirlockCreate({
      asset: NEW_TOKEN, numeraire: WETH, initializer: INITIALIZER, poolOrHook: POOL,
    });
    const dbRow = db
      .prepare("SELECT status FROM discovered_tokens WHERE address = ? COLLATE NOCASE")
      .get(NEW_TOKEN);
    assert.equal(dbRow.status, "pending", "polling path must insert as PENDING");
    assert.equal(
      getActive().some((t) => t.address.toLowerCase() === NEW_TOKEN.toLowerCase()),
      false,
      "PENDING tokens must NOT appear in getActive()"
    );
  });
});
