// Listens for new tokens deployed across all three Uniswap versions on Base:
//   V2 — UniswapV2Factory.PairCreated
//   V3 — UniswapV3Factory.PoolCreated
//   V4 — PoolManager.Initialize  (currency0 can be address(0) for native ETH)
//
// Common pipeline per event:
//   1. Cheap WETH-or-native pair filter (no RPC/fetch on rejected pairs).
//   2. Liquidity check on the new pool/pair (skip empty deployments).
//   3. ERC20 metadata read on the non-WETH token.
//   4. honeypot.is safety probe.
//   5. Register ACTIVE or UNSAFE.
//
// All three versions register `tradeableOn: ["uniswap"]` so the AlphaRouter
// auto-router picks the best route at trade time regardless of where the
// pool actually lives.
import { parseAbi, parseAbiItem } from "viem";
import { config } from "../config.js";
import { publicClient } from "../core/rpc.js";
import { add, STATUS } from "../core/tokenRegistry.js";
import { tryFireSniperBuy } from "../orchestrator/sniper.js";
import { checkToken } from "../safety/index.js";
import { logger } from "../util/logger.js";
import { tokenHasExistingPools } from "./poolExistence.js";

const PairCreated = parseAbiItem(
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"
);

const PoolCreated = parseAbiItem(
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
);

const V4Initialize = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"
);

const ERC20_META_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const V2_PAIR_ABI = parseAbi([
  "function getReserves() view returns (uint112, uint112, uint32)",
]);

const V3_POOL_ABI = parseAbi([
  "function liquidity() view returns (uint128)",
]);

const NATIVE_ZERO = "0x0000000000000000000000000000000000000000";

const WETH = () => config.chain.wnative.toLowerCase();
const V2_FACTORY = () => config.chain.dexes.uniswap.v2Factory;
const V3_FACTORY = () => config.chain.dexes.uniswap.v3Factory;
const V4_POOL_MANAGER = () => config.chain.dexes.uniswap.v4PoolManager;

const isWethOrNative = (addr) => {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a === WETH() || a === NATIVE_ZERO;
};

const pickNonNative = (a, b) => (isWethOrNative(a) ? b : a);

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

const fetchV2Reserves = async (pair) => {
  try {
    const [r0, r1] = await publicClient.readContract({
      address: pair, abi: V2_PAIR_ABI, functionName: "getReserves",
    });
    return r0 + r1;
  } catch { return 0n; }
};

const fetchV3Liquidity = async (pool) => {
  try {
    return await publicClient.readContract({
      address: pool, abi: V3_POOL_ABI, functionName: "liquidity",
    });
  } catch { return 0n; }
};

const registerIfFirstAndSafe = async ({ tokenAddr, source, excludePool, poolMetadata, extra = {} }) => {
  // First-listing filter: skip if the token already has a tradeable pool elsewhere.
  // This event is then "yet another pool for an established token", not a fresh launch.
  const existing = await tokenHasExistingPools({ tokenAddr, excludePool });
  if (existing.exists) {
    logger.info(
      { token: tokenAddr, source, alreadyAt: existing.where, ...extra },
      "uniswap: skipping — token already tradeable elsewhere"
    );
    return { skipped: "already-tradeable-elsewhere", existing };
  }

  const meta = await fetchMetadata(tokenAddr);
  if (!meta) return { skipped: "no-metadata" };

  // For generic Uniswap discovery (not Clanker/Doppler/Virtuals) we keep the safety check —
  // any random deployer can put any ERC20 in a pool with no template guarantees.
  const safety = await checkToken(tokenAddr);
  const status = safety.pending
    ? STATUS.PENDING
    : safety.safe
      ? STATUS.ACTIVE
      : STATUS.UNSAFE;

  add({
    address: tokenAddr,
    symbol: meta.symbol,
    decimals: meta.decimals,
    tradeableOn: ["uniswap"],
    source,
    status,
    poolMetadata,
  });
  logger.info({ token: tokenAddr, symbol: meta.symbol, source, status, ...extra }, "uniswap: discovery resolved");

  // Fresh launch + safety verdict came back SAFE → fire sniper buy immediately.
  if (status === STATUS.ACTIVE) {
    tryFireSniperBuy({
      token: {
        address: tokenAddr, symbol: meta.symbol, decimals: meta.decimals,
        tradeableOn: ["uniswap"], source, poolMetadata,
      },
    }).catch((err) => logger.error({ err: err.message }, "sniper invocation threw"));
  }

  return { added: true, status };
};

// ----- V2 -----
export const handleV2PairCreated = async ({ token0, token1, pair }) => {
  if (!isWethOrNative(token0) && !isWethOrNative(token1)) return { skipped: "not-weth-pair" };
  const totalReserves = await fetchV2Reserves(pair);
  if (totalReserves === 0n) return { skipped: "no-liquidity" };
  const tokenAddr = pickNonNative(token0, token1);
  return registerIfFirstAndSafe({
    tokenAddr,
    source: "uniswap-v2",
    excludePool: pair,
    poolMetadata: { version: "v2", pair, token0, token1 },
    extra: { pair },
  });
};

// ----- V3 -----
export const handleV3PoolCreated = async ({ token0, token1, fee, pool }) => {
  if (!isWethOrNative(token0) && !isWethOrNative(token1)) return { skipped: "not-weth-pair" };
  const liquidity = await fetchV3Liquidity(pool);
  if (liquidity === 0n) return { skipped: "no-liquidity" };
  const tokenAddr = pickNonNative(token0, token1);
  return registerIfFirstAndSafe({
    tokenAddr,
    source: `uniswap-v3-fee${fee}`,
    excludePool: pool,
    poolMetadata: { version: "v3", pool, fee: Number(fee), token0, token1 },
    extra: { pool, liquidity: liquidity.toString() },
  });
};

// ----- V4 -----
// V4 pools are pre-initialized empty — there's no cheap "has liquidity?" view available from
// the PoolManager (liquidity is per-position). We rely on honeypot.is's simulation to fail
// gracefully on tokens that can't actually be traded; over time the sweeper evicts unfunded
// ones via TTL.
export const handleV4Initialize = async ({ currency0, currency1, fee, tickSpacing, hooks, pool }) => {
  if (!isWethOrNative(currency0) && !isWethOrNative(currency1)) return { skipped: "not-weth-pair" };
  const tokenAddr = pickNonNative(currency0, currency1);
  if (tokenAddr.toLowerCase() === NATIVE_ZERO) return { skipped: "both-native" };
  return registerIfFirstAndSafe({
    tokenAddr,
    source: `uniswap-v4-fee${fee}`,
    // V4 pool IDs are bytes32 hashes, not addresses — leave excludePool undefined so the
    // V2/V3 check evaluates fully (V4-only tokens have no V2/V3 pool anyway).
    poolMetadata: {
      version: "v4",
      poolId: pool,
      currency0, currency1,
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      hooks,
    },
    extra: { pool, hooks },
  });
};

// ----- watchers -----
let unwatchers = [];

export const startUniswapDiscovery = () => {
  if (unwatchers.length > 0) return;

  unwatchers.push(
    publicClient.watchEvent({
      address: V2_FACTORY(),
      event: PairCreated,
      onLogs: (logs) => {
        for (const log of logs) {
          handleV2PairCreated({
            token0: log.args.token0,
            token1: log.args.token1,
            pair: log.args.pair,
          }).catch((err) => logger.error({ err: err.message }, "uniswap V2: handler threw"));
        }
      },
      onError: (err) => logger.error({ err: err.message }, "uniswap V2: watcher error"),
    })
  );

  unwatchers.push(
    publicClient.watchEvent({
      address: V3_FACTORY(),
      event: PoolCreated,
      onLogs: (logs) => {
        for (const log of logs) {
          handleV3PoolCreated({
            token0: log.args.token0,
            token1: log.args.token1,
            fee: log.args.fee,
            pool: log.args.pool,
          }).catch((err) => logger.error({ err: err.message }, "uniswap V3: handler threw"));
        }
      },
      onError: (err) => logger.error({ err: err.message }, "uniswap V3: watcher error"),
    })
  );

  unwatchers.push(
    publicClient.watchEvent({
      address: V4_POOL_MANAGER(),
      event: V4Initialize,
      onLogs: (logs) => {
        for (const log of logs) {
          handleV4Initialize({
            currency0: log.args.currency0,
            currency1: log.args.currency1,
            fee: log.args.fee,
            tickSpacing: log.args.tickSpacing,
            hooks: log.args.hooks,
            pool: log.args.id,
          }).catch((err) => logger.error({ err: err.message }, "uniswap V4: handler threw"));
        }
      },
      onError: (err) => logger.error({ err: err.message }, "uniswap V4: watcher error"),
    })
  );

  logger.info(
    { v2: V2_FACTORY(), v3: V3_FACTORY(), v4: V4_POOL_MANAGER() },
    "uniswap discovery started (V2 + V3 + V4)"
  );
};

export const stopUniswapDiscovery = () => {
  for (const unwatch of unwatchers) { try { unwatch(); } catch {} }
  unwatchers = [];
};
