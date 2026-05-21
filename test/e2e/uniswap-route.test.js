import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isAddress } from "viem";
import { quote } from "../../src/adapters/uniswap.js";

const USDC = { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, symbol: "USDC" };
const NATIVE = { address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", decimals: 18, symbol: "ETH" };

const FRESH_RECIPIENT = "0x000000000000000000000000000000000000dEaD";

describe("AlphaRouter route (Base mainnet, read-only)", { timeout: 90_000 }, () => {
  test("ETH→USDC returns methodParameters with a Universal Router target", async () => {
    const route = await quote({
      tokenIn: NATIVE,
      tokenOut: USDC,
      amountInWei: 1_000_000_000_000_000n,
      slippageBps: 50,
      recipient: FRESH_RECIPIENT,
    });
    assert.ok(route.methodParameters);
    const { to, calldata, value } = route.methodParameters;
    assert.ok(isAddress(to), `to is not an address: ${to}`);
    assert.ok(calldata.startsWith("0x") && calldata.length > 10);
    assert.equal(BigInt(value), 1_000_000_000_000_000n);
    assert.ok(route.quote, "expected a non-empty quote");
  });
});
