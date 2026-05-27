// Stuck-sell watchdog — periodic safety net for positions whose sniper sell retry chain
// already exhausted (5×30s for non-Clanker, 10×1min for Clanker per v13.18) but the hook
// anti-snipe window outlasted it.
//
// Concrete trigger: the 2026-05-27 cycle ended with 10 Clanker-v4 positions stuck — the
// per-token hook window exceeded our 10 min retry budget (~3.7% of buys, fatter tail than
// the v13.18 forensic P99=3min estimate).
//
// Design: every WATCHDOG_INTERVAL_MS, scan today's submitted buys with no matching sell,
// older than WATCHDOG_MIN_AGE_MS (so we don't race the sniper retry). For each, attempt
// one sell via executor.executeAction. Silent on Telegram — dailyCleanup at 23:30 owns
// the dust notification.
import { erc20Abi } from "viem";
import { db } from "../core/db.js";
import { executeAction } from "../core/executor.js";
import { publicClient } from "../core/rpc.js";
import { _listAll } from "../core/tokenRegistry.js";
import { logger } from "../util/logger.js";
import { inc } from "../util/metrics.js";

const INTERVAL_MS = Number(process.env.STUCK_SELL_WATCHDOG_INTERVAL_MS ?? 10 * 60 * 1000);
const MIN_AGE_MS = Number(process.env.STUCK_SELL_WATCHDOG_MIN_AGE_MS ?? 15 * 60 * 1000);
const ENABLED = process.env.STUCK_SELL_WATCHDOG_ENABLED !== "false";

const utcDateKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

// Today's buy/token pairs that don't have a matching sell yet, filtered by min age.
const findStuckBuys = ({ walletId, date, nowMs = Date.now() }) => {
  const cutoffMs = nowMs - MIN_AGE_MS;
  return db
    .prepare(
      `SELECT DISTINCT token_out FROM trades t1
       WHERE wallet_id = ?
         AND side = 'buy'
         AND status IN ('submitted', 'dry-run')
         AND strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') = ?
         AND created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM trades t2
           WHERE t2.wallet_id = t1.wallet_id
             AND t2.token_in = t1.token_out
             AND t2.side = 'sell'
             AND t2.status IN ('submitted', 'dry-run')
         )`
    )
    .all(walletId, date, cutoffMs)
    .map((r) => r.token_out.toLowerCase());
};

const findTokenInRegistry = (address) =>
  _listAll().find((t) => t.address.toLowerCase() === address.toLowerCase());

const sellOneStuck = async ({ wallet, tokenAddr }) => {
  const registryToken = findTokenInRegistry(tokenAddr);
  if (!registryToken) return { ok: false, error: "not-in-registry" };
  const balance = await publicClient.readContract({
    address: tokenAddr, abi: erc20Abi, functionName: "balanceOf", args: [wallet.account.address],
  });
  if (balance === 0n) return { ok: true, skipped: "zero-balance" };
  const sniper = wallet.profile.sniper ?? {};
  const plan = {
    dex: registryToken.tradeableOn?.[0] ?? "uniswap",
    side: "sell",
    token: registryToken,
    amountInWei: balance,
    slippageBps: sniper.sellSlippageBpsMax ?? sniper.sellSlippageBps ?? 2500,
    gasMultiplier: 1.2,
    silentOnFail: true,
  };
  logger.info(
    { walletId: wallet.id, token: registryToken.symbol, balance: balance.toString() },
    "stuck-watchdog: firing sell"
  );
  inc("stuck-watchdog", { outcome: "fire" });
  const result = await executeAction({ wallet, plan });
  if (result.status === "submitted" || result.status === "dry-run") {
    inc("stuck-watchdog", { outcome: "success" });
    return { ok: true, txHash: result.txHash };
  }
  inc("stuck-watchdog", { outcome: "failed" });
  return { ok: false, error: result.error ?? result.status };
};

export const runWatchdogOnce = async ({ wallets, nowMs = Date.now() }) => {
  const date = utcDateKey(nowMs);
  let scanned = 0; let fired = 0; let succeeded = 0; let failed = 0;
  await Promise.all(wallets.map(async (wallet) => {
    const tokens = findStuckBuys({ walletId: wallet.id, date, nowMs });
    for (const tokenAddr of tokens) {
      scanned++;
      try {
        const r = await sellOneStuck({ wallet, tokenAddr });
        if (r.ok && !r.skipped) succeeded++;
        else if (!r.ok) failed++;
        fired++;
      } catch (err) {
        logger.error(
          { walletId: wallet.id, tokenAddr, err: err.message },
          "stuck-watchdog: sell threw"
        );
        failed++;
      }
    }
  }));
  if (scanned > 0) {
    logger.info({ scanned, fired, succeeded, failed }, "stuck-watchdog: scan complete");
  }
  return { scanned, fired, succeeded, failed };
};

let timer = null;

export const startStuckSellWatchdog = ({ wallets }) => {
  if (!ENABLED) {
    logger.info({}, "stuck-watchdog disabled via STUCK_SELL_WATCHDOG_ENABLED=false");
    return;
  }
  if (timer) return;
  logger.info({ intervalMs: INTERVAL_MS, minAgeMs: MIN_AGE_MS }, "stuck-watchdog scheduled");
  timer = setInterval(async () => {
    try { await runWatchdogOnce({ wallets }); }
    catch (err) { logger.error({ err: err.message }, "stuck-watchdog: scan threw"); }
  }, INTERVAL_MS);
};

export const stopStuckSellWatchdog = () => {
  if (timer) { clearInterval(timer); timer = null; }
};

export const _internals = { findStuckBuys, sellOneStuck, INTERVAL_MS, MIN_AGE_MS };
