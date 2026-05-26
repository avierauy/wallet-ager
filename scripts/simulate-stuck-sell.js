// Simulate a sell of a stuck token via UR using eth_call (no broadcast). Gets the exact
// revert reason from the chain to understand WHY the hook is blocking.
//
// Builds the exact same calldata that directSwap.js would build for sellV4Direct, then
// publicClient.call(...) it to see the revert.
import { createRequire } from "node:module";
import { encodeFunctionData, erc20Abi, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { config } from "../src/config.js";
import { publicClient } from "../src/core/rpc.js";
import { quoteV4Pool } from "../src/discovery/v4PoolKey.js";
import { db } from "../src/core/db.js";

const require = createRequire(import.meta.url);
const { CommandType, ROUTER_AS_RECIPIENT, RoutePlanner, UniversalRouterVersion } = require("@uniswap/universal-router-sdk");
const { Actions, V4Planner } = require("@uniswap/v4-sdk");

const TOKEN = (process.argv[2] || "").toLowerCase();
const WALLET_ADDR = (process.argv[3] || "").toLowerCase();
if (!TOKEN || !WALLET_ADDR) { console.error("Usage: <token-addr> <wallet-addr>"); process.exit(1); }

const UR_VERSION = UniversalRouterVersion.V2_1_1;
const UR = config.chain.dexes.uniswap.universalRouter;
const WETH = config.chain.wnative;
const UR_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

const row = db.prepare("SELECT * FROM discovered_tokens WHERE lower(address) = ?").get(TOKEN);
const meta = JSON.parse(row.pool_metadata);

const balance = await publicClient.readContract({
  address: TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [WALLET_ADDR],
});
console.log(`Wallet ${WALLET_ADDR} balance: ${balance} (${row.symbol})`);

const tokenIsC0 = meta.currency0.toLowerCase() !== WETH.toLowerCase();
const zeroForOne = tokenIsC0;
const poolKey = { currency0: meta.currency0, currency1: meta.currency1, fee: Number(meta.fee), tickSpacing: Number(meta.tickSpacing), hooks: meta.hooks };

// Get expected output for context
const q = await quoteV4Pool({ poolKey, amountIn: balance, zeroForOne, publicClient, quoter: config.chain.dexes.uniswap.v4Quoter });
console.log(`Quoter says: ${balance} ${row.symbol} → ${q?.amountOut} wei ETH`);

// Build the same V4_SWAP calldata sell-positions.js builds — 50% slippage
const slippageBps = 5000n;
const expectedOut = q?.amountOut ?? 0n;
const minOut = expectedOut > 0n ? (expectedOut * (10000n - slippageBps)) / 10000n : 1n;
console.log(`minReturnAmount with 50% slippage: ${minOut}`);

const FULL_DELTA = 0n;
const v4 = new V4Planner();
v4.addAction(Actions.SWAP_EXACT_IN_SINGLE, [{
  poolKey, zeroForOne,
  amountIn: balance.toString(),
  amountOutMinimum: minOut.toString(),
  maxHopSlippage: "0",
  hookData: "0x",
}], UR_VERSION);
v4.addAction(Actions.SETTLE, [TOKEN, FULL_DELTA.toString(), true]);
v4.addAction(Actions.TAKE, [WETH, ROUTER_AS_RECIPIENT, FULL_DELTA.toString()]);
const v4Input = v4.finalize();

const planner = new RoutePlanner();
planner.addCommand(CommandType.V4_SWAP, [v4Input], false, UR_VERSION);
planner.addCommand(CommandType.UNWRAP_WETH, [WALLET_ADDR, "0"], false, UR_VERSION);
const calldata = encodeFunctionData({
  abi: UR_ABI, functionName: "execute",
  args: [planner.commands, planner.inputs, BigInt(Math.floor(Date.now() / 1000) + 1800)],
});

console.log(`\nSimulating eth_call to UR (${UR}) with this calldata...`);
try {
  const r = await publicClient.call({ account: WALLET_ADDR, to: UR, data: calldata, value: 0n });
  console.log(`✓ SIMULATION SUCCEEDED unexpectedly. Data: ${r.data?.slice(0, 200)}`);
} catch (err) {
  console.log(`\n✗ REVERT REASON:`);
  console.log(`  shortMessage: ${err.shortMessage}`);
  console.log(`  details:      ${err.details}`);
  if (err.cause) {
    console.log(`  cause.shortMessage: ${err.cause.shortMessage}`);
    console.log(`  cause.data:         ${err.cause.data}`);
  }
  if (err.data) console.log(`  err.data: ${err.data}`);
}
