import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _setDeps, _resetDeps, simulateRoundtrip } from "../../src/safety/simulation.js";

const TOKEN = "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00";

const PROBE = 100_000_000_000_000n; // 0.0001 ETH

// Fake AlphaRouter `quote()`: returns a route whose .quote.quotient is a configurable BigInt.
const buildQuote = (handler) => async (params) => {
  const out = await handler(params);
  if (typeof out === "string") throw new Error(out); // shorthand to throw "no route" etc.
  return {
    methodParameters: { to: "0xR0", calldata: "0xdeadbeef", value: "0" },
    quote: { quotient: { toString: () => String(out) } },
  };
};

const buildPublicClient = ({ callBehavior = "ok" } = {}) => ({
  call: async () => {
    if (callBehavior === "ok") return { data: "0x" };
    throw new Error(callBehavior);
  },
});

describe("simulateRoundtrip", () => {
  afterEach(_resetDeps);

  test("PENDING when buy quote has no route (subgraph lag)", async () => {
    _setDeps({
      quote: buildQuote(() => "no route found between WETH and target"),
      publicClient: buildPublicClient(),
    });
    const r = await simulateRoundtrip({ token: TOKEN });
    assert.equal(r.safe, false);
    assert.equal(r.pending, true);
    assert.match(r.reasons.join(" "), /AlphaRouter has no route/);
  });

  test("UNSAFE when buy simulation reverts (e.g., max-tx, blacklist modifier)", async () => {
    _setDeps({
      quote: buildQuote(() => 1_000_000n),
      publicClient: buildPublicClient({ callBehavior: "execution reverted: not allowed" }),
    });
    const r = await simulateRoundtrip({ token: TOKEN });
    assert.equal(r.safe, false);
    assert.equal(r.pending, undefined);
    assert.match(r.reasons.join(" "), /buy simulation reverted/);
  });

  test("UNSAFE when sell direction has no route (honeypot pattern)", async () => {
    let call = 0;
    _setDeps({
      quote: buildQuote(({ tokenIn }) => {
        call++;
        // First call: ETH → token returns tokens.
        // Second call: token → ETH throws no route.
        if (tokenIn.symbol === "ETH") return 1_000_000n;
        return "no route found";
      }),
      publicClient: buildPublicClient(),
    });
    const r = await simulateRoundtrip({ token: TOKEN });
    assert.equal(r.safe, false);
    assert.match(r.reasons.join(" "), /sell direction has no route/);
  });

  test("UNSAFE when roundtrip ratio is below threshold (high tax)", async () => {
    // Buy returns 1e9 tokens for the probe. Sell of those tokens returns only 30% of probe back.
    _setDeps({
      quote: buildQuote(({ tokenIn }) => (tokenIn.symbol === "ETH" ? 10n ** 9n : (PROBE * 30n) / 100n)),
      publicClient: buildPublicClient(),
    });
    const r = await simulateRoundtrip({ token: TOKEN });
    assert.equal(r.safe, false);
    assert.ok(r.roundtripPct < 70);
    assert.match(r.reasons.join(" "), /roundtrip recovers only/);
  });

  test("SAFE when roundtrip ratio is at or above threshold", async () => {
    _setDeps({
      quote: buildQuote(({ tokenIn }) => (tokenIn.symbol === "ETH" ? 10n ** 9n : (PROBE * 95n) / 100n)),
      publicClient: buildPublicClient(),
    });
    const r = await simulateRoundtrip({ token: TOKEN });
    assert.equal(r.safe, true);
    assert.ok(r.roundtripPct >= 70);
    assert.equal(r.reasons.length, 0);
  });

  test("UNSAFE when buy quote returns zero tokens", async () => {
    _setDeps({
      quote: buildQuote(({ tokenIn }) => (tokenIn.symbol === "ETH" ? 0n : PROBE)),
      publicClient: buildPublicClient(),
    });
    const r = await simulateRoundtrip({ token: TOKEN });
    assert.equal(r.safe, false);
    assert.match(r.reasons.join(" "), /zero tokens/);
  });

  test("reports roundtripPct and amounts on safe verdict", async () => {
    _setDeps({
      quote: buildQuote(({ tokenIn }) => (tokenIn.symbol === "ETH" ? 5n * 10n ** 8n : (PROBE * 90n) / 100n)),
      publicClient: buildPublicClient(),
    });
    const r = await simulateRoundtrip({ token: TOKEN });
    assert.equal(r.safe, true);
    assert.equal(typeof r.roundtripPct, "number");
    assert.ok(Math.abs(r.roundtripPct - 90) < 0.1);
    assert.equal(r.expectedTokensOutWei, String(5n * 10n ** 8n));
    assert.equal(r.expectedEthBackWei, String((PROBE * 90n) / 100n));
  });
});
