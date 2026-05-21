// On-chain simulation-based safety check. Replaces honeypot.is for V2/V3/V4 + Bankr.
//
// Pipeline:
//   1. quote ETH → token via AlphaRouter (catches V2/V3/V4 + splits)
//      - throws "no route" → token not indexed by Uniswap subgraph yet → PENDING
//   2. eth_call the actual buy calldata with stateOverride giving the simulated buyer ETH
//      - revert → buy mechanics blocked (modifier, max-buy, etc.) → UNSAFE
//   3. quote token → ETH for the expected output from step 1
//      - throws "no route" → sell direction unroutable → UNSAFE (classic honeypot pattern)
//   4. compute roundtripPct = ethBack / ethIn × 100
//      - below threshold (high tax / large price impact) → UNSAFE
//      - above threshold → SAFE
//
// Probe is a tiny 0.0001 ETH so we don't move the market. If the token's pool is too thin
// to handle even that, the buy sim reverts naturally and we mark UNSAFE.
import { parseEther } from "viem";
import { quote as defaultQuote } from "../adapters/uniswap.js";
import { publicClient as defaultPublicClient } from "../core/rpc.js";

const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const FAKE_BUYER = "0x000000000000000000000000000000000000C0DE";
const PROBE_AMOUNT_ETH = parseEther("0.0001");
const MIN_ROUNDTRIP_PCT = 70; // tolerate up to 30% loss (taxes + price impact on the probe)
const FAKE_BUYER_ETH_OVERRIDE = parseEther("1"); // way more than we'll spend, covers gas too

const isNoRouteError = (err) => {
  const msg = String(err?.message ?? err?.shortMessage ?? "");
  return /no route|cannot find/i.test(msg);
};

// _deps lets tests inject mocks without monkey-patching ESM exports.
const defaultDeps = { quote: defaultQuote, publicClient: defaultPublicClient };
export const _setDeps = (overrides) => Object.assign(defaultDeps, overrides);
export const _resetDeps = () => {
  defaultDeps.quote = defaultQuote;
  defaultDeps.publicClient = defaultPublicClient;
};

export const simulateRoundtrip = async ({ token }) => {
  const { quote, publicClient } = defaultDeps;
  const ETH_LEG = { address: NATIVE_SENTINEL, decimals: 18, symbol: "ETH" };
  const tokenLeg = typeof token === "string" ? { address: token, decimals: 18, symbol: "?" } : token;

  // Step 1: quote ETH → token
  let buyRoute;
  try {
    buyRoute = await quote({
      tokenIn: ETH_LEG,
      tokenOut: tokenLeg,
      amountInWei: PROBE_AMOUNT_ETH,
      slippageBps: 1000, // generous to maximize sim survival
      recipient: FAKE_BUYER,
    });
  } catch (err) {
    if (isNoRouteError(err)) {
      return { safe: false, pending: true, reasons: ["AlphaRouter has no route yet"], cached: false };
    }
    return { safe: false, reasons: [`buy quote failed: ${err.shortMessage ?? err.message}`], cached: false };
  }

  // Step 2: eth_call simulate the buy calldata
  try {
    await publicClient.call({
      account: FAKE_BUYER,
      to: buyRoute.methodParameters.to,
      data: buyRoute.methodParameters.calldata,
      value: PROBE_AMOUNT_ETH,
      stateOverride: [{ address: FAKE_BUYER, balance: FAKE_BUYER_ETH_OVERRIDE }],
    });
  } catch (err) {
    return {
      safe: false,
      reasons: [`buy simulation reverted: ${err.shortMessage ?? err.message}`],
      cached: false,
    };
  }

  // Step 3: quote expected tokens back to ETH
  const expectedTokensOut = BigInt(buyRoute.quote.quotient.toString());
  if (expectedTokensOut === 0n) {
    return { safe: false, reasons: ["buy quote yielded zero tokens"], cached: false };
  }
  let sellRoute;
  try {
    sellRoute = await quote({
      tokenIn: tokenLeg,
      tokenOut: ETH_LEG,
      amountInWei: expectedTokensOut,
      slippageBps: 1000,
      recipient: FAKE_BUYER,
    });
  } catch (err) {
    if (isNoRouteError(err)) {
      return { safe: false, reasons: ["sell direction has no route — likely honeypot pattern"], cached: false };
    }
    return { safe: false, reasons: [`sell quote failed: ${err.shortMessage ?? err.message}`], cached: false };
  }

  // Step 4: ratio check
  const ethBack = BigInt(sellRoute.quote.quotient.toString());
  const roundtripPct = Number((ethBack * 10000n) / PROBE_AMOUNT_ETH) / 100;
  const safe = roundtripPct >= MIN_ROUNDTRIP_PCT;
  return {
    safe,
    reasons: safe ? [] : [`roundtrip recovers only ${roundtripPct.toFixed(2)}% (threshold ${MIN_ROUNDTRIP_PCT}%)`],
    roundtripPct,
    expectedTokensOutWei: expectedTokensOut.toString(),
    expectedEthBackWei: ethBack.toString(),
    cached: false,
  };
};

// API-compatible aliases so the discovery handlers and executor can swap between
// safety providers without changing call sites.
export const checkToken = (token) => simulateRoundtrip({ token });
export const checkBeforeSell = (token) => simulateRoundtrip({ token });
