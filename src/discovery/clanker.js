// Clanker launchpad on Base — factory 0xE85A…83a9. Deploys an ERC20 + a V4 pool atomically;
// every TokenCreated event is by definition a fresh listing (no prior pool can exist for that
// address). Trades settle via standard Uniswap Universal Router so the adapter is "uniswap".
import { parseAbiItem } from "viem";
import { config } from "../config.js";
import { publicClient } from "../core/rpc.js";
import { add, STATUS } from "../core/tokenRegistry.js";
import { tryFireSniperBuy } from "../orchestrator/sniper.js";
import { checkToken } from "../safety/index.js";
import { logger } from "../util/logger.js";

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

  const safety = await checkToken(tokenAddress);
  const status = safety.pending
    ? STATUS.PENDING
    : safety.safe
      ? STATUS.ACTIVE
      : STATUS.UNSAFE;

  add({
    address: tokenAddress,
    symbol: tokenSymbol,
    decimals: 18,
    tradeableOn: ["uniswap"],
    source: "clanker-v4",
    status,
  });
  logger.info(
    { token: tokenAddress, symbol: tokenSymbol, source: "clanker-v4", status, poolId, poolHook },
    "clanker: discovery resolved"
  );

  if (status === STATUS.ACTIVE) {
    tryFireSniperBuy({
      token: { address: tokenAddress, symbol: tokenSymbol, decimals: 18, tradeableOn: ["uniswap"] },
    }).catch((err) => logger.error({ err: err.message }, "sniper invocation threw"));
  }

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
