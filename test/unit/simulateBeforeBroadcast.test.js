// Tests for simulateBeforeBroadcast (v13.18): eth_call pre-flight that throws
// PreSimulationRevert on revert and returns silently on success.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PreSimulationRevert } from "../../src/util/errors.js";
import { simulateBeforeBroadcast } from "../../src/util/simulateBeforeBroadcast.js";

const mockClient = ({ callBehavior } = {}) => {
  const calls = [];
  return {
    publicClient: {
      call: async (params) => {
        calls.push(params);
        if (callBehavior === "revert") {
          const err = new Error("execution reverted with reason: Return amount is not enough");
          err.shortMessage = "Execution reverted with reason: Return amount is not enough.";
          throw err;
        }
        if (callBehavior === "network") {
          const err = new Error("network error: fetch failed");
          throw err;
        }
        return { data: "0x" };
      },
    },
    calls,
  };
};

const ACCOUNT = { address: "0xAAAa" };
const TX = { to: "0xRouter", data: "0xdeadbeef", value: 1234n };

describe("simulateBeforeBroadcast", () => {
  test("simulation passes → returns silently, no throw", async () => {
    const { publicClient, calls } = mockClient({ callBehavior: "success" });
    await simulateBeforeBroadcast({ publicClient, account: ACCOUNT, tx: TX });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].account, ACCOUNT);
    assert.equal(calls[0].to, TX.to);
    assert.equal(calls[0].data, TX.data);
    assert.equal(calls[0].value, TX.value);
  });

  test("simulation reverts → throws PreSimulationRevert with reason + target", async () => {
    const { publicClient } = mockClient({ callBehavior: "revert" });
    await assert.rejects(
      simulateBeforeBroadcast({ publicClient, account: ACCOUNT, tx: TX }),
      (err) => {
        assert.ok(err instanceof PreSimulationRevert);
        assert.equal(err.target, TX.to);
        assert.ok(err.reason.includes("Return amount is not enough"));
        return true;
      }
    );
  });

  test("network errors during eth_call also surface as PreSimulationRevert", async () => {
    // Pragmatic choice: we can't distinguish a revert from a transport error at this layer.
    // The caller (typically the retry scheduler) treats both as "swap will not land now".
    const { publicClient } = mockClient({ callBehavior: "network" });
    await assert.rejects(
      simulateBeforeBroadcast({ publicClient, account: ACCOUNT, tx: TX }),
      PreSimulationRevert
    );
  });

  test("value defaults to 0n when omitted (sell-side: no ETH sent)", async () => {
    const { publicClient, calls } = mockClient({ callBehavior: "success" });
    await simulateBeforeBroadcast({
      publicClient, account: ACCOUNT,
      tx: { to: "0xR", data: "0x00" }, // no value
    });
    assert.equal(calls[0].value, 0n);
  });
});
