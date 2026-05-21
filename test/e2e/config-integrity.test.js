import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseAbi } from "viem";
import { config } from "../../src/config.js";
import { publicClient } from "../../src/core/rpc.js";

describe("on-chain config integrity (Base mainnet)", () => {
  test("DexRouter address has the version() view function reachable", async () => {
    const v = await publicClient.readContract({
      address: config.chain.dexes.virtuals.postGradRouter,
      abi: parseAbi(["function version() view returns (string)"]),
      functionName: "version",
    });
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0);
  });

  test("Permit2 address has the allowance() view function reachable", async () => {
    const [, , nonce] = await publicClient.readContract({
      address: config.chain.permit2,
      abi: parseAbi([
        "function allowance(address owner, address token, address spender) view returns (uint160, uint48, uint48)",
      ]),
      functionName: "allowance",
      args: [
        "0x000000000000000000000000000000000000dEaD",
        "0x4200000000000000000000000000000000000006",
        "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7",
      ],
    });
    assert.equal(typeof nonce, "number");
  });
});
