import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { waitForAllowance } from "../../src/util/waitForAllowance.js";

const OWNER = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const TOKEN = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
const SPENDER = "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc";

// Build a fake client whose readContract returns successive values from a queue.
const buildClient = (sequence) => {
  let calls = 0;
  return {
    readContract: async () => {
      const v = sequence[Math.min(calls, sequence.length - 1)];
      calls++;
      return v;
    },
    get calls() { return calls; },
  };
};

describe("waitForAllowance", () => {
  test("returns 0 immediately when atLeast is 0n", async () => {
    let called = false;
    const client = { readContract: async () => { called = true; return 0n; } };
    const result = await waitForAllowance({ owner: OWNER, token: TOKEN, spender: SPENDER, atLeast: 0n, client });
    assert.equal(result, 0n);
    assert.equal(called, false);
  });

  test("returns on the first poll when allowance already meets atLeast", async () => {
    const client = buildClient([10n ** 18n]);
    const result = await waitForAllowance({
      owner: OWNER, token: TOKEN, spender: SPENDER,
      atLeast: 10n ** 18n, client, pollMs: 1, timeoutMs: 5_000,
    });
    assert.equal(result, 10n ** 18n);
    assert.equal(client.calls, 1);
  });

  test("polls multiple times until allowance reaches atLeast", async () => {
    const client = buildClient([0n, 0n, 5n, 100n]);
    const result = await waitForAllowance({
      owner: OWNER, token: TOKEN, spender: SPENDER,
      atLeast: 100n, client, pollMs: 1, timeoutMs: 5_000,
    });
    assert.equal(result, 100n);
    assert.equal(client.calls, 4);
  });

  test("returns when allowance overshoots atLeast", async () => {
    const client = buildClient([10n ** 30n]);
    const result = await waitForAllowance({
      owner: OWNER, token: TOKEN, spender: SPENDER,
      atLeast: 100n, client, pollMs: 1, timeoutMs: 5_000,
    });
    assert.equal(result, 10n ** 30n);
  });

  test("throws on timeout with the last observed allowance in the message", async () => {
    const client = buildClient([0n, 7n, 12n]);
    await assert.rejects(
      waitForAllowance({
        owner: OWNER, token: TOKEN, spender: SPENDER,
        atLeast: 100n, client, pollMs: 5, timeoutMs: 25,
      }),
      /stayed at \d+ after \d+ms \(needed 100\)/
    );
  });
});
