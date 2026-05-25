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
import { deleteApprovalsForToken } from "../core/db.js";
import { publicClient } from "../core/rpc.js";
import { _listAll, add, markExpired, STATUS } from "../core/tokenRegistry.js";
import { tryFireSniperBuy } from "../orchestrator/sniper.js";
import { logger } from "../util/logger.js";
import { logWatcherError } from "../util/watcherErrors.js";
import { tokenHasExistingPools } from "./poolExistence.js";
import { detectV3Pool, resolveV4PoolKeyViaQuoter } from "./v4PoolKey.js";
import { startV4Poll } from "./v4Poller.js";

const AirlockCreate = parseAbiItem(
  "event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)"
);
const AirlockMigrate = parseAbiItem(
  "event Migrate(address indexed asset, address indexed pool)"
);

// Doppler's anti-sniper hook is structurally more aggressive than Clanker's MEV module.
// v13.3 extended the polling window to 5min hoping to catch more pools opening up — a
// full session at that setting (~1.5h, 348 polls, 0 successful Doppler buys) showed the
// extra wait does NOT improve success; the hook keeps the pool closed well past 5min in
// nearly every case observed. Reverted to a 30s fail-fast default so we stop burning RPC
// quota chasing pools that won't open. Still configurable via DOPPLER_POLL_MAX_MS for
// experimentation; raise it back to 300_000 if a future hook update changes the picture.
const DOPPLER_POLL_INTERVAL_MS = 5000;
const DOPPLER_POLL_MAX_MS = Number(process.env.DOPPLER_POLL_MAX_MS ?? 30_000);
const DOPPLER_POLL_MAX_ATTEMPTS = Math.max(1, Math.ceil(DOPPLER_POLL_MAX_MS / DOPPLER_POLL_INTERVAL_MS));

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

  // Doppler launches use standard ERC20 templates — the token contract itself has no rug
  // surface. The V4 hook may have an anti-snipe window, but that's a delay not a hazard.
  // Skip safety and mark ACTIVE so the sniper fires; revert losses on hook-blocked phases
  // are limited to gas estimation since eth_estimateGas fails before broadcast.
  const status = STATUS.ACTIVE;
  const source = `doppler-${labelForInitializer(initializer)}`;

  // Resolve the actual pool topology so directSwap can fire without AlphaRouter.
  // `poolOrHook` is either a V3 pool address or a V4 hook. Probe V3 first (cheap, 3 reads);
  // if that reverts assume V4 and brute-force the PoolKey via Quoter. If even Quoter rejects
  // (hook MEV window, uninitialized, unknown config), start a background poll that retries
  // until either the pool accepts or the timeout fires.

  const baseToken = {
    address: asset, symbol: meta.symbol, decimals: meta.decimals,
    tradeableOn: ["uniswap"], source,
  };
  const fireSniper = (poolMetadata, reason) => {
    if (reason) {
      logger.info({ asset, symbol: meta.symbol, reason }, "doppler: firing sniper after poll");
    }
    tryFireSniperBuy({ token: { ...baseToken, poolMetadata } })
      .catch((err) => logger.error({ err: err.message }, "sniper invocation threw"));
  };

  const v3Probe = await detectV3Pool({ poolAddress: poolOrHook, publicClient });
  if (v3Probe) {
    const poolMetadata = {
      version: "v3",
      pool: v3Probe.pool,
      fee: v3Probe.fee,
      token0: v3Probe.token0,
      token1: v3Probe.token1,
    };
    add({ ...baseToken, status, poolMetadata });
    logger.info(
      { asset, symbol: meta.symbol, status, source, initializer, poolOrHook,
        poolVersion: "v3", poolKeyResolved: true },
      "doppler: discovery resolved"
    );
    fireSniper(poolMetadata);
    return { added: true, status, source, initializer, poolOrHook };
  }

  // V3 probe failed → it's a V4 hook. Try the full Quoter brute-force.
  const v4Match = await resolveV4PoolKeyViaQuoter({
    tokenIn: numeraire, tokenOut: asset, hooks: poolOrHook,
    publicClient, quoter: config.chain.dexes.uniswap.v4Quoter,
  });

  if (v4Match) {
    const poolMetadata = {
      version: "v4",
      poolId: v4Match.poolId,
      currency0: v4Match.currency0,
      currency1: v4Match.currency1,
      fee: v4Match.fee,
      tickSpacing: v4Match.tickSpacing,
      hooks: v4Match.hooks,
    };
    add({ ...baseToken, status, poolMetadata });
    logger.info(
      { asset, symbol: meta.symbol, status, source, initializer, poolOrHook,
        poolVersion: "v4", poolKeyResolved: true,
        fee: v4Match.fee, tickSpacing: v4Match.tickSpacing },
      "doppler: discovery resolved"
    );
    fireSniper(poolMetadata);
    return { added: true, status, source, initializer, poolOrHook };
  }

  // Neither V3 nor an initial V4 candidate quote returned. Register as pending and start a
  // background poll: retry the full V4 brute-force every ~5s until the hook lets us in or
  // we time out. AlphaRouter is not invoked in this path — the sniper only fires from
  // the poll's onReady callback.
  const pendingMetadata = {
    version: "v4-or-v3", poolOrHook, pairedToken: numeraire,
    tokenAddress: asset, pending: true,
  };
  add({ ...baseToken, status, poolMetadata: pendingMetadata });
  logger.info(
    { asset, symbol: meta.symbol, status, source, initializer, poolOrHook,
      poolVersion: "v4-or-v3", poolKeyResolved: false },
    "doppler: discovery resolved (polling will retry)"
  );

  startV4Poll({
    probe: async (attempt) => {
      const m = await resolveV4PoolKeyViaQuoter({
        tokenIn: numeraire, tokenOut: asset, hooks: poolOrHook,
        publicClient, quoter: config.chain.dexes.uniswap.v4Quoter,
      });
      if (m) return { attempt, match: m };
      return null;
    },
    onReady: ({ match }, attempts) => {
      const poolMetadata = {
        version: "v4",
        poolId: match.poolId,
        currency0: match.currency0, currency1: match.currency1,
        fee: match.fee, tickSpacing: match.tickSpacing, hooks: match.hooks,
      };
      add({ ...baseToken, status, poolMetadata });
      logger.info(
        { asset, symbol: meta.symbol, attempts, fee: match.fee, tickSpacing: match.tickSpacing,
          probeAmountOut: match.probeAmountOut?.toString() },
        "doppler: pool became tradeable — firing sniper"
      );
      fireSniper(poolMetadata, "poll-success");
    },
    onTimeout: (attempts) => {
      // Quoter never accepted within the window → structurally blocked. Mark EXPIRED so the
      // registry doesn't keep a stale ACTIVE row until the sweeper's TTL eviction (up to 48h).
      // Drop any cached approvals too (defensive — we never traded, so usually none exist).
      markExpired({ address: asset, reason: `doppler-poll-timeout (${attempts} attempts, ${DOPPLER_POLL_MAX_MS}ms)` });
      deleteApprovalsForToken(asset);
      logger.warn(
        { asset, symbol: meta.symbol, attempts, windowMs: DOPPLER_POLL_MAX_MS },
        "doppler: Quoter never accepted after polling — sniper skipped, token marked expired"
      );
    },
    options: {
      intervalMs: DOPPLER_POLL_INTERVAL_MS,
      maxAttempts: DOPPLER_POLL_MAX_ATTEMPTS,
    },
  });

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
      onError: (err) => logWatcherError(logger, err, "doppler/airlock-create: watcher error"),
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
      onError: (err) => logWatcherError(logger, err, "doppler/airlock-migrate: watcher error"),
    })
  );

  logger.info({ contract: addr, events: ["Create", "Migrate"] }, "doppler discovery started");
};

export const stopBankrDiscovery = () => {
  for (const unwatch of watchers) { try { unwatch(); } catch {} }
  watchers = [];
};
