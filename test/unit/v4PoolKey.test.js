// Tests for the V4 PoolKey resolvers + Quoter helpers.
//   - resolveV4PoolKey       — hash-match (offline)
//   - quoteV4Pool            — single Quoter call (mocked publicClient)
//   - resolveV4PoolKeyViaQuoter — Doppler-style brute-force + quote
//   - detectV3Pool           — V3-vs-V4 probe via token0/token1/fee
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  _internals,
  computePoolId,
  detectV3Pool,
  quoteV4Pool,
  resolveV4PoolKey,
  resolveV4PoolKeyViaQuoter,
} from "../../src/discovery/v4PoolKey.js";

const WETH = "0x4200000000000000000000000000000000000006";
const CLANKER_HOOK = "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC";
const QUOTER = "0x0d5e0f971ed27fbff6c2837bf31316121532048d";

describe("resolveV4PoolKey (hash-match)", () => {
  test("recovers Clanker PoolKey for Plsbro (mainnet)", () => {
    const key = resolveV4PoolKey({
      tokenA: "0x304Ed58209262a7EA72600525d9967Fbe44a5b07",
      tokenB: WETH,
      hooks: CLANKER_HOOK,
      expectedPoolId: "0xf2e034ab585c8036aa775e1d32b46fc7992366840e0406bb6e10f17c0274c73c",
    });
    assert.ok(key);
    assert.equal(key.fee, 8388608);
    assert.equal(key.tickSpacing, 200);
    assert.equal(key.verified, true);
  });

  test("works regardless of token order", () => {
    const id = "0xf2e034ab585c8036aa775e1d32b46fc7992366840e0406bb6e10f17c0274c73c";
    const a = resolveV4PoolKey({
      tokenA: "0x304Ed58209262a7EA72600525d9967Fbe44a5b07", tokenB: WETH, hooks: CLANKER_HOOK, expectedPoolId: id,
    });
    const b = resolveV4PoolKey({
      tokenA: WETH, tokenB: "0x304Ed58209262a7EA72600525d9967Fbe44a5b07", hooks: CLANKER_HOOK, expectedPoolId: id,
    });
    assert.deepEqual({ c0: a.currency0, c1: a.currency1, fee: a.fee }, { c0: b.currency0, c1: b.currency1, fee: b.fee });
  });

  test("returns null when no candidate matches", () => {
    const k = resolveV4PoolKey({
      tokenA: "0x304Ed58209262a7EA72600525d9967Fbe44a5b07",
      tokenB: WETH,
      hooks: CLANKER_HOOK,
      expectedPoolId: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });
    assert.equal(k, null);
  });

  test("computePoolId is deterministic", () => {
    const k = {
      currency0: "0x304Ed58209262a7EA72600525d9967Fbe44a5b07",
      currency1: WETH, fee: 8388608, tickSpacing: 200, hooks: CLANKER_HOOK,
    };
    assert.equal(_internals.computePoolId(k), computePoolId(k));
    assert.equal(
      computePoolId(k).toLowerCase(),
      "0xf2e034ab585c8036aa775e1d32b46fc7992366840e0406bb6e10f17c0274c73c"
    );
  });
});

describe("quoteV4Pool", () => {
  const poolKey = {
    currency0: "0x304ed58209262a7ea72600525d9967fbe44a5b07",
    currency1: WETH, fee: 8388608, tickSpacing: 200, hooks: CLANKER_HOOK,
  };

  test("returns {amountOut, gasEstimate} when Quoter succeeds", async () => {
    const publicClient = {
      simulateContract: async ({ functionName, args }) => {
        assert.equal(functionName, "quoteExactInputSingle");
        assert.equal(args[0].zeroForOne, false);
        return { result: [12345n, 67890n] };
      },
    };
    const r = await quoteV4Pool({
      poolKey, amountIn: 100n, zeroForOne: false, publicClient, quoter: QUOTER,
    });
    assert.deepEqual(r, { amountOut: 12345n, gasEstimate: 67890n });
  });

  test("returns null on Quoter revert", async () => {
    const publicClient = {
      simulateContract: async () => { throw new Error("PoolNotInitialized"); },
    };
    const r = await quoteV4Pool({
      poolKey, amountIn: 100n, zeroForOne: false, publicClient, quoter: QUOTER,
    });
    assert.equal(r, null);
  });
});

describe("resolveV4PoolKeyViaQuoter", () => {
  const ASSET = "0x304ed58209262a7ea72600525d9967fbe44a5b07";

  test("picks the candidate whose Quoter returns a non-zero amountOut", async () => {
    let attempts = 0;
    const publicClient = {
      simulateContract: async ({ args }) => {
        attempts++;
        const fee = args[0].poolKey.fee;
        const ts = args[0].poolKey.tickSpacing;
        // Only the second candidate (fee=8388608, tickSpacing=60) "exists"
        if (fee === 8388608 && ts === 60) return { result: [99999n, 1000n] };
        throw new Error("PoolNotInitialized");
      },
    };
    const r = await resolveV4PoolKeyViaQuoter({
      tokenIn: WETH, tokenOut: ASSET, hooks: CLANKER_HOOK,
      publicClient, quoter: QUOTER,
    });
    assert.ok(r);
    assert.equal(r.fee, 8388608);
    assert.equal(r.tickSpacing, 60);
    assert.equal(r.verified, true);
    assert.equal(r.probeAmountOut, 99999n);
    assert.ok(typeof r.zeroForOne === "boolean");
    // Sorted currencies
    assert.ok(r.currency0.toLowerCase() < r.currency1.toLowerCase());
    // Should have stopped at 2nd attempt (Plsbro/Clanker convention is candidate #1 but we asked #2)
    assert.equal(attempts, 2);
  });

  test("returns null when no candidate succeeds", async () => {
    const publicClient = {
      simulateContract: async () => { throw new Error("PoolNotInitialized"); },
    };
    const r = await resolveV4PoolKeyViaQuoter({
      tokenIn: WETH, tokenOut: ASSET, hooks: CLANKER_HOOK,
      publicClient, quoter: QUOTER,
    });
    assert.equal(r, null);
  });

  test("zeroForOne reflects the direction (tokenIn → tokenOut)", async () => {
    // When tokenIn (WETH=0x42..) > tokenOut (asset=0x30..) lex, then WETH is currency1
    // and zeroForOne should be false (we go 1→0).
    const publicClient = {
      simulateContract: async ({ args }) => ({ result: [1n, 1n] }),
    };
    const r = await resolveV4PoolKeyViaQuoter({
      tokenIn: WETH, tokenOut: ASSET, hooks: CLANKER_HOOK,
      publicClient, quoter: QUOTER,
    });
    assert.equal(r.zeroForOne, false); // WETH > asset, so WETH=currency1, go 1→0
  });
});

describe("detectV3Pool", () => {
  const POOL = "0xd0b53d9277642d899df5c87a3966a349a798f224";

  test("returns full metadata when slot0/token0/token1/fee read OK", async () => {
    const publicClient = {
      readContract: async ({ functionName }) => {
        if (functionName === "token0") return "0x4200000000000000000000000000000000000006";
        if (functionName === "token1") return "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b";
        if (functionName === "fee") return 3000;
        throw new Error("unexpected: " + functionName);
      },
    };
    const r = await detectV3Pool({ poolAddress: POOL, publicClient });
    assert.ok(r);
    assert.equal(r.pool, POOL);
    assert.equal(r.fee, 3000);
  });

  test("returns null when reads revert (V4 hook contract)", async () => {
    const publicClient = { readContract: async () => { throw new Error("reverted"); } };
    assert.equal(await detectV3Pool({ poolAddress: POOL, publicClient }), null);
  });
});
