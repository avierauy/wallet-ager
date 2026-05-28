import { erc20Abi } from "viem";
import { quote } from "../adapters/uniswap.js";
import { logger } from "../util/logger.js";
import { createSemaphore } from "../util/semaphore.js";
import {
  getInitialSnapshot,
  getLatestSnapshot,
  insertBalanceSnapshot,
} from "./db.js";
import { publicClient } from "./rpc.js";

const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const QUOTE_RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const PRICE_FETCH_CONCURRENCY = 20;

// In-memory negative cache for the price probe: meme tokens in tokens.json that
// AlphaRouter cannot route get re-queried on every startup, generating ~35 warnings
// of the same kind every restart. Cache the failure for 30min so the first restart
// after a code change pays the cost, but quick restarts (debugging) don't.
const NO_ROUTE_CACHE_TTL_MS = 30 * 60 * 1000;
const noRouteCache = new Map(); // lowercase addr → expiresAt (epoch ms)
export const _clearNoRouteCache = () => noRouteCache.clear(); // test helper

// Quote `probeAmount` (1 whole token unit) of each token into ETH wei. Returns a Map
// keyed by lowercase token address with `{ probeAmount, ethValue }` so callers can scale
// linearly for any wallet balance.
export const fetchTokenPrices = async (tokens) => {
  const prices = new Map();
  const now = Date.now();
  const sem = createSemaphore(PRICE_FETCH_CONCURRENCY);
  await Promise.all(
    tokens.map((token) =>
      sem.run(async () => {
        const key = token.address.toLowerCase();
        if (key === NATIVE_SENTINEL.toLowerCase()) {
          prices.set(key, { probeAmount: 10n ** 18n, ethValue: 10n ** 18n });
          return;
        }
        // Skip the quote if we recently saw a no-route failure for this token.
        const cachedUntil = noRouteCache.get(key);
        if (cachedUntil && cachedUntil > now) {
          prices.set(key, null);
          return;
        }
        const probeAmount = 10n ** BigInt(token.decimals);
        try {
          const route = await quote({
            tokenIn: token,
            tokenOut: { address: NATIVE_SENTINEL, decimals: 18, symbol: "ETH" },
            amountInWei: probeAmount,
            slippageBps: 100,
            recipient: QUOTE_RECIPIENT,
          });
          const ethValue = BigInt(route.quote.quotient.toString());
          prices.set(key, { probeAmount, ethValue });
          noRouteCache.delete(key); // success — drop any stale negative entry
        } catch (err) {
          logger.warn({ token: token.symbol, err: err.message }, "price quote failed; valuing at 0");
          prices.set(key, null);
          noRouteCache.set(key, now + NO_ROUTE_CACHE_TTL_MS);
        }
      })
    )
  );
  return prices;
};

// Pure: convert a token amount (wei) into ETH-wei using a probed price.
export const valueOf = (tokenAddr, amountWei, prices) => {
  if (amountWei === 0n) return 0n;
  const p = prices.get(tokenAddr.toLowerCase());
  if (!p) return 0n;
  return (amountWei * p.ethValue) / p.probeAmount;
};

export const computeWalletValue = async ({ wallet, tokens, prices }) => {
  const nativeWei = await publicClient.getBalance({ address: wallet.account.address });
  let tokensValueWei = 0n;
  const breakdown = [];

  if (tokens.length > 0) {
    const results = await publicClient.multicall({
      contracts: tokens.map((t) => ({
        address: t.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.account.address],
      })),
      allowFailure: true,
    });
    for (let i = 0; i < tokens.length; i++) {
      const balance = results[i].status === "success" ? results[i].result : 0n;
      if (balance === 0n) continue;
      const ethValue = valueOf(tokens[i].address, balance, prices);
      tokensValueWei += ethValue;
      breakdown.push({ symbol: tokens[i].symbol, balanceWei: balance, ethValueWei: ethValue });
    }
  }
  return { nativeWei, tokensValueWei, totalWei: nativeWei + tokensValueWei, breakdown };
};

const buildSnapshotRow = (wallet, value, blockNumber, isInitial) => ({
  wallet_id: wallet.id,
  is_initial: isInitial ? 1 : 0,
  native_wei: value.nativeWei.toString(),
  tokens_value_wei: value.tokensValueWei.toString(),
  total_wei: value.totalWei.toString(),
  block_number: Number(blockNumber),
  taken_at: Date.now(),
});

// Snapshot persisted only if none exists yet (idempotent across restarts).
export const ensureInitialSnapshot = async ({ wallet, tokens, prices }) => {
  const existing = getInitialSnapshot(wallet.id);
  if (existing) return existing;
  const value = await computeWalletValue({ wallet, tokens, prices });
  const blockNumber = await publicClient.getBlockNumber();
  const row = buildSnapshotRow(wallet, value, blockNumber, true);
  insertBalanceSnapshot(row);
  return row;
};

export const takeSnapshot = async ({ wallet, tokens, prices }) => {
  const value = await computeWalletValue({ wallet, tokens, prices });
  const blockNumber = await publicClient.getBlockNumber();
  const row = buildSnapshotRow(wallet, value, blockNumber, false);
  insertBalanceSnapshot(row);
  return row;
};

// Convenience for the CLI — get current value without persisting.
export const peekWalletValue = async ({ wallet, tokens, prices }) => {
  const value = await computeWalletValue({ wallet, tokens, prices });
  const initial = getInitialSnapshot(wallet.id);
  const latest = getLatestSnapshot(wallet.id);
  return { value, initial, latest };
};
