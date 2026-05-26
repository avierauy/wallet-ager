import { concat, encodeFunctionData, erc20Abi, parseAbi } from "viem";
import { config } from "../config.js";
import { publicClient, walletClientFor } from "../core/rpc.js";
import { notifyApproval } from "../notify/telegram.js";
import { OnChainRevert, SkipExecution } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { submitAndConfirm } from "../util/submitAndConfirm.js";
import { waitForAllowance } from "../util/waitForAllowance.js";
import * as uniswap from "./uniswap.js";

const BONDING_ABI = parseAbi([
  "function buy(uint256 amountIn, address token, uint256 minAmountOut, uint256 deadline)",
  "function sell(uint256 amountIn, address token, uint256 minAmountOut, uint256 deadline)",
]);

// FRouterV3.getAmountsOut(token, assetToken_, amountIn):
//   - When assetToken_ == VIRTUAL → BUY direction: amountIn is VIRTUAL, returns expected agent
//   - When assetToken_ == agentToken → SELL direction: amountIn is agent, returns expected VIRTUAL
// Source: BaseScan-verified FRouterV3 at 0x42ea980e773ff5b18cc1c56f2f6db8bf47d55e32.
const FROUTER_ABI = parseAbi([
  "function getAmountsOut(address token, address assetToken_, uint256 amountIn) view returns (uint256)",
]);

const PRE_GRAD_ROUTER = () => config.chain.dexes.virtuals.preGradRouter;
const PRE_GRAD_SPENDER = () => config.chain.dexes.virtuals.preGradApproveSpender;
const VIRTUAL_TOKEN = () => config.chain.dexes.virtuals.virtualToken;
const MARKER = () => config.chain.dexes.virtuals.frontendMarker;

// Below this many wei of VIRTUAL the wallet is considered to have none.
const VIRTUAL_DUST_WEI = 10n ** 15n; // 0.001 VIRTUAL

// Pre-flight minimum: a Virtuals snipe requires acquiring at least DUST_WEI of $VIRTUAL on
// Uniswap. If the planned ETH amount is too small, slippage + thin liquidity can result in a
// post-acquisition balance below the dust threshold — the bonding curve then refuses to fire
// and the swap stays in the wallet as stuck dust. Skipping pre-flight when ETH < this minimum
// avoids wasting gas on a doomed acquisition. Calibrated for ~$5 USD spend at $3500/ETH,
// which gives a comfortable 5000x margin over the VIRTUAL dust threshold at $1/VIRTUAL.
const MIN_ETH_FOR_VIRTUALS_WEI = 1_500_000_000_000_000n; // 0.0015 ETH

const applySlippage = (amount, bps) => (amount * BigInt(10000 - bps)) / 10000n;

const appendMarker = (data) => (MARKER() ? concat([data, MARKER()]) : data);

// ---- PURE DATA BUILDERS (testable, no network) ----

export const buildApprovePreGradData = ({ amount }) =>
  appendMarker(
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [PRE_GRAD_SPENDER(), amount],
    })
  );

export const buildBuyPreGradData = ({ agentToken, amountInVirtualWei, minOutWei, deadline }) =>
  appendMarker(
    encodeFunctionData({
      abi: BONDING_ABI,
      functionName: "buy",
      args: [amountInVirtualWei, agentToken, minOutWei, deadline],
    })
  );

export const buildSellPreGradData = ({ agentToken, amountInWei, minOutVirtualWei, deadline }) =>
  appendMarker(
    encodeFunctionData({
      abi: BONDING_ABI,
      functionName: "sell",
      args: [amountInWei, agentToken, minOutVirtualWei, deadline],
    })
  );

// ---- HIGH-LEVEL ----

export const approveForPreGrad = async ({ account, token, amount }) => {
  const wallet = walletClientFor(account);
  const current = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, PRE_GRAD_SPENDER()],
  });
  if (current >= amount) return null;
  return wallet.sendTransaction({ to: token, data: buildApprovePreGradData({ amount }) });
};

export const buyPreGrad = async ({ account, agentToken, amountInVirtualWei, minOutWei, deadlineSecs = 600 }) => {
  const wallet = walletClientFor(account);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSecs);
  const data = buildBuyPreGradData({ agentToken, amountInVirtualWei, minOutWei, deadline });
  // v13.17: wait + verify receipt. On revert (token graduated / pool closed / hook reject),
  // submitAndConfirm throws OnChainRevert which the caller (executeBuyFlow) converts to
  // SkipExecution so the daily cap isn't burned and Telegram isn't spammed.
  const { hash } = await submitAndConfirm({
    publicClient, walletClient: wallet,
    tx: { to: PRE_GRAD_ROUTER(), data },
  });
  return hash;
};

export const sellPreGrad = async ({ account, agentToken, amountInWei, minOutVirtualWei, deadlineSecs = 600 }) => {
  const wallet = walletClientFor(account);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSecs);
  const data = buildSellPreGradData({ agentToken, amountInWei, minOutVirtualWei, deadline });
  const { hash } = await submitAndConfirm({
    publicClient, walletClient: wallet,
    tx: { to: PRE_GRAD_ROUTER(), data },
  });
  return hash;
};

// ---- READ HELPERS ----

export const readVirtualBalance = (account) =>
  publicClient.readContract({
    address: VIRTUAL_TOKEN(),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });

export const quoteVirtualToAgent = ({ agentToken, amountInVirtualWei }) =>
  publicClient.readContract({
    address: PRE_GRAD_SPENDER(),
    abi: FROUTER_ABI,
    functionName: "getAmountsOut",
    args: [agentToken, VIRTUAL_TOKEN(), amountInVirtualWei],
  });

export const quoteAgentToVirtual = ({ agentToken, amountInAgentWei }) =>
  publicClient.readContract({
    address: PRE_GRAD_SPENDER(),
    abi: FROUTER_ABI,
    functionName: "getAmountsOut",
    args: [agentToken, agentToken, amountInAgentWei],
  });

// ---- FULL FLOWS (chain multiple txs, wait for each receipt) ----

// Buy flow:
//   1. If wallet has VIRTUAL above dust → use ALL of it; no Uniswap step (per user's spec: reuse
//      VIRTUAL accumulated from prior sells, don't buy more).
//   2. If wallet has no/dust VIRTUAL → Uniswap ETH→VIRTUAL with the planned ETH amount, then use
//      the resulting VIRTUAL balance.
//   3. Approve exact-amount to FRouter (matches UI footprint, marker appended).
//   4. BondingV5.buy.
export const executeBuyFlow = async ({ wallet, agentToken, plannedAmountInWei, slippageBps }) => {
  const account = wallet.account;
  const agentTokenAddress = typeof agentToken === "string" ? agentToken : agentToken.address;

  let virtualBalance = await readVirtualBalance(account);
  let acquisition = null;

  if (virtualBalance < VIRTUAL_DUST_WEI) {
    // (A) Pre-flight: bail BEFORE broadcasting the Uniswap acquisition when the planned ETH
    // is too small to reliably produce a usable VIRTUAL balance. Avoids the failure mode
    // where the acquisition succeeds but lands sub-dust, leaving stuck VIRTUAL in the wallet
    // and wasting gas. SkipExecution → executor returns status="skipped", no slot consumed.
    if (plannedAmountInWei < MIN_ETH_FOR_VIRTUALS_WEI) {
      throw new SkipExecution(
        `Virtuals snipe skipped: planned ETH ${plannedAmountInWei} below minimum ${MIN_ETH_FOR_VIRTUALS_WEI} (no usable VIRTUAL in wallet)`
      );
    }
    const uniRes = await uniswap.buyExactEthForToken({
      account,
      tokenOut: { address: VIRTUAL_TOKEN(), decimals: 18, symbol: "VIRTUAL" },
      amountInWei: plannedAmountInWei,
      slippageBps,
    });
    await publicClient.waitForTransactionReceipt({ hash: uniRes.txHash });
    virtualBalance = await readVirtualBalance(account);
    acquisition = { txHash: uniRes.txHash, virtualAcquiredWei: virtualBalance.toString() };
    // (C) Recovery posture: if the acquisition still landed sub-dust (catastrophic slippage,
    // tx reverted but mined, etc.) skip cleanly instead of throwing as a hard failure. The
    // acquired VIRTUAL stays in the wallet — the next Virtuals snipe on this wallet will
    // pick up the accumulated balance via the recovery branch above (virtualBalance >= DUST).
    if (virtualBalance < VIRTUAL_DUST_WEI) {
      throw new SkipExecution(
        `VIRTUAL acquired (${virtualBalance}) still below dust ${VIRTUAL_DUST_WEI}; keeping for retry`
      );
    }
  }

  const approveTx = await approveForPreGrad({
    account,
    token: VIRTUAL_TOKEN(),
    amount: virtualBalance,
  });
  if (approveTx) {
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    // Receipt isn't enough: Infura's load-balanced reads can briefly return stale state for
    // the next tx's pre-flight (estimateGas). Poll allowance until the spender sees it.
    await waitForAllowance({
      owner: account.address,
      token: VIRTUAL_TOKEN(),
      spender: PRE_GRAD_SPENDER(),
      atLeast: virtualBalance,
    });
    notifyApproval({
      walletId: wallet.id,
      tokenSymbol: "VIRTUAL",
      decimals: 18,
      amountWei: virtualBalance,
      spender: PRE_GRAD_SPENDER(),
      spenderLabel: "Virtuals FRouter",
      txHash: approveTx,
      explorer: config.chain.blockExplorer,
    });
  }

  const expectedOut = await quoteVirtualToAgent({ agentToken: agentTokenAddress, amountInVirtualWei: virtualBalance });
  const minOut = applySlippage(expectedOut, slippageBps);

  // BondingV5.buy can revert on-chain for reasons the Quoter doesn't surface (token
  // graduated mid-cycle, bonding curve closed, hook rejection). Catch those and convert
  // to SkipExecution so the daily cap slot isn't burned and the operator doesn't get
  // spammed with notifyError for a structural condition we can't fix.
  let buyTx;
  try {
    buyTx = await buyPreGrad({
      account,
      agentToken: agentTokenAddress,
      amountInVirtualWei: virtualBalance,
      minOutWei: minOut,
    });
  } catch (err) {
    // v13.17: OnChainRevert is the post-broadcast confirmation; the legacy regex catches
    // pre-broadcast RPC rejections that include "reverted" in the message. Both indicate
    // the BondingV5.buy was structurally rejected (graduated token, closed curve, hook).
    if (err instanceof OnChainRevert || /execution reverted|reverted/i.test(err.message ?? "")) {
      throw new SkipExecution(
        `BondingV5.buy reverted (token graduated or pool closed): ${(err.message ?? "").slice(0, 120)}`
      );
    }
    throw err;
  }

  return {
    txHash: buyTx,
    acquisition,
    virtualSpentWei: virtualBalance.toString(),
    expectedAgentOutWei: expectedOut.toString(),
    minAgentOutWei: minOut.toString(),
  };
};

// Convert any VIRTUAL balance in the wallet to ETH via Uniswap. Idempotent on the
// approve step (approveTokenToPermit2 is a no-op if max allowance is already in place).
// Returns { skipped: "no-balance" } if the wallet has nothing above dust, or the swap
// result otherwise. Surface errors but DO NOT throw — the caller (sell flow / startup
// drain) treats the VIRTUAL→ETH leg as best-effort cleanup: if it fails the wallet
// keeps the VIRTUAL but the agent-token sell still counts as a completed roundtrip.
export const drainAccumulatedVirtual = async ({ account, slippageBps = 500 }) => {
  const virtualBalance = await readVirtualBalance(account);
  if (virtualBalance < VIRTUAL_DUST_WEI) {
    return { skipped: "no-balance", balance: virtualBalance.toString() };
  }
  // Ensure Permit2 has unlimited allowance from this wallet on VIRTUAL. No-op if it
  // already does (the helper checks current allowance and skips if >= MAX/2).
  await uniswap.approveTokenToPermit2({ account, token: VIRTUAL_TOKEN() });
  const swap = await uniswap.sellExactTokenForEth({
    account,
    tokenIn: { address: VIRTUAL_TOKEN(), decimals: 18, symbol: "VIRTUAL" },
    amountInWei: virtualBalance,
    slippageBps,
  });
  return {
    drained: true,
    virtualAmountWei: virtualBalance.toString(),
    txHash: swap.txHash,
  };
};

// Sell flow: approve agent token → BondingV5.sell → sell resulting VIRTUAL to ETH on
// Uniswap. Each cycle ends with the wallet holding ETH only, so the next buy starts
// from a known state (virtualBalance < DUST) and the executeBuyFlow pre-flight A check
// can correctly bail when the planned ETH is too small.
//
// The VIRTUAL→ETH leg is best-effort: if it fails (Uniswap reverts, RPC error), the
// agent-token sell is still considered successful and we log a warning. The next
// startup drain or a later cycle's VIRTUAL→ETH attempt can pick up the residual.
export const executeSellFlow = async ({ wallet, agentToken, amountInWei, slippageBps }) => {
  const account = wallet.account;
  const agentTokenAddress = typeof agentToken === "string" ? agentToken : agentToken.address;
  const agentTokenSymbol = typeof agentToken === "string" ? null : agentToken.symbol;
  const agentTokenDecimals = typeof agentToken === "string" ? 18 : agentToken.decimals;

  const approveTx = await approveForPreGrad({ account, token: agentTokenAddress, amount: amountInWei });
  if (approveTx) {
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    await waitForAllowance({
      owner: account.address,
      token: agentTokenAddress,
      spender: PRE_GRAD_SPENDER(),
      atLeast: amountInWei,
    });
    notifyApproval({
      walletId: wallet.id,
      tokenSymbol: agentTokenSymbol ?? agentTokenAddress.slice(0, 8),
      decimals: agentTokenDecimals,
      amountWei: amountInWei,
      spender: PRE_GRAD_SPENDER(),
      spenderLabel: "Virtuals FRouter",
      txHash: approveTx,
      explorer: config.chain.blockExplorer,
    });
  }

  const expectedOut = await quoteAgentToVirtual({ agentToken: agentTokenAddress, amountInAgentWei: amountInWei });
  const minOut = applySlippage(expectedOut, slippageBps);

  const sellTx = await sellPreGrad({
    account,
    agentToken: agentTokenAddress,
    amountInWei,
    minOutVirtualWei: minOut,
  });

  // Wait for the BondingV5.sell receipt before swapping the resulting VIRTUAL —
  // otherwise the Uniswap path sees a stale (lower) VIRTUAL balance.
  await publicClient.waitForTransactionReceipt({ hash: sellTx });

  // Close the roundtrip: dump the newly-received VIRTUAL to ETH. Best-effort: a failure
  // here doesn't unwind the agent-token sell, just leaves VIRTUAL in the wallet for the
  // next drain (either at startup or the next sell flow's call to this same helper).
  let virtualToEth = null;
  try {
    virtualToEth = await drainAccumulatedVirtual({ account, slippageBps });
  } catch (err) {
    logger.warn(
      { walletId: wallet.id, err: err.message, agentToken: agentTokenAddress },
      "virtuals: VIRTUAL→ETH leg failed; agent sell succeeded but VIRTUAL stays in wallet"
    );
  }

  return {
    txHash: sellTx,
    expectedVirtualOutWei: expectedOut.toString(),
    minVirtualOutWei: minOut.toString(),
    virtualToEth, // { drained, virtualAmountWei, txHash } | { skipped: "no-balance" } | null
  };
};
