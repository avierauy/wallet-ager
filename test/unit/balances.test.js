import { describe, test } from "node:test";
import assert from "node:assert/strict";

const rpcModule = await import("../../src/core/rpc.js");
const { fetchBalances } = await import("../../src/core/balances.js");

const ACCOUNT = { address: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" };
const TOKEN_A = { address: "0x1111111111111111111111111111111111111111", decimals: 18, symbol: "A" };
const TOKEN_B = { address: "0x2222222222222222222222222222222222222222", decimals: 18, symbol: "B" };

describe("fetchBalances", () => {
  test("returns native + per-token map, lowercased keys", async () => {
    rpcModule.publicClient.getBalance = async () => 12345n;
    rpcModule.publicClient.multicall = async () => [
      { status: "success", result: 100n },
      { status: "success", result: 200n },
    ];
    const { native, byToken } = await fetchBalances({ account: ACCOUNT, tokens: [TOKEN_A, TOKEN_B] });
    assert.equal(native, 12345n);
    assert.equal(byToken[TOKEN_A.address.toLowerCase()], 100n);
    assert.equal(byToken[TOKEN_B.address.toLowerCase()], 200n);
  });

  test("treats failed multicall entries as 0", async () => {
    rpcModule.publicClient.getBalance = async () => 0n;
    rpcModule.publicClient.multicall = async () => [
      { status: "failure", error: new Error("boom") },
      { status: "success", result: 42n },
    ];
    const { byToken } = await fetchBalances({ account: ACCOUNT, tokens: [TOKEN_A, TOKEN_B] });
    assert.equal(byToken[TOKEN_A.address.toLowerCase()], 0n);
    assert.equal(byToken[TOKEN_B.address.toLowerCase()], 42n);
  });

  test("skips multicall when no tokens provided", async () => {
    rpcModule.publicClient.getBalance = async () => 99n;
    let called = false;
    rpcModule.publicClient.multicall = async () => { called = true; return []; };
    const { native, byToken } = await fetchBalances({ account: ACCOUNT, tokens: [] });
    assert.equal(native, 99n);
    assert.deepEqual(byToken, {});
    assert.equal(called, false);
  });
});
