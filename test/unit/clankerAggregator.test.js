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
// `simulationReverts`: makes publicClient.call (the pre-flight check) throw.
// `swapRevertsOnChain`: simulation passes, broadcast lands, but receipt status=reverted (v13.17).
const buildMockClients = ({
  allowance = 0n, simulationReverts = false, swapRevertsOnChain = false,
} = {}) => {
  const calls = { sentTx: [], approveTx: [], allowanceReads: [], receipts: [], simulations: [] };
  const publicClient = {
    readContract: async ({ functionName, args }) => {
      if (functionName === "allowance") {
        calls.allowanceReads.push(args);
        if (calls.allowanceReads.length === 1) return allowance;
        return maxUint256;
      }
      throw new Error("unexpected readContract: " + functionName);
    },
    waitForTransactionReceipt: async ({ hash }) => {
      calls.receipts.push(hash);
      // Swap txs (0xswaphash) honor swapRevertsOnChain; approve txs (0xappr0v3) always succeed
      const isSwap = hash === "0xswaphash";
      if (isSwap && swapRevertsOnChain) return { status: "reverted", gasUsed: 50000n };
      return { status: "success", gasUsed: 100000n };
    },
    call: async (params) => {
      calls.simulations.push(params);
      if (simulationReverts) {
        const err = new Error("execution reverted: Return amount is not enough");
        err.shortMessage = "Execution reverted with reason: Return amount is not enough.";
        throw err;
      }
      return { data: "0x" };
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
    // v13.17: now we wait for BOTH the approve receipt AND the swap receipt
    assert.equal(calls.receipts.length, 2, "waited for approve + swap receipts");

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

  test("buy: pre-simulation reverts → throws clanker-api: error, NO broadcast", async () => {
    // v13.16 — slippage-tight calldata reverts on eth_call before we waste gas. The thrown
    // error has the "clanker-api:" prefix so the dispatcher falls back to UR.
    const { publicClient, walletClient, calls } = buildMockClients({ simulationReverts: true });
    _setDeps({
      getQuote: async () => successQuote({ value: 1234n, outputAmount: 9999n }),
      publicClient,
      walletClientFor: () => walletClient,
    });

    await assert.rejects(
      buyExactEthForToken({ wallet: WALLET, tokenOut: TOKEN, amountInWei: 1234n }),
      /clanker-api: simulation reverted/
    );
    assert.equal(calls.simulations.length, 1, "simulated before broadcast");
    assert.equal(calls.sentTx.length, 0, "no broadcast when simulation reverts");
  });

  test("sell: pre-simulation reverts → throws after approval, NO swap broadcast", async () => {
    // Approval still happens (needed for the simulation to be meaningful — without it,
    // simulation would always revert on allowance check, hiding the actual slippage issue).
    const { publicClient, walletClient, calls } = buildMockClients({
      allowance: 0n, simulationReverts: true,
    });
    _setDeps({
      getQuote: async () => successQuote({ value: 0n, outputAmount: 100n }),
      publicClient,
      walletClientFor: () => walletClient,
    });

    await assert.rejects(
      sellExactTokenForEth({ wallet: WALLET, tokenIn: TOKEN, amountInWei: 1n }),
      /clanker-api: simulation reverted/
    );
    assert.equal(calls.approveTx.length, 1, "approval was submitted (idempotent, cached after)");
    assert.equal(calls.simulations.length, 1, "simulation ran after approval");
    assert.equal(calls.sentTx.length, 0, "swap NOT broadcast on simulation revert");
  });

  test("buy: simulation passes → broadcast proceeds normally", async () => {
    const { publicClient, walletClient, calls } = buildMockClients({ simulationReverts: false });
    _setDeps({
      getQuote: async () => successQuote({ value: 1234n, outputAmount: 9999n }),
      publicClient,
      walletClientFor: () => walletClient,
    });

    const r = await buyExactEthForToken({ wallet: WALLET, tokenOut: TOKEN, amountInWei: 1234n });

    assert.equal(calls.simulations.length, 1);
    assert.equal(calls.sentTx.length, 1, "broadcast after simulation passes");
    assert.equal(r.txHash, "0xswaphash");
  });

  test("v13.17: buy where sim passes but receipt reverts → re-throws as clanker-api: for UR fallback", async () => {
    // Race: between sim (eth_call) and broadcast, price moved enough that the actual tx
    // reverts on-chain. The clankerAggregator catches the OnChainRevert and re-throws with
    // the clanker-api: prefix so the dispatcher's existing fallback to UR kicks in.
    const { publicClient, walletClient, calls } = buildMockClients({
      simulationReverts: false, swapRevertsOnChain: true,
    });
    _setDeps({
      getQuote: async () => successQuote({ value: 1234n, outputAmount: 9999n }),
      publicClient,
      walletClientFor: () => walletClient,
    });

    await assert.rejects(
      buyExactEthForToken({ wallet: WALLET, tokenOut: TOKEN, amountInWei: 1234n }),
      /clanker-api: tx reverted on-chain/
    );
    assert.equal(calls.simulations.length, 1, "sim still ran (and passed)");
    assert.equal(calls.sentTx.length, 1, "tx was broadcast");
    assert.equal(calls.receipts.length, 1, "we waited for the receipt");
  });

  test("v13.17: sell where receipt reverts → also re-thrown as clanker-api: for fallback", async () => {
    const { publicClient, walletClient, calls } = buildMockClients({
      allowance: maxUint256, simulationReverts: false, swapRevertsOnChain: true,
    });
    _setDeps({
      getQuote: async () => successQuote({ value: 0n, outputAmount: 100n }),
      publicClient,
      walletClientFor: () => walletClient,
    });

    await assert.rejects(
      sellExactTokenForEth({ wallet: WALLET, tokenIn: TOKEN, amountInWei: 50n }),
      /clanker-api: tx reverted on-chain/
    );
    assert.equal(calls.sentTx.length, 1);
    assert.equal(calls.receipts.length, 1);
  });
});
