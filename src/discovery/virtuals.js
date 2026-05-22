import { readFileSync } from "node:fs";
import { parseAbi } from "viem";
import { config } from "../config.js";
import { publicClient } from "../core/rpc.js";
import { add, markExpired, STATUS } from "../core/tokenRegistry.js";
import { tryFireSniperBuy } from "../orchestrator/sniper.js";
import { logger } from "../util/logger.js";

// Use the BaseScan-fetched ABI so the complex `launchParams` tuple is decoded automatically.
const BONDING_ABI = JSON.parse(
  readFileSync(new URL("../../config/abis/BondingV5.json", import.meta.url), "utf8")
);

const ERC20_META_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const PRE_GRAD_ROUTER = () => config.chain.dexes.virtuals.preGradRouter;

const fetchMetadata = async (address) => {
  try {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "symbol" }),
      publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "decimals" }),
    ]);
    return { symbol, decimals: Number(decimals) };
  } catch (err) {
    logger.warn({ address, err: err.message }, "virtuals: failed to read token metadata");
    return null;
  }
};

// Exported so tests can drive the handler directly without spinning a real watcher.
export const handleLaunched = async ({ token }) => {
  const meta = await fetchMetadata(token);
  if (!meta) return { skipped: "no-metadata" };

  // Virtuals tokens follow the protocol's standard template — no rug surface. The bonding
  // curve is the trading venue and is operated by the protocol contracts directly. Skip the
  // safety probe and mark ACTIVE so the sniper fires immediately via the virtuals adapter
  // (BondingV5.buy is direct on-chain, no subgraph dependency).
  const status = STATUS.ACTIVE;
  add({
    address: token,
    symbol: meta.symbol,
    decimals: meta.decimals,
    tradeableOn: ["virtuals"],
    virtualsState: "pre-graduation",
    source: "virtuals-Launched",
    status,
  });
  logger.info(
    { token, symbol: meta.symbol, status },
    "virtuals: token discovery resolved"
  );

  tryFireSniperBuy({
    token: {
      address: token, symbol: meta.symbol, decimals: meta.decimals,
      tradeableOn: ["virtuals"], source: "virtuals-Launched",
    },
  }).catch((err) => logger.error({ err: err.message }, "sniper invocation threw"));

  return { added: true, status };
};

export const handleGraduated = ({ token }) => {
  // Post-grad routing (OKX-aggregated) is out of scope, so we expire the registry entry. If
  // we later add post-grad support, switch this to update tradeableOn instead of expiring.
  markExpired({ address: token, reason: "graduated-to-uniswap" });
  return { expired: true };
};

let watchers = [];

export const startVirtualsDiscovery = () => {
  if (watchers.length > 0) return;
  const router = PRE_GRAD_ROUTER();

  watchers.push(
    publicClient.watchContractEvent({
      address: router,
      abi: BONDING_ABI,
      eventName: "Launched",
      onLogs: (logs) => {
        for (const log of logs) {
          handleLaunched({ token: log.args.token }).catch((err) =>
            logger.error({ err: err.message, token: log.args.token }, "virtuals: handleLaunched threw")
          );
        }
      },
      onError: (err) => logger.error({ err: err.message }, "virtuals: Launched watcher error"),
    })
  );

  watchers.push(
    publicClient.watchContractEvent({
      address: router,
      abi: BONDING_ABI,
      eventName: "Graduated",
      onLogs: (logs) => {
        for (const log of logs) {
          try { handleGraduated({ token: log.args.token }); }
          catch (err) { logger.error({ err: err.message, token: log.args.token }, "virtuals: handleGraduated threw"); }
        }
      },
      onError: (err) => logger.error({ err: err.message }, "virtuals: Graduated watcher error"),
    })
  );

  logger.info({ contract: router, events: ["Launched", "Graduated"] }, "virtuals discovery started");
};

export const stopVirtualsDiscovery = () => {
  for (const unwatch of watchers) {
    try { unwatch(); } catch {}
  }
  watchers = [];
};
