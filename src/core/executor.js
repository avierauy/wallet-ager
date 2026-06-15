import * as bankr from "../adapters/bankr.js";
import * as clankerAggregator from "../adapters/clankerAggregator.js";
import * as uniswap from "../adapters/uniswap.js";
import * as virtuals from "../adapters/virtuals.js";
import { config } from "../config.js";
import { notifyApproval, notifyError, notifyTrade } from "../notify/telegram.js";
import { checkBeforeSell, checkBondingCurve, checkToken } from "../safety/index.js";
import { OnChainRevert, PreSimulationRevert, SkipExecution } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { inc } from "../util/metrics.js";
import { withRetry } from "../util/retry.js";
import { waitForAllowance } from "../util/waitForAllowance.js";
import { hasApproval, insertTrade, recordApproval, updateTrade } from "./db.js";
import { swapPublicClient as publicClient } from "./rpc.js";
import { markTraded } from "./tokenRegistry.js";
import { withWalletLock } from "./nonceManager.js";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

// A terminal "no route found" is the expected outcome of sniping a fresh launchpad token
// before its pool routes (sniper fanout buys land here en masse — see 2026-06-01 forensics:
// 80/82 terminal failures were sniper clanker buys that fell to the UR fallback) and of aging
// picking a token whose pool has since died. It is non-actionable noise on Telegram. We
// suppress the per-failure ping while still recording it (DB status + metric + ERROR log) so
// the failure rate stays observable for monitoring. Genuinely actionable failures (e.g. wallet
// out of gas) still notify.
const NO_NOTIFY_FAILURE_RE = /no route found/i;

// Decide whether a terminal trade failure should page the operator via Telegram. Sniper retries
// set silentOnFail (the sniper notifies once on exhaustion); expected no-route failures are
// suppressed regardless. Exported for unit testing.
export const shouldNotifyFailure = (errMessage, silentOnFail) =>
  !silentOnFail && !NO_NOTIFY_FAILURE_RE.test(String(errMessage ?? ""));

const ETH_LEG = (amountWei) => ({ symbol: "ETH", decimals: 18, amountWei });
const VIRTUAL_LEG = (amountWei) => ({ symbol: "VIRTUAL", decimals: 18, amountWei });
const TOKEN_LEG = (token, amountWei) => ({ symbol: token.symbol, decimals: token.decimals, amountWei });

const ensurePermit2Approval = async ({ wallet, token }) => {
  if (hasApproval({ wallet_id: wallet.id, token: token.address, spender: config.chain.permit2 })) return;
  const hash = await uniswap.approveTokenToPermit2({ account: wallet.account, token: token.address });
  if (hash) {
    await publicClient.waitForTransactionReceipt({ hash });
    // Guard the subsequent sell against RPC state staleness — any large allowance is fine here.
    await waitForAllowance({
      owner: wallet.account.address,
      token: token.address,
      spender: config.chain.permit2,
      atLeast: 2n ** 128n,
    });
    recordApproval({
      wallet_id: wallet.id,
      token: token.address,
      spender: config.chain.permit2,
      tx_hash: hash,
      granted_at: Date.now(),
    });
    notifyApproval({
      walletId: wallet.id,
      walletAddress: wallet.account.address,
      tokenSymbol: token.symbol,
      decimals: token.decimals,
      amountWei: null, // Permit2 one-time MAX → display as "unlimited"
      spender: config.chain.permit2,
      spenderLabel: "Permit2",
      txHash: hash,
      explorer: config.chain.blockExplorer,
    });
  }
};

const quoteToLeg = (route, symbol, decimals) => {
  if (!route?.quote) return null;
  try {
    return { symbol, decimals, amountWei: BigInt(route.quote.quotient.toString()) };
  } catch {
    return null;
  }
};

// Clanker-source tokens prefer the Clanker API route (byte-perfect fingerprint match with
// the official UI flow; 1% integrator fee accepted in exchange). UR remains the fallback when
// the API itself is unreachable — swap-level reverts propagate to the executor's withRetry.
const isClankerSource = (source) => /^clanker-/.test(source ?? "");
const isClankerApiError = (err) => String(err?.message ?? "").startsWith("clanker-api:");

// dispatch — runs the adapter call and returns { txHash, in, out } where in/out are notification
// legs with { symbol, decimals, amountWei }. `out` may be null when the adapter doesn't surface
// an expected-output amount (e.g. Bankr/0x without parsing the quote payload).
const dispatch = async ({ wallet, plan }) => {
  if (plan.dex === "uniswap") {
    // Clanker-source path — try Clanker aggregator API first. On API failure, fall through
    // to the UR path below; on swap-level failure (revert, nonce, etc.), re-throw and let
    // the executor's withRetry layer decide.
    if (isClankerSource(plan.token.source)) {
      try {
        if (plan.side === "buy") {
          const r = await clankerAggregator.buyExactEthForToken({
            wallet, tokenOut: plan.token, amountInWei: plan.amountInWei,
          });
          inc("clanker-aggregator", { outcome: "buy", provider: r.provider });
          return {
            txHash: r.txHash,
            in: ETH_LEG(plan.amountInWei),
            out: quoteToLeg(r.route, plan.token.symbol, plan.token.decimals),
          };
        }
        const r = await clankerAggregator.sellExactTokenForEth({
          wallet, tokenIn: plan.token, amountInWei: plan.amountInWei,
        });
        inc("clanker-aggregator", { outcome: "sell", provider: r.provider });
        return {
          txHash: r.txHash,
          in: TOKEN_LEG(plan.token, plan.amountInWei),
          out: quoteToLeg(r.route, "ETH", 18),
        };
      } catch (err) {
        if (!isClankerApiError(err)) throw err;
        logger.warn(
          { walletId: wallet.id, token: plan.token.symbol, side: plan.side, err: err.message },
          "clanker-aggregator: API failed — falling back to Universal Router path"
        );
        inc("clanker-aggregator", { outcome: "fallback-ur" });
        // fall through to the UR path below
      }
    }

    if (plan.side === "buy") {
      const r = await uniswap.buyExactEthForToken({
        account: wallet.account,
        tokenOut: plan.token,
        amountInWei: plan.amountInWei,
        slippageBps: plan.slippageBps,
      });
      return {
        txHash: r.txHash,
        in: ETH_LEG(plan.amountInWei),
        out: quoteToLeg(r.route, plan.token.symbol, plan.token.decimals),
      };
    }
    await ensurePermit2Approval({ wallet, token: plan.token });
    const r = await uniswap.sellExactTokenForEth({
      account: wallet.account,
      tokenIn: plan.token,
      amountInWei: plan.amountInWei,
      slippageBps: plan.slippageBps,
    });
    return {
      txHash: r.txHash,
      in: TOKEN_LEG(plan.token, plan.amountInWei),
      out: quoteToLeg(r.route, "ETH", 18),
    };
  }

  if (plan.dex === "bankr") {
    const sellToken = plan.side === "buy" ? NATIVE : plan.token.address;
    const buyToken = plan.side === "buy" ? plan.token.address : NATIVE;
    const txHash = await bankr.swap({
      account: wallet.account,
      sellToken,
      buyToken,
      sellAmount: plan.amountInWei.toString(),
      slippageBps: plan.slippageBps,
    });
    return {
      txHash,
      in: plan.side === "buy" ? ETH_LEG(plan.amountInWei) : TOKEN_LEG(plan.token, plan.amountInWei),
      out: null,
    };
  }

  if (plan.dex === "virtuals") {
    if (plan.side === "buy") {
      const r = await virtuals.executeBuyFlow({
        wallet,
        agentToken: plan.token,
        plannedAmountInWei: plan.amountInWei,
        slippageBps: plan.slippageBps,
      });
      const inLeg = r.acquisition
        ? ETH_LEG(plan.amountInWei)
        : VIRTUAL_LEG(BigInt(r.virtualSpentWei));
      return {
        txHash: r.txHash,
        in: inLeg,
        out: { symbol: plan.token.symbol, decimals: plan.token.decimals, amountWei: BigInt(r.expectedAgentOutWei) },
      };
    }
    const r = await virtuals.executeSellFlow({
      wallet,
      agentToken: plan.token,
      amountInWei: plan.amountInWei,
      slippageBps: plan.slippageBps,
    });
    return {
      txHash: r.txHash,
      in: TOKEN_LEG(plan.token, plan.amountInWei),
      out: VIRTUAL_LEG(BigInt(r.expectedVirtualOutWei)),
    };
  }

  throw new Error(`dex not wired in orchestrator: ${plan.dex}`);
};

export const executeAction = async ({ wallet, plan }) => {
  const tradeId = insertTrade({
    wallet_id: wallet.id,
    dex: plan.dex,
    side: plan.side,
    token_in: plan.side === "buy" ? NATIVE : plan.token.address,
    token_out: plan.side === "buy" ? plan.token.address : NATIVE,
    amount_in: plan.amountInWei.toString(),
    amount_out_min: "0",
    status: "pending",
    created_at: Date.now(),
  });

  // Trusted launchpads (Clanker/Doppler/Virtuals) deploy from fixed ERC20 templates with no
  // rug surface. We skip the safety probe on BOTH buy and sell sides:
  //   - Buy : keeps the snipe instant.
  //   - Sell: avoids the AlphaRouter "no route" cascade where checkBeforeSell uses
  //           AlphaRouter, which lags the subgraph by minutes on fresh launches and would
  //           otherwise refuse to verify the sell. The template guarantees no rug surface,
  //           so the only failure mode is hook-blocked swaps (caught at Quoter time).
  const isTrustedLaunchpad =
    /^(clanker-|doppler-|virtuals-)/.test(plan.token.source ?? "");

  const safety = isTrustedLaunchpad
    ? { safe: true, reasons: [], cached: false, bypassedFor: plan.token.source }
    // Virtuals pre-grad tokens don't have Uniswap pools — honeypot.is can't simulate them.
    // For dex=virtuals we use a bonding-curve roundtrip probe instead. Other dexes go through
    // honeypot.is as before.
    : plan.dex === "virtuals"
      ? await checkBondingCurve({ agentToken: plan.token.address })
      : plan.side === "buy"
        ? await checkToken(plan.token.address)
        : await checkBeforeSell(plan.token.address);

  if (isTrustedLaunchpad) {
    logger.info(
      { walletId: wallet.id, token: plan.token.symbol, side: plan.side, source: plan.token.source },
      "safety bypassed — trusted launchpad source"
    );
    inc("safety", { verdict: "bypassed", cached: "no" });
  } else {
    inc("safety", { verdict: safety.safe ? "safe" : "unsafe", cached: safety.cached ? "yes" : "no" });
  }

  if (!safety.safe) {
    const reason = safety.reasons.join("; ");
    logger.warn({ walletId: wallet.id, token: plan.token.symbol, reason }, "safety check failed");
    updateTrade(tradeId, { status: "skipped", error: reason });
    inc("trade", { status: "skipped", dex: plan.dex, side: plan.side });
    return { status: "skipped", error: reason };
  }

  if (config.runtime.dryRun) {
    logger.info(
      {
        walletId: wallet.id,
        dex: plan.dex,
        side: plan.side,
        token: plan.token.symbol,
        amountInWei: plan.amountInWei.toString(),
        slippageBps: plan.slippageBps,
        buyTax: safety.buyTax,
        sellTax: safety.sellTax,
      },
      "DRY_RUN — would execute"
    );
    updateTrade(tradeId, { status: "dry-run" });
    inc("trade", { status: "dry-run", dex: plan.dex, side: plan.side });
    return { status: "dry-run" };
  }

  try {
    // Retry the adapter flow on transient errors (allowance race after a just-confirmed approve,
    // nonce desync, RPC 5xx, etc.). Adapters are idempotent — they re-check allowance and re-quote
    // — so re-running the whole dispatch is safe and refreshes stale state.
    const dispatched = await withWalletLock(wallet.account, () =>
      withRetry(() => dispatch({ wallet, plan }), {
        onRetry: ({ attempt, err, nextDelayMs }) => {
          logger.warn(
            {
              walletId: wallet.id,
              dex: plan.dex,
              side: plan.side,
              attempt,
              nextDelayMs,
              msg: String(err.shortMessage ?? err.message ?? err).slice(0, 200),
            },
            "transient dispatch error — retrying"
          );
          inc("trade-retry", { dex: plan.dex, side: plan.side });
        },
      })
    );
    // v13.18: set confirmed_at on successful broadcasts. Was always null pre-v13.18 because
    // the schema field was declared but never written; the forensic tracker uses this to
    // compute pool-age-at-confirmation deltas without re-fetching receipts.
    updateTrade(tradeId, {
      status: "submitted",
      tx_hash: dispatched.txHash,
      confirmed_at: Date.now(),
    });
    inc("trade", { status: "submitted", dex: plan.dex, side: plan.side });
    // No-op for static tokens; bumps last_traded_at for discovered ones so the sweeper
    // doesn't TTL-evict them while they're actively being cycled.
    markTraded({ address: plan.token.address });
    notifyTrade({
      walletId: wallet.id,
      walletAddress: wallet.account.address,
      dex: plan.dex,
      side: plan.side,
      source: plan.token.source,
      txHash: dispatched.txHash,
      explorer: config.chain.blockExplorer,
      in: dispatched.in,
      out: dispatched.out,
    });
    // Consolidated trade record — single INFO line per completed trade carrying every
    // field the operator needs. Granular adapter / sniper logs around this point are at
    // DEBUG so production INFO traffic stays one-line-per-trade. Set LOG_LEVEL=debug to
    // see the per-step breakdown when investigating a specific trade.
    logger.info(
      {
        event: "trade_completed",
        walletId: wallet.id,
        walletAddress: wallet.account.address,
        dex: plan.dex,
        side: plan.side,
        token: plan.token.symbol,
        tokenAddress: plan.token.address,
        amountInWei: dispatched.in?.amountWei?.toString?.() ?? plan.amountInWei.toString(),
        amountOutWei: dispatched.out?.amountWei?.toString?.() ?? null,
        slippageBps: plan.slippageBps,
        txHash: dispatched.txHash,
        source: plan.token.source ?? null,
      },
      "trade completed"
    );
    return { status: "submitted", txHash: dispatched.txHash };
  } catch (err) {
    // Adapter-initiated skip (e.g., Virtuals pre-flight): clean no-op, not a failure. Same
    // surface as a safety-check rejection — sniper releases its cooldown, no Telegram noise.
    if (err instanceof SkipExecution) {
      updateTrade(tradeId, { status: "skipped", error: err.message });
      inc("trade", { status: "skipped", dex: plan.dex, side: plan.side });
      logger.info(
        { walletId: wallet.id, walletAddress: wallet.account.address,
          dex: plan.dex, side: plan.side, reason: err.message },
        "execution skipped — pre-flight check"
      );
      return { status: "skipped", error: err.message };
    }
    // v13.17: on-chain revert (slippage, hook block, etc.) — distinct from RPC/network
    // failures. Mark as `reverted` with the txHash so post-mortem can find it on BaseScan.
    // Daily cap is NOT consumed (countSubmittedBuysOnDate only counts 'submitted'/'dry-run').
    // The sniper's cooldown logic releases the wallet via its existing finally block.
    if (err instanceof OnChainRevert) {
      updateTrade(tradeId, { status: "reverted", tx_hash: err.txHash, error: err.message });
      inc("trade", { status: "reverted", dex: plan.dex, side: plan.side });
      logger.warn(
        { walletId: wallet.id, walletAddress: wallet.account.address,
          dex: plan.dex, side: plan.side, txHash: err.txHash, gasUsed: err.gasUsed?.toString?.() },
        "execution reverted on-chain"
      );
      if (!plan.silentOnFail) {
        notifyError({
          walletId: wallet.id,
          walletAddress: wallet.account.address,
          dex: plan.dex,
          source: plan.token.source,
          error: `on-chain revert: ${err.message.slice(0, 100)}`,
          explorer: config.chain.blockExplorer,
        });
      }
      return { status: "reverted", error: err.message, txHash: err.txHash };
    }
    // v13.18: pre-simulation revert (eth_call rejected before broadcast). No gas spent.
    // Treated similarly to OnChainRevert for retry/cap purposes — sniper retry will see
    // status='pre-sim-reverted' as non-terminal and reschedule. Daily cap not consumed.
    if (err instanceof PreSimulationRevert) {
      updateTrade(tradeId, { status: "pre-sim-reverted", error: err.message });
      inc("trade", { status: "pre-sim-reverted", dex: plan.dex, side: plan.side });
      logger.warn(
        { walletId: wallet.id, walletAddress: wallet.account.address,
          dex: plan.dex, side: plan.side, target: err.target, reason: err.reason },
        "execution rejected pre-broadcast (sim revert)"
      );
      // Silent on Telegram — these are expected during Clanker hook windows; the sniper's
      // retry loop will handle them. Operator only gets notified once retries are exhausted.
      return { status: "pre-sim-reverted", error: err.message };
    }
    updateTrade(tradeId, { status: "failed", error: err.message });
    inc("trade", { status: "failed", dex: plan.dex, side: plan.side });
    // Sniper retries set plan.silentOnFail so the operator only gets a Telegram message
    // once retries are exhausted (sniper handles that final notification itself). Expected
    // no-route failures are suppressed too (see NO_NOTIFY_FAILURE_RE) — they still hit the
    // ERROR log + failed-trade metric below for observability.
    if (shouldNotifyFailure(err.message, plan.silentOnFail)) {
      notifyError({
        walletId: wallet.id,
        walletAddress: wallet.account.address,
        dex: plan.dex,
        source: plan.token.source,
        error: err.message,
        explorer: config.chain.blockExplorer,
      });
    }
    logger.error(
      { walletId: wallet.id, walletAddress: wallet.account.address,
        err: err.message, dex: plan.dex, silentOnFail: !!plan.silentOnFail },
      "execution failed"
    );
    return { status: "failed", error: err.message };
  }
};
