// V4 PoolKey resolution + Quoter-based validation.
//
// Why this module exists:
//   Launchpads emit events that don't carry the full V4 PoolKey. Clanker gives us the poolId
//   (so we can hash-match candidates). Doppler doesn't — only `poolOrHook`. In either case we
//   need the full (currency0, currency1, fee, tickSpacing, hooks) tuple to construct a direct
//   swap via Universal Router.
//
// The two resolvers below produce that tuple, and `quoteV4Pool` validates that the resolved
// pool is actually swappable RIGHT NOW (catches MEV hook windows, hook reverts, etc.). The
// Quoter is the same contract Uniswap's UI uses for pre-swap simulation, so a passing quote
// is strong evidence the swap will land if we broadcast immediately.
//
// Exported:
//   - computePoolId          — pure keccak256(abi.encode(PoolKey)). No RPC.
//   - resolveV4PoolKey       — hash-match candidates against a known poolId (Clanker).
//   - quoteV4Pool            — single Quoter call; returns { amountOut, gasEstimate } or null.
//   - resolveV4PoolKeyViaQuoter — Doppler-style: try each candidate, first one that quotes wins.
//   - detectV3Pool           — Distinguish V3 pool from V4 hook by probing token0/token1/fee.
import { encodeAbiParameters, keccak256, parseAbi } from "viem";

// Standard V4 fee + tick-spacing pairs seen on Base mainnet, ordered by frequency.
// 8388608 (= 0x800000) is the LPFeeLibrary.DYNAMIC_FEE_FLAG — used when fee is controlled by
// a hook. Clanker AND Doppler (Bankr) both use this.
const DEFAULT_CANDIDATES = [
  // Clanker / Doppler-bankr convention (most fresh launches on Base today)
  { fee: 8388608, tickSpacing: 200 },
  { fee: 8388608, tickSpacing: 60 },
  { fee: 8388608, tickSpacing: 100 },
  { fee: 8388608, tickSpacing: 2 },
  // Static-fee pools (standard Uniswap tiers)
  { fee: 100,   tickSpacing: 1 },
  { fee: 500,   tickSpacing: 10 },
  { fee: 3000,  tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];

const POOL_KEY_ENCODING = [
  { type: "address" },
  { type: "address" },
  { type: "uint24" },
  { type: "int24" },
  { type: "address" },
];

export const computePoolId = ({ currency0, currency1, fee, tickSpacing, hooks }) =>
  keccak256(encodeAbiParameters(POOL_KEY_ENCODING, [currency0, currency1, fee, tickSpacing, hooks]));

const sortCurrencies = (a, b) =>
  a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];

// Hash-match resolver — used when the discovery event carries `poolId` (Clanker's TokenCreated).
// Pure off-chain. Returns the full PoolKey on success, null if no candidate matched.
export const resolveV4PoolKey = ({ tokenA, tokenB, hooks, expectedPoolId, candidates = DEFAULT_CANDIDATES }) => {
  const [currency0, currency1] = sortCurrencies(tokenA, tokenB);
  for (const { fee, tickSpacing } of candidates) {
    const computed = computePoolId({ currency0, currency1, fee, tickSpacing, hooks });
    if (computed.toLowerCase() === expectedPoolId.toLowerCase()) {
      return { currency0, currency1, fee, tickSpacing, hooks, verified: true };
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// V4 Quoter (on-chain swap simulation)

// V4Quoter exposes quoteExactInputSingle which returns the exact output amount for a swap
// without modifying state. Reverts cleanly if the pool isn't initialized, hooks block the
// swap, or there's no liquidity — exactly the signals we want to detect.
const V4_QUOTER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

// Single-pool quote. Returns { amountOut, gasEstimate } on success, null on revert.
// `poolKey` must be the full V4 tuple; `zeroForOne` indicates swap direction.
export const quoteV4Pool = async ({ poolKey, amountIn, zeroForOne, publicClient, quoter, hookData = "0x" }) => {
  try {
    const result = await publicClient.simulateContract({
      address: quoter,
      abi: V4_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData }],
    });
    const [amountOut, gasEstimate] = result.result;
    return { amountOut, gasEstimate };
  } catch {
    return null;
  }
};

// Doppler-style resolver — we have the hook + the two currencies (asset + numeraire) but not
// fee/tickSpacing. Tries each candidate via Quoter; the first one that produces a non-reverting
// quote IS the right pool AND is currently tradeable.
//
// Returns { currency0, currency1, fee, tickSpacing, hooks, zeroForOne, poolId, probeAmountOut }
// on success, null otherwise.
//
// `tokenIn` is the side we'll spend (WETH for buys), `tokenOut` is what we want to receive.
// Caller can pass a small `probeAmount` (default 0.0001 ETH) to keep RPC light.
export const resolveV4PoolKeyViaQuoter = async ({
  tokenIn, tokenOut, hooks, publicClient, quoter,
  probeAmount = 100_000_000_000_000n,
  candidates = DEFAULT_CANDIDATES,
}) => {
  const [currency0, currency1] = sortCurrencies(tokenIn, tokenOut);
  const inIsCurrency0 = tokenIn.toLowerCase() === currency0.toLowerCase();
  const zeroForOne = inIsCurrency0;

  for (const { fee, tickSpacing } of candidates) {
    const poolKey = { currency0, currency1, fee, tickSpacing, hooks };
    const q = await quoteV4Pool({ poolKey, amountIn: probeAmount, zeroForOne, publicClient, quoter });
    if (q && q.amountOut > 0n) {
      return {
        ...poolKey,
        zeroForOne,
        poolId: computePoolId(poolKey),
        probeAmountOut: q.amountOut,
        verified: true,
      };
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// V3 pool detection — used by Doppler when `poolOrHook` could be either

const V3_POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);

// Probe `poolOrHook` to see if it's a V3 pool. On success returns full V3 metadata; on revert
// (typical for a V4 hook contract) returns null.
export const detectV3Pool = async ({ poolAddress, publicClient }) => {
  try {
    const [token0, token1, fee] = await Promise.all([
      publicClient.readContract({ address: poolAddress, abi: V3_POOL_ABI, functionName: "token0" }),
      publicClient.readContract({ address: poolAddress, abi: V3_POOL_ABI, functionName: "token1" }),
      publicClient.readContract({ address: poolAddress, abi: V3_POOL_ABI, functionName: "fee" }),
    ]);
    return { pool: poolAddress, token0, token1, fee: Number(fee) };
  } catch {
    return null;
  }
};

export const _internals = { computePoolId, sortCurrencies, DEFAULT_CANDIDATES };
