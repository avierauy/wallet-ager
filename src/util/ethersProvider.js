// AlphaRouter (smart-order-router) requires ethers v5. We keep this provider isolated to
// the Uniswap adapter — every other module uses viem.
import pkg from "ethers";
import { config } from "../config.js";

const { providers } = pkg;

export const ethersProvider = new providers.JsonRpcProvider(config.rpc.primary, {
  chainId: config.chain.chainId,
  name: config.chain.name,
});
