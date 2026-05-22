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
import { executeAction as defaultExecuteAction } from "../core/executor.js";
import { publicClient as defaultPublicClient } from "../core/rpc.js";

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
      const delayMin = sampleUniform(sniper.sellDelayMin, rng);
      scheduleSell({ wallet, token, delayMs: delayMin * 60 * 1000, sniper });
    }
    return { fired: true, walletId: wallet.id, result };
  } catch (err) {
    logger.error({ walletId: wallet.id, err: err.message }, "sniper: buy threw");
    inc("sniper", { outcome: "buy-error" });
    return { error: err.message };
  }
};

const scheduleSell = ({ wallet, token, delayMs, sniper }) => {
  const key = `${wallet.id}:${token.address.toLowerCase()}`;
  const existing = pendingSells.get(key);
  if (existing) clearTimeout(existing);

  logger.info(
    { walletId: wallet.id, token: token.symbol, delayMinutes: Math.round(delayMs / 60000) },
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
        logger.warn(
          { walletId: wallet.id, token: token.symbol },
          "sniper: scheduled sell — wallet holds 0 (likely DRY_RUN buy)"
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
      };
      logger.info(
        { walletId: wallet.id, token: token.symbol, balance: balance.toString() },
        "sniper: firing sell"
      );
      inc("sniper", { outcome: "sell-fire" });
      await deps.executeAction({ wallet, plan });
    } catch (err) {
      logger.error(
        { walletId: wallet.id, token: token.symbol, err: err.message },
        "sniper: scheduled sell failed"
      );
      inc("sniper", { outcome: "sell-error" });
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
  walletsRef = [];
};
