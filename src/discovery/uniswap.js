import { parseAbi, parseAbiItem } from "viem";
import { config } from "../config.js";
import { publicClient } from "../core/rpc.js";
import { add, STATUS } from "../core/tokenRegistry.js";
import { checkToken } from "../safety/honeypot.js";
import { logger } from "../util/logger.js";

const PoolCreated = parseAbiItem(
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
);

const ERC20_META_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const V3_POOL_ABI = parseAbi([
  "function liquidity() view returns (uint128)",
]);

const WETH = () => config.chain.wnative.toLowerCase();
const V3_FACTORY = () => config.chain.dexes.uniswap.v3Factory;

// Pools below this `liquidity()` value are skipped — they were created but no LP was added.
// (V3 `liquidity` is a tick-relative value, not a USD figure, but >0 is a meaningful signal
// that someone seeded the pool. We deliberately don't compute USD here to keep this cheap.)
const MIN_POOL_LIQUIDITY = 1n;

const fetchMetadata = async (address) => {
  try {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "symbol" }),
      publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "decimals" }),
    ]);
    return { symbol, decimals: Number(decimals) };
  } catch (err) {
    logger.warn({ address, err: err.message }, "uniswap: metadata read failed");
    return null;
  }
};

const fetchLiquidity = async (poolAddress) => {
  try {
    return await publicClient.readContract({
      address: poolAddress,
      abi: V3_POOL_ABI,
      functionName: "liquidity",
    });
  } catch {
    return 0n;
  }
};

export const handlePoolCreated = async ({ token0, token1, fee, pool }) => {
  const weth = WETH();
  const isToken0Weth = token0.toLowerCase() === weth;
  const isToken1Weth = token1.toLowerCase() === weth;
  if (!isToken0Weth && !isToken1Weth) return { skipped: "not-weth-pair" };

  const tokenAddr = isToken0Weth ? token1 : token0;

  const liquidity = await fetchLiquidity(pool);
  if (liquidity < MIN_POOL_LIQUIDITY) return { skipped: "no-liquidity" };

  const meta = await fetchMetadata(tokenAddr);
  if (!meta) return { skipped: "no-metadata" };

  const safety = await checkToken(tokenAddr);
  const status = safety.safe ? STATUS.ACTIVE : STATUS.UNSAFE;

  add({
    address: tokenAddr,
    symbol: meta.symbol,
    decimals: meta.decimals,
    tradeableOn: ["uniswap"],
    source: `uniswap-v3-fee${fee}`,
    status,
  });
  logger.info(
    { token: tokenAddr, symbol: meta.symbol, fee, pool, status, liquidity: liquidity.toString() },
    "uniswap: PoolCreated processed"
  );
  return { added: true, status, fee, pool };
};

let unwatch = null;

export const startUniswapDiscovery = () => {
  if (unwatch) return;
  unwatch = publicClient.watchEvent({
    address: V3_FACTORY(),
    event: PoolCreated,
    onLogs: (logs) => {
      for (const log of logs) {
        handlePoolCreated({
          token0: log.args.token0,
          token1: log.args.token1,
          fee: log.args.fee,
          pool: log.args.pool,
        }).catch((err) => logger.error({ err: err.message }, "uniswap: handlePoolCreated threw"));
      }
    },
    onError: (err) => logger.error({ err: err.message }, "uniswap: watcher error"),
  });
  logger.info({ contract: V3_FACTORY() }, "uniswap V3 discovery started");
};

export const stopUniswapDiscovery = () => {
  if (unwatch) { unwatch(); unwatch = null; }
};
