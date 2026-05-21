import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isTransientError, withRetry } from "../../src/util/retry.js";

describe("isTransientError", () => {
  test("classifies allowance race as transient", () => {
    assert.equal(isTransientError({ message: "execution reverted: ERC20: insufficient allowance" }), true);
  });

  test("classifies nonce errors as transient", () => {
    assert.equal(isTransientError({ message: "nonce too low" }), true);
    assert.equal(isTransientError({ message: "nonce has already been used" }), true);
    assert.equal(isTransientError({ shortMessage: "known transaction: …" }), true);
  });

  test("classifies mempool/gas churn as transient", () => {
    assert.equal(isTransientError({ message: "replacement transaction underpriced" }), true);
    assert.equal(isTransientError({ message: "transaction underpriced" }), true);
  });

  test("classifies RPC/network errors as transient", () => {
    assert.equal(isTransientError({ message: "fetch failed" }), true);
    assert.equal(isTransientError({ message: "ECONNRESET" }), true);
    assert.equal(isTransientError({ message: "request timed out" }), true);
    assert.equal(isTransientError({ message: "HTTP 503 service unavailable" }), true);
  });

  test("classifies real reverts as NON-transient (safety)", () => {
    assert.equal(isTransientError({ message: "execution reverted: TooLittleReceived" }), false);
    assert.equal(isTransientError({ message: "insufficient funds for gas * price + value" }), false);
    assert.equal(isTransientError({ message: "execution reverted: V3TooLittleReceived()" }), false);
    assert.equal(isTransientError({ message: "honeypot detected" }), false);
  });

  test("walks nested causes (viem wraps deeply)", () => {
    const err = { message: "wrapped", cause: { message: "outer", cause: { message: "nonce too low" } } };
    assert.equal(isTransientError(err), true);
  });

  test("guards against circular cause chains", () => {
    const err = { message: "outer" };
    err.cause = err; // self-referential
    assert.equal(isTransientError(err), false);
  });

  test("returns false for null/undefined", () => {
    assert.equal(isTransientError(null), false);
    assert.equal(isTransientError(undefined), false);
  });

  test("handles plain Error and string-form errors", () => {
    assert.equal(isTransientError(new Error("nonce too low")), true);
    assert.equal(isTransientError("fetch failed"), true);
    assert.equal(isTransientError("real revert"), false);
  });
});

describe("withRetry", () => {
  test("returns the value on first success and does not retry", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 42; }, { delays: [1] });
    assert.equal(result, 42);
    assert.equal(calls, 1);
  });

  test("retries transient failures up to maxAttempts", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => { calls++; if (calls < 3) throw new Error("nonce too low"); return "ok"; },
      { delays: [1, 1, 1] }
    );
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  test("throws immediately on non-transient errors", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new Error("TooLittleReceived"); }, { delays: [1, 1] }),
      /TooLittleReceived/
    );
    assert.equal(calls, 1);
  });

  test("throws after exhausting maxAttempts on transient errors", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new Error("nonce too low"); }, { maxAttempts: 3, delays: [1, 1] }),
      /nonce too low/
    );
    assert.equal(calls, 3);
  });

  test("invokes onRetry with attempt + err + nextDelayMs", async () => {
    const events = [];
    await assert.rejects(
      withRetry(
        async () => { throw new Error("fetch failed"); },
        {
          maxAttempts: 3,
          delays: [1, 2],
          onRetry: (e) => events.push({ attempt: e.attempt, msg: e.err.message, nextDelayMs: e.nextDelayMs }),
        }
      )
    );
    assert.deepEqual(events, [
      { attempt: 1, msg: "fetch failed", nextDelayMs: 1 },
      { attempt: 2, msg: "fetch failed", nextDelayMs: 2 },
    ]);
  });

  test("uses the last delay value when attempts exceed the delays array", async () => {
    let calls = 0;
    const seenDelays = [];
    await assert.rejects(
      withRetry(
        async () => { calls++; throw new Error("nonce too low"); },
        {
          maxAttempts: 5,
          delays: [1, 2], // only two entries; later retries should reuse `2`
          onRetry: (e) => seenDelays.push(e.nextDelayMs),
        }
      )
    );
    assert.deepEqual(seenDelays, [1, 2, 2, 2]);
    assert.equal(calls, 5);
  });

  test("respects a custom isTransient predicate", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => { calls++; throw new Error("nonce too low"); },
        { delays: [1], isTransient: () => false }
      )
    );
    assert.equal(calls, 1);
  });

  test("rejects maxAttempts < 1", async () => {
    await assert.rejects(withRetry(async () => 1, { maxAttempts: 0 }), /maxAttempts/);
  });
});
