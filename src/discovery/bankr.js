// Bankr deploys tokens through Doppler Protocol's Airlock (0x660e…8D12 on Base).
// We listen to Airlock.Create(asset, indexed numeraire, initializer, poolOrHook) — fires for
// every Doppler-launched token, regardless of which front-end (Bankr, others) triggered it.
//
// `numeraire` is the quote token (typically WETH); we only register pairs we can sell back to
// native. `poolOrHook` is either a Uniswap V3 pool or a V4 hook depending on the launch config.
// Doppler tokens trade through Uniswap so we register with tradeableOn=["uniswap"].
import { parseAbiItem, parseAbi } from "viem";
import { config } from "../config.js";
import { publicClient } from "../core/rpc.js";
import { add, STATUS } from "../core/tokenRegistry.js";
import { checkToken } from "../safety/index.js";
import { logger } from "../util/logger.js";
import { tokenHasExistingPools } from "./poolExistence.js";

const AirlockCreate = parseAbiItem(
  "event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)"
);

const ERC20_META_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const AIRLOCK = () => config.chain.dexes.bankr.airlock;
const WETH = () => config.chain.wnative.toLowerCase();
const NATIVE_ZERO = "0x0000000000000000000000000000000000000000";

const isWethOrNative = (addr) => {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a === WETH() || a === NATIVE_ZERO;
};

const fetchMetadata = async (address) => {
  try {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "symbol" }),
      publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "decimals" }),
    ]);
    return { symbol, decimals: Number(decimals) };
  } catch (err) {
    logger.warn({ address, err: err.message }, "bankr/airlock: metadata read failed");
    return null;
  }
};

export const handleAirlockCreate = async ({ asset, numeraire, initializer, poolOrHook }) => {
  if (!isWethOrNative(numeraire)) return { skipped: "non-weth-numeraire" };

  // First-listing filter — defends against the case where a Doppler relaunch happens for an
  // already-tradeable token. (Airlock theoretically only fires for fresh deploys, but this is
  // cheap and consistent with the uniswap handlers.)
  const existing = await tokenHasExistingPools({ tokenAddr: asset, excludePool: poolOrHook });
  if (existing.exists) {
    logger.info(
      { asset, alreadyAt: existing.where, initializer, poolOrHook },
      "bankr/airlock: skipping — token already tradeable elsewhere"
    );
    return { skipped: "already-tradeable-elsewhere", existing };
  }

  const meta = await fetchMetadata(asset);
  if (!meta) return { skipped: "no-metadata" };

  const safety = await checkToken(asset);
  const status = safety.pending
    ? STATUS.PENDING
    : safety.safe
      ? STATUS.ACTIVE
      : STATUS.UNSAFE;
  add({
    address: asset,
    symbol: meta.symbol,
    decimals: meta.decimals,
    tradeableOn: ["uniswap"], // Doppler launches settle into V3 or V4 pools
    source: "bankr-airlock",
    status,
  });
  logger.info(
    { asset, symbol: meta.symbol, status, initializer, poolOrHook },
    "bankr/airlock: discovery resolved"
  );
  return { added: true, status, initializer, poolOrHook };
};

let unwatch = null;

export const startBankrDiscovery = () => {
  if (unwatch) return;
  unwatch = publicClient.watchEvent({
    address: AIRLOCK(),
    event: AirlockCreate,
    onLogs: (logs) => {
      for (const log of logs) {
        handleAirlockCreate({
          asset: log.args.asset,
          numeraire: log.args.numeraire,
          initializer: log.args.initializer,
          poolOrHook: log.args.poolOrHook,
        }).catch((err) => logger.error({ err: err.message }, "bankr/airlock: handler threw"));
      }
    },
    onError: (err) => logger.error({ err: err.message }, "bankr/airlock: watcher error"),
  });
  logger.info({ contract: AIRLOCK() }, "bankr discovery started (Doppler Airlock)");
};

export const stopBankrDiscovery = () => {
  if (unwatch) { unwatch(); unwatch = null; }
};
