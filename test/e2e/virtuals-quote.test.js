import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { quoteAgentToVirtual, quoteVirtualToAgent } from "../../src/adapters/virtuals.js";

// POLYHERMES — the pre-grad agent token from the original discovery sample. If this token
// graduates or is removed, swap to another active pre-grad token from app.virtuals.io.
const POLYHERMES = "0x479e864957dbb19f780c37ac7f7e3bfbba23c45a";

describe("Virtuals FRouterV3.getAmountsOut (Base mainnet)", { timeout: 30_000 }, () => {
  test("VIRTUAL → agent quote returns positive amount", async () => {
    const out = await quoteVirtualToAgent({
      agentToken: POLYHERMES,
      amountInVirtualWei: 10n ** 18n, // 1 VIRTUAL
    });
    assert.ok(out > 0n, `expected agent out > 0, got ${out}`);
  });

  test("agent → VIRTUAL quote returns positive amount", async () => {
    const out = await quoteAgentToVirtual({
      agentToken: POLYHERMES,
      amountInAgentWei: 10n ** 18n,
    });
    assert.ok(out > 0n, `expected virtual out > 0, got ${out}`);
  });
});
