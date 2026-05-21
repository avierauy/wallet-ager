// Periodic re-safety + TTL eviction for discovered tokens.
//
// Every DISCOVERY_RECHECK_HOURS:
//   - For each active discovered token:
//     - If untraded for > DISCOVERY_TTL_HOURS (counting from discovery if never traded),
//       mark EXPIRED — keeps the registry from growing unbounded with stale picks.
//     - Else re-run the safety check appropriate to its dex (bonding curve for virtuals,
//       honeypot.is for uniswap). If now unsafe, mark UNSAFE.
//     - Otherwise refresh safety_checked_at and leave it active.
import { config } from "../config.js";
import {
  _listAll,
  markExpired,
  markUnsafe,
  refreshSafetyChecked,
  STATUS,
} from "../core/tokenRegistry.js";
import { checkToken } from "../safety/honeypot.js";
import { checkBondingCurve } from "../safety/virtuals.js";
import { logger } from "../util/logger.js";
import { inc } from "../util/metrics.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

const pickSafetyCheck = (token) => {
  if (token.tradeableOn?.includes("virtuals")) return () => checkBondingCurve({ agentToken: token.address });
  if (token.tradeableOn?.includes("uniswap")) return () => checkToken(token.address);
  return null;
};

const lastActivityMs = (token) => token.lastTradedAt ?? token.discoveredAt ?? 0;

export const sweepOnce = async ({ now = Date.now(), ttlHours = config.discovery.ttlHours } = {}) => {
  const ttlMs = ttlHours * ONE_HOUR_MS;
  const SWEEP_STATUSES = new Set(["active", "pending"]); // UNSAFE/EXPIRED are terminal
  const all = _listAll();
  // _listAll returns the latest snapshot but doesn't carry status field on the token shape, so
  // we re-query each row's status from the registry helpers via getActive() set membership and
  // explicit DB read. Simpler: filter on tokens we know are still mutable.
  const tokens = all.filter((t) => t.source);
  const { listDiscoveredTokens } = await import("../core/db.js");
  const statusByAddr = new Map(
    listDiscoveredTokens({ chain: config.chain.name }).map((r) => [r.address.toLowerCase(), r.status])
  );

  let expired = 0;
  let rechecked = 0;
  let markedUnsafe = 0;
  let markedActive = 0;
  let stillPending = 0;
  let skipped = 0;

  for (const token of tokens) {
    const status = statusByAddr.get(token.address.toLowerCase());
    if (!SWEEP_STATUSES.has(status)) { skipped++; continue; }

    // TTL check first (cheap, no network).
    const idleMs = now - lastActivityMs(token);
    if (idleMs > ttlMs) {
      markExpired({ address: token.address, reason: `idle ${Math.round(idleMs / ONE_HOUR_MS)}h > ttl ${ttlHours}h` });
      expired++;
      inc("discovery-sweep", { outcome: "expired" });
      continue;
    }

    const check = pickSafetyCheck(token);
    if (!check) { skipped++; continue; }

    try {
      const verdict = await check();
      if (verdict.pending) {
        // Still not indexed by honeypot.is. Leave as-is; TTL handles eviction if it never resolves.
        stillPending++;
        inc("discovery-sweep", { outcome: "still-pending" });
        continue;
      }
      if (!verdict.safe) {
        markUnsafe({ address: token.address, reason: (verdict.reasons || []).join("; ") });
        markedUnsafe++;
        inc("discovery-sweep", { outcome: "unsafe" });
        continue;
      }
      // Safe verdict. Promote pending → active, or just refresh active.
      if (status === "pending") {
        const { add } = await import("../core/tokenRegistry.js");
        add({
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
          tradeableOn: token.tradeableOn,
          virtualsState: token.virtualsState,
          source: token.source,
          status: "active",
        });
        markedActive++;
        inc("discovery-sweep", { outcome: "promoted-active" });
      } else {
        refreshSafetyChecked({ address: token.address });
        rechecked++;
        inc("discovery-sweep", { outcome: "still-safe" });
      }
    } catch (err) {
      logger.warn({ token: token.address, err: err.message }, "sweeper: safety check threw");
      inc("discovery-sweep", { outcome: "check-error" });
    }
  }

  const summary = {
    total: tokens.length,
    expired, rechecked, markedUnsafe, markedActive, stillPending, skipped,
  };
  logger.info(summary, "discovery sweep complete");
  return summary;
};

let intervalHandle = null;

export const startSweeper = () => {
  if (intervalHandle) return;
  const hours = config.discovery.recheckHours;
  if (!hours || hours <= 0) {
    logger.info("discovery sweeper disabled (DISCOVERY_RECHECK_HOURS=0)");
    return;
  }
  // Run once at startup so freshly resumed daemons evict stale rows before any trading.
  sweepOnce().catch((err) => logger.error({ err: err.message }, "initial sweep threw"));
  intervalHandle = setInterval(
    () => sweepOnce().catch((err) => logger.error({ err: err.message }, "sweep threw")),
    hours * ONE_HOUR_MS
  );
  logger.info({ everyHours: hours, ttlHours: config.discovery.ttlHours }, "discovery sweeper started");
};

export const stopSweeper = () => {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
};
