// HTTP client for Clanker's quote API. Returns ready-to-send txData built by the same router
// the Clanker UI would have picked (KyberSwap, OKX, 0x, etc.), with their integrator fee
// already embedded in the calldata signature.
//
// Endpoint: https://www.clanker.world/api/quotes
// Required query params: chainId, inputToken, outputToken, inputAmount, swapperAccount, strategy
//
// Response shape (success):
//   { success: true,
//     provider: "kyberswap" | "okx" | "0x" | ...,
//     details: { routerAddress, encodedSwapData, totalGas, swaps, ... },
//     txData:  { to: "0x...", data: "0x...", value: bigint },
//     outputAmount: bigint,
//     inputAmount:  bigint,
//     ... }
//
// The API serializes some numeric fields as the string "__bigint__:<digits>" — we strip that
// prefix in a JSON reviver and return real BigInts so callers can pass txData.value directly
// to viem's sendTransaction.
import { logger } from "./logger.js";

const BASE_URL = "https://www.clanker.world/api/quotes";

// Clanker's sentinel for native ETH. Distinct from our internal NATIVE constant
// ("0xeeee...") — the Clanker API expects this exact mixed-case string.
export const CLANKER_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const BIGINT_PREFIX = "__bigint__:";
const reviveBigInts = (_key, value) => {
  if (typeof value === "string" && value.startsWith(BIGINT_PREFIX)) {
    return BigInt(value.slice(BIGINT_PREFIX.length));
  }
  return value;
};

// Public entry. Returns a discriminated union: { success: true, ...details } | { success: false, error }.
// Callers should always check `success` before reading txData.
export const getQuote = async ({
  chainId,
  inputToken,
  outputToken,
  inputAmount,
  swapperAccount,
  strategy = "best",
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
}) => {
  if (!chainId) return { success: false, error: "chainId is required" };
  if (!inputToken || !outputToken) return { success: false, error: "inputToken and outputToken are required" };
  if (!swapperAccount) return { success: false, error: "swapperAccount is required" };
  if (inputAmount === undefined || inputAmount === null) return { success: false, error: "inputAmount is required" };

  const params = new URLSearchParams({
    chainId: String(chainId),
    inputToken,
    outputToken,
    inputAmount: String(inputAmount),
    swapperAccount,
    strategy,
  });
  const url = `${BASE_URL}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ url, status: res.status, body: body.slice(0, 200) }, "clankerQuoter: non-2xx response");
      return { success: false, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text, reviveBigInts);
    } catch (err) {
      logger.warn({ url, err: err.message, snippet: text.slice(0, 200) }, "clankerQuoter: JSON parse failed");
      return { success: false, error: "invalid JSON response" };
    }
    if (!data?.success) {
      const apiErr = data?.error ?? data?.message ?? "API returned success=false";
      logger.warn({ url, error: apiErr }, "clankerQuoter: API rejected quote");
      return { success: false, error: apiErr };
    }
    if (!data.txData?.to || !data.txData?.data) {
      logger.warn({ url, provider: data.provider }, "clankerQuoter: response missing txData");
      return { success: false, error: "response missing txData" };
    }
    return data;
  } catch (err) {
    const isTimeout = err.name === "AbortError";
    logger.warn({ url, err: err.message, timeout: isTimeout }, "clankerQuoter: fetch failed");
    return { success: false, error: isTimeout ? "timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
};

// Test-friendly default export and helper exports.
export const _internals = { reviveBigInts, BASE_URL };
