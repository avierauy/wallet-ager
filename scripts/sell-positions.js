// One-shot liquidator. Reads ./data/sell-plan.json (produced by dry-check) and for each
// position runs the standard Uniswap-UI sell flow:
//   1. ERC20.approve(token, Permit2, max)     — once per token (idempotent)
//   2. Permit2.approve(token, UR, max, max)   — once per token (idempotent)
//   3. UR.execute([V4_SWAP, UNWRAP_WETH])     — the actual swap
//
// Using Permit2.approve() instead of PERMIT2_PERMIT inline avoids any signature-encoding
// gotchas. Net cost: 3 txs per token instead of 2 — gas is negligible on Base.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const require = createRequire(import.meta.url);
const { CommandType, ROUTER_AS_RECIPIENT, RoutePlanner, UniversalRouterVersion } = require("@uniswap/universal-router-sdk");
const { Actions, V4Planner } = require("@uniswap/v4-sdk");

const env = readFileSync(".env", "utf8").split("\n").reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {});

const RPC_URL = env.RPC_URL;
const UR_VERSION = UniversalRouterVersion.V2_1_1;
const UNIVERSAL_ROUTER = "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const WETH = "0x4200000000000000000000000000000000000006";
const SLIPPAGE_BPS = 5000n; // 50% — accept basically anything for liquidation
const FULL_DELTA_AMOUNT = 0n;

const MAX_UINT160 = 2n ** 160n - 1n;
const MAX_UINT48 = 2n ** 48n - 1n;

const UR_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });

const plan = JSON.parse(readFileSync("./data/sell-plan.json", "utf8"));
console.log(`Loaded ${plan.length} positions to liquidate`);
console.log("");

const wj = JSON.parse(readFileSync("./config/wallets.json", "utf8"));
const accounts = wj.wallets.map((pk) => privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk));
const byAddress = Object.fromEntries(accounts.map((a) => [a.address.toLowerCase(), a]));

const walletClientFor = (account) => createWalletClient({ account, chain: base, transport: http(RPC_URL) });

const ensureErc20Approval = async ({ walletClient, account, token }) => {
  const current = await publicClient.readContract({
    address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, PERMIT2],
  });
  if (current >= maxUint256 / 2n) return { skipped: true };
  const hash = await walletClient.writeContract({
    address: token, abi: erc20Abi, functionName: "approve", args: [PERMIT2, maxUint256],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
};

const ensurePermit2Approval = async ({ walletClient, account, token }) => {
  const [amount] = await publicClient.readContract({
    address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance",
    args: [account.address, token, UNIVERSAL_ROUTER],
  });
  if (amount >= MAX_UINT160 / 2n) return { skipped: true };
  const hash = await walletClient.writeContract({
    address: PERMIT2, abi: PERMIT2_ABI, functionName: "approve",
    args: [token, UNIVERSAL_ROUTER, MAX_UINT160, Number(MAX_UINT48)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
};

const buildSellCalldata = ({ account, position }) => {
  const { token, balance, expectedOut, poolKey, zeroForOne } = position;
  const minOut = (BigInt(expectedOut) * (10000n - SLIPPAGE_BPS)) / 10000n;

  // V4 actions: swap, settle from user (Permit2 already approved UR), take WETH to router.
  const v4Planner = new V4Planner();
  v4Planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [{
    poolKey,
    zeroForOne,
    amountIn: BigInt(balance).toString(),
    amountOutMinimum: minOut.toString(),
    maxHopSlippage: "0",
    hookData: "0x",
  }], UR_VERSION);
  // payerIsUser=true → router calls Permit2.transferFrom(user, address(this), token, amount)
  v4Planner.addAction(Actions.SETTLE, [token, FULL_DELTA_AMOUNT.toString(), true]);
  // Output WETH stays at router so UNWRAP_WETH can convert it
  v4Planner.addAction(Actions.TAKE, [WETH, ROUTER_AS_RECIPIENT, FULL_DELTA_AMOUNT.toString()]);
  const v4SwapInput = v4Planner.finalize();

  const planner = new RoutePlanner();
  planner.addCommand(CommandType.V4_SWAP, [v4SwapInput], false, UR_VERSION);
  planner.addCommand(CommandType.UNWRAP_WETH, [account.address, "0"], false, UR_VERSION);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  return encodeFunctionData({
    abi: UR_ABI,
    functionName: "execute",
    args: [planner.commands, planner.inputs, deadline],
  });
};

const liquidateOne = async ({ account, walletClient, position }) => {
  const label = `${account.address.slice(0, 8)}…/${position.symbol}`;

  // 1. ERC20.approve(token, Permit2, max)
  process.stdout.write(`  ${label}: erc20-approve... `);
  try {
    const a = await ensureErc20Approval({ walletClient, account, token: position.token });
    console.log(a.skipped ? "already" : `tx ${a.hash}`);
  } catch (e) {
    console.log(`failed: ${e.shortMessage || e.message}`);
    return { ok: false, step: "erc20-approve", error: e.message };
  }

  // 2. Permit2.approve(token, UR, max, max)
  process.stdout.write(`  ${label}: permit2-approve... `);
  try {
    const a = await ensurePermit2Approval({ walletClient, account, token: position.token });
    console.log(a.skipped ? "already" : `tx ${a.hash}`);
  } catch (e) {
    console.log(`failed: ${e.shortMessage || e.message}`);
    return { ok: false, step: "permit2-approve", error: e.message };
  }

  // 3. Sell via UR
  process.stdout.write(`  ${label}: selling... `);
  try {
    const data = buildSellCalldata({ account, position });
    const txHash = await walletClient.sendTransaction({ to: UNIVERSAL_ROUTER, data, value: 0n });
    console.log(`sent ${txHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === "success") {
      console.log(`    ✓ confirmed block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
      return { ok: true, txHash };
    } else {
      console.log(`    ✗ reverted on-chain block ${receipt.blockNumber}`);
      return { ok: false, step: "sell", txHash, reverted: true };
    }
  } catch (e) {
    console.log(`failed: ${e.shortMessage || e.message}`);
    return { ok: false, step: "sell", error: e.message };
  }
};

// Group by wallet so each wallet's positions run serially (avoid nonce races within a wallet).
const byWallet = new Map();
for (const p of plan) {
  if (!byWallet.has(p.walletAddr)) byWallet.set(p.walletAddr, []);
  byWallet.get(p.walletAddr).push(p);
}

console.log(`Processing ${byWallet.size} wallets in parallel...`);
console.log("");

const results = await Promise.all([...byWallet.entries()].map(async ([walletAddr, positions]) => {
  const account = byAddress[walletAddr.toLowerCase()];
  if (!account) {
    console.log(`✗ wallet ${walletAddr} not in config`);
    return { walletAddr, results: [] };
  }
  const walletClient = walletClientFor(account);
  const out = [];
  console.log(`▶ ${walletAddr} — ${positions.length} positions`);
  for (const p of positions) {
    const r = await liquidateOne({ account, walletClient, position: { ...p, balance: p.balance, expectedOut: p.expectedOut } });
    out.push({ symbol: p.symbol, token: p.token, ...r });
  }
  return { walletAddr, results: out };
}));

console.log("");
console.log("=== Summary ===");
let okCount = 0, failCount = 0;
const failed = [];
for (const w of results) {
  for (const r of w.results) {
    if (r.ok) okCount++;
    else { failCount++; failed.push(r); }
  }
}
console.log(`OK: ${okCount}  Failed: ${failCount}`);
if (failCount > 0) {
  console.log("");
  console.log("Failures:");
  for (const f of failed) {
    console.log(`  - ${f.symbol} (${f.step}): ${f.error?.slice(0, 80) || (f.reverted ? "on-chain revert" : "?")}`);
  }
}
process.exit(failCount > 0 ? 1 : 0);
