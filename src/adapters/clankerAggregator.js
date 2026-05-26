// Clanker-aggregator adapter. Uses the Clanker quoter API to obtain tx-ready calldata that
// the Clanker UI would have produced for this swap. The API picks the best router across
// KyberSwap / OKX / 0x / Uniswap UR and returns { txData, outputAmount, provider }; we just
// submit txData with our own wallet.
//
// Cost: Clanker takes a 1.0% integrator fee on output (visible in `activatedFeatures` and
// confirmed by amountOut vs outputAmount math). In exchange we get byte-perfect fingerprint
// match with the official UI flow, including per-router authorization signatures we couldn't
// reproduce on our own.
//
// Approval: for sells, we approve the router address Clanker picked (varies per quote — could
// be KyberSwap router, OKX router, etc.). Cached in the `approvals` table so the sweeper's
// `deleteApprovalsForToken` still cleans up on token EXPIRED/UNSAFE.
import { erc20Abi, maxUint256 } from "viem";
import { config } from "../config.js";
import { hasApproval, recordApproval } from "../core/db.js";
import { publicClient, walletClientFor } from "../core/rpc.js";
import { CLANKER_NATIVE_TOKEN, getQuote as defaultGetQuote } from "../util/clankerQuoter.js";
import { OnChainRevert } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { submitAndConfirm } from "../util/submitAndConfirm.js";
import { waitForAllowance } from "../util/waitForAllowance.js";

// DI for tests — replaceable transport.
const deps = {
  getQuote: defaultGetQuote,
  publicClient,
  walletClientFor,
};
export const _setDeps = (overrides) => Object.assign(deps, overrides);
export const _resetDeps = () => {
  deps.getQuote = defaultGetQuote;
  deps.publicClient = publicClient;
  deps.walletClientFor = walletClientFor;
};

// Synthesize the `route` object the executor expects from each adapter (quoteToLeg reads
// `route.quote.quotient.toString()`). The Clanker API gives us outputAmount as a BigInt;
// wrap it in the expected shape.
const synthRoute = (outputAmount) => ({
  quote: { quotient: { toString: () => outputAmount.toString() } },
});

// Ensure the wallet has approved `routerAddress` to pull `token`. Idempotent: skips if the
// on-chain allowance is already maxed. Records in DB so the sweeper can clean up on eviction.
// `routerAddress` varies per quote — Clanker picks the best router each time.
const ensureRouterApproval = async ({ wallet, token, routerAddress }) => {
  if (hasApproval({ wallet_id: wallet.id, token, spender: routerAddress })) return null;

  const current = await deps.publicClient.readContract({
    address: token, abi: erc20Abi, functionName: "allowance",
    args: [wallet.account.address, routerAddress],
  });
  // Already approved on-chain but not in DB (e.g. set in a previous daemon run). Record + skip.
  if (current >= maxUint256 / 2n) {
    recordApproval({
      wallet_id: wallet.id, token, spender: routerAddress,
      tx_hash: "0x0", granted_at: Date.now(),
    });
    return null;
  }

  const writeClient = deps.walletClientFor(wallet.account);
  const txHash = await writeClient.writeContract({
    address: token, abi: erc20Abi, functionName: "approve",
    args: [routerAddress, maxUint256],
  });
  await deps.publicClient.waitForTransactionReceipt({ hash: txHash });
  // Guard the subsequent swap against RPC load-balancer staleness (same pattern as v13.x).
  await waitForAllowance({
    owner: wallet.account.address, token, spender: routerAddress,
    atLeast: 2n ** 128n,
  });
  recordApproval({
    wallet_id: wallet.id, token, spender: routerAddress,
    tx_hash: txHash, granted_at: Date.now(),
  });
  logger.info(
    { walletId: wallet.id, token, spender: routerAddress, txHash },
    "clankerAggregator: router approval submitted"
  );
  return txHash;
};

// Pre-flight: simulate the swap via eth_call before broadcasting. Catches slippage reverts
// (e.g. KyberSwap's "Return amount is not enough") and other deterministic failures without
// spending gas. On revert we throw with the "clanker-api:" prefix so the executor's
// dispatcher falls back to the UR path (which uses our own configurable slippageBps).
//
// Rationale: the Clanker quote API hardcodes a tight slippage tolerance into the calldata
// (~1%). On fresh launches with low liquidity + sniper competition, the price moves enough
// between quote and broadcast that the tx reverts on slippage. Pre-simulation catches this
// upfront — observed live in v13.15 with 100% revert rate on Clanker buys.
const simulateOrThrow = async ({ wallet, quote }) => {
  try {
    await deps.publicClient.call({
      account: wallet.account,
      to: quote.txData.to,
      data: quote.txData.data,
      value: quote.txData.value ?? 0n,
    });
  } catch (err) {
    const reason = String(err.shortMessage ?? err.message ?? err).slice(0, 150);
    throw new Error(`clanker-api: simulation reverted (${reason})`);
  }
};

const submitFromQuote = async ({ wallet, quote }) => {
  await simulateOrThrow({ wallet, quote });
  const writeClient = deps.walletClientFor(wallet.account);
  try {
    const { hash } = await submitAndConfirm({
      publicClient: deps.publicClient,
      walletClient: writeClient,
      tx: {
        to: quote.txData.to,
        data: quote.txData.data,
        value: quote.txData.value ?? 0n,
      },
    });
    return hash;
  } catch (err) {
    // If the broadcast lands but reverts on-chain (race between sim pass and broadcast),
    // re-throw with the "clanker-api:" prefix so the dispatcher falls back to UR — same
    // way it would for a simulation-time revert. Without this prefix the executor would
    // mark the trade as `reverted` permanently, missing the chance to retry via UR.
    if (err instanceof OnChainRevert) {
      throw new Error(`clanker-api: tx reverted on-chain (hash=${err.txHash})`);
    }
    throw err;
  }
};

// buy: ETH → token. No approval needed (we send ETH directly in tx.value).
export const buyExactEthForToken = async ({ wallet, tokenOut, amountInWei }) => {
  const q = await deps.getQuote({
    chainId: config.chain.chainId,
    inputToken: CLANKER_NATIVE_TOKEN,
    outputToken: tokenOut.address,
    inputAmount: amountInWei,
    swapperAccount: wallet.account.address,
  });
  if (!q.success) throw new Error(`clanker-api: ${q.error}`);
  const txHash = await submitFromQuote({ wallet, quote: q });
  logger.info(
    { walletId: wallet.id, token: tokenOut.symbol, provider: q.provider,
      router: q.txData.to, expectedOut: q.outputAmount.toString() },
    "clankerAggregator: buy submitted"
  );
  return { txHash, route: synthRoute(q.outputAmount), provider: q.provider };
};

// sell: token → ETH. Ensures approval to the chosen router first.
export const sellExactTokenForEth = async ({ wallet, tokenIn, amountInWei }) => {
  const q = await deps.getQuote({
    chainId: config.chain.chainId,
    inputToken: tokenIn.address,
    outputToken: CLANKER_NATIVE_TOKEN,
    inputAmount: amountInWei,
    swapperAccount: wallet.account.address,
  });
  if (!q.success) throw new Error(`clanker-api: ${q.error}`);
  await ensureRouterApproval({
    wallet, token: tokenIn.address, routerAddress: q.txData.to,
  });
  const txHash = await submitFromQuote({ wallet, quote: q });
  logger.info(
    { walletId: wallet.id, token: tokenIn.symbol, provider: q.provider,
      router: q.txData.to, expectedOut: q.outputAmount.toString() },
    "clankerAggregator: sell submitted"
  );
  return { txHash, route: synthRoute(q.outputAmount), provider: q.provider };
};
