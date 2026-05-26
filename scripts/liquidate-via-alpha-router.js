// Fallback liquidator using the project's own uniswap adapter (AlphaRouter under the hood,
// which auto-routes V2/V3/V4). Reads ./data/sell-plan.json — same shape as sell-positions.js
// expects, but you can pre-filter to specific tokens via positional argv args (symbol or
// token address). Uses 50% slippage (wide for stuck positions).
import { readFileSync } from "node:fs";
import { erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../src/config.js";
import { publicClient, walletClientFor } from "../src/core/rpc.js";
import * as uniswap from "../src/adapters/uniswap.js";

const SLIPPAGE_BPS = 5000; // 50%
const filterArgs = process.argv.slice(2).map((s) => s.toLowerCase());

const walletsRaw = JSON.parse(readFileSync(config.paths.wallets, "utf8"));
const accounts = walletsRaw.wallets.map((pk) => privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk));
const byAddress = Object.fromEntries(accounts.map((a) => [a.address.toLowerCase(), a]));

let plan = JSON.parse(readFileSync("./data/sell-plan.json", "utf8"));
if (filterArgs.length > 0) {
  plan = plan.filter((p) =>
    filterArgs.some((f) => (p.symbol || "").toLowerCase() === f || p.token.toLowerCase() === f)
  );
}
console.log(`Loaded ${plan.length} positions to liquidate (slippage ${SLIPPAGE_BPS / 100}%)`);
console.log("");

const liquidateOne = async ({ position }) => {
  const acc = byAddress[position.walletAddr.toLowerCase()];
  if (!acc) {
    console.log(`✗ ${position.symbol}: wallet ${position.walletAddr} not in config`);
    return { ok: false };
  }
  const label = `${acc.address.slice(0, 8)}…/${position.symbol}`;
  process.stdout.write(`  ${label}: balance ${(Number(position.balance) / 10 ** (position.decimals || 18)).toFixed(2)}, selling via AlphaRouter... `);
  // Confirm balance is still there (in case a prior partial sell succeeded)
  try {
    const onchain = await publicClient.readContract({
      address: position.token, abi: erc20Abi, functionName: "balanceOf",
      args: [acc.address],
    });
    if (onchain === 0n) {
      console.log("already empty");
      return { ok: true, skipped: "no-balance" };
    }
    const r = await uniswap.sellExactTokenForEth({
      account: acc,
      tokenIn: { address: position.token, decimals: position.decimals || 18, symbol: position.symbol },
      amountInWei: onchain,
      slippageBps: SLIPPAGE_BPS,
    });
    console.log(`tx ${r.txHash}`);
    console.log(`    ✓ confirmed`);
    return { ok: true, txHash: r.txHash };
  } catch (e) {
    const msg = String(e.shortMessage ?? e.message ?? e).slice(0, 200);
    console.log(`failed: ${msg}`);
    return { ok: false, error: msg };
  }
};

console.log(`Processing ${plan.length} positions serially (avoid nonce races)...\n`);
let ok = 0, fail = 0;
for (const p of plan) {
  const r = await liquidateOne({ position: p });
  if (r.ok) ok++; else fail++;
}
console.log(`\n=== Summary === OK: ${ok}  Failed: ${fail}`);
