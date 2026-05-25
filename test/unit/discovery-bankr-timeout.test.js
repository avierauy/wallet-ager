// Doppler poll-timeout behavior: when the V4 Quoter never accepts within DOPPLER_POLL_MAX_MS,
// the discovery handler must mark the token EXPIRED and drop any cached approvals so the
// registry doesn't sit on a stale ACTIVE row for up to the sweeper TTL (48h default).
//
// We need the real V4 poller for this — the other discovery-bankr tests run with the poller
// disabled. Each test file gets its own Node process under `node --test`, so deleting the
// env here does not bleed into the disabled-default tests.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

delete process.env.V4_POLLER_DISABLED;
process.env.DOPPLER_POLL_MAX_MS = "100"; // 2 attempts at 5s interval -> exhaust fast

const rpc = await import("../../src/core/rpc.js");
const { db, recordApproval, hasApproval } = await import("../../src/core/db.js");
const { _resetStaticCache } = await import("../../src/core/tokenRegistry.js");
const { handleAirlockCreate } = await import("../../src/discovery/bankr.js");

const WETH = "0x4200000000000000000000000000000000000006";
const TOKEN = "0x" + "a".repeat(40);
const POOL = "0x" + "3".repeat(40);
const INITIALIZER = "0x" + "9".repeat(40);

const originalRead = rpc.publicClient.readContract;
const originalSimulate = rpc.publicClient.simulateContract;
const originalFetch = globalThis.fetch;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("doppler poll timeout", () => {
  beforeEach(() => {
    db.exec("DELETE FROM discovered_tokens; DELETE FROM approvals; DELETE FROM token_safety");
    _resetStaticCache();
    // ERC20 metadata succeeds; V3 probe fails; V4 Quoter always reverts → poll exhausts.
    rpc.publicClient.readContract = async ({ functionName }) => {
      if (functionName === "symbol") return "DOPPLER";
      if (functionName === "decimals") return 18;
      throw new Error("not a V3 pool");
    };
    rpc.publicClient.simulateContract = async () => { throw new Error("PoolNotInitialized"); };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  });
  afterEach(() => {
    rpc.publicClient.readContract = originalRead;
    rpc.publicClient.simulateContract = originalSimulate;
    globalThis.fetch = originalFetch;
  });

  test("poll timeout marks token EXPIRED and drops cached approvals", async () => {
    // Seed an approval row so we can confirm the cleanup branch runs.
    recordApproval({
      wallet_id: "w-doppler-test",
      token: TOKEN,
      spender: "0x" + "f".repeat(40),
      tx_hash: "0x" + "0".repeat(64),
      granted_at: Date.now(),
    });
    assert.equal(
      hasApproval({ wallet_id: "w-doppler-test", token: TOKEN, spender: "0x" + "f".repeat(40) }),
      true,
      "approval seeded for cleanup assertion"
    );

    await handleAirlockCreate({
      asset: TOKEN, numeraire: WETH, initializer: INITIALIZER, poolOrHook: POOL,
    });

    // Wait long enough for ~2 poll attempts (intervalMs=5000 default × 2 + jitter). The
    // poller schedules timers asynchronously; we need real wall-clock time for it to fire.
    // DOPPLER_POLL_MAX_MS=100 caps maxAttempts at 1, so a single failed probe triggers timeout.
    await wait(200);

    const row = db
      .prepare("SELECT status FROM discovered_tokens WHERE address = ? COLLATE NOCASE")
      .get(TOKEN);
    assert.ok(row, "token row exists");
    assert.equal(row.status, "expired", "poll timeout must mark token EXPIRED");

    assert.equal(
      hasApproval({ wallet_id: "w-doppler-test", token: TOKEN, spender: "0x" + "f".repeat(40) }),
      false,
      "cached approval rows must be deleted on expiry"
    );
  });
});
