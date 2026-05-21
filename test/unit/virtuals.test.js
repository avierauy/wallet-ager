import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { toFunctionSelector } from "viem";
import {
  buildApprovePreGradData,
  buildBuyPreGradData,
  buildSellPreGradData,
} from "../../src/adapters/virtuals.js";
import { config } from "../../src/config.js";

const POLYHERMES = "0x479e864957dbb19f780c37ac7f7e3bfbba23c45a";

const MARKER = config.chain.dexes.virtuals.frontendMarker;

describe("virtuals pre-grad data builders — match UI footprint", () => {
  test("approve carries ERC20 approve selector and ends with the Virtuals UI marker", () => {
    const data = buildApprovePreGradData({ amount: 1_000_000n });
    assert.equal(data.slice(0, 10), "0x095ea7b3");
    assert.ok(data.endsWith(MARKER.slice(2)));
  });

  test("buy selector matches 0x706910ff (Bonding.buy)", () => {
    const data = buildBuyPreGradData({
      agentToken: POLYHERMES,
      amountInVirtualWei: 10n ** 18n,
      minOutWei: 1n,
      deadline: 1n,
    });
    assert.equal(data.slice(0, 10), "0x706910ff");
    assert.ok(data.endsWith(MARKER.slice(2)));
  });

  test("sell selector matches 0xb233e056 (Bonding.sell)", () => {
    const data = buildSellPreGradData({
      agentToken: POLYHERMES,
      amountInWei: 10n ** 18n,
      minOutVirtualWei: 1n,
      deadline: 1n,
    });
    assert.equal(data.slice(0, 10), "0xb233e056");
    assert.ok(data.endsWith(MARKER.slice(2)));
  });

  test("computed buy selector matches the on-chain BondingV5.buy signature", () => {
    const sel = toFunctionSelector({
      type: "function",
      name: "buy",
      inputs: [
        { name: "amountIn", type: "uint256" },
        { name: "token", type: "address" },
        { name: "minAmountOut", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    });
    assert.equal(sel, "0x706910ff");
  });
});
