import { erc20Abi, isAddressEqual } from "viem";
import { config } from "../config.js";
import { publicClient, walletClientFor } from "../core/rpc.js";
import { simulateBeforeBroadcast } from "../util/simulateBeforeBroadcast.js";
import { submitAndConfirm } from "../util/submitAndConfirm.js";

// 0x AllowanceHolder exposes only `execute` — we don't need to encode it ourselves.
// The 0x Swap API returns `to`, `data`, `value`, `allowanceTarget`, `buyAmount`, etc.
// We forward exactly what the API returns, which is what the Bankr UI does.

const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const isNative = (addr) => isAddressEqual(addr, NATIVE_SENTINEL);

export const fetchZeroExQuote = async ({ sellToken, buyToken, sellAmount, taker, slippageBps }) => {
  const url = new URL(`${config.chain.dexes.bankr.apiBase}/quote`);
  url.searchParams.set("chainId", String(config.chain.chainId));
  url.searchParams.set("sellToken", sellToken);
  url.searchParams.set("buyToken", buyToken);
  url.searchParams.set("sellAmount", String(sellAmount));
  url.searchParams.set("taker", taker);
  url.searchParams.set("slippageBps", String(slippageBps));

  const res = await fetch(url, {
    headers: {
      "0x-api-key": config.apis.zeroEx,
      "0x-version": "v2",
    },
  });
  if (!res.ok) throw new Error(`0x quote ${res.status}: ${await res.text()}`);
  return res.json();
};

// Approve the AllowanceHolder (or `allowanceTarget` from quote) to spend `token` for `amount`.
// Bankr UI approves the exact swap amount each time (not infinite); we mirror that.
export const ensureAllowance = async ({ account, token, spender, amount }) => {
  if (isNative(token)) return null;
  const current = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, spender],
  });
  if (current >= amount) return null;
  const wallet = walletClientFor(account);
  return wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
};

export const submitZeroExSwap = async ({ account, quote }) => {
  const wallet = walletClientFor(account);
  const tx = {
    to: quote.transaction.to,
    data: quote.transaction.data,
    value: BigInt(quote.transaction.value ?? "0"),
    gas: quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
  };
  // v13.18: pre-simulate to catch any structural revert before broadcast.
  await simulateBeforeBroadcast({ publicClient, account, tx });
  // v13.17: wait + verify receipt.
  const { hash } = await submitAndConfirm({ publicClient, walletClient: wallet, tx });
  return hash;
};

export const swap = async ({ account, sellToken, buyToken, sellAmount, slippageBps }) => {
  if (!config.apis.zeroEx) throw new Error("ZEROEX_API_KEY missing");
  const quote = await fetchZeroExQuote({
    sellToken,
    buyToken,
    sellAmount,
    taker: account.address,
    slippageBps,
  });
  if (!isNative(sellToken) && quote.issues?.allowance) {
    await ensureAllowance({
      account,
      token: sellToken,
      spender: quote.issues.allowance.spender,
      amount: BigInt(sellAmount),
    });
  }
  return submitZeroExSwap({ account, quote });
};
