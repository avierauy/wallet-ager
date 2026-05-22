// Doppler Protocol Airlock listener. Doppler is the underlying launch protocol; Bankr is one
// of the front-ends that uses it (others may exist). We file this under "bankr.js" because
// Bankr was our entry point — the source labels and the migrate handler keep that relationship
// explicit:
//   doppler-bankr           — fresh launch where Bankr's initializer triggered Airlock.create
//   doppler-<other>         — fresh launch from a different known initializer
//   doppler-unknown         — initializer not in the known map
//   *-postgrad              — same as above, after the Airlock.Migrate event fires
//
// All Doppler-launched tokens settle into Uniswap V3/V4 pools, so they trade via the standard
// Uniswap adapter regardless of phase.
import { parseAbi, parseAbiItem } from "viem";
import { config } from "../config.js";
import { publicClient } from "../core/rpc.js";
import { _listAll, add, STATUS } from "../core/tokenRegistry.js";
import { tryFireSniperBuy } from "../orchestrator/sniper.js";
import { checkToken } from "../safety/index.js";
import { logger } from "../util/logger.js";
import { tokenHasExistingPools } from "./poolExistence.js";

const AirlockCreate = parseAbiItem(
  "event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)"
);
const AirlockMigrate = parseAbiItem(
  "event Migrate(address indexed asset, address indexed pool)"
);

const ERC20_META_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const AIRLOCK = () => config.chain.dexes.doppler.airlock;
const KNOWN_INITIALIZERS = () => config.chain.dexes.doppler.knownInitializers ?? {};
const WETH = () => config.chain.wnative.toLowerCase();
const NATIVE_ZERO = "0x0000000000000000000000000000000000000000";

const isWethOrNative = (addr) => {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a === WETH() || a === NATIVE_ZERO;
};

const labelForInitializer = (initializer) => {
  const map = KNOWN_INITIALIZERS();
  const key = Object.keys(map).find((k) => k.toLowerCase() === (initializer || "").toLowerCase());
  return key ? map[key] : "unknown";
};

const fetchMetadata = async (address) => {
  try {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "symbol" }),
      publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "decimals" }),
    ]);
    return { symbol, decimals: Number(decimals) };
  } catch (err) {
    logger.warn({ address, err: err.message }, "doppler: metadata read failed");
    return null;
  }
};

export const handleAirlockCreate = async ({ asset, numeraire, initializer, poolOrHook }) => {
  if (!isWethOrNative(numeraire)) return { skipped: "non-weth-numeraire" };

  // First-listing filter — defensive. Airlock.Create should only fire for fresh deploys, but
  // the check costs us 5 reads and prevents weird re-registers if Doppler ever supports it.
  const existing = await tokenHasExistingPools({ tokenAddr: asset, excludePool: poolOrHook });
  if (existing.exists) {
    logger.info(
      { asset, alreadyAt: existing.where, initializer, poolOrHook },
      "doppler: skipping — token already tradeable elsewhere"
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
  const source = `doppler-${labelForInitializer(initializer)}`;
  add({
    address: asset,
    symbol: meta.symbol,
    decimals: meta.decimals,
    tradeableOn: ["uniswap"],
    source,
    status,
  });
  logger.info(
    { asset, symbol: meta.symbol, status, source, initializer, poolOrHook },
    "doppler: discovery resolved"
  );

  if (status === STATUS.ACTIVE) {
    tryFireSniperBuy({
      token: { address: asset, symbol: meta.symbol, decimals: meta.decimals, tradeableOn: ["uniswap"] },
    }).catch((err) => logger.error({ err: err.message }, "sniper invocation threw"));
  }

  return { added: true, status, source, initializer, poolOrHook };
};

// When Airlock.Migrate fires, the token transitions from "anti-sniper phase" to "open pool".
// We append "-postgrad" to the source label to make the lifecycle visible in metrics.
export const handleAirlockMigrate = async ({ asset, pool }) => {
  const existing = _listAll().find((t) => t.address.toLowerCase() === asset.toLowerCase());
  if (!existing) {
    logger.info({ asset, pool }, "doppler: Migrate for token not in registry — ignoring");
    return { skipped: "not-in-registry" };
  }
  if (existing.source?.endsWith("-postgrad")) return { skipped: "already-postgrad" };
  const newSource = `${existing.source}-postgrad`;
  add({
    address: existing.address,
    symbol: existing.symbol,
    decimals: existing.decimals,
    tradeableOn: existing.tradeableOn,
    source: newSource,
    status: STATUS.ACTIVE, // any active token migrating stays active; pending ones get a re-check on next sweep
  });
  logger.info(
    { asset, pool, source: newSource, from: existing.source },
    "doppler: token migrated to postgrad"
  );
  return { migrated: true, source: newSource };
};

let watchers = [];

export const startBankrDiscovery = () => {
  if (watchers.length > 0) return;
  const addr = AIRLOCK();

  watchers.push(
    publicClient.watchEvent({
      address: addr,
      event: AirlockCreate,
      onLogs: (logs) => {
        for (const log of logs) {
          handleAirlockCreate({
            asset: log.args.asset,
            numeraire: log.args.numeraire,
            initializer: log.args.initializer,
            poolOrHook: log.args.poolOrHook,
          }).catch((err) => logger.error({ err: err.message }, "doppler/airlock-create: handler threw"));
        }
      },
      onError: (err) => logger.error({ err: err.message }, "doppler/airlock-create: watcher error"),
    })
  );

  watchers.push(
    publicClient.watchEvent({
      address: addr,
      event: AirlockMigrate,
      onLogs: (logs) => {
        for (const log of logs) {
          handleAirlockMigrate({ asset: log.args.asset, pool: log.args.pool })
            .catch((err) => logger.error({ err: err.message }, "doppler/airlock-migrate: handler threw"));
        }
      },
      onError: (err) => logger.error({ err: err.message }, "doppler/airlock-migrate: watcher error"),
    })
  );

  logger.info({ contract: addr, events: ["Create", "Migrate"] }, "doppler discovery started");
};

export const stopBankrDiscovery = () => {
  for (const unwatch of watchers) { try { unwatch(); } catch {} }
  watchers = [];
};
