// Sniper mode — fires a buy as soon as a fresh token reaches ACTIVE status, then schedules
// a sell after a random delay. Lives alongside the per-wallet aging scheduler:
//   - Aging tick    : periodic, random token from full registry, simulates a "human trader"
//   - Sniper trigger: event-driven, fires on every active fresh launch, simulates a "degen
//                     hunter" who watches new pools and buys quickly
//
// Per-wallet cooldown prevents one wallet from sniping every fresh token in a row. Pending
// sells are setTimeout-based: if the daemon restarts, in-flight sells are lost (the aging
// scheduler will eventually sell residuals).
import { erc20Abi } from "viem";
import { config } from "../config.js";
import { executeAction as defaultExecuteAction } from "../core/executor.js";
import { publicClient as defaultPublicClient } from "../core/rpc.js";
import { notifyError } from "../notify/telegram.js";
import { getDailyState, recordTrade } from "../strategy/dailyCounter.js";

// Dependency injection — lets tests substitute executeAction + publicClient without touching
// ESM module bindings. Production code uses the defaults.
const deps = { executeAction: defaultExecuteAction, publicClient: defaultPublicClient };
export const _setDeps = (overrides) => Object.assign(deps, overrides);
export const _resetDeps = () => {
  deps.executeAction = defaultExecuteAction;
  deps.publicClient = defaultPublicClient;
};
import { ethFloatToWei, sampleUniform, sampleUniformInt } from "../strategy/randomizer.js";
import { isWithinActiveHours } from "../strategy/scheduler.js";
import { logger } from "../util/logger.js";
import { inc } from "../util/metrics.js";

const DEFAULT_SNIPER = {
  enabled: false,
  cooldownMin: 5,             // min minutes between snipes per wallet
  sellDelayMin: [10, 60],     // [low, high] minutes between buy and sell
  amountRangeNativeEth: null, // falls back to profile.amountRangeNativeEth
  sellSlippageBps: 300,       // wider than aging sells — fresh tokens move fast
};

let walletsRef = [];
const sniperState = new Map();  // walletId → { lastSnipeAt }
const pendingSells = new Map(); // "walletId:tokenAddr" → timeout handle

// In-memory slot reservations to close the race between picking a wallet and the
// executor's insertTrade row landing in the DB. Without this, a burst of fresh-token
// discoveries (Clanker pool launches arrive in clusters) would let several
// tryFireSniperBuy calls each pass canTrade() before any of their trade rows hit
// the trades table, allowing a wallet to exceed its daily cap by N-1 buys.
//
// Lifecycle: incremented in tryFireSniperBuy right after pickWallet, decremented
// in the finally block once executeAction returns (any outcome). The reservation
// only needs to cover the window between pickWallet and insertTrade — after the
// trade row exists, getDailyState reads the authoritative count from DB.
const reservedSlots = new Map(); // walletId → number of in-flight buy attempts

export const initSniper = (wallets) => {
  walletsRef = wallets;
  const enabledCount = wallets.filter((w) => w.profile.sniper?.enabled).length;
  logger.info({ totalWallets: wallets.length, snipersEnabled: enabledCount }, "sniper initialized");
};

const profileSniper = (wallet) => ({ ...DEFAULT_SNIPER, ...(wallet.profile.sniper || {}) });

const isEligible = (wallet, nowMs) => {
  const sniper = profileSniper(wallet);
  if (!sniper.enabled) return false;
  const nowHour = new Date(nowMs).getUTCHours();
  if (!isWithinActiveHours(nowHour, wallet.profile.activeHoursUtc)) return false;
  const last = sniperState.get(wallet.id);
  if (last && nowMs - last.lastSnipeAt < sniper.cooldownMin * 60 * 1000) return false;
  // Daily round-trip cap applies to BOTH sniper and aging flows — a buy consumes one slot
  // regardless of source. Sells (scheduled or retried) never consume slots. We include
  // in-flight reservations so concurrent Clanker bursts cannot all pass this check before
  // any of their trade rows reach the DB.
  const state = getDailyState({ wallet });
  if (!state) return false;
  const reserved = reservedSlots.get(wallet.id) ?? 0;
  if (state.used + reserved >= state.allowance) return false;
  return true;
};

const pickWallet = (rng) => {
  const now = Date.now();
  const eligible = walletsRef.filter((w) => isEligible(w, now));
  if (eligible.length === 0) return null;
  return eligible[Math.floor(rng() * eligible.length)];
};

// Public entry — fire-and-forget from the discovery handlers. Returns a result object so
// tests can assert on it; callers should NOT await unless they care about the outcome.
export const tryFireSniperBuy = async ({ token, rng = Math.random }) => {
  if (walletsRef.length === 0) {
    return { skipped: "not-initialized" };
  }
  const wallet = pickWallet(rng);
  if (!wallet) {
    inc("sniper", { outcome: "no-eligible-wallet" });
    return { skipped: "no-eligible-wallet" };
  }

  // Reserve immediately so two near-simultaneous fresh tokens don't both pick the same wallet.
  sniperState.set(wallet.id, { lastSnipeAt: Date.now() });
  // Reserve a daily-cap slot for this in-flight buy. Released in the finally below regardless
  // of outcome — once executeAction returns, the trade row (if submitted) is in the DB and
  // future canTrade reads will see it via the live count.
  reservedSlots.set(wallet.id, (reservedSlots.get(wallet.id) ?? 0) + 1);

  const sniper = profileSniper(wallet);
  const ethRange = sniper.amountRangeNativeEth ?? wallet.profile.amountRangeNativeEth;
  const amountEth = sampleUniform(ethRange, rng);
  const amountInWei = ethFloatToWei(amountEth);

  // Pick the dex from the token's tradeableOn — virtuals pre-grad tokens need adapter "virtuals"
  // (BondingV5), uniswap-routed tokens need "uniswap". Defaults to uniswap if absent.
  const dex = token.tradeableOn?.[0] ?? "uniswap";
  const plan = {
    dex,
    side: "buy",
    token,
    amountInWei,
    slippageBps: sampleUniformInt(wallet.profile.slippageBps, rng),
    gasMultiplier: 1.2,
  };

  logger.info(
    { walletId: wallet.id, token: token.symbol, amountInWei: amountInWei.toString(), source: "sniper-fresh" },
    "sniper: firing buy"
  );
  inc("sniper", { outcome: "fire-attempt" });

  try {
    const result = await deps.executeAction({ wallet, plan });
    if (result.status === "submitted" || result.status === "dry-run") {
      recordTrade({ wallet });
      const remaining = getDailyState({ wallet })?.remaining;
      logger.info(
        { walletId: wallet.id, token: token.symbol, remainingTradesToday: remaining },
        "sniper: round-trip slot consumed"
      );
      const delayMin = sampleUniform(sniper.sellDelayMin, rng);
      scheduleSell({ wallet, token, delayMs: delayMin * 60 * 1000, sniper });
    } else if (result.status === "skipped") {
      // Skip didn't broadcast and didn't consume a daily slot — release the cooldown
      // reservation so this wallet stays available for the next fresh-launch event.
      sniperState.delete(wallet.id);
      inc("sniper", { outcome: "skip-released" });
      logger.info(
        { walletId: wallet.id, token: token.symbol, reason: result.error },
        "sniper: skipped — cooldown released"
      );
    }
    return { fired: true, walletId: wallet.id, result };
  } catch (err) {
    logger.error({ walletId: wallet.id, err: err.message }, "sniper: buy threw");
    inc("sniper", { outcome: "buy-error" });
    return { error: err.message };
  } finally {
    // Release the in-flight reservation. Outcome doesn't matter: if the trade was
    // submitted, the DB row is now visible to canTrade; if it was skipped/failed/threw,
    // no slot was consumed in the first place.
    const next = (reservedSlots.get(wallet.id) ?? 1) - 1;
    if (next <= 0) reservedSlots.delete(wallet.id);
    else reservedSlots.set(wallet.id, next);
  }
};

// Each failed sell schedules itself again after RETRY_INTERVAL_MS, up to MAX_SELL_ATTEMPTS
// total tries (~2.5 min total with the defaults). Hook-blocked sells often clear on the
// next block or two — instead of waiting for aging mode to randomly pick up the position,
// we keep retrying within the sniper's own scheduler.
const RETRY_INTERVAL_MS = 30_000;
const MAX_SELL_ATTEMPTS = 5;

// Exported so the aging-mode orchestrator can reuse the same retry mechanism after one of
// its own sells fails — see src/orchestrator.js. Both flows then share the 5×30s retry
// surface and the silent-on-fail Telegram suppression until exhaustion.
export const scheduleSell = ({ wallet, token, delayMs, sniper, attempt = 1 }) => {
  const key = `${wallet.id}:${token.address.toLowerCase()}`;
  const existing = pendingSells.get(key);
  if (existing) clearTimeout(existing);

  logger.info(
    { walletId: wallet.id, token: token.symbol, delayMinutes: Math.round(delayMs / 60000), attempt },
    "sniper: sell scheduled"
  );
  inc("sniper", { outcome: "sell-scheduled" });

  const handle = setTimeout(async () => {
    pendingSells.delete(key);
    try {
      const balance = await deps.publicClient.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.account.address],
      });
      if (balance === 0n) {
        // Either DRY_RUN, or a prior retry succeeded — nothing to sell.
        logger.warn(
          { walletId: wallet.id, token: token.symbol, attempt },
          "sniper: scheduled sell — wallet holds 0"
        );
        inc("sniper", { outcome: "sell-no-balance" });
        return;
      }
      const plan = {
        dex: token.tradeableOn?.[0] ?? "uniswap",
        side: "sell",
        token,
        amountInWei: balance,
        slippageBps: sniper.sellSlippageBps,
        gasMultiplier: 1.2,
        // Telegram-noise control: every retry attempt is silent on Telegram. We notify
        // ONCE at the bottom of this block if all retries are exhausted, with a meaningful
        // summary instead of per-attempt error spam.
        silentOnFail: true,
      };
      logger.info(
        { walletId: wallet.id, walletAddress: wallet.account.address,
          token: token.symbol, balance: balance.toString(), attempt },
        "sniper: firing sell"
      );
      inc("sniper", { outcome: "sell-fire" });
      const result = await deps.executeAction({ wallet, plan });
      // Treat anything that did not actually broadcast as "needs another shot" — hooks are
      // state-dependent so the next block may unblock the pool. Skipped (safety) and
      // dry-run are terminal: nothing changes by retrying.
      const succeeded = result?.status === "submitted" || result?.status === "dry-run";
      const terminal = succeeded || result?.status === "skipped";
      if (!terminal && attempt < MAX_SELL_ATTEMPTS) {
        logger.info(
          { walletId: wallet.id, token: token.symbol, attempt, nextAttempt: attempt + 1,
            nextDelayMs: RETRY_INTERVAL_MS },
          "sniper: sell failed — scheduling retry"
        );
        inc("sniper", { outcome: "sell-retry" });
        scheduleSell({ wallet, token, delayMs: RETRY_INTERVAL_MS, sniper, attempt: attempt + 1 });
      } else if (!terminal) {
        logger.warn(
          { walletId: wallet.id, walletAddress: wallet.account.address,
            token: token.symbol, attempts: attempt },
          "sniper: sell exhausted retries — leaving position for aging mode"
        );
        inc("sniper", { outcome: "sell-exhausted" });
        notifyError({
          walletId: wallet.id,
          walletAddress: wallet.account.address,
          dex: plan.dex,
          error: `sell ${token.symbol} exhausted ${attempt} attempts — leaving position`,
          explorer: config.chain.blockExplorer,
        });
      }
    } catch (err) {
      logger.error(
        { walletId: wallet.id, walletAddress: wallet.account.address,
          token: token.symbol, attempt, err: err.message },
        "sniper: scheduled sell failed"
      );
      inc("sniper", { outcome: "sell-error" });
      if (attempt < MAX_SELL_ATTEMPTS) {
        scheduleSell({ wallet, token, delayMs: RETRY_INTERVAL_MS, sniper, attempt: attempt + 1 });
      } else {
        notifyError({
          walletId: wallet.id,
          walletAddress: wallet.account.address,
          dex: token.tradeableOn?.[0] ?? "uniswap",
          error: `sell ${token.symbol} exhausted ${attempt} attempts (last error: ${err.message})`,
          explorer: config.chain.blockExplorer,
        });
      }
    }
  }, delayMs);

  pendingSells.set(key, handle);
};

// Test/maintenance helpers
export const _state = () => ({
  pendingSells: pendingSells.size,
  cooldowns: sniperState.size,
});
export const _stopAll = () => {
  for (const h of pendingSells.values()) clearTimeout(h);
  pendingSells.clear();
  sniperState.clear();
  reservedSlots.clear();
  walletsRef = [];
};
