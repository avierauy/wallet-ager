import { erc20Abi } from "viem";
import { publicClient } from "./rpc.js";

export const fetchBalances = async ({ account, tokens }) => {
  const native = await publicClient.getBalance({ address: account.address });
  const byToken = {};
  if (tokens.length === 0) return { native, byToken };

  const results = await publicClient.multicall({
    contracts: tokens.map((t) => ({
      address: t.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    })),
    allowFailure: true,
  });
  results.forEach((r, i) => {
    const addr = tokens[i].address.toLowerCase();
    byToken[addr] = r.status === "success" ? r.result : 0n;
  });
  return { native, byToken };
};
