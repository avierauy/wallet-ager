// Clanker poll-timeout behavior: when the V4 Quoter never accepts inside the MEV blackout
// window, the discovery handler must mark the token EXPIRED and drop any cached approvals.
// Uses CLANKER_POLL_* env knobs to shrink the polling window so the test runs in <1s.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

delete process.env.V4_POLLER_DISABLED;
// maxAttempts=1 → setImmediate fires once, fails, onTimeout. Avoids jitter on retries.
process.env.CLANKER_POLL_INTERVAL_MS = "10";
process.env.CLANKER_POLL_MAX_ATTEMPTS = "1";

const rpc = await import("../../src/core/rpc.js");
const { db, recordApproval, hasApproval } = await import("../../src/core/db.js");
const { _resetStaticCache } = await import("../../src/core/tokenRegistry.js");
const { _internals } = await import("../../src/discovery/v4PoolKey.js");
const { handleTokenCreated } = await import("../../src/discovery/clanker.js");

const WETH = "0x4200000000000000000000000000000000000006";
const TOKEN = "0xcc11abcdef0123456789abcdef0123456789abcd";
const POOL_HOOK = "0x0000000000000000000000000000000000000000";

// Match the first candidate so resolveV4PoolKey succeeds → handler enters the polling branch.
const [c0, c1] = _internals.sortCurrencies(TOKEN, WETH);
const cand = _internals.DEFAULT_CANDIDATES[0];
const POOL_ID = _internals.computePoolId({
  currency0: c0, currency1: c1, fee: cand.fee, tickSpacing: cand.tickSpacing, hooks: POOL_HOOK,
});

const originalSimulate = rpc.publicClient.simulateContract;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("clanker poll timeout", () => {
  beforeEach(() => {
    db.exec("DELETE FROM discovered_tokens; DELETE FROM approvals; DELETE FROM token_safety");
    _resetStaticCache();
    rpc.publicClient.simulateContract = async () => { throw new Error("PoolNotInitialized"); };
  });
  afterEach(() => {
    rpc.publicClient.simulateContract = originalSimulate;
  });

  test("poll timeout marks token EXPIRED and drops cached approvals", async () => {
    recordApproval({
      wallet_id: "w-clanker-test",
      token: TOKEN,
      spender: "0x" + "f".repeat(40),
      tx_hash: "0x" + "0".repeat(64),
      granted_at: Date.now(),
    });

    await handleTokenCreated({
      tokenAddress: TOKEN, tokenSymbol: "CLNK",
      pairedToken: WETH, poolId: POOL_ID, poolHook: POOL_HOOK,
    });

    // intervalMs=10, maxAttempts=2 → exhausted at ~30ms incl. jitter. Wait generously.
    await wait(150);

    const row = db
      .prepare("SELECT status FROM discovered_tokens WHERE address = ? COLLATE NOCASE")
      .get(TOKEN);
    assert.ok(row, "token row exists");
    assert.equal(row.status, "expired", "poll timeout must mark token EXPIRED");

    assert.equal(
      hasApproval({ wallet_id: "w-clanker-test", token: TOKEN, spender: "0x" + "f".repeat(40) }),
      false,
      "cached approval rows must be deleted on expiry"
    );
  });
});
