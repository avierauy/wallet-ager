// One-shot smoke against Base mainnet — exercises one trade end-to-end (safety + quote +
// broadcast + Telegram). Routes through the same executor the orchestrator uses, so the
// behavior is identical.
//
// Examples:
//   npm run smoke -- --wallet w-0dd9f512 --dex uniswap --side buy --token 0xa4a2… --amount-eth 0.0005
//   npm run smoke -- --wallet w-0dd9f512 --dex uniswap --side sell --token 0xa4a2… --amount-token 5
//   npm run smoke -- --wallet w-0dd9f512 --dex virtuals --side buy --token 0x479e… --amount-eth 0.0005
//
// Defaults to dry-run; add --confirm to broadcast.

import { erc20Abi, formatEther, formatUnits, parseEther } from "viem";
import { quote } from "../src/adapters/uniswap.js";
import * as virtuals from "../src/adapters/virtuals.js";
import { config } from "../src/config.js";
import { executeAction } from "../src/core/executor.js";
import { publicClient } from "../src/core/rpc.js";
import { loadWallets } from "../src/core/wallets.js";
import { checkBeforeSell, checkToken } from "../src/safety/honeypot.js";
import { checkBondingCurve } from "../src/safety/virtuals.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, [])
);

const need = (k) => {
  if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
  return args[k];
};

const walletId = need("wallet");
const tokenAddress = need("token");
const dex = args.dex ?? "uniswap";
const side = args.side ?? "buy";
const amountStr = need(side === "buy" ? "amount-eth" : "amount-token");
const slippageBps = Number(args["slippage-bps"] ?? 100);
const confirm = args.confirm === "true";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const VIRTUAL_TOKEN_ADDR = config.chain.dexes.virtuals.virtualToken;

const wallet = loadWallets().find((w) => w.id === walletId);
if (!wallet) { console.error(`wallet "${walletId}" not found in ${config.paths.wallets}`); process.exit(2); }

const [symbol, decimals] = await Promise.all([
  publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "symbol" }),
  publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "decimals" }),
]);
const token = { address: tokenAddress, symbol, decimals };
let amountInWei;
if (side === "buy") {
  amountInWei = parseEther(amountStr); // for virtuals buy this is only used if VIRTUAL needs acquisition
} else if (amountStr === "max" || amountStr === "all") {
  amountInWei = await publicClient.readContract({
    address: tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [wallet.account.address],
  });
} else {
  amountInWei = BigInt(Math.floor(Number(amountStr) * 10 ** decimals));
}

console.log("\n=== smoke ===");
console.log("mode      :", confirm ? "BROADCAST" : "dry-run");
console.log("chain     :", config.chain.name, "(" + config.chain.chainId + ")");
console.log("wallet    :", wallet.id, wallet.account.address);
console.log("dex       :", dex);
console.log("side      :", side);
console.log("token     :", token.symbol, token.address);
console.log("amount    :", side === "buy" && dex !== "virtuals" ? `${amountStr} ETH` :
                            side === "buy" && dex === "virtuals" ? `${amountStr} ETH (if VIRTUAL needs acquisition)` :
                            amountStr === "max" || amountStr === "all" ? `${formatUnits(amountInWei, decimals)} ${symbol} (full balance)` :
                            `${amountStr} ${symbol}`);
console.log("slippage  :", slippageBps, "bps");

const nativeBal = await publicClient.getBalance({ address: wallet.account.address });
console.log("native bal:", formatEther(nativeBal), "ETH");

if (side === "sell") {
  const tokenBal = await publicClient.readContract({
    address: tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [wallet.account.address],
  });
  console.log("token bal :", formatUnits(tokenBal, decimals), symbol);
  if (tokenBal < amountInWei) { console.error("insufficient token balance"); process.exit(1); }
}

const safetySource = dex === "virtuals" ? "bonding-curve probe" : "honeypot.is";
console.log(`\n--- safety (${safetySource}) ---`);
const safety = dex === "virtuals"
  ? await checkBondingCurve({ agentToken: tokenAddress })
  : side === "buy"
    ? await checkToken(tokenAddress)
    : await checkBeforeSell(tokenAddress);
console.log("verdict   :", safety.safe ? "SAFE" : "UNSAFE");
console.log("buy tax   :", (safety.buyTax ?? "n/a") + "%");
console.log("sell tax  :", (safety.sellTax ?? "n/a") + "%");
if (safety.isHoneypot !== undefined) console.log("honeypot  :", safety.isHoneypot);
if (!safety.safe) { console.error("reasons:", safety.reasons.join("; ")); process.exit(1); }

console.log("\n--- quote ---");
if (dex === "uniswap") {
  const route = await quote({
    tokenIn:  side === "buy" ? { address: NATIVE, decimals: 18, symbol: "ETH" } : token,
    tokenOut: side === "buy" ? token : { address: NATIVE, decimals: 18, symbol: "ETH" },
    amountInWei, slippageBps, recipient: wallet.account.address,
  });
  const out = BigInt(route.quote.quotient.toString());
  const minOut = (out * BigInt(10000 - slippageBps)) / 10000n;
  const outDec = side === "buy" ? decimals : 18;
  const outSym = side === "buy" ? symbol : "ETH";
  console.log("router    :", route.methodParameters.to);
  console.log("expected  :", formatUnits(out, outDec), outSym);
  console.log("min       :", formatUnits(minOut, outDec), outSym);
} else if (dex === "virtuals" && side === "buy") {
  const virtualBal = await virtuals.readVirtualBalance(wallet.account);
  console.log("VIRTUAL bal:", formatUnits(virtualBal, 18), "VIRTUAL");
  const DUST = 10n ** 15n;
  let virtualSpend = virtualBal;
  if (virtualBal < DUST) {
    console.log("→ would acquire VIRTUAL via Uniswap with", amountStr, "ETH");
    const ethToVirtual = await quote({
      tokenIn: { address: NATIVE, decimals: 18, symbol: "ETH" },
      tokenOut: { address: VIRTUAL_TOKEN_ADDR, decimals: 18, symbol: "VIRTUAL" },
      amountInWei, slippageBps, recipient: wallet.account.address,
    });
    virtualSpend = BigInt(ethToVirtual.quote.quotient.toString());
    console.log("expected VIRTUAL:", formatUnits(virtualSpend, 18), "VIRTUAL");
  } else {
    console.log("→ reusing existing VIRTUAL balance, no Uniswap step");
  }
  const agentOut = await virtuals.quoteVirtualToAgent({ agentToken: tokenAddress, amountInVirtualWei: virtualSpend });
  const minAgent = (agentOut * BigInt(10000 - slippageBps)) / 10000n;
  console.log("expected agent:", formatUnits(agentOut, decimals), symbol);
  console.log("min agent     :", formatUnits(minAgent, decimals), symbol);
} else if (dex === "virtuals" && side === "sell") {
  const virtualOut = await virtuals.quoteAgentToVirtual({ agentToken: tokenAddress, amountInAgentWei: amountInWei });
  const minVirtual = (virtualOut * BigInt(10000 - slippageBps)) / 10000n;
  console.log("expected   :", formatUnits(virtualOut, 18), "VIRTUAL");
  console.log("min        :", formatUnits(minVirtual, 18), "VIRTUAL");
}

if (!confirm) {
  console.log("\n=== dry-run complete — NOT broadcasting ===");
  console.log("Add --confirm to send the tx for real.");
  process.exit(0);
}

console.log("\n=== BROADCASTING via executor (with telegram + DB + metrics) ===");
config.runtime.dryRun = false;

const plan = { dex, side, token, amountInWei, slippageBps, gasMultiplier: 1.0 };
const result = await executeAction({ wallet, plan });
console.log("\nexecutor result:", { status: result.status, txHash: result.txHash, error: result.error });

if (result.status === "submitted") {
  console.log("explorer:", config.chain.blockExplorer + "/tx/" + result.txHash);
  console.log("waiting for receipt…");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: result.txHash });
  console.log("status :", receipt.status);
  console.log("block  :", receipt.blockNumber);
  console.log("gas    :", receipt.gasUsed.toString());
}
