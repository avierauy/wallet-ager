import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../src/core/db.js";
import { checkToken, SAFETY_THRESHOLDS } from "../../src/safety/honeypot.js";

const reset = () => db.exec("DELETE FROM token_safety");

const originalFetch = globalThis.fetch;
const stubFetch = (responder) => {
  globalThis.fetch = async (url) => {
    const body = await responder(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
};
const restoreFetch = () => {
  globalThis.fetch = originalFetch;
};

const safeResponse = {
  simulationSuccess: true,
  honeypotResult: { isHoneypot: false },
  simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0 },
  summary: { riskLevel: 1 },
};

const honeypotResponse = {
  simulationSuccess: true,
  honeypotResult: { isHoneypot: true, honeypotReason: "blacklisted seller" },
  simulationResult: { buyTax: 0, sellTax: 100, transferTax: 0 },
  summary: { riskLevel: 9 },
};

const highSellTaxResponse = {
  simulationSuccess: true,
  honeypotResult: { isHoneypot: false },
  simulationResult: { buyTax: 0, sellTax: 25, transferTax: 0 },
  summary: { riskLevel: 5 },
};

describe("checkToken (honeypot.is wrapper)", () => {
  beforeEach(reset);
  afterEach(restoreFetch);

  test("returns safe=true for a clean token", async () => {
    stubFetch(() => safeResponse);
    const result = await checkToken("0xaaaa");
    assert.equal(result.safe, true);
    assert.equal(result.cached, false);
    assert.equal(result.reasons.length, 0);
  });

  test("flags honeypots as unsafe with reason", async () => {
    stubFetch(() => honeypotResponse);
    const result = await checkToken("0xbbbb");
    assert.equal(result.safe, false);
    assert.ok(result.reasons.some((r) => r.includes("honeypot")));
    assert.equal(result.isHoneypot, true);
  });

  test(`flags sellTax > ${SAFETY_THRESHOLDS.maxSellTaxPct}% as unsafe`, async () => {
    stubFetch(() => highSellTaxResponse);
    const result = await checkToken("0xcccc");
    assert.equal(result.safe, false);
    assert.ok(result.reasons.some((r) => r.includes("sellTax")));
  });

  test("uses SQLite cache on second call within TTL", async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      return safeResponse;
    });
    const first = await checkToken("0xdddd");
    const second = await checkToken("0xdddd");
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
  });

  test("fail-safe: returns unsafe when the API is down", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "down" });
    const result = await checkToken("0xeeee");
    assert.equal(result.safe, false);
    assert.ok(result.reasons.some((r) => r.includes("unreachable")));
  });
});
