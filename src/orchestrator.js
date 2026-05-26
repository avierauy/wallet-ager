import { config } from "./config.js";
import { fetchBalances } from "./core/balances.js";
import { executeAction } from "./core/executor.js";
import { getActive as getActiveTokens } from "./core/tokenRegistry.js";
import { scheduleSell } from "./orchestrator/sniper.js";
import { canTrade, getDailyState, recordTrade } from "./strategy/dailyCounter.js";
import { planAction } from "./strategy/planner.js";
import { initialDelayMs, isWithinActiveHours, nextDelayMs } from "./strategy/scheduler.js";
import { logger } from "./util/logger.js";
import { inc, recordTickDuration } from "./util/metrics.js";
import { createSemaphore } from "./util/semaphore.js";

const INACTIVE_RECHECK_MS = 15 * 60 * 1000;
const NO_DEX_RECHECK_MS = 60 * 60 * 1000;

// Post-grad (OKX-routed) was scoped out — Virtuals here covers pre-grad only.
const buildEnabledDexes = () => {
  const enabled = ["uniswap", "virtuals"];
  if (config.apis.zeroEx) enabled.push("bankr");
  return enabled;
};

const filterDexWeights = (weights, enabled) =>
  Object.fromEntries(Object.entries(weights).filter(([dex]) => enabled.includes(dex)));

export const runOneTick = async ({ wallet, rng, tokens }) => {
  const enabled = buildEnabledDexes();
  const nowHour = new Date().getUTCHours();
  if (!isWithinActiveHours(nowHour, wallet.profile.activeHoursUtc)) {
    return { status: "outside-active-hours" };
  }

  const effectiveWeights = filterDexWeights(wallet.profile.dexWeights, enabled);
  if (Object.values(effectiveWeights).reduce((s, n) => s + n, 0) === 0) {
    logger.warn({ walletId: wallet.id }, "no enabled DEXes for this wallet");
    return { status: "no-enabled-dex" };
  }
  const effectiveProfile = { ...wallet.profile, dexWeights: effectiveWeights };

  // Snapshot the registry per tick so newly discovered tokens become tradeable immediately.
  // `tokens` is reserved for tests / smoke flows that want to inject a fixed set.
  const activeTokens = tokens ?? getActiveTokens();

  const { native, byToken } = await fetchBalances({ account: wallet.account, tokens: activeTokens });
  const allowBuy = canTrade({ wallet, rng });
  const plan = planAction({
    profile: effectiveProfile,
    tokens: activeTokens,
    balances: byToken,
    nativeBalance: native,
    rng,
    allowBuy,
  });
  if (!plan) {
    logger.info(
      { walletId: wallet.id, nativeWei: native.toString(), allowBuy,
        remainingTradesToday: getDailyState({ wallet, rng })?.remaining },
      "no viable action this tick"
    );
    return { status: "no-plan" };
  }

  const result = await executeAction({ wallet, plan });
  if (plan.side === "buy" && (result.status === "submitted" || result.status === "dry-run")) {
    recordTrade({ wallet, rng });
  }
  // Aging-mode sell that didn't broadcast (failed: RPC/network) OR broadcast and reverted
  // (reverted: slippage, hook block) OR rejected pre-broadcast (pre-sim-reverted: hook
  // window) → hand off to the sniper's retry scheduler so the position doesn't sit until
  // the next aging tick (minutes-to-hours away). Sells never consume daily slots so we
  // can keep retrying without affecting the cap. The retry applies a slippage bump (v13.5)
  // which often clears slippage-style reverts; structural reverts (hook windows) only
  // clear with time and the v13.18 per-source retry window.
  if (plan.side === "sell"
      && (result.status === "failed" || result.status === "reverted" || result.status === "pre-sim-reverted")) {
    const sniper = wallet.profile.sniper ?? {};
    logger.info(
      { walletId: wallet.id, token: plan.token.symbol },
      "aging-mode sell failed — handing off to retry scheduler"
    );
    scheduleSell({
      wallet, token: plan.token, delayMs: 30_000, sniper, attempt: 2,
    });
  }
  return result;
};

// Singleton semaphore — bounds global concurrent ticks across all wallets.
let tickSem = null;
const getTickSem = () => {
  if (!tickSem) tickSem = createSemaphore(config.runtime.maxConcurrency);
  return tickSem;
};
export const _resetTickSem = () => { tickSem = null; };

export const startWalletLoop = ({ wallet, rng = Math.random }) => {
  const sem = getTickSem();

  const tick = async () => {
    const startMs = Date.now();
    let nextDelay;
    let result = { status: "unknown" };
    try {
      result = await sem.run(() => runOneTick({ wallet, rng }));
    } catch (err) {
      logger.error({ walletId: wallet.id, err: err.message }, "tick threw");
      inc("tick", { status: "threw" });
    } finally {
      recordTickDuration(Date.now() - startMs);
      inc("tick", { status: result.status });
    }
    nextDelay = result.status === "outside-active-hours"
      ? INACTIVE_RECHECK_MS
      : result.status === "no-enabled-dex"
        ? NO_DEX_RECHECK_MS
        : nextDelayMs({ profile: wallet.profile, rng });
    setTimeout(tick, nextDelay ?? 60_000);
  };

  setTimeout(tick, initialDelayMs({ profile: wallet.profile, rng }));
};
