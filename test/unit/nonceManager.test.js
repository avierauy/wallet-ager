import { describe, test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// We stub the publicClient before importing the module under test so that ensure() reads
// from our fake chain instead of hitting an RPC.
const fakePending = { count: 7 };
const rpcModule = await import("../../src/core/rpc.js");
rpcModule.publicClient.getTransactionCount = async () => fakePending.count;

const { reserveNonce, releaseNonce, resyncNonce, withWalletLock, _clearState, getState } =
  await import("../../src/core/nonceManager.js");

const ACCOUNT_A = { address: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" };
const ACCOUNT_B = { address: "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb" };

describe("nonceManager", () => {
  beforeEach(() => {
    _clearState();
    fakePending.count = 7;
  });

  test("first reserveNonce returns the chain pending nonce", async () => {
    const n = await reserveNonce(ACCOUNT_A);
    assert.equal(n, 7);
  });

  test("subsequent reservations increment locally", async () => {
    const a = await reserveNonce(ACCOUNT_A);
    const b = await reserveNonce(ACCOUNT_A);
    const c = await reserveNonce(ACCOUNT_A);
    assert.deepEqual([a, b, c], [7, 8, 9]);
  });

  test("releaseNonce rolls back the last nonce when not broadcast", async () => {
    const n = await reserveNonce(ACCOUNT_A);
    releaseNonce(ACCOUNT_A, n, { broadcast: false });
    const next = await reserveNonce(ACCOUNT_A);
    assert.equal(next, n);
  });

  test("releaseNonce does NOT roll back if other nonces are in flight", async () => {
    const a = await reserveNonce(ACCOUNT_A);
    const b = await reserveNonce(ACCOUNT_A);
    releaseNonce(ACCOUNT_A, a, { broadcast: false }); // can't safely rollback past b
    const next = await reserveNonce(ACCOUNT_A);
    assert.equal(next, b + 1);
  });

  test("two wallets advance independently", async () => {
    const a1 = await reserveNonce(ACCOUNT_A);
    const b1 = await reserveNonce(ACCOUNT_B);
    const a2 = await reserveNonce(ACCOUNT_A);
    assert.deepEqual([a1, a2, b1], [7, 8, 7]);
  });

  test("resyncNonce jumps forward when chain is ahead", async () => {
    await reserveNonce(ACCOUNT_A); // local = 8
    fakePending.count = 20;
    const after = await resyncNonce(ACCOUNT_A);
    assert.equal(after, 20);
    const next = await reserveNonce(ACCOUNT_A);
    assert.equal(next, 20);
  });

  test("resyncNonce does NOT regress when chain is behind (in-flight not yet mined)", async () => {
    await reserveNonce(ACCOUNT_A); // local 7→8
    await reserveNonce(ACCOUNT_A); // local 8→9
    fakePending.count = 7; // chain hasn't seen our pending txs yet
    const after = await resyncNonce(ACCOUNT_A);
    assert.equal(after, 9);
  });

  test("withWalletLock serializes operations on the same wallet", async () => {
    const order = [];
    const slow = withWalletLock(ACCOUNT_A, async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("slow");
    });
    const fast = withWalletLock(ACCOUNT_A, async () => {
      order.push("fast");
    });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ["slow", "fast"]);
  });

  test("withWalletLock allows different wallets to run in parallel", async () => {
    const start = Date.now();
    await Promise.all([
      withWalletLock(ACCOUNT_A, () => new Promise((r) => setTimeout(r, 50))),
      withWalletLock(ACCOUNT_B, () => new Promise((r) => setTimeout(r, 50))),
    ]);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 90, `expected ~50ms in parallel, took ${elapsed}ms`);
  });
});
