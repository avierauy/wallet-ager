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
import { swapPublicClient as defaultPublicClient } from "../core/rpc.js";
import { notifyError } from "../notify/telegram.js";
import { getDailyState, recordTrade } from "../strategy/dailyCounter.js";
import { isPaused } from "../util/runtimeState.js";

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
  // Per-retry slippage bump. Hook-blocked sells often clear within seconds, but on
  // a volatile fresh launch the price has already moved. Each retry widens the
  // tolerance so the next attempt has a better chance of landing.
  // attempt 1 uses sellSlippageBps; attempt N uses sellSlippageBps + bump * (N-1),
  // capped at sellSlippageBpsMax to prevent giving away too much on a stale token.
  sellSlippageBumpBpsPerAttempt: 500,
  sellSlippageBpsMax: 5000,
};

let walletsRef = [];
const sniperState = new Map();  // walletId → { lastSnipeAt }
const pendingSells = new Map(); // "walletId:tokenAddr" → timeout handle
// Fanout setTimeout handles for staggered fires that haven't run yet. Tracked so _stopAll
// can cancel pending fires on shutdown / test teardown — otherwise late-arriving fires would
// land in pendingSells after the cleanup ran.
const pendingFanoutFires = new Set();

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

// Multi-wallet pick for fanout. Single-wallet path delegates to pickWallet to preserve the
// exact rng-consumption pattern existing tests depend on (one rng() call → one wallet index).
// Multi-wallet uses Fisher-Yates so the chosen subset is uniformly random without replacement.
const pickWalletsRandom = (rng, n) => {
  if (n <= 1) {
    const w = pickWallet(rng);
    return w ? [w] : [];
  }
  const now = Date.now();
  const eligible = walletsRef.filter((w) => isEligible(w, now));
  if (eligible.length === 0) return [];
  const shuffled = [...eligible];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(n, shuffled.length));
};

const computeStaggerDelay = ([minMs, maxMs], rng) => {
  if (minMs === 0 && maxMs === 0) return 0;
  if (minMs === maxMs) return minMs;
  return Math.floor(minMs + (maxMs - minMs) * rng());
};

// Per-wallet fire logic — extracted from the original tryFireSniperBuy. Caller is responsible
// for having already reserved the slot + cooldown for this wallet (see tryFireSniperBuy).
// Returns { fired, walletId, result } on success, { error } on throw. Releases the reservation
// in finally regardless of outcome.
const fireOneSniperBuy = async ({ wallet, token, rng }) => {
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

  try {
    // v13.23: don't fire on a wallet that can't afford this snipe. The aging planner caps the
    // buy by usable balance (planner.js:77); the sniper used to fire blind, so an underfunded
    // wallet burned a clanker-api pre-sim + UR fallback only to fail "exceeds balance" / "no
    // route" (840 such reverts in the 2026-06-15 cycle). Bail before any adapter call.
    // minNativeBalanceWei is the same gas floor the planner reserves. A getBalance throw falls
    // through to the catch below, which also skips the fire.
    const minNative = BigInt(wallet.profile.minNativeBalanceWei ?? "0");
    const balanceWei = await deps.publicClient.getBalance({ address: wallet.account.address });
    if (amountInWei > balanceWei - minNative) {
      sniperState.delete(wallet.id); // free the wallet for the next launch (mirror skip path)
      inc("sniper", { outcome: "skip-insufficient-balance" });
      logger.info(
        { walletId: wallet.id, token: token.symbol,
          balanceWei: balanceWei.toString(), wantWei: amountInWei.toString(), minNativeWei: minNative.toString() },
        "sniper: skipped — insufficient balance"
      );
      return { fired: false, walletId: wallet.id, skipped: "insufficient-balance" };
    }

    logger.info(
      { walletId: wallet.id, token: token.symbol, amountInWei: amountInWei.toString(), source: "sniper-fresh" },
      "sniper: firing buy"
    );
    inc("sniper", { outcome: "fire-attempt" });

    const result = await deps.executeAction({ wallet, plan });
    if (result.status === "submitted" || result.status === "dry-run") {
      recordTrade({ wallet });
      const remaining = getDailyState({ wallet })?.remaining;
      logger.debug(
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

// Public entry — fire-and-forget from the discovery handlers. Reads universal fanout + stagger
// from config (v13.15: dropped per-source breakdown — cooldown already prevents cross-source
// wallet overlap). Picks N random eligible wallets; reserves slot+cooldown for all N
// immediately at pick time (so a concurrent discovery cannot re-pick them); then fires each
// one with a random stagger delay.
//
// Backwards-compat path: when fanout=1 AND stagger is [0,0] (the defaults), fires the single
// wallet synchronously and returns { fired, walletId, result } exactly like pre-v13.13.
// Multi-wallet OR stagger>0 returns { fanout, scheduled: [{ walletId, delayMs }] } and the
// individual fires run in background via setTimeout. Callers don't await individual fires.
export const tryFireSniperBuy = async ({ token, rng = Math.random }) => {
  if (walletsRef.length === 0) {
    return { skipped: "not-initialized" };
  }
  // Operator pause via /pause Telegram command. Sells in flight continue; we only block
  // new buys. The flag lives in memory and resets on restart.
  if (isPaused()) {
    inc("sniper", { outcome: "paused" });
    return { skipped: "paused" };
  }

  const fanoutN = config.sniper.fanout;
  const staggerRange = config.sniper.staggerMs;

  const wallets = pickWalletsRandom(rng, fanoutN);
  if (wallets.length === 0) {
    inc("sniper", { outcome: "no-eligible-wallet" });
    return { skipped: "no-eligible-wallet" };
  }

  // Reserve slot + cooldown for ALL picked wallets immediately. This is the race protection:
  // a concurrent tryFireSniperBuy for a different token must see these wallets as already
  // reserved (cap-wise) and in cooldown (sniperState-wise), so it picks others.
  const now = Date.now();
  for (const w of wallets) {
    sniperState.set(w.id, { lastSnipeAt: now });
    reservedSlots.set(w.id, (reservedSlots.get(w.id) ?? 0) + 1);
  }

  // Backwards-compat: single wallet + no stagger → fire synchronously, same return shape as before.
  if (wallets.length === 1 && staggerRange[0] === 0 && staggerRange[1] === 0) {
    return await fireOneSniperBuy({ wallet: wallets[0], token, rng });
  }

  // Fanout path: schedule each fire with random stagger delay; return descriptor synchronously.
  const scheduled = wallets.map((w) => ({ walletId: w.id, delayMs: computeStaggerDelay(staggerRange, rng) }));
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const delayMs = scheduled[i].delayMs;
    const run = () => {
      fireOneSniperBuy({ wallet: w, token, rng })
        .catch((err) => logger.error({ walletId: w.id, err: err.message }, "sniper: fanout fire threw"));
    };
    if (delayMs === 0) {
      run();
    } else {
      let handle;
      handle = setTimeout(() => {
        pendingFanoutFires.delete(handle);
        run();
      }, delayMs);
      pendingFanoutFires.add(handle);
    }
  }
  inc("sniper", { outcome: "fanout-scheduled" });
  logger.info(
    { token: token.symbol, source: token.source, fanoutN: wallets.length,
      walletIds: wallets.map((w) => w.id), staggerRange },
    "sniper: fanout scheduled"
  );
  return { fanout: wallets.length, scheduled };
};

// Each failed sell schedules itself again after RETRY_INTERVAL_MS, up to MAX_SELL_ATTEMPTS
// total tries (~2.5 min total with the defaults). Hook-blocked sells often clear on the
// next block or two — instead of waiting for aging mode to randomly pick up the position,
// we keep retrying within the sniper's own scheduler.
//
// v13.18: Clanker tokens use the per-source overrides. The Clanker MEV hook
// (0xb429d62f...) has a time-based anti-snipe window that blocks Universal Router sells.
// Forensic data from cycle 2026-05-26 (n=93 tokens): P50 first-sell-OK at 2.1 min from
// discovery, P99 at 3.0 min. The default 5×30s window (2.5 min) covers the median but
// not the tail — Clanker config below extends to 10 min total (10 attempts × 1 min),
// which covers P99 with ~3× headroom. Outlier cases (>10 min windows) still need
// manual recovery; they're rare per the data.
const RETRY_INTERVAL_MS = 30_000;
const MAX_SELL_ATTEMPTS = 5;
const CLANKER_RETRY_INTERVAL_MS = Number(process.env.SNIPER_CLANKER_SELL_RETRY_INTERVAL_MS ?? 60_000); // 1 min
const CLANKER_MAX_SELL_ATTEMPTS = Number(process.env.SNIPER_CLANKER_SELL_MAX_ATTEMPTS ?? 10);

const retryConfigForToken = (token) => {
  if (/^clanker-/.test(token.source ?? "")) {
    return { intervalMs: CLANKER_RETRY_INTERVAL_MS, maxAttempts: CLANKER_MAX_SELL_ATTEMPTS };
  }
  return { intervalMs: RETRY_INTERVAL_MS, maxAttempts: MAX_SELL_ATTEMPTS };
};

// Pure: compute the slippage tolerance for the Nth attempt. attempt is 1-indexed.
// Exported for unit tests; production callers use it inside scheduleSell.
export const effectiveSellSlippageBps = (sniper, attempt) => {
  const baseBps = sniper.sellSlippageBps ?? DEFAULT_SNIPER.sellSlippageBps;
  const bumpBps = sniper.sellSlippageBumpBpsPerAttempt ?? DEFAULT_SNIPER.sellSlippageBumpBpsPerAttempt;
  const maxBps = sniper.sellSlippageBpsMax ?? DEFAULT_SNIPER.sellSlippageBpsMax;
  return Math.min(maxBps, baseBps + bumpBps * Math.max(0, attempt - 1));
};

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
      const effectiveSlippageBps = effectiveSellSlippageBps(sniper, attempt);
      const plan = {
        dex: token.tradeableOn?.[0] ?? "uniswap",
        side: "sell",
        token,
        amountInWei: balance,
        slippageBps: effectiveSlippageBps,
        gasMultiplier: 1.2,
        // Telegram-noise control: every retry attempt is silent on Telegram. We notify
        // ONCE at the bottom of this block if all retries are exhausted, with a meaningful
        // summary instead of per-attempt error spam.
        silentOnFail: true,
      };
      logger.info(
        { walletId: wallet.id, walletAddress: wallet.account.address,
          token: token.symbol, balance: balance.toString(), attempt,
          slippageBps: effectiveSlippageBps },
        "sniper: firing sell"
      );
      inc("sniper", { outcome: "sell-fire" });
      const result = await deps.executeAction({ wallet, plan });
      // Treat anything that did not actually broadcast as "needs another shot" — hooks are
      // state-dependent so the next block may unblock the pool. Skipped (safety) and
      // dry-run are terminal: nothing changes by retrying.
      const succeeded = result?.status === "submitted" || result?.status === "dry-run";
      const terminal = succeeded || result?.status === "skipped";
      // v13.18: per-source retry config — Clanker tokens get a longer window to outlast the
      // hook anti-snipe block.
      const retryCfg = retryConfigForToken(token);
      if (!terminal && attempt < retryCfg.maxAttempts) {
        logger.info(
          { walletId: wallet.id, token: token.symbol, attempt, nextAttempt: attempt + 1,
            nextDelayMs: retryCfg.intervalMs, maxAttempts: retryCfg.maxAttempts },
          "sniper: sell failed — scheduling retry"
        );
        inc("sniper", { outcome: "sell-retry" });
        scheduleSell({ wallet, token, delayMs: retryCfg.intervalMs, sniper, attempt: attempt + 1 });
      } else if (!terminal) {
        logger.warn(
          { walletId: wallet.id, walletAddress: wallet.account.address,
            token: token.symbol, attempts: attempt, maxAttempts: retryCfg.maxAttempts },
          "sniper: sell exhausted retries — leaving position for aging mode"
        );
        inc("sniper", { outcome: "sell-exhausted" });
        notifyError({
          walletId: wallet.id,
          walletAddress: wallet.account.address,
          dex: plan.dex,
          source: token.source,
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
      const retryCfg = retryConfigForToken(token);
      if (attempt < retryCfg.maxAttempts) {
        scheduleSell({ wallet, token, delayMs: retryCfg.intervalMs, sniper, attempt: attempt + 1 });
      } else {
        notifyError({
          walletId: wallet.id,
          walletAddress: wallet.account.address,
          dex: token.tradeableOn?.[0] ?? "uniswap",
          source: token.source,
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
  for (const h of pendingFanoutFires) clearTimeout(h);
  pendingFanoutFires.clear();
  sniperState.clear();
  reservedSlots.clear();
  walletsRef = [];
};
