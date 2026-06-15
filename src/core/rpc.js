import { createPublicClient, createWalletClient, fallback, http } from "viem";
import { base } from "viem/chains";
import { config } from "../config.js";

const chainMap = { base };

const resolveChain = (name) => {
  const c = chainMap[name];
  if (!c) throw new Error(`Unsupported viem chain: ${name}`);
  return c;
};

const dedupe = (arr) => Array.from(new Set(arr));

const buildTransport = (urls) => {
  const list = dedupe(urls.filter(Boolean));
  if (list.length === 0) throw new Error("No RPC_URL configured");
  return list.length === 1 ? http(list[0]) : fallback(list.map((u) => http(u)));
};

// Discovery / watchers / snapshots / price quotes. Stays on primary + global fallback only —
// never touches RPC_URL_SWAP_FALLBACK, which is reserved for swap retries to preserve public-RPC
// rate-limit budget. See v13.21 — Infura RPC outage 2026-06-01 (~7h) motivated the split.
export const publicClient = createPublicClient({
  chain: resolveChain(config.chain.name),
  transport: buildTransport([config.rpc.primary, ...config.rpc.fallback]),
});

// Swap path — adapters, executor, sniper sell-retry, watchdog, dailyCleanup, nonceManager,
// pre-sim, receipt-wait. Adds RPC_URL_SWAP_FALLBACK on top so a swap can still land when
// Infura degrades, without leaking discovery polling to the public endpoint.
export const swapPublicClient = createPublicClient({
  chain: resolveChain(config.chain.name),
  transport: buildTransport([config.rpc.primary, ...config.rpc.fallback, ...config.rpc.swapFallback]),
});

// Wallet clients broadcast txs and only exist on the swap path — they get the full URL list.
export const walletClientFor = (account) =>
  createWalletClient({
    account,
    chain: resolveChain(config.chain.name),
    transport: buildTransport([config.rpc.primary, ...config.rpc.fallback, ...config.rpc.swapFallback]),
  });
