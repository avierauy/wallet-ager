// Tests for submitAndConfirm (v13.17): broadcast + wait + status check, throw OnChainRevert
// on reverted receipts.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { OnChainRevert } from "../../src/util/errors.js";
import { submitAndConfirm } from "../../src/util/submitAndConfirm.js";

const mockClients = ({ receiptStatus = "success", gasUsed = 100000n } = {}) => {
  const calls = { sent: [], wrote: [], waited: [] };
  return {
    publicClient: {
      waitForTransactionReceipt: async ({ hash, timeout }) => {
        calls.waited.push({ hash, timeout });
        return { status: receiptStatus, gasUsed };
      },
    },
    walletClient: {
      sendTransaction: async (tx) => { calls.sent.push(tx); return "0xrawtx"; },
      writeContract: async (tx) => { calls.wrote.push(tx); return "0xwritecall"; },
    },
    calls,
  };
};

describe("submitAndConfirm", () => {
  test("raw sendTransaction path: returns { hash, gasUsed } on success", async () => {
    const { publicClient, walletClient, calls } = mockClients({ gasUsed: 250000n });
    const r = await submitAndConfirm({
      publicClient, walletClient,
      tx: { to: "0xR", data: "0xdeadbeef", value: 1234n },
    });
    assert.equal(r.hash, "0xrawtx");
    assert.equal(r.gasUsed, 250000n);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.wrote.length, 0);
    assert.equal(calls.waited[0].hash, "0xrawtx");
  });

  test("writeContract path: routes by presence of abi + functionName", async () => {
    const { publicClient, walletClient, calls } = mockClients();
    const r = await submitAndConfirm({
      publicClient, walletClient,
      tx: { address: "0xT", abi: [], functionName: "approve", args: ["0xS", 100n] },
    });
    assert.equal(r.hash, "0xwritecall");
    assert.equal(calls.wrote.length, 1);
    assert.equal(calls.sent.length, 0);
  });

  test("reverted receipt throws OnChainRevert with hash + gasUsed", async () => {
    const { publicClient, walletClient } = mockClients({
      receiptStatus: "reverted", gasUsed: 50000n,
    });
    await assert.rejects(
      async () => submitAndConfirm({
        publicClient, walletClient,
        tx: { to: "0xR", data: "0xdead", value: 0n },
      }),
      (err) => {
        assert.ok(err instanceof OnChainRevert, "must be OnChainRevert");
        assert.equal(err.txHash, "0xrawtx");
        assert.equal(err.gasUsed, 50000n);
        return true;
      }
    );
  });

  test("passes timeoutMs through to waitForTransactionReceipt (default 60s)", async () => {
    const { publicClient, walletClient, calls } = mockClients();
    await submitAndConfirm({
      publicClient, walletClient,
      tx: { to: "0xR", data: "0xdead", value: 0n },
    });
    assert.equal(calls.waited[0].timeout, 60_000);
    await submitAndConfirm({
      publicClient, walletClient,
      tx: { to: "0xR", data: "0xdead", value: 0n },
      timeoutMs: 15_000,
    });
    assert.equal(calls.waited[1].timeout, 15_000);
  });

  test("network errors during wait propagate (not transformed)", async () => {
    const { walletClient } = mockClients();
    const publicClient = {
      waitForTransactionReceipt: async () => { throw new Error("timeout waiting for receipt"); },
    };
    await assert.rejects(
      async () => submitAndConfirm({
        publicClient, walletClient,
        tx: { to: "0xR", data: "0xdead", value: 0n },
      }),
      /timeout waiting for receipt/
    );
  });
});
