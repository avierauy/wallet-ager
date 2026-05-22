// Tests for startV4Poll — the background retry loop that waits for Clanker/Doppler MEV
// windows to expire. We use shrunken intervals so the suite stays fast.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
// v4Poller respects V4_POLLER_DISABLED for the discovery tests; here we explicitly enable it
// so we can exercise the actual retry loop.
delete process.env.V4_POLLER_DISABLED;
import { startV4Poll } from "../../src/discovery/v4Poller.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("startV4Poll", () => {
  test("calls onReady on the first successful probe", async () => {
    let probeCalls = 0;
    let onReadyArg = null;
    startV4Poll({
      probe: async () => { probeCalls++; return { ok: true }; },
      onReady: (r, attempts) => { onReadyArg = { r, attempts }; },
      onTimeout: () => { assert.fail("should not timeout"); },
      options: { intervalMs: 10, jitterMs: 0, maxAttempts: 5 },
    });
    await wait(30);
    assert.equal(probeCalls, 1, "first probe should succeed");
    assert.deepEqual(onReadyArg, { r: { ok: true }, attempts: 1 });
  });

  test("retries until probe returns truthy", async () => {
    let probeCalls = 0;
    let onReadyAt = 0;
    startV4Poll({
      probe: async () => {
        probeCalls++;
        return probeCalls >= 3 ? { done: probeCalls } : null;
      },
      onReady: (_, attempts) => { onReadyAt = attempts; },
      onTimeout: () => { assert.fail("should not timeout"); },
      options: { intervalMs: 10, jitterMs: 0, maxAttempts: 10 },
    });
    await wait(80);
    assert.equal(probeCalls, 3);
    assert.equal(onReadyAt, 3);
  });

  test("calls onTimeout after maxAttempts exhausted", async () => {
    let probeCalls = 0;
    let timedOutAt = 0;
    startV4Poll({
      probe: async () => { probeCalls++; return null; },
      onReady: () => { assert.fail("should not succeed"); },
      onTimeout: (attempts) => { timedOutAt = attempts; },
      options: { intervalMs: 5, jitterMs: 0, maxAttempts: 4 },
    });
    await wait(80);
    assert.equal(probeCalls, 4);
    assert.equal(timedOutAt, 4);
  });

  test("swallows probe errors and keeps polling", async () => {
    let probeCalls = 0;
    let onReadyArg = null;
    startV4Poll({
      probe: async () => {
        probeCalls++;
        if (probeCalls === 1) throw new Error("rpc transient");
        if (probeCalls === 2) return null;
        return { recovered: true };
      },
      onReady: (r) => { onReadyArg = r; },
      onTimeout: () => { assert.fail("should not timeout"); },
      options: { intervalMs: 5, jitterMs: 0, maxAttempts: 6 },
    });
    await wait(80);
    assert.equal(probeCalls, 3);
    assert.deepEqual(onReadyArg, { recovered: true });
  });

  test("stop() cancels pending retries", async () => {
    let probeCalls = 0;
    let onReadyOrTimeout = false;
    const stop = startV4Poll({
      probe: async () => { probeCalls++; return null; },
      onReady: () => { onReadyOrTimeout = "ready"; },
      onTimeout: () => { onReadyOrTimeout = "timeout"; },
      options: { intervalMs: 20, jitterMs: 0, maxAttempts: 10 },
    });
    await wait(15); // let first probe run
    stop();
    await wait(80);
    assert.equal(onReadyOrTimeout, false, "stopped poll must not invoke callbacks");
    assert.ok(probeCalls <= 2, "should stop within an iteration or two");
  });
});
