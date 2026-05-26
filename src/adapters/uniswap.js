// The Uniswap SDK packages ship ESM with missing .js extensions which Node's strict resolver
// rejects. We load them via the CJS entry to avoid that issue — same code, just a different
// module format. Keep this isolated to the Uniswap adapter.
import { createRequire } from "node:module";
import { erc20Abi, maxUint256 } from "viem";
import { config } from "../config.js";
import { publicClient, walletClientFor } from "../core/rpc.js";
import { ethersProvider } from "../util/ethersProvider.js";
import { signPermitSingle } from "../util/permit2.js";
import { simulateBeforeBroadcast } from "../util/simulateBeforeBroadcast.js";
import { submitAndConfirm } from "../util/submitAndConfirm.js";
import { buyDirect, isDirectSwappable, isSellDirectSwappable, sellDirect } from "./directSwap.js";
import { logger } from "../util/logger.js";

const require = createRequire(import.meta.url);
const { CurrencyAmount, Ether, Percent, Token, TradeType } = require("@uniswap/sdk-core");
const { AlphaRouter, SwapType } = require("@uniswap/smart-order-router");
const { UniversalRouterVersion } = require("@uniswap/universal-router-sdk");

// V2_1_1 matches the router the live UI uses (0xfdf6…fbc7). Requires the package.json
// `overrides` entry forcing universal-router-sdk ^5.4.0 — the version smart-order-router
// pulls by default (4.35.0) produces invalid V2_1_1 calldata (SliceOutOfBounds).
const UR_VERSION = UniversalRouterVersion.V2_1_1;

const permit2 = () => config.chain.permit2;

// AlphaRouter is heavy to instantiate (loads pool data on first call). Reuse one instance.
let routerSingleton = null;
const getRouter = () => {
  if (!routerSingleton) {
    routerSingleton = new AlphaRouter({
      chainId: config.chain.chainId,
      provider: ethersProvider,
    });
  }
  return routerSingleton;
};

const toCurrency = ({ address, decimals, symbol }) => {
  const native = config.chain.nativeSentinel;
  if (address.toLowerCase() === native.toLowerCase()) return Ether.onChain(config.chain.chainId);
  return new Token(config.chain.chainId, address, decimals, symbol);
};

// Soft-error patterns that mean "router couldn't price this trade right now" — almost always
// the V4 subgraph lagging behind chain state on fresh launches. We collapse them into the
// same "no route found" surface the executor already knows how to treat as a failed trade,
// instead of letting the raw stack escape and risk an unhandled rejection.
const SUBGRAPH_SOFT_ERROR = /(failed to get subgraph pools|subgraph|no route)/i;

// quote: returns the AlphaRouter SwapRoute (covers V2/V3/V4 + splits). `methodParameters` has
// `{ to, calldata, value }` ready to forward to viem.
export const quote = async ({ tokenIn, tokenOut, amountInWei, slippageBps, recipient, inputTokenPermit }) => {
  const router = getRouter();
  const inCur = toCurrency(tokenIn);
  const outCur = toCurrency(tokenOut);
  const amount = CurrencyAmount.fromRawAmount(inCur, amountInWei.toString());
  let route;
  try {
    route = await router.route(amount, outCur, TradeType.EXACT_INPUT, {
      recipient,
      slippageTolerance: new Percent(slippageBps, 10_000),
      deadline: Math.floor(Date.now() / 1000) + 1800,
      type: SwapType.UNIVERSAL_ROUTER,
      version: UR_VERSION,    // smart-order-router reads this for UNIVERSAL_ROUTER_ADDRESS lookup
      urVersion: UR_VERSION,  // universal-router-sdk reads this for command ABI selection (V2_1_1 adds minHopPriceX36)
      ...(inputTokenPermit ? { inputTokenPermit } : {}),
    });
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (SUBGRAPH_SOFT_ERROR.test(msg)) {
      logger.warn({ err: msg.slice(0, 200) }, "AlphaRouter subgraph soft-error — treating as no route");
      throw new Error("no route found");
    }
    throw err;
  }
  if (!route) throw new Error("no route found");
  return route;
};

// One-time per (wallet, token) — Uniswap UI uses max approve to Permit2.
export const approveTokenToPermit2 = async ({ account, token }) => {
  const wallet = walletClientFor(account);
  const current = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, permit2()],
  });
  if (current >= maxUint256 / 2n) return null;
  return wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [permit2(), maxUint256],
  });
};

const submitRoute = async ({ account, route }) => {
  const wallet = walletClientFor(account);
  const { to, calldata, value } = route.methodParameters;
  // v13.18: pre-simulate to catch hook blocks / structural reverts before broadcasting.
  // Throws PreSimulationRevert if it would revert. Caller (sniper retry path) reschedules.
  await simulateBeforeBroadcast({
    publicClient, account,
    tx: { to, data: calldata, value: BigInt(value) },
  });
  // v13.17: wait for receipt + verify status. On-chain reverts (race past pre-sim) throw
  // OnChainRevert which propagates up to the executor.
  const { hash } = await submitAndConfirm({
    publicClient,
    walletClient: wallet,
    tx: { to, data: calldata, value: BigInt(value) },
  });
  return hash;
};

export const buyExactEthForToken = async ({ account, tokenOut, amountInWei, slippageBps }) => {
  // Fast path: fresh-launch token with full pool metadata → bypass AlphaRouter's subgraph
  // (avoids "no route found" on pools the indexer hasn't picked up yet).
  if (isDirectSwappable(tokenOut.poolMetadata)) {
    try {
      const r = await buyDirect({
        account,
        poolMetadata: tokenOut.poolMetadata,
        amountInWei,
        slippageBps,
      });
      logger.debug(
        { token: tokenOut.symbol, path: r.path, minOut: r.minOut.toString(), txHash: r.txHash },
        "uniswap: direct swap submitted"
      );
      // Synthetic route shape so the executor's notifyTrade can still compute the output leg.
      const syntheticRoute = { quote: { quotient: { toString: () => r.minOut.toString() } } };
      return { txHash: r.txHash, route: syntheticRoute };
    } catch (err) {
      logger.warn(
        { token: tokenOut.symbol, err: err.message },
        "uniswap: directSwap failed — falling back to AlphaRouter"
      );
      // Falls through to AlphaRouter below.
    }
  }

  const route = await quote({
    tokenIn: { address: config.chain.nativeSentinel, decimals: 18, symbol: "ETH" },
    tokenOut,
    amountInWei,
    slippageBps,
    recipient: account.address,
  });
  return { txHash: await submitRoute({ account, route }), route };
};

export const sellExactTokenForEth = async ({ account, tokenIn, amountInWei, slippageBps }) => {
  // Fast path: token has V4 metadata captured at discovery time → bypass AlphaRouter (whose
  // subgraph lag stalls sells for minutes on fresh launches) and swap directly via UR + V4.
  // The directSwap adapter handles its own ERC20→Permit2 + Permit2→UR approvals.
  if (isSellDirectSwappable(tokenIn.poolMetadata)) {
    try {
      const r = await sellDirect({
        account,
        poolMetadata: tokenIn.poolMetadata,
        amountInWei,
        slippageBps,
      });
      logger.debug(
        { token: tokenIn.symbol, path: r.path, minOut: r.minOut.toString(),
          expectedOut: r.expectedOut.toString(), txHash: r.txHash,
          approvals: r.approvals.length },
        "uniswap: direct sell submitted"
      );
      const syntheticRoute = { quote: { quotient: { toString: () => r.expectedOut.toString() } } };
      return { txHash: r.txHash, route: syntheticRoute };
    } catch (err) {
      logger.warn(
        { token: tokenIn.symbol, err: err.message },
        "uniswap: direct sell failed — falling back to AlphaRouter"
      );
      // Falls through to AlphaRouter below.
    }
  }

  const universalRouter = config.chain.dexes.uniswap.universalRouter;
  const wallet = walletClientFor(account);

  const { permit, signature } = await signPermitSingle({
    walletClient: wallet,
    account,
    token: tokenIn.address,
    spender: universalRouter,
  });
  const inputTokenPermit = { ...permit, signature };

  const route = await quote({
    tokenIn,
    tokenOut: { address: config.chain.nativeSentinel, decimals: 18, symbol: "ETH" },
    amountInWei,
    slippageBps,
    recipient: account.address,
    inputTokenPermit,
  });
  return { txHash: await submitRoute({ account, route }), route };
};
