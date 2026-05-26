// Forensics for a stuck token: query the V4 Quoter both directions, check pool liquidity
// via PoolManager, inspect hook contract, and read the failed sell tx receipt to get the
// exact revert reason.
//
// Usage: node --env-file=.env scripts/diagnose-stuck-token.js <token-addr> [failed-tx-hash]
import { erc20Abi, parseAbi } from "viem";
import { config } from "../src/config.js";
import { publicClient } from "../src/core/rpc.js";
import { quoteV4Pool } from "../src/discovery/v4PoolKey.js";
import { db } from "../src/core/db.js";

const TOKEN = (process.argv[2] || "").toLowerCase();
const FAILED_TX = process.argv[3];
const WETH = config.chain.wnative;

if (!TOKEN) { console.error("Usage: <token-addr> [failed-tx-hash]"); process.exit(1); }

const row = db.prepare("SELECT * FROM discovered_tokens WHERE lower(address) = ?").get(TOKEN);
if (!row) { console.error("Token not in DB"); process.exit(1); }
const meta = JSON.parse(row.pool_metadata);
console.log(`Token: ${row.symbol} (${TOKEN})`);
console.log(`Source: ${row.source}  Status: ${row.status}`);
console.log(`PoolKey:`, JSON.stringify(meta, null, 2));
console.log();

const c0 = meta.currency0;
const c1 = meta.currency1;
const wethLower = WETH.toLowerCase();
const tokenIsCurrency0 = c0.toLowerCase() !== wethLower;
const poolKey = { currency0: c0, currency1: c1, fee: Number(meta.fee), tickSpacing: Number(meta.tickSpacing), hooks: meta.hooks };

// ──────── 1. Token total supply + our balance ────────
console.log("=== 1. Token state ===");
try {
  const supply = await publicClient.readContract({ address: TOKEN, abi: erc20Abi, functionName: "totalSupply" });
  console.log(`totalSupply: ${supply}`);
} catch (e) { console.log(`totalSupply err: ${e.message.slice(0,80)}`); }

// ──────── 2. Quoter — sell direction (token → ETH) ────────
console.log(`\n=== 2. V4 Quoter — SELL direction (token → ETH) ===`);
const sellAmountIn = 1000000_000000000000000000n; // 1M tokens (similar to our stuck balance scale)
const sellZeroForOne = tokenIsCurrency0;
try {
  const q = await quoteV4Pool({
    poolKey, amountIn: sellAmountIn, zeroForOne: sellZeroForOne,
    publicClient, quoter: config.chain.dexes.uniswap.v4Quoter,
  });
  console.log(`amountIn ${sellAmountIn}: amountOut = ${q?.amountOut} (${q ? "OK" : "REVERTED"})`);
} catch (e) { console.log(`quote err: ${e.message.slice(0,80)}`); }

// Try with smaller amounts to see if it's a size/depth issue
for (const amt of [1000n, 1000000n, 1000000000n]) {
  try {
    const q = await quoteV4Pool({
      poolKey, amountIn: amt, zeroForOne: sellZeroForOne,
      publicClient, quoter: config.chain.dexes.uniswap.v4Quoter,
    });
    console.log(`amountIn ${amt}: amountOut = ${q?.amountOut} (${q ? "OK" : "REVERTED"})`);
  } catch (e) { console.log(`amountIn ${amt}: err ${e.message.slice(0,60)}`); }
}

// ──────── 3. Quoter — buy direction (ETH → token) ────────
console.log(`\n=== 3. V4 Quoter — BUY direction (ETH → token) — sanity check ===`);
try {
  const q = await quoteV4Pool({
    poolKey, amountIn: 100000000000000n /* 0.0001 ETH */, zeroForOne: !sellZeroForOne,
    publicClient, quoter: config.chain.dexes.uniswap.v4Quoter,
  });
  console.log(`buy 0.0001 ETH: amountOut = ${q?.amountOut} (${q ? "OK" : "REVERTED"})`);
} catch (e) { console.log(`buy quote err: ${e.message.slice(0,80)}`); }

// ──────── 4. Hook contract — bytecode size ────────
console.log(`\n=== 4. Hook contract ${meta.hooks} ===`);
try {
  const code = await publicClient.getBytecode({ address: meta.hooks });
  console.log(`bytecode size: ${code ? (code.length - 2) / 2 : 0} bytes`);
} catch (e) { console.log(`code err: ${e.message.slice(0,80)}`); }

// ──────── 5. Failed tx receipt (if provided) ────────
if (FAILED_TX) {
  console.log(`\n=== 5. Failed tx ${FAILED_TX} ===`);
  try {
    const tx = await publicClient.getTransaction({ hash: FAILED_TX });
    console.log(`from: ${tx.from}  to: ${tx.to}  value: ${tx.value}  block: ${tx.blockNumber}`);
    console.log(`input head: ${tx.input.slice(0, 100)}...`);
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: FAILED_TX });
      console.log(`receipt status: ${receipt.status}  gasUsed: ${receipt.gasUsed}  logs: ${receipt.logs.length}`);
    } catch (e) { console.log(`receipt err: ${e.message.slice(0,80)}`); }
  } catch (e) { console.log(`tx err: ${e.message.slice(0,80)}`); }
}
