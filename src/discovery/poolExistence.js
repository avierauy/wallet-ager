import { parseAbi, getAddress } from "viem";
import { config } from "../config.js";
import { publicClient } from "../core/rpc.js";

const FACTORY_ABI = parseAbi([
  "function getPair(address tokenA, address tokenB) view returns (address)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

const V3_FEE_TIERS = [100, 500, 3000, 10000];
const ZERO = "0x0000000000000000000000000000000000000000";

const sameAddr = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

// Returns true if (token, WETH) has any V2 or V3 pool other than `excludePool`. Used by the
// discovery handlers to skip events that aren't actually a "first listing" — e.g. someone
// adding a new fee tier or a V4 pool for a token that's been trading on V3 for months.
export const tokenHasExistingPools = async ({ tokenAddr, excludePool }) => {
  const weth = config.chain.wnative;
  const v2 = config.chain.dexes.uniswap.v2Factory;
  const v3 = config.chain.dexes.uniswap.v3Factory;
  const ex = excludePool ?? ZERO;

  try {
    const v2Pair = await publicClient.readContract({
      address: v2, abi: FACTORY_ABI, functionName: "getPair", args: [tokenAddr, weth],
    });
    if (v2Pair !== ZERO && !sameAddr(v2Pair, ex)) {
      return { exists: true, where: "v2", at: getAddress(v2Pair) };
    }
  } catch { /* factory call shouldn't throw, but be defensive */ }

  for (const fee of V3_FEE_TIERS) {
    try {
      const v3Pool = await publicClient.readContract({
        address: v3, abi: FACTORY_ABI, functionName: "getPool", args: [tokenAddr, weth, fee],
      });
      if (v3Pool !== ZERO && !sameAddr(v3Pool, ex)) {
        return { exists: true, where: `v3-fee${fee}`, at: getAddress(v3Pool) };
      }
    } catch { /* defensive */ }
  }

  return { exists: false };
};
