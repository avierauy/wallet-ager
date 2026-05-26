// Unit tests for the Clanker aggregator adapter.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { maxUint256 } from "viem";
import { db } from "../../src/core/db.js";
import {
  _resetDeps, _setDeps, buyExactEthForToken, sellExactTokenForEth,
} from "../../src/adapters/clankerAggregator.js";

const WALLET = {
  id: "w-test",
  account: { address: "0x56dac66DB126D5ad9ABA4422717D68aC5774f1B8" },
};
const TOKEN = {
  address: "0x6d0FD889108168111126A068273c8eAf3fce0b07",
  symbol: "CLNK",
  decimals: 18,
};

const ROUTER_KYBER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";

const successQuote = ({ value, outputAmount }) => ({
  success: true,
  provider: "kyberswap",
  txData: { to: ROUTER_KYBER, data: "0xe21fd0e9aabb", value },
  outputAmount,
});

// Builds a mock publicClient/walletClient pair with introspection.
const buildMockClients = ({ allowance = 0n } = {}) => {
  const calls = { sentTx: [], approveTx: [], allowanceReads: [], receipts: [] };
  const publicClient = {
    readContract: async ({ functionName, args }) => {
      if (functionName === "allowance") {
        calls.allowanceReads.push(args);
        // First read: configured value. Second read (after approve): saturated.
        if (calls.allowanceReads.length === 1) return allowance;
        return maxUint256;
      }
      throw new Error("unexpected readContract: " + functionName);
    },
    waitForTransactionReceipt: async ({ hash }) => {
      calls.receipts.push(hash);
      return { status: "success" };
    },
  };
  const walletClient = {
    writeContract: async ({ functionName, args }) => {
      calls.approveTx.push({ functionName, args });
      return "0xappr0v3";
    },
    sendTransaction: async (tx) => {
      calls.sentTx.push(tx);
      return "0xswaphash";
    },
  };
  return { publicClient, walletClient, calls };
};

describe("clankerAggregator", () => {
  beforeEach(() => {
    db.exec("DELETE FROM approvals");
    _resetDeps();
  });
  afterEach(() => _resetDeps());

  test("buy: calls quoter with ETH sentinel + outputToken + submits txData", async () => {
    const captured = {};
    const { publicClient, walletClient, calls } = buildMockClients();
    _setDeps({
      getQuote: async (args) => {
        Object.assign(captured, args);
        return successQuote({ value: 12345n, outputAmount: 9999999999n });
      },
      publicClient,
      walletClientFor: () => walletClient,
    });

    const r = await buyExactEthForToken({ wallet: WALLET, tokenOut: TOKEN, amountInWei: 12345n });

    assert.equal(captured.inputToken, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
    assert.equal(captured.outputToken, TOKEN.address);
    assert.equal(captured.inputAmount, 12345n);
    assert.equal(captured.swapperAccount, WALLET.account.address);

    assert.equal(calls.sentTx.length, 1);
    assert.equal(calls.sentTx[0].to, ROUTER_KYBER);
    assert.equal(calls.sentTx[0].data, "0xe21fd0e9aabb");
    assert.equal(calls.sentTx[0].value, 12345n);

    assert.equal(r.txHash, "0xswaphash");
    assert.equal(r.provider, "kyberswap");
    // synthRoute exposes outputAmount via route.quote.quotient.toString()
    assert.equal(r.route.quote.quotient.toString(), "9999999999");
    // buy never approves
    assert.equal(calls.approveTx.length, 0);
  });

  test("buy: quoter failure surfaces as thrown Error", async () => {
    const { publicClient, walletClient } = buildMockClients();
    _setDeps({
      getQuote: async () => ({ success: false, error: "no route" }),
      publicClient,
      walletClientFor: () => walletClient,
    });

    await assert.rejects(
      buyExactEthForToken({ wallet: WALLET, tokenOut: TOKEN, amountInWei: 1n }),
      /clanker-api: no route/
    );
  });

  test("sell: first-time approves the router from txData.to, then submits", async () => {
    const { publicClient, walletClient, calls } = buildMockClients({ allowance: 0n });
    _setDeps({
      getQuote: async () => successQuote({ value: 0n, outputAmount: 50000n }),
      publicClient,
      walletClientFor: () => walletClient,
    });

    const r = await sellExactTokenForEth({ wallet: WALLET, tokenIn: TOKEN, amountInWei: 100n });

    assert.equal(calls.approveTx.length, 1, "first-time sell must approve");
    assert.equal(calls.approveTx[0].functionName, "approve");
    assert.equal(calls.approveTx[0].args[0], ROUTER_KYBER, "spender = chosen router");
    assert.equal(calls.approveTx[0].args[1], maxUint256, "amount = max");
    assert.equal(calls.sentTx.length, 1, "swap submitted after approval");
    assert.equal(calls.receipts.length, 1, "waited for approve receipt");

    // Approval recorded in DB
    const row = db.prepare(
      "SELECT * FROM approvals WHERE wallet_id = ? AND lower(token) = lower(?) AND lower(spender) = lower(?)"
    ).get(WALLET.id, TOKEN.address, ROUTER_KYBER);
    assert.ok(row, "approval recorded for (wallet, token, router)");
    assert.equal(row.tx_hash, "0xappr0v3");
    assert.equal(r.txHash, "0xswaphash");
  });

  test("sell: DB-cached approval skips re-approve", async () => {
    db.prepare(`
      INSERT INTO approvals (wallet_id, token, spender, tx_hash, granted_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(WALLET.id, TOKEN.address, ROUTER_KYBER, "0xprev", Date.now());

    const { publicClient, walletClient, calls } = buildMockClients({ allowance: 0n });
    _setDeps({
      getQuote: async () => successQuote({ value: 0n, outputAmount: 100n }),
      publicClient,
      walletClientFor: () => walletClient,
    });

    await sellExactTokenForEth({ wallet: WALLET, tokenIn: TOKEN, amountInWei: 50n });

    assert.equal(calls.approveTx.length, 0, "cached approval skips approve");
    assert.equal(calls.allowanceReads.length, 0, "cached approval skips on-chain read");
    assert.equal(calls.sentTx.length, 1, "swap still submitted");
  });

  test("sell: on-chain allowance already maxed → records + skips approve", async () => {
    const { publicClient, walletClient, calls } = buildMockClients({ allowance: maxUint256 });
    _setDeps({
      getQuote: async () => successQuote({ value: 0n, outputAmount: 100n }),
      publicClient,
      walletClientFor: () => walletClient,
    });

    await sellExactTokenForEth({ wallet: WALLET, tokenIn: TOKEN, amountInWei: 50n });

    assert.equal(calls.approveTx.length, 0, "already-maxed allowance skips approve");
    assert.equal(calls.allowanceReads.length, 1, "still does on-chain check first time");
    const row = db.prepare(
      "SELECT * FROM approvals WHERE wallet_id = ? AND lower(spender) = lower(?)"
    ).get(WALLET.id, ROUTER_KYBER);
    assert.ok(row, "records DB row even when on-chain already maxed");
  });

  test("sell: quoter failure surfaces and no approval/swap submitted", async () => {
    const { publicClient, walletClient, calls } = buildMockClients();
    _setDeps({
      getQuote: async () => ({ success: false, error: "timeout" }),
      publicClient,
      walletClientFor: () => walletClient,
    });

    await assert.rejects(
      sellExactTokenForEth({ wallet: WALLET, tokenIn: TOKEN, amountInWei: 1n }),
      /clanker-api: timeout/
    );
    assert.equal(calls.approveTx.length, 0);
    assert.equal(calls.sentTx.length, 0);
  });
});
