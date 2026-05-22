// Tests the pure handlers, not the live watcher (viem's watchContractEvent opens connections
// we don't want in CI). Stubs publicClient.readContract — both the metadata reads and the
// safety probe's quote reads — so we cover the full handler path without mocking modules.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../src/core/db.js";
import { _listAll, _resetStaticCache, add, getActive } from "../../src/core/tokenRegistry.js";

const rpc = await import("../../src/core/rpc.js");
const { handleLaunched, handleGraduated } = await import("../../src/discovery/virtuals.js");

const TOKEN_NEW = "0x" + "1".repeat(40);
const TOKEN_BAD = "0x" + "2".repeat(40);
const TOKEN_GRAD = "0x" + "3".repeat(40);

const originalRead = rpc.publicClient.readContract;
const restore = () => { rpc.publicClient.readContract = originalRead; };

const stubPublicClient = ({ symbol = "AGENT", decimals = 18, metadataThrows = false, safetyRoundtripPct = 1 }) => {
  rpc.publicClient.readContract = async ({ functionName, args }) => {
    if (functionName === "symbol") {
      if (metadataThrows) throw new Error("metadata read failed");
      return symbol;
    }
    if (functionName === "decimals") {
      if (metadataThrows) throw new Error("metadata read failed");
      return decimals;
    }
    if (functionName === "getAmountsOut") {
      // Safety probe calls this twice: VIRTUAL→agent then agent→VIRTUAL.
      // We return (amountIn * (100 - roundtripPct/2) / 100) so the total roundtrip loss
      // ≈ roundtripPct. >30 triggers the safety threshold.
      const amountIn = args[2];
      return (amountIn * BigInt(Math.floor(100 - safetyRoundtripPct / 2))) / 100n;
    }
    throw new Error("unexpected readContract: " + functionName);
  };
};

describe("virtuals discovery handlers", () => {
  beforeEach(() => {
    db.exec("DELETE FROM discovered_tokens");
    _resetStaticCache();
  });
  afterEach(restore);

  test("handleLaunched registers a safe token as ACTIVE", async () => {
    stubPublicClient({ symbol: "FRESH", safetyRoundtripPct: 2 });
    const result = await handleLaunched({ token: TOKEN_NEW });
    assert.equal(result.added, true);
    assert.equal(result.status, "active");

    const row = _listAll().find((t) => t.address.toLowerCase() === TOKEN_NEW.toLowerCase());
    assert.ok(row);
    assert.equal(row.symbol, "FRESH");
    assert.equal(row.virtualsState, "pre-graduation");
    assert.deepEqual(row.tradeableOn, ["virtuals"]);
    assert.equal(row.source, "virtuals-Launched");
  });

  test("Virtuals tokens skip the bonding-curve safety probe — trusted template", async () => {
    // Phase A: Virtuals deploys the protocol's standard ERC20 template — no rug surface. The
    // discovery handler must NOT call getAmountsOut (the safety probe) and must register ACTIVE.
    let safetyProbeCalled = false;
    rpc.publicClient.readContract = async ({ functionName }) => {
      if (functionName === "symbol") return "FRESH";
      if (functionName === "decimals") return 18;
      if (functionName === "getAmountsOut") { safetyProbeCalled = true; return 1n; }
      throw new Error("unexpected: " + functionName);
    };

    const result = await handleLaunched({ token: TOKEN_BAD });
    assert.equal(result.added, true);
    assert.equal(result.status, "active");
    assert.equal(safetyProbeCalled, false, "bonding-curve safety probe must not be called");
    assert.ok(getActive().some((t) => t.address.toLowerCase() === TOKEN_BAD.toLowerCase()));
  });

  test("handleLaunched skips when token metadata can't be read", async () => {
    stubPublicClient({ metadataThrows: true });
    const result = await handleLaunched({ token: TOKEN_NEW });
    assert.equal(result.skipped, "no-metadata");
    assert.equal(_listAll().length, 0);
  });

  test("handleGraduated marks a discovered token as expired", () => {
    add({
      address: TOKEN_GRAD,
      symbol: "GRAD",
      decimals: 18,
      tradeableOn: ["virtuals"],
      virtualsState: "pre-graduation",
      source: "virtuals-Launched",
    });
    assert.ok(getActive().some((t) => t.address.toLowerCase() === TOKEN_GRAD.toLowerCase()));

    handleGraduated({ token: TOKEN_GRAD });

    assert.ok(!getActive().some((t) => t.address.toLowerCase() === TOKEN_GRAD.toLowerCase()),
      "graduated token should no longer be active");
  });
});
