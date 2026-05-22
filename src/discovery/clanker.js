// Clanker launchpad on Base — factory 0xE85A…83a9. Deploys an ERC20 + a V4 pool atomically;
// every TokenCreated event is by definition a fresh listing (no prior pool can exist for that
// address). Trades settle via standard Uniswap Universal Router so the adapter is "uniswap".
import { parseAbiItem } from "viem";
import { config } from "../config.js";
import { publicClient } from "../core/rpc.js";
import { add, STATUS } from "../core/tokenRegistry.js";
import { tryFireSniperBuy } from "../orchestrator/sniper.js";
import { logger } from "../util/logger.js";
import { quoteV4Pool, resolveV4PoolKey } from "./v4PoolKey.js";
import { startV4Poll } from "./v4Poller.js";

const TokenCreated = parseAbiItem(
  "event TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24 startingTick, address poolHook, bytes32 poolId, address pairedToken, address locker, address mevModule, uint256 extensionsSupply, address[] extensions)"
);

const NATIVE_ZERO = "0x0000000000000000000000000000000000000000";
const FACTORY = () => config.chain.dexes.clanker.factory;
const WETH = () => config.chain.wnative.toLowerCase();

const isWethOrNative = (addr) => {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a === WETH() || a === NATIVE_ZERO;
};

// TokenCreated carries symbol directly — no follow-up ERC20 metadata call needed. We do still
// need decimals; Clanker uses 18 by convention (the Clanker ERC20 template hardcodes it), so
// we skip the round-trip and assume 18. If a non-standard Clanker variant appears we'll catch
// the trade failures at execution time.
export const handleTokenCreated = async ({ tokenAddress, tokenSymbol, pairedToken, poolId, poolHook }) => {
  if (!isWethOrNative(pairedToken)) return { skipped: "non-weth-paired-token" };

  // Clanker uses a fixed ERC20 template — no rug surface at the token level. Skip the safety
  // probe and mark ACTIVE immediately so the sniper fires before the subgraph catches up.
  const status = STATUS.ACTIVE;

  // Reconstruct the full V4 PoolKey by brute-forcing (fee, tickSpacing) against the known
  // poolId hash. When this succeeds (~95%+ of Clanker pools — they share one canonical
  // config) the sniper buy uses directSwap V4 instantly with no AlphaRouter dependency.
  const resolved = resolveV4PoolKey({
    tokenA: tokenAddress,
    tokenB: pairedToken,
    hooks: poolHook,
    expectedPoolId: poolId,
  });

  // Register the token as pending immediately so the registry has it. If the Quoter probe
  // succeeds (now or after the MEV window closes) we upgrade the entry with full metadata
  // and fire the sniper.
  const baseToken = {
    address: tokenAddress, symbol: tokenSymbol, decimals: 18,
    tradeableOn: ["uniswap"], source: "clanker-v4",
  };

  // If hash-match itself fails (unknown Clanker config) — register pending, fire sniper which
  // will fall back to AlphaRouter. No point polling because we don't have a verified PoolKey.
  if (!resolved) {
    const poolMetadata = {
      version: "v4", poolId, hooks: poolHook, pairedToken, tokenAddress, pending: true,
    };
    add({ ...baseToken, status, poolMetadata });
    logger.info(
      { token: tokenAddress, symbol: tokenSymbol, source: "clanker-v4", status, poolId, poolHook, poolKeyResolved: false },
      "clanker: discovery resolved"
    );
    tryFireSniperBuy({ token: { ...baseToken, poolMetadata } })
      .catch((err) => logger.error({ err: err.message }, "sniper invocation threw"));
    return { added: true, status };
  }

  // Hash matched — store the full PoolKey and probe via Quoter. The Clanker MEV hook usually
  // blocks the first ~10-30 seconds of swaps, so a single probe often reverts. We register
  // the token first, then run a background poll that fires the sniper once Quoter accepts.
  const fullPoolMetadata = {
    version: "v4", poolId,
    currency0: resolved.currency0, currency1: resolved.currency1,
    fee: resolved.fee, tickSpacing: resolved.tickSpacing, hooks: resolved.hooks,
  };
  add({ ...baseToken, status, poolMetadata: fullPoolMetadata });

  const zeroForOne = pairedToken.toLowerCase() === resolved.currency0.toLowerCase();
  const quoteOnce = () => quoteV4Pool({
    poolKey: {
      currency0: resolved.currency0, currency1: resolved.currency1,
      fee: resolved.fee, tickSpacing: resolved.tickSpacing, hooks: resolved.hooks,
    },
    amountIn: 100_000_000_000_000n, // 0.0001 ETH probe
    zeroForOne, publicClient,
    quoter: config.chain.dexes.uniswap.v4Quoter,
  });

  logger.info(
    {
      token: tokenAddress, symbol: tokenSymbol, source: "clanker-v4", status, poolId, poolHook,
      poolKeyResolved: true, fee: resolved.fee, tickSpacing: resolved.tickSpacing,
    },
    "clanker: discovery resolved"
  );

  startV4Poll({
    probe: async (attempt) => {
      const q = await quoteOnce();
      if (q && q.amountOut > 0n) return { attempt, amountOut: q.amountOut };
      return null;
    },
    onReady: (result, attempts) => {
      logger.info(
        { token: tokenAddress, symbol: tokenSymbol, attempts, amountOut: result.amountOut.toString() },
        "clanker: pool became tradeable — firing sniper"
      );
      tryFireSniperBuy({ token: { ...baseToken, poolMetadata: fullPoolMetadata } })
        .catch((err) => logger.error({ err: err.message }, "sniper invocation threw"));
    },
    onTimeout: (attempts) => {
      logger.warn(
        { token: tokenAddress, symbol: tokenSymbol, attempts },
        "clanker: Quoter never accepted after MEV window — sniper skipped"
      );
    },
  });

  return { added: true, status };
};

let unwatch = null;

export const startClankerDiscovery = () => {
  if (unwatch) return;
  unwatch = publicClient.watchEvent({
    address: FACTORY(),
    event: TokenCreated,
    onLogs: (logs) => {
      for (const log of logs) {
        handleTokenCreated({
          tokenAddress: log.args.tokenAddress,
          tokenSymbol: log.args.tokenSymbol,
          pairedToken: log.args.pairedToken,
          poolId: log.args.poolId,
          poolHook: log.args.poolHook,
        }).catch((err) => logger.error({ err: err.message }, "clanker: handler threw"));
      }
    },
    onError: (err) => logger.error({ err: err.message }, "clanker: watcher error"),
  });
  logger.info({ contract: FACTORY() }, "clanker discovery started");
};

export const stopClankerDiscovery = () => {
  if (unwatch) { unwatch(); unwatch = null; }
};
