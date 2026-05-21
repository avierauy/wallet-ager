import { config } from "./config.js";
import { fetchBalances } from "./core/balances.js";
import { executeAction } from "./core/executor.js";
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

export const runOneTick = async ({ wallet, tokens, rng }) => {
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

  const { native, byToken } = await fetchBalances({ account: wallet.account, tokens });
  const plan = planAction({
    profile: effectiveProfile,
    tokens,
    balances: byToken,
    nativeBalance: native,
    rng,
  });
  if (!plan) {
    logger.info({ walletId: wallet.id, nativeWei: native.toString() }, "no viable action this tick");
    return { status: "no-plan" };
  }

  return executeAction({ wallet, plan });
};

// Singleton semaphore — bounds global concurrent ticks across all wallets.
let tickSem = null;
const getTickSem = () => {
  if (!tickSem) tickSem = createSemaphore(config.runtime.maxConcurrency);
  return tickSem;
};
export const _resetTickSem = () => { tickSem = null; };

export const startWalletLoop = ({ wallet, tokens, rng = Math.random }) => {
  const sem = getTickSem();

  const tick = async () => {
    const startMs = Date.now();
    let nextDelay;
    let result = { status: "unknown" };
    try {
      result = await sem.run(() => runOneTick({ wallet, tokens, rng }));
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
