// Clanker discovery handler. Same stubbing pattern as the other discovery tests:
// publicClient.readContract for liquidity/quotes (skipped here since Clanker uses pre-event
// symbol), publicClient.call for safety eth_call.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../src/core/db.js";
import { _listAll, _resetStaticCache, getActive } from "../../src/core/tokenRegistry.js";

const sim = await import("../../src/safety/simulation.js");
const { _internals } = await import("../../src/discovery/v4PoolKey.js");
const { handleTokenCreated } = await import("../../src/discovery/clanker.js");

const WETH = "0x4200000000000000000000000000000000000006";
// All-lowercase to skip viem's EIP-55 checksum validation in encodeAbiParameters
const TOKEN = "0xcc11abcdef0123456789abcdef0123456789abcd";
const POOL_ID = "0xaaa1111111111111111111111111111111111111111111111111111111111111";
const POOL_HOOK = "0x0000000000000000000000000000000000000000";

// Match the first candidate so resolveV4PoolKey succeeds → handler enters the polling branch.
const TOKEN_HASH_MATCH = "0xbb22abcdef0123456789abcdef0123456789abcd";
const [c0, c1] = _internals.sortCurrencies(TOKEN_HASH_MATCH, WETH);
const cand = _internals.DEFAULT_CANDIDATES[0];
const POOL_ID_HASH_MATCH = _internals.computePoolId({
  currency0: c0, currency1: c1, fee: cand.fee, tickSpacing: cand.tickSpacing, hooks: POOL_HOOK,
});

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

  test("no-pool-key fallback → ACTIVE (AlphaRouter path)", async () => {
    // POOL_ID does not match any canonical candidate hash → resolveV4PoolKey returns null →
    // handler takes the fallback branch: registers ACTIVE and fires the sniper via AlphaRouter.
    // P2 preserves ACTIVE here per the design decision (the fallback is the only way this path
    // can ever fire, so we don't want to gate it behind a Quoter probe).
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
    const dbRow = db
      .prepare("SELECT status FROM discovered_tokens WHERE address = ? COLLATE NOCASE")
      .get(TOKEN);
    assert.equal(dbRow.status, "active", "fallback path must persist as ACTIVE");
  });

  test("hash-matched poolId → PENDING (poll still in flight)", async () => {
    // POOL_ID_HASH_MATCH is computed to collide with the first DEFAULT_CANDIDATES entry, so
    // resolveV4PoolKey succeeds and the handler enters the polling branch. P2 requires this
    // row to be inserted as PENDING — not ACTIVE — so the aging scheduler doesn't pick it
    // before the MEV hook has confirmed swappability. onTimeout (P1) marks EXPIRED on failure;
    // onReady promotes to ACTIVE on success (covered by clanker-timeout test for the failure path).
    const result = await handleTokenCreated({
      tokenAddress: TOKEN_HASH_MATCH, tokenSymbol: "CLNK2",
      pairedToken: WETH, poolId: POOL_ID_HASH_MATCH, poolHook: POOL_HOOK,
    });
    assert.equal(result.added, true);
    const dbRow = db
      .prepare("SELECT status FROM discovered_tokens WHERE address = ? COLLATE NOCASE")
      .get(TOKEN_HASH_MATCH);
    assert.equal(dbRow.status, "pending", "hash-matched + polling path must persist as PENDING");
    assert.equal(
      getActive().some((t) => t.address.toLowerCase() === TOKEN_HASH_MATCH.toLowerCase()),
      false,
      "PENDING tokens must NOT appear in getActive()"
    );
  });
});
