// Unit tests for the Clanker quoter HTTP client.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { _internals, CLANKER_NATIVE_TOKEN, getQuote } from "../../src/util/clankerQuoter.js";

const BASE = {
  chainId: 8453,
  inputToken: CLANKER_NATIVE_TOKEN,
  outputToken: "0x6d0FD889108168111126A068273c8eAf3fce0b07",
  inputAmount: 100000000000000n,
  swapperAccount: "0x56dac66DB126D5ad9ABA4422717D68aC5774f1B8",
};

const mockFetch = (response, { status = 200, throws = null, delayMs = 0 } = {}) => {
  return async (url, opts) => {
    if (delayMs > 0) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        opts?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    if (throws) throw throws;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => typeof response === "string" ? response : JSON.stringify(response),
    };
  };
};

const SUCCESS_PAYLOAD = {
  success: true,
  provider: "kyberswap",
  details: {
    routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    encodedSwapData: "0xe21fd0e9aabb",
    totalGas: 356167,
  },
  txData: {
    to: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    data: "0xe21fd0e9aabb",
    value: "__bigint__:100000000000000",
  },
  outputAmount: "__bigint__:351270975390593116998205",
  inputAmount: "__bigint__:100000000000000",
  activatedFeatures: ["integratorFees"],
};

describe("clankerQuoter.getQuote", () => {
  test("happy path: returns parsed payload with BigInts", async () => {
    const fetchImpl = mockFetch(SUCCESS_PAYLOAD);
    const r = await getQuote({ ...BASE, fetchImpl });
    assert.equal(r.success, true);
    assert.equal(r.provider, "kyberswap");
    assert.equal(r.txData.to, "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5");
    assert.equal(r.txData.data, "0xe21fd0e9aabb");
    // BigInt revival: txData.value, outputAmount, inputAmount
    assert.equal(typeof r.txData.value, "bigint");
    assert.equal(r.txData.value, 100000000000000n);
    assert.equal(typeof r.outputAmount, "bigint");
    assert.equal(r.outputAmount, 351270975390593116998205n);
  });

  test("URL is built with required query params", async () => {
    let capturedUrl;
    const fetchImpl = async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, text: async () => JSON.stringify(SUCCESS_PAYLOAD) };
    };
    await getQuote({ ...BASE, fetchImpl });
    const parsed = new URL(capturedUrl);
    assert.equal(parsed.searchParams.get("chainId"), "8453");
    assert.equal(parsed.searchParams.get("inputToken"), BASE.inputToken);
    assert.equal(parsed.searchParams.get("outputToken"), BASE.outputToken);
    assert.equal(parsed.searchParams.get("inputAmount"), "100000000000000");
    assert.equal(parsed.searchParams.get("swapperAccount"), BASE.swapperAccount);
    assert.equal(parsed.searchParams.get("strategy"), "best", "strategy defaults to 'best'");
  });

  test("non-2xx response returns { success: false, error }", async () => {
    const fetchImpl = mockFetch("rate limited", { status: 429 });
    const r = await getQuote({ ...BASE, fetchImpl });
    assert.equal(r.success, false);
    assert.equal(r.error, "HTTP 429");
  });

  test("invalid JSON returns { success: false, error }", async () => {
    const fetchImpl = mockFetch("not json", { status: 200 });
    const r = await getQuote({ ...BASE, fetchImpl });
    assert.equal(r.success, false);
    assert.equal(r.error, "invalid JSON response");
  });

  test("API returns success=false propagates the error message", async () => {
    const fetchImpl = mockFetch({ success: false, error: "no route" });
    const r = await getQuote({ ...BASE, fetchImpl });
    assert.equal(r.success, false);
    assert.equal(r.error, "no route");
  });

  test("API returns success=true but missing txData → rejected", async () => {
    const fetchImpl = mockFetch({ success: true, provider: "kyberswap" });
    const r = await getQuote({ ...BASE, fetchImpl });
    assert.equal(r.success, false);
    assert.equal(r.error, "response missing txData");
  });

  test("network throw returns { success: false, error: message }", async () => {
    const fetchImpl = mockFetch(null, { throws: new Error("ECONNREFUSED") });
    const r = await getQuote({ ...BASE, fetchImpl });
    assert.equal(r.success, false);
    assert.equal(r.error, "ECONNREFUSED");
  });

  test("timeout returns { success: false, error: 'timeout' }", async () => {
    const fetchImpl = mockFetch(SUCCESS_PAYLOAD, { delayMs: 200 });
    const r = await getQuote({ ...BASE, fetchImpl, timeoutMs: 30 });
    assert.equal(r.success, false);
    assert.equal(r.error, "timeout");
  });

  test("required-field validation rejects missing args without fetching", async () => {
    let called = false;
    const fetchImpl = async () => { called = true; throw new Error("should not be called"); };
    const r1 = await getQuote({ ...BASE, inputToken: null, fetchImpl });
    assert.equal(r1.success, false);
    assert.ok(r1.error.includes("inputToken"));
    const r2 = await getQuote({ ...BASE, swapperAccount: undefined, fetchImpl });
    assert.equal(r2.success, false);
    assert.ok(r2.error.includes("swapperAccount"));
    assert.equal(called, false, "fetch must not be invoked when validation fails");
  });

  test("BigInt reviver: only revives __bigint__-prefixed strings", () => {
    assert.equal(_internals.reviveBigInts("k", "__bigint__:42"), 42n);
    assert.equal(_internals.reviveBigInts("k", "regular string"), "regular string");
    assert.equal(_internals.reviveBigInts("k", 42), 42);
    assert.equal(_internals.reviveBigInts("k", null), null);
  });
});
