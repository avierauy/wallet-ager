import { createPublicClient, createWalletClient, fallback, http } from "viem";
import { base } from "viem/chains";
import { config } from "../config.js";

const chainMap = { base };

const resolveChain = (name) => {
  const c = chainMap[name];
  if (!c) throw new Error(`Unsupported viem chain: ${name}`);
  return c;
};

const buildTransport = () => {
  const urls = [config.rpc.primary, ...config.rpc.fallback].filter(Boolean);
  if (urls.length === 0) throw new Error("No RPC_URL configured");
  return urls.length === 1 ? http(urls[0]) : fallback(urls.map((u) => http(u)));
};

export const publicClient = createPublicClient({
  chain: resolveChain(config.chain.name),
  transport: buildTransport(),
});

export const walletClientFor = (account) =>
  createWalletClient({
    account,
    chain: resolveChain(config.chain.name),
    transport: buildTransport(),
  });
