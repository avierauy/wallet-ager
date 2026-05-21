// One-shot smoke test against Base mainnet — broadcasts a single buy or sell from a single wallet.
// Defaults to dry-run; requires --confirm to actually broadcast.
//
// Examples:
//   npm run smoke -- --wallet w-0dd9f512 --token 0xa4a2... --amount-eth 0.0005 --side buy
//   npm run smoke -- --wallet w-0dd9f512 --token 0xa4a2... --amount-eth 0.0005 --side buy --confirm

import { erc20Abi, formatEther, formatUnits, parseEther } from "viem";
import { buyExactEthForToken, quote, sellExactTokenForEth } from "../src/adapters/uniswap.js";
import { config } from "../src/config.js";
import { publicClient } from "../src/core/rpc.js";
import { loadWallets } from "../src/core/wallets.js";
import { checkBeforeSell, checkToken } from "../src/safety/honeypot.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, [])
);

const need = (k) => {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
  return args[k];
};

const walletId = need("wallet");
const tokenAddress = need("token");
const side = args.side ?? "buy";
const amountStr = need(side === "buy" ? "amount-eth" : "amount-token");
const slippageBps = Number(args["slippage-bps"] ?? 100);
const confirm = args.confirm === "true";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const wallet = loadWallets().find((w) => w.id === walletId);
if (!wallet) {
  console.error(`wallet "${walletId}" not found in ${config.paths.wallets}`);
  process.exit(2);
}

const [symbol, decimals] = await Promise.all([
  publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "symbol" }),
  publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "decimals" }),
]);
const token = { address: tokenAddress, symbol, decimals };
const amountInWei = side === "buy"
  ? parseEther(amountStr)
  : BigInt(Math.floor(Number(amountStr) * 10 ** decimals)); // crude but ok for smoke

console.log("\n=== smoke test ===");
console.log("mode      :", confirm ? "BROADCAST" : "dry-run (no --confirm)");
console.log("chain     :", config.chain.name, "(" + config.chain.chainId + ")");
console.log("wallet    :", wallet.id, wallet.account.address);
console.log("dex       : uniswap (AlphaRouter)");
console.log("side      :", side);
console.log("token     :", token.symbol, token.address);
console.log("amount    :", side === "buy" ? `${amountStr} ETH` : `${amountStr} ${symbol}`);
console.log("slippage  :", slippageBps, "bps (" + slippageBps / 100 + "%)");

const nativeBal = await publicClient.getBalance({ address: wallet.account.address });
console.log("native bal:", formatEther(nativeBal), "ETH");
if (side === "buy" && nativeBal < amountInWei + parseEther("0.0001")) {
  console.error("insufficient native balance for amount + gas buffer");
  process.exit(1);
}
if (side === "sell") {
  const tokenBal = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet.account.address],
  });
  console.log("token bal :", formatUnits(tokenBal, decimals), symbol);
  if (tokenBal < amountInWei) {
    console.error("insufficient token balance");
    process.exit(1);
  }
}

console.log("\n--- safety check (honeypot.is) ---");
const safety = side === "buy" ? await checkToken(tokenAddress) : await checkBeforeSell(tokenAddress);
console.log("verdict   :", safety.safe ? "SAFE" : "UNSAFE");
console.log("buy tax   :", safety.buyTax + "%");
console.log("sell tax  :", safety.sellTax + "%");
console.log("honeypot  :", safety.isHoneypot);
if (!safety.safe) {
  console.error("reasons:", safety.reasons.join("; "));
  process.exit(1);
}

console.log("\n--- AlphaRouter quote ---");
const route = await quote({
  tokenIn: side === "buy" ? { address: NATIVE, decimals: 18, symbol: "ETH" } : token,
  tokenOut: side === "buy" ? token : { address: NATIVE, decimals: 18, symbol: "ETH" },
  amountInWei,
  slippageBps,
  recipient: wallet.account.address,
});
const expectedOut = BigInt(route.quote.quotient.toString());
const minOut = (expectedOut * BigInt(10000 - slippageBps)) / 10000n;
const outDecimals = side === "buy" ? decimals : 18;
const outSymbol = side === "buy" ? symbol : "ETH";
console.log("router    :", route.methodParameters.to);
console.log("expected  :", formatUnits(expectedOut, outDecimals), outSymbol);
console.log("min after slippage:", formatUnits(minOut, outDecimals), outSymbol);
console.log("gas estimate:", route.estimatedGasUsed?.toString() ?? "(n/a)");

if (!confirm) {
  console.log("\n=== dry-run complete — NOT broadcasting ===");
  console.log("Add --confirm to send the tx for real.");
  process.exit(0);
}

console.log("\n=== BROADCASTING ===");
const result = side === "buy"
  ? await buyExactEthForToken({
      account: wallet.account,
      tokenOut: token,
      amountInWei,
      slippageBps,
    })
  : await sellExactTokenForEth({
      account: wallet.account,
      tokenIn: token,
      amountInWei,
      slippageBps,
    });

console.log("tx hash   :", result.txHash);
console.log("explorer  :", config.chain.blockExplorer + "/tx/" + result.txHash);
console.log("\nwaiting for receipt…");
const receipt = await publicClient.waitForTransactionReceipt({ hash: result.txHash });
console.log("status    :", receipt.status);
console.log("block     :", receipt.blockNumber);
console.log("gas used  :", receipt.gasUsed.toString());
