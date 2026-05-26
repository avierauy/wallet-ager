// Direct V2/V3/V4 swap path — bypasses AlphaRouter when we already know the exact pool to
// hit. Used by the sniper on fresh-launch tokens where the Uniswap subgraph hasn't indexed
// the pool yet (AlphaRouter would return "no route found"). For aging-mode trades and any
// token without poolMetadata, the caller falls back to AlphaRouter.
//
// All swaps go through the Universal Router (UR_VERSION = V2_1_1). Encoding uses the official
// SDK helpers (RoutePlanner + V4Planner) which emit V2_1_1-compatible commands when given the
// urVersion flag — keeps us in sync with the live UI router and avoids manually tracking the
// minHopPriceX36 / maxHopSlippage params.
//
// Limitations (handled by caller's fallback):
//   - Tokens with poolMetadata.pending===true (Clanker/Doppler — we don't have the full V4
//     PoolKey from their launch events). Caller must check pending before calling.
//
// Sell path notes:
//   We use explicit on-chain Permit2.approve(token, UR, max, max) rather than the inline
//   PERMIT2_PERMIT command. The inline path's struct/signature encoding through ethers'
//   defaultAbiCoder hit subtle issues on V2_1_1 where the entire UR.execute reverted with
//   TRANSFER_FROM_FAILED (Permit2 saw zero allowance for the spender). Two extra one-time
//   approvals per (wallet, token) is a fair price for reliability — the subsequent sells
//   become plain UR.execute calls with no signature plumbing.
import { createRequire } from "node:module";
import { encodeFunctionData, erc20Abi, maxUint256, parseAbi } from "viem";
import { config } from "../config.js";
import { publicClient, walletClientFor } from "../core/rpc.js";
import { quoteV4Pool } from "../discovery/v4PoolKey.js";
import { simulateBeforeBroadcast } from "../util/simulateBeforeBroadcast.js";
import { submitAndConfirm } from "../util/submitAndConfirm.js";

const require = createRequire(import.meta.url);
const {
  CommandType,
  ROUTER_AS_RECIPIENT,
  RoutePlanner,
  UniversalRouterVersion,
} = require("@uniswap/universal-router-sdk");
const { Actions, V4Planner } = require("@uniswap/v4-sdk");

const UR_VERSION = UniversalRouterVersion.V2_1_1;
const UR_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
const NATIVE_ZERO = "0x0000000000000000000000000000000000000000";
const FULL_DELTA_AMOUNT = 0n; // V4 sentinel — settle/take whatever is owed

const V2_PAIR_ABI = parseAbi([
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
]);
const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);
// V4 minOut is computed via the official V4Quoter — exact, accounting for concentrated
// liquidity and any hook fee adjustments. See src/discovery/v4PoolKey.js for the helper.

const applySlippage = (amount, slippageBps) =>
  (amount * BigInt(10000 - slippageBps)) / 10000n;

// ---- minOut computation -----------------------------------------------------

// V2: exact via x*y=k with 0.3% fee. amountIn * 997 * reserveOut / (reserveIn * 1000 + amountIn * 997).
const computeV2MinOut = async ({ pair, tokenIn, amountIn, slippageBps }) => {
  const [reserve0, reserve1] = await publicClient.readContract({
    address: pair, abi: V2_PAIR_ABI, functionName: "getReserves",
  });
  const token0 = await publicClient.readContract({
    address: pair, abi: V2_PAIR_ABI, functionName: "token0",
  });
  const inIs0 = tokenIn.toLowerCase() === token0.toLowerCase();
  const reserveIn = inIs0 ? reserve0 : reserve1;
  const reserveOut = inIs0 ? reserve1 : reserve0;
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  const amountInWithFee = amountIn * 997n;
  const expectedOut = (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
  return applySlippage(expectedOut, slippageBps);
};

// V3/V4: approximate via sqrtPriceX96 (assumes infinite depth — the slippageBps buffer covers
// the real depth-induced slippage). price = (sqrtPriceX96 / 2^96)^2 expressed as token1/token0.
const priceQuote = ({ sqrtPriceX96, amountIn, inIsToken0 }) => {
  if (sqrtPriceX96 === 0n) return 0n;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  // inIs0 → out = in * sq / 2^192;  inIs1 → out = in * 2^192 / sq
  return inIsToken0 ? (amountIn * sq) >> 192n : (amountIn << 192n) / sq;
};

const computeV3MinOut = async ({ pool, tokenIn, token0, amountIn, slippageBps }) => {
  const [sqrtPriceX96] = await publicClient.readContract({
    address: pool, abi: V3_POOL_ABI, functionName: "slot0",
  });
  const inIsToken0 = tokenIn.toLowerCase() === token0.toLowerCase();
  const expectedOut = priceQuote({ sqrtPriceX96, amountIn, inIsToken0 });
  return applySlippage(expectedOut, slippageBps);
};

// Quote the exact amountOut via V4Quoter, then apply slippageBps as the user's buffer.
// Returns 0n if the Quoter reverts (caller will fail the swap before broadcast).
const computeV4MinOut = async ({ poolKey, zeroForOne, amountIn, slippageBps }) => {
  const q = await quoteV4Pool({
    poolKey, amountIn, zeroForOne,
    publicClient, quoter: config.chain.dexes.uniswap.v4Quoter,
  });
  if (!q || q.amountOut === 0n) return 0n;
  return applySlippage(q.amountOut, slippageBps);
};

// ---- calldata builders ------------------------------------------------------

const buildExecuteCalldata = (planner, deadline) =>
  encodeFunctionData({
    abi: UR_ABI,
    functionName: "execute",
    args: [planner.commands, planner.inputs, deadline],
  });

const submitUR = async ({ account, calldata, value }) => {
  const wallet = walletClientFor(account);
  // v13.18: pre-simulate before broadcast. Catches Clanker hook anti-snipe window blocks
  // and similar structural reverts without burning gas. Throws PreSimulationRevert which
  // propagates to executor (status 'pre-sim-reverted') and the sniper retry queue.
  await simulateBeforeBroadcast({
    publicClient, account,
    tx: { to: config.chain.dexes.uniswap.universalRouter, data: calldata, value },
  });
  // v13.17: wait + verify receipt. Post-broadcast reverts throw OnChainRevert.
  const { hash } = await submitAndConfirm({
    publicClient,
    walletClient: wallet,
    tx: { to: config.chain.dexes.uniswap.universalRouter, data: calldata, value },
  });
  return hash;
};

// ---- V2 buy (ETH → token) ---------------------------------------------------

export const buyV2Direct = async ({ account, poolMetadata, amountInWei, slippageBps }) => {
  const { pair, token0, token1 } = poolMetadata;
  const WETH = config.chain.wnative;
  const tokenOut = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0;
  const minOut = await computeV2MinOut({ pair, tokenIn: WETH, amountIn: amountInWei, slippageBps });

  const planner = new RoutePlanner();
  planner.addCommand(CommandType.WRAP_ETH,
    [ROUTER_AS_RECIPIENT, amountInWei.toString()], false, UR_VERSION);
  planner.addCommand(CommandType.V2_SWAP_EXACT_IN, [
    account.address,
    amountInWei.toString(),
    minOut.toString(),
    [WETH, tokenOut],
    false, // payerIsUser = false; router holds the wrapped WETH
    [],    // minHopPriceX36 — empty (global check via amountOutMin)
  ], false, UR_VERSION);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const data = buildExecuteCalldata(planner, deadline);
  const txHash = await submitUR({ account, calldata: data, value: amountInWei });
  return { txHash, minOut, path: "v2-direct" };
};

// ---- V3 buy (ETH → token) ---------------------------------------------------

export const buyV3Direct = async ({ account, poolMetadata, amountInWei, slippageBps }) => {
  const { pool, fee, token0, token1 } = poolMetadata;
  const WETH = config.chain.wnative;
  const tokenOut = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0;
  const minOut = await computeV3MinOut({ pool, tokenIn: WETH, token0, amountIn: amountInWei, slippageBps });

  // V3 path: tokenIn (20 bytes) + fee (3 bytes) + tokenOut (20 bytes) — single hop
  const feeHex = Number(fee).toString(16).padStart(6, "0");
  const path = `0x${WETH.slice(2).toLowerCase()}${feeHex}${tokenOut.slice(2).toLowerCase()}`;

  const planner = new RoutePlanner();
  planner.addCommand(CommandType.WRAP_ETH,
    [ROUTER_AS_RECIPIENT, amountInWei.toString()], false, UR_VERSION);
  planner.addCommand(CommandType.V3_SWAP_EXACT_IN, [
    account.address,
    amountInWei.toString(),
    minOut.toString(),
    path,
    false,
    [],
  ], false, UR_VERSION);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const data = buildExecuteCalldata(planner, deadline);
  const txHash = await submitUR({ account, calldata: data, value: amountInWei });
  return { txHash, minOut, path: "v3-direct" };
};

// ---- V4 buy (ETH → token) ---------------------------------------------------

export const buyV4Direct = async ({ account, poolMetadata, amountInWei, slippageBps }) => {
  const { poolId, currency0, currency1, fee, tickSpacing, hooks } = poolMetadata;
  const WETH = config.chain.wnative;

  const c0Lower = currency0.toLowerCase();
  const c1Lower = currency1.toLowerCase();
  const wethLower = WETH.toLowerCase();
  const c0IsWeth = c0Lower === wethLower || c0Lower === NATIVE_ZERO;
  const c1IsWeth = c1Lower === wethLower || c1Lower === NATIVE_ZERO;
  if (!c0IsWeth && !c1IsWeth) throw new Error("buyV4Direct: pool has no WETH/native side");

  const inputIsCurrency0 = c0IsWeth;
  const currencyIn = inputIsCurrency0 ? currency0 : currency1;
  const currencyOut = inputIsCurrency0 ? currency1 : currency0;
  const zeroForOne = inputIsCurrency0;
  const inputIsNative = currencyIn.toLowerCase() === NATIVE_ZERO;

  const minOut = await computeV4MinOut({
    poolKey: { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks },
    zeroForOne,
    amountIn: amountInWei,
    slippageBps,
  });

  // Build V4 swap actions — mirroring the canonical sequence emitted by
  // @uniswap/universal-router-sdk's addV4Swap helper:
  //   SWAP_EXACT_IN_SINGLE — execute the swap, accumulating deltas in the PoolManager
  //   SETTLE               — router pays the input currency (payerIsUser=false because
  //                          we WRAP_ETH first, so the router itself holds WETH)
  //   TAKE                 — router collects the output and forwards to the user
  //
  // FULL_DELTA_AMOUNT (= 0) tells SETTLE/TAKE to use the entire net delta from the swap,
  // sidestepping the rounding mismatches that SETTLE_ALL's maxAmount check triggers.
  const v4Planner = new V4Planner();
  v4Planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [{
    poolKey: { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks },
    zeroForOne,
    amountIn: amountInWei.toString(),
    amountOutMinimum: minOut.toString(),
    maxHopSlippage: "0",
    hookData: "0x",
  }], UR_VERSION);
  v4Planner.addAction(Actions.SETTLE, [currencyIn, FULL_DELTA_AMOUNT.toString(), false]);
  v4Planner.addAction(Actions.TAKE, [currencyOut, account.address, FULL_DELTA_AMOUNT.toString()]);
  const v4SwapInput = v4Planner.finalize();

  const planner = new RoutePlanner();
  if (!inputIsNative) {
    // Wrap so the router holds WETH for SETTLE. Native ETH path settles msg.value directly.
    planner.addCommand(CommandType.WRAP_ETH,
      [ROUTER_AS_RECIPIENT, amountInWei.toString()], false, UR_VERSION);
  }
  planner.addCommand(CommandType.V4_SWAP, [v4SwapInput], false, UR_VERSION);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const data = buildExecuteCalldata(planner, deadline);
  const txHash = await submitUR({ account, calldata: data, value: amountInWei });
  return { txHash, minOut, path: "v4-direct" };
};

// ---- V4 sell (token → ETH) -------------------------------------------------

const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const MAX_UINT160 = 2n ** 160n - 1n;
const MAX_UINT48 = 2n ** 48n - 1n;

// Idempotent two-step approval: ERC20 → Permit2, then Permit2 → UR. Returns the txHashes
// produced (empty if nothing was needed), so callers can record them.
const ensureSellApprovals = async ({ account, token }) => {
  const permit2 = config.chain.permit2;
  const universalRouter = config.chain.dexes.uniswap.universalRouter;
  const wallet = walletClientFor(account);
  const hashes = [];

  const ercAllowance = await publicClient.readContract({
    address: token, abi: erc20Abi, functionName: "allowance",
    args: [account.address, permit2],
  });
  if (ercAllowance < maxUint256 / 2n) {
    const h = await wallet.writeContract({
      address: token, abi: erc20Abi, functionName: "approve",
      args: [permit2, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
    hashes.push({ step: "erc20-approve-permit2", hash: h });
  }

  const [p2Allowance] = await publicClient.readContract({
    address: permit2, abi: PERMIT2_ABI, functionName: "allowance",
    args: [account.address, token, universalRouter],
  });
  if (p2Allowance < MAX_UINT160 / 2n) {
    const h = await wallet.writeContract({
      address: permit2, abi: PERMIT2_ABI, functionName: "approve",
      args: [token, universalRouter, MAX_UINT160, Number(MAX_UINT48)],
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
    hashes.push({ step: "permit2-approve-router", hash: h });
  }

  return hashes;
};

// Minimum slippage floor on sells. The configured `sniper.sellSlippageBps` is honored if
// it's larger. We pair this with an inner retry-with-zero (see `buildAndSubmit` below): if
// the slippage-bounded attempt reverts, we immediately resubmit with minOut=0, accepting
// any output rather than leaving the position open. The outer sniper scheduler does another
// 5x30s retry loop on top, so the end-to-end recovery surface is very wide even at low
// slippage settings.
const MIN_SELL_SLIPPAGE_BPS = 1000;

export const sellV4Direct = async ({ account, poolMetadata, amountInWei, slippageBps }) => {
  const { currency0, currency1, fee, tickSpacing, hooks } = poolMetadata;
  const WETH = config.chain.wnative;
  const c0Lower = currency0.toLowerCase();
  const c1Lower = currency1.toLowerCase();
  const wethLower = WETH.toLowerCase();

  // Identify the token side (the non-WETH/non-native currency).
  const c0IsWeth = c0Lower === wethLower || c0Lower === NATIVE_ZERO;
  if (!c0IsWeth && c1Lower !== wethLower && c1Lower !== NATIVE_ZERO) {
    throw new Error("sellV4Direct: pool has no WETH/native side");
  }
  const tokenInIsCurrency0 = !c0IsWeth;
  const currencyIn = tokenInIsCurrency0 ? currency0 : currency1;
  const currencyOut = tokenInIsCurrency0 ? currency1 : currency0;
  const zeroForOne = tokenInIsCurrency0;

  // Make sure approvals are in place (idempotent — skipped after the first call).
  const approvals = await ensureSellApprovals({ account, token: currencyIn });

  // Get exact output via Quoter for the actual amountInWei.
  const q = await quoteV4Pool({
    poolKey: { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks },
    amountIn: amountInWei,
    zeroForOne,
    publicClient,
    quoter: config.chain.dexes.uniswap.v4Quoter,
  });
  if (!q || q.amountOut === 0n) {
    throw new Error("sellV4Direct: Quoter rejected the swap (hook block or no liquidity)");
  }
  const effectiveSlippage = Math.max(slippageBps, MIN_SELL_SLIPPAGE_BPS);
  const slippageMinOut = applySlippage(q.amountOut, effectiveSlippage);

  // Build + submit. If the bounded-slippage attempt reverts (transient hook state, price
  // moved hard, etc.), retry once with minOut=0 — by this point we've already validated via
  // the Quoter that the pool exists and currently accepts trades, so the residual risk is
  // accepting a worse price rather than holding a worthless bag.
  const buildAndSubmit = async (minOut) => {
    const v4Planner = new V4Planner();
    v4Planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [{
      poolKey: { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks },
      zeroForOne,
      amountIn: amountInWei.toString(),
      amountOutMinimum: minOut.toString(),
      maxHopSlippage: "0",
      hookData: "0x",
    }], UR_VERSION);
    v4Planner.addAction(Actions.SETTLE, [currencyIn, FULL_DELTA_AMOUNT.toString(), true]);
    v4Planner.addAction(Actions.TAKE, [currencyOut, ROUTER_AS_RECIPIENT, FULL_DELTA_AMOUNT.toString()]);
    const v4SwapInput = v4Planner.finalize();

    const planner = new RoutePlanner();
    planner.addCommand(CommandType.V4_SWAP, [v4SwapInput], false, UR_VERSION);
    planner.addCommand(CommandType.UNWRAP_WETH, [account.address, "0"], false, UR_VERSION);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const data = buildExecuteCalldata(planner, deadline);
    return submitUR({ account, calldata: data, value: 0n });
  };

  let txHash;
  let usedMinOut = slippageMinOut;
  try {
    txHash = await buildAndSubmit(slippageMinOut);
  } catch (err) {
    usedMinOut = 0n;
    txHash = await buildAndSubmit(0n);
  }
  return { txHash, minOut: usedMinOut, expectedOut: q.amountOut, path: "v4-direct-sell", approvals };
};

// ---- V3 sell (token → ETH) -------------------------------------------------

// V3 QuoterV2 (deployed at config.chain.dexes.uniswap.quoterV2). Same revert-with-data
// pattern as the V4 Quoter — call via simulateContract.
const V3_QUOTERV2_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const quoteV3Pool = async ({ tokenIn, tokenOut, fee, amountIn, publicClient: client, quoter }) => {
  try {
    const r = await client.simulateContract({
      address: quoter, abi: V3_QUOTERV2_ABI, functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee: Number(fee), sqrtPriceLimitX96: 0n }],
    });
    return { amountOut: r.result[0], gasEstimate: r.result[3] };
  } catch {
    return null;
  }
};

export const sellV3Direct = async ({ account, poolMetadata, amountInWei, slippageBps }) => {
  const { pool, fee, token0, token1 } = poolMetadata;
  const WETH = config.chain.wnative;
  const wethLower = WETH.toLowerCase();
  const t0Lower = token0.toLowerCase();
  if (t0Lower !== wethLower && token1.toLowerCase() !== wethLower) {
    throw new Error("sellV3Direct: pool has no WETH side");
  }
  const tokenIn = t0Lower === wethLower ? token1 : token0;
  const tokenOut = WETH;

  const approvals = await ensureSellApprovals({ account, token: tokenIn });

  const q = await quoteV3Pool({
    tokenIn, tokenOut, fee, amountIn: amountInWei,
    publicClient, quoter: config.chain.dexes.uniswap.quoterV2,
  });
  if (!q || q.amountOut === 0n) {
    throw new Error("sellV3Direct: Quoter rejected the swap (no liquidity or path)");
  }
  const effectiveSlippage = Math.max(slippageBps, MIN_SELL_SLIPPAGE_BPS);
  const slippageMinOut = applySlippage(q.amountOut, effectiveSlippage);

  // V3 swap path: tokenIn (20 bytes) + fee (3 bytes) + WETH (20 bytes) — single hop.
  const feeHex = Number(fee).toString(16).padStart(6, "0");
  const path = `0x${tokenIn.slice(2).toLowerCase()}${feeHex}${WETH.slice(2).toLowerCase()}`;

  const buildAndSubmit = async (minOut) => {
    const planner = new RoutePlanner();
    // payerIsUser=true → UR pulls tokens via Permit2 (we pre-approved)
    // recipient = ROUTER_AS_RECIPIENT so UNWRAP_WETH can convert + forward
    planner.addCommand(CommandType.V3_SWAP_EXACT_IN, [
      ROUTER_AS_RECIPIENT,
      amountInWei.toString(),
      minOut.toString(),
      path,
      true, // payerIsUser
      [],   // minHopPriceX36 — empty
    ], false, UR_VERSION);
    planner.addCommand(CommandType.UNWRAP_WETH, [account.address, "0"], false, UR_VERSION);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const data = buildExecuteCalldata(planner, deadline);
    return submitUR({ account, calldata: data, value: 0n });
  };

  let txHash;
  let usedMinOut = slippageMinOut;
  try {
    txHash = await buildAndSubmit(slippageMinOut);
  } catch (err) {
    usedMinOut = 0n;
    txHash = await buildAndSubmit(0n);
  }
  return { txHash, minOut: usedMinOut, expectedOut: q.amountOut, path: "v3-direct-sell", approvals };
};

// ---- dispatcher -------------------------------------------------------------

export const isDirectSwappable = (poolMetadata) => {
  if (!poolMetadata || poolMetadata.pending) return false;
  return ["v2", "v3", "v4"].includes(poolMetadata.version);
};

// Sell-direction direct swap is wired for V3 and V4 — covers all fresh-launch volume on
// Base (Clanker/Doppler V4 + occasional V3 pool from generic factory events).
export const isSellDirectSwappable = (poolMetadata) => {
  if (!poolMetadata || poolMetadata.pending) return false;
  return poolMetadata.version === "v3" || poolMetadata.version === "v4";
};

export const buyDirect = async ({ account, poolMetadata, amountInWei, slippageBps }) => {
  if (!poolMetadata) throw new Error("buyDirect: poolMetadata is required");
  switch (poolMetadata.version) {
    case "v2": return buyV2Direct({ account, poolMetadata, amountInWei, slippageBps });
    case "v3": return buyV3Direct({ account, poolMetadata, amountInWei, slippageBps });
    case "v4": return buyV4Direct({ account, poolMetadata, amountInWei, slippageBps });
    default: throw new Error(`buyDirect: unsupported version ${poolMetadata.version}`);
  }
};

export const sellDirect = async ({ account, poolMetadata, amountInWei, slippageBps }) => {
  if (!poolMetadata) throw new Error("sellDirect: poolMetadata is required");
  switch (poolMetadata.version) {
    case "v3": return sellV3Direct({ account, poolMetadata, amountInWei, slippageBps });
    case "v4": return sellV4Direct({ account, poolMetadata, amountInWei, slippageBps });
    default: throw new Error(`sellDirect: unsupported version ${poolMetadata.version}`);
  }
};
