import * as bankr from "../adapters/bankr.js";
import * as uniswap from "../adapters/uniswap.js";
import * as virtuals from "../adapters/virtuals.js";
import { config } from "../config.js";
import { notifyError, notifyTrade } from "../notify/telegram.js";
import { checkBeforeSell, checkToken } from "../safety/honeypot.js";
import { checkBondingCurve } from "../safety/virtuals.js";
import { logger } from "../util/logger.js";
import { inc } from "../util/metrics.js";
import { hasApproval, insertTrade, recordApproval, updateTrade } from "./db.js";
import { withWalletLock } from "./nonceManager.js";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ETH_LEG = (amountWei) => ({ symbol: "ETH", decimals: 18, amountWei });
const VIRTUAL_LEG = (amountWei) => ({ symbol: "VIRTUAL", decimals: 18, amountWei });
const TOKEN_LEG = (token, amountWei) => ({ symbol: token.symbol, decimals: token.decimals, amountWei });

const ensurePermit2Approval = async ({ wallet, token }) => {
  if (hasApproval({ wallet_id: wallet.id, token, spender: config.chain.permit2 })) return;
  const hash = await uniswap.approveTokenToPermit2({ account: wallet.account, token });
  if (hash) {
    recordApproval({
      wallet_id: wallet.id,
      token,
      spender: config.chain.permit2,
      tx_hash: hash,
      granted_at: Date.now(),
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

// dispatch — runs the adapter call and returns { txHash, in, out } where in/out are notification
// legs with { symbol, decimals, amountWei }. `out` may be null when the adapter doesn't surface
// an expected-output amount (e.g. Bankr/0x without parsing the quote payload).
const dispatch = async ({ wallet, plan }) => {
  if (plan.dex === "uniswap") {
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
    await ensurePermit2Approval({ wallet, token: plan.token.address });
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
        agentToken: plan.token.address,
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
      agentToken: plan.token.address,
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

  // Virtuals pre-grad tokens don't have Uniswap pools — honeypot.is can't simulate them.
  // For dex=virtuals we use a bonding-curve roundtrip probe instead. Other dexes go through
  // honeypot.is as before.
  const safety = plan.dex === "virtuals"
    ? await checkBondingCurve({ agentToken: plan.token.address })
    : plan.side === "buy"
      ? await checkToken(plan.token.address)
      : await checkBeforeSell(plan.token.address);

  inc("safety", { verdict: safety.safe ? "safe" : "unsafe", cached: safety.cached ? "yes" : "no" });

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
    const dispatched = await withWalletLock(wallet.account, () => dispatch({ wallet, plan }));
    updateTrade(tradeId, { status: "submitted", tx_hash: dispatched.txHash });
    inc("trade", { status: "submitted", dex: plan.dex, side: plan.side });
    notifyTrade({
      walletId: wallet.id,
      dex: plan.dex,
      side: plan.side,
      txHash: dispatched.txHash,
      explorer: config.chain.blockExplorer,
      in: dispatched.in,
      out: dispatched.out,
    });
    logger.info(
      { walletId: wallet.id, dex: plan.dex, side: plan.side, token: plan.token.symbol, txHash: dispatched.txHash },
      "trade submitted"
    );
    return { status: "submitted", txHash: dispatched.txHash };
  } catch (err) {
    updateTrade(tradeId, { status: "failed", error: err.message });
    inc("trade", { status: "failed", dex: plan.dex, side: plan.side });
    notifyError({ walletId: wallet.id, dex: plan.dex, error: err.message });
    logger.error({ walletId: wallet.id, err: err.message, dex: plan.dex }, "execution failed");
    return { status: "failed", error: err.message };
  }
};
