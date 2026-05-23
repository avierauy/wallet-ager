// Daily cleanup job — one final sell attempt per held position at end of UTC day.
//
// The sniper's per-sell retry chain (5×30s) handles transient hook blocks within minutes
// of each buy. If a position still has a non-zero balance after that, it's typically
// because the hook permanently rejected the sell or the inner retries ran into something
// truly persistent. At 23:30 UTC we make one more directSwap attempt per such position;
// the executor's inner retry-with-zero and AlphaRouter fallback are still in play.
//
// On success: notifyTrade fires from the executor as usual.
// On failure: we explicitly notifyError so the operator gets a single Telegram message
// flagging the dust position.
import { erc20Abi } from "viem";
import { config } from "../config.js";
import { db } from "../core/db.js";
import { executeAction } from "../core/executor.js";
import { publicClient } from "../core/rpc.js";
import { _listAll } from "../core/tokenRegistry.js";
import { notifyError } from "../notify/telegram.js";
import { logger } from "../util/logger.js";
import { inc } from "../util/metrics.js";

const TARGET_UTC_HOUR = 23;
const TARGET_UTC_MIN = 30;

const utcDateKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

// Tokens bought today by this wallet (status=submitted or dry-run, side=buy).
const tokensBoughtToday = ({ walletId, date }) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT token_out FROM trades
       WHERE wallet_id = ?
         AND side = 'buy'
         AND status IN ('submitted', 'dry-run')
         AND strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') = ?`
    )
    .all(walletId, date);
  return rows.map((r) => r.token_out.toLowerCase());
};

const findTokenInRegistry = (address) =>
  _listAll().find((t) => t.address.toLowerCase() === address.toLowerCase());

// Sell one residual position. Returns { ok, txHash?, error? }. Surfaces failures via
// notifyError so the operator sees the dust explicitly in Telegram.
const sellOneResidual = async ({ wallet, tokenAddr }) => {
  const registryToken = findTokenInRegistry(tokenAddr);
  if (!registryToken) {
    return { ok: false, error: "not-in-registry" };
  }
  const balance = await publicClient.readContract({
    address: tokenAddr, abi: erc20Abi, functionName: "balanceOf", args: [wallet.account.address],
  });
  if (balance === 0n) {
    return { ok: true, skipped: "zero-balance" };
  }
  const sniper = wallet.profile.sniper ?? {};
  const plan = {
    dex: registryToken.tradeableOn?.[0] ?? "uniswap",
    side: "sell",
    token: registryToken,
    amountInWei: balance,
    slippageBps: sniper.sellSlippageBps ?? 1000,
    gasMultiplier: 1.2,
    // We want the Telegram notification on failure — this IS the final attempt.
    silentOnFail: false,
  };
  logger.info(
    { walletId: wallet.id, walletAddress: wallet.account.address,
      token: registryToken.symbol, balance: balance.toString() },
    "daily-cleanup: firing final sell"
  );
  inc("daily-cleanup", { outcome: "fire" });
  const result = await executeAction({ wallet, plan });
  if (result.status === "submitted" || result.status === "dry-run") {
    inc("daily-cleanup", { outcome: "success" });
    return { ok: true, txHash: result.txHash };
  }
  inc("daily-cleanup", { outcome: "failed" });
  // executor.executeAction with silentOnFail=false already notified — log here for the
  // local audit trail.
  logger.warn(
    { walletId: wallet.id, token: registryToken.symbol, status: result.status, error: result.error },
    "daily-cleanup: final sell failed — position remains as dust"
  );
  return { ok: false, error: result.error ?? result.status };
};

// Process every wallet in parallel; each wallet's positions in series (nonce ordering).
export const runCleanupOnce = async ({ wallets }) => {
  const date = utcDateKey();
  logger.info({ date, wallets: wallets.length }, "daily-cleanup: scan starting");
  const results = await Promise.all(wallets.map(async (wallet) => {
    const tokens = tokensBoughtToday({ walletId: wallet.id, date });
    const out = [];
    for (const tokenAddr of tokens) {
      try {
        out.push({ tokenAddr, ...(await sellOneResidual({ wallet, tokenAddr })) });
      } catch (err) {
        logger.error(
          { walletId: wallet.id, tokenAddr, err: err.message },
          "daily-cleanup: residual sell threw"
        );
        notifyError({
          walletId: wallet.id,
          walletAddress: wallet.account.address,
          dex: "cleanup",
          error: `daily-cleanup: sell threw for ${tokenAddr.slice(0, 10)}…: ${err.message}`,
          explorer: config.chain.blockExplorer,
        });
        out.push({ tokenAddr, ok: false, error: err.message });
      }
    }
    return { walletId: wallet.id, processed: out };
  }));
  logger.info({ summary: results.map((r) => ({ wallet: r.walletId, count: r.processed.length })) },
    "daily-cleanup: scan complete");
  return results;
};

// ms from `now` to the next occurrence of TARGET_UTC_HOUR:TARGET_UTC_MIN. If we're already
// past that today, returns the duration until tomorrow's slot.
const msUntilNextRun = (now = Date.now()) => {
  const next = new Date(now);
  next.setUTCHours(TARGET_UTC_HOUR, TARGET_UTC_MIN, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now;
};

let timer = null;

export const startDailyCleanup = ({ wallets }) => {
  if (timer) return; // idempotent
  const schedule = () => {
    const delay = msUntilNextRun();
    logger.info({ runsInMs: delay, runsInMin: Math.round(delay / 60000) },
      "daily-cleanup scheduled");
    timer = setTimeout(async () => {
      try { await runCleanupOnce({ wallets }); }
      catch (err) { logger.error({ err: err.message }, "daily-cleanup: scan threw"); }
      schedule(); // reschedule for the next day
    }, delay);
  };
  schedule();
};

export const stopDailyCleanup = () => {
  if (timer) { clearTimeout(timer); timer = null; }
};

export const _internals = { tokensBoughtToday, msUntilNextRun, TARGET_UTC_HOUR, TARGET_UTC_MIN };
