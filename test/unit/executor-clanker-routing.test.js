// Integration test for the v13.14 dispatcher: confirms Clanker-source tokens go through
// clankerAggregator and non-Clanker sources skip it. Runs with DRY_RUN=false to exercise
// the actual dispatch branch (the default test env has DRY_RUN=true which short-circuits).
//
// Other dispatch branches (uniswap UR, bankr, virtuals) are covered by their own adapter
// tests + the existing executor.test.js. This file is only about the new source-based
// routing introduced in v13.14.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.DRY_RUN = "false";

const { db } = await import("../../src/core/db.js");
const { executeAction } = await import("../../src/core/executor.js");
const clankerAggregator = await import("../../src/adapters/clankerAggregator.js");

const WALLET = {
  id: "w-routing-test",
  account: { address: "0x56dac66DB126D5ad9ABA4422717D68aC5774f1B8" },
  profile: {},
};
const TOKEN = {
  address: "0x6d0FD889108168111126A068273c8eAf3fce0b07",
  symbol: "CLNK",
  decimals: 18,
};

const SUCCESS_QUOTE = {
  success: true,
  provider: "kyberswap",
  txData: {
    to: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    data: "0xe21fd0e9aabb",
    value: 1000n,
  },
  outputAmount: 999999n,
};

const setupClankerMocks = ({ quoteResult, simulationReverts = false } = {}) => {
  let quoteCallCount = 0;
  clankerAggregator._setDeps({
    getQuote: async () => {
      quoteCallCount++;
      return quoteResult;
    },
    publicClient: {
      readContract: async () => 0n,
      waitForTransactionReceipt: async () => ({ status: "success" }),
      // v13.16: clankerAggregator pre-simulates via eth_call before broadcasting. Tests
      // pass simulationReverts:true to verify the dispatcher's UR fallback triggers.
      call: async () => {
        if (simulationReverts) {
          const err = new Error("execution reverted: Return amount is not enough");
          err.shortMessage = "Execution reverted with reason: Return amount is not enough.";
          throw err;
        }
        return { data: "0x" };
      },
    },
    walletClientFor: () => ({
      writeContract: async () => "0xappr0v3",
      sendTransaction: async () => "0xswaphash",
    }),
  });
  return { getQuoteCallCount: () => quoteCallCount };
};

describe("executor: Clanker-source routing", () => {
  beforeEach(() => {
    db.exec("DELETE FROM trades; DELETE FROM approvals; DELETE FROM token_safety");
  });
  afterEach(() => {
    clankerAggregator._resetDeps();
  });

  test("clanker-* source token → routed through clankerAggregator (quoter called)", async () => {
    const { getQuoteCallCount } = setupClankerMocks({ quoteResult: SUCCESS_QUOTE });

    const plan = {
      dex: "uniswap",
      side: "buy",
      token: { ...TOKEN, source: "clanker-v4" },
      amountInWei: 1000n,
      slippageBps: 50,
    };
    const result = await executeAction({ wallet: WALLET, plan });

    assert.equal(result.status, "submitted", "trade marked submitted");
    assert.equal(result.txHash, "0xswaphash");
    assert.equal(getQuoteCallCount(), 1, "Clanker quoter must be called exactly once");
  });

  test("non-clanker source (uniswap-v3) → skips clankerAggregator entirely", async () => {
    const { getQuoteCallCount } = setupClankerMocks({ quoteResult: SUCCESS_QUOTE });

    const plan = {
      dex: "uniswap",
      side: "buy",
      token: { ...TOKEN, source: "uniswap-v3" }, // generic uniswap discovery, not Clanker
      amountInWei: 1000n,
      slippageBps: 50,
    };
    // UR path will fail here (no RPC mocking for uniswap adapter) — catch + verify routing.
    let urReached = false;
    try {
      await executeAction({ wallet: WALLET, plan });
    } catch (err) {
      urReached = true;
    }
    // The point of this test isn't to verify UR works (covered elsewhere) — it's to verify
    // that the clanker quoter was NOT called for non-Clanker sources. Either UR succeeds or
    // throws; what matters is that quoteCallCount stayed at zero.
    assert.equal(getQuoteCallCount(), 0, "Clanker quoter must NOT be called for non-Clanker source");
  });

  test("doppler-* source token → skips clankerAggregator (only clanker-* uses it)", async () => {
    const { getQuoteCallCount } = setupClankerMocks({ quoteResult: SUCCESS_QUOTE });

    const plan = {
      dex: "uniswap",
      side: "buy",
      token: { ...TOKEN, source: "doppler-bankr" },
      amountInWei: 1000n,
      slippageBps: 50,
    };
    try { await executeAction({ wallet: WALLET, plan }); } catch {}
    assert.equal(getQuoteCallCount(), 0, "Doppler tokens must use existing UR path, not Clanker API");
  });

  test("Clanker API failure → falls back to UR path (quoter called once, then fallthrough)", async () => {
    // getQuote returns failure → adapter throws "clanker-api: <error>" → dispatcher catches +
    // falls through to UR. UR will then fail (no RPC mocking), but we've verified the fallback
    // was reached because the test doesn't throw at the clanker-api error.
    const { getQuoteCallCount } = setupClankerMocks({
      quoteResult: { success: false, error: "timeout" },
    });

    const plan = {
      dex: "uniswap",
      side: "buy",
      token: { ...TOKEN, source: "clanker-v4" },
      amountInWei: 1000n,
      slippageBps: 50,
    };
    let threw = null;
    try { await executeAction({ wallet: WALLET, plan }); } catch (err) { threw = err; }
    assert.equal(getQuoteCallCount(), 1, "quoter called once before falling back");
    // The fallback to UR will throw because we haven't mocked the uniswap adapter — that's
    // expected. The error message should NOT contain "clanker-api:" prefix because the
    // dispatcher swallowed that and proceeded to UR.
    if (threw) {
      assert.ok(
        !String(threw.message).includes("clanker-api:"),
        "fallback consumed the clanker-api error; UR errors propagate independently"
      );
    }
  });

  test("v13.16: Clanker simulation revert → also falls back to UR (slippage protection)", async () => {
    // The quoter returns success (calldata built), but the eth_call simulation reverts
    // (e.g. KyberSwap slippage). The adapter throws "clanker-api: simulation reverted ..."
    // which matches isClankerApiError → dispatcher falls back to UR.
    const { getQuoteCallCount } = setupClankerMocks({
      quoteResult: SUCCESS_QUOTE,
      simulationReverts: true,
    });

    const plan = {
      dex: "uniswap",
      side: "buy",
      token: { ...TOKEN, source: "clanker-v4" },
      amountInWei: 1000n,
      slippageBps: 50,
    };
    let threw = null;
    try { await executeAction({ wallet: WALLET, plan }); } catch (err) { threw = err; }
    assert.equal(getQuoteCallCount(), 1, "quoter still called once");
    // No revert message should bubble up with clanker-api prefix — dispatcher caught it
    // and fell through to UR (which will then fail in this mock, propagating its own error).
    if (threw) {
      assert.ok(
        !String(threw.message).includes("clanker-api:"),
        "simulation-revert error consumed by fallback path"
      );
    }
  });

  test("Clanker API success on SELL → approves the chosen router (not Permit2)", async () => {
    const { getQuoteCallCount } = setupClankerMocks({ quoteResult: SUCCESS_QUOTE });

    const plan = {
      dex: "uniswap",
      side: "sell",
      token: { ...TOKEN, source: "clanker-v4" },
      amountInWei: 1000n,
      slippageBps: 50,
    };
    const result = await executeAction({ wallet: WALLET, plan });
    assert.equal(result.status, "submitted");
    assert.equal(getQuoteCallCount(), 1);
    // Approval was recorded against the KyberSwap router (txData.to), not Permit2.
    const row = db.prepare(
      "SELECT spender FROM approvals WHERE wallet_id = ? AND lower(token) = lower(?)"
    ).get(WALLET.id, TOKEN.address);
    assert.ok(row, "sell recorded approval");
    assert.equal(row.spender.toLowerCase(), "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
      "approval went to the router Clanker picked, not Permit2");
  });
});
