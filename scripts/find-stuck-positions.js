// Focused stuck-position scanner: only scans (wallet, token) pairs where THIS wallet has
// actually bought THIS token (from `trades` table). Parallelized across wallets with progress
// logging every few seconds. Outputs ./data/sell-plan.json compatible with sell-positions.js.
import { readFileSync, writeFileSync } from "node:fs";
import { erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../src/config.js";
import { db } from "../src/core/db.js";
import { publicClient } from "../src/core/rpc.js";
import { quoteV4Pool } from "../src/discovery/v4PoolKey.js";

const WETH = config.chain.wnative.toLowerCase();
const NATIVE_ZERO = "0x0000000000000000000000000000000000000000";
const DUST_WEI = 1n;

const walletsRaw = JSON.parse(readFileSync(config.paths.wallets, "utf8"));
const wallets = walletsRaw.wallets.map((pk) => {
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
  return { id: "w-" + account.address.slice(2, 10).toLowerCase(), address: account.address };
});
process.stdout.write(`[init] ${wallets.length} wallets\n`);

// Build (wallet, token) pairs FROM the trades table — only check what we actually bought
const buyPairs = db.prepare(
  `SELECT DISTINCT t.wallet_id, t.token_out AS token_addr,
          d.symbol, d.decimals, d.source, d.pool_metadata
     FROM trades t
     LEFT JOIN discovered_tokens d ON lower(t.token_out) = lower(d.address)
    WHERE t.side = 'buy' AND t.status = 'submitted'`
).all();
process.stdout.write(`[init] ${buyPairs.length} (wallet, token) buy pairs to verify\n`);

const walletByid = Object.fromEntries(wallets.map((w) => [w.id, w]));

// Group by wallet for parallel scan
const byWallet = new Map();
for (const p of buyPairs) {
  if (!byWallet.has(p.wallet_id)) byWallet.set(p.wallet_id, []);
  byWallet.get(p.wallet_id).push(p);
}
process.stdout.write(`[init] ${byWallet.size} unique wallets touched buys\n\n`);

let totalScanned = 0;
let totalNonZero = 0;
const positions = [];
const startMs = Date.now();

// Progress ticker (every 5s)
const progressTimer = setInterval(() => {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
  process.stdout.write(`[progress] scanned ${totalScanned}/${buyPairs.length} | non-zero ${totalNonZero} | ${elapsed}s\n`);
}, 5000);

const scanWalletPairs = async ([walletId, pairs]) => {
  const w = walletByid[walletId];
  if (!w) return;
  for (const p of pairs) {
    totalScanned++;
    try {
      const balance = await publicClient.readContract({
        address: p.token_addr, abi: erc20Abi, functionName: "balanceOf",
        args: [w.address],
      });
      if (balance < DUST_WEI) continue;
      totalNonZero++;
      const meta = p.pool_metadata ? JSON.parse(p.pool_metadata) : null;
      const hasV4 = meta?.version === "v4" && meta.currency0 && meta.fee != null;
      if (!hasV4) {
        positions.push({
          walletId, walletAddr: w.address,
          token: p.token_addr, symbol: p.symbol ?? "?", decimals: p.decimals ?? 18,
          balance: balance.toString(),
          source: p.source,
          SKIP_REASON: meta ? `no V4 key (version=${meta.version})` : "no poolMetadata",
        });
        continue;
      }
      const c0Lower = meta.currency0.toLowerCase();
      const c0IsWeth = c0Lower === WETH || c0Lower === NATIVE_ZERO;
      const tokenIsCurrency0 = !c0IsWeth;
      const zeroForOne = tokenIsCurrency0;
      let expectedOut = "0";
      try {
        const q = await quoteV4Pool({
          poolKey: {
            currency0: meta.currency0, currency1: meta.currency1,
            fee: Number(meta.fee), tickSpacing: Number(meta.tickSpacing), hooks: meta.hooks,
          },
          amountIn: balance, zeroForOne, publicClient,
          quoter: config.chain.dexes.uniswap.v4Quoter,
        });
        if (q?.amountOut > 0n) expectedOut = q.amountOut.toString();
      } catch {}
      positions.push({
        walletId, walletAddr: w.address,
        token: p.token_addr, symbol: p.symbol ?? "?", decimals: p.decimals ?? 18,
        balance: balance.toString(), expectedOut,
        source: p.source,
        poolKey: {
          currency0: meta.currency0, currency1: meta.currency1,
          fee: Number(meta.fee), tickSpacing: Number(meta.tickSpacing), hooks: meta.hooks,
        },
        zeroForOne,
      });
    } catch {}
  }
};

await Promise.all([...byWallet.entries()].map(scanWalletPairs));

clearInterval(progressTimer);

const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
process.stdout.write(`\n[done] ${totalScanned} pairs scanned in ${elapsed}s | ${positions.length} non-zero positions\n\n`);

if (positions.length > 0) {
  console.log("Stuck positions:");
  for (const p of positions) {
    const balFmt = (Number(p.balance) / 10 ** (p.decimals || 18)).toFixed(4);
    const outFmt = p.expectedOut ? (Number(p.expectedOut) / 1e18).toFixed(8) : "?";
    const tag = p.SKIP_REASON ? `[SKIP: ${p.SKIP_REASON}]` : `→ ${outFmt} ETH`;
    console.log(`  ${p.walletId}  ${(p.symbol||"?").padEnd(15)} ${balFmt.padStart(16)} ${tag}  src=${p.source}`);
  }
}

const liquidatable = positions.filter((p) => !p.SKIP_REASON);
const skipped = positions.filter((p) => p.SKIP_REASON);
console.log(`\nLiquidatable via V4 sell-positions.js: ${liquidatable.length}`);
console.log(`Skipped V4 (use alpha-router fallback): ${skipped.length}`);

if (positions.length > 0) {
  // Write ALL non-zero positions including V3/skipped ones — the alpha-router liquidator
  // handles any source, V4-specific liquidator only handles entries with poolKey.
  writeFileSync("./data/sell-plan.json", JSON.stringify(positions, null, 2));
  console.log(`\nWrote ./data/sell-plan.json with ${positions.length} total positions.`);
  console.log(`Run V4-only (faster):    node scripts/sell-positions.js`);
  console.log(`Run via AlphaRouter:     node scripts/liquidate-via-alpha-router.js`);
} else {
  console.log("\nWallets clean — nothing to liquidate.");
}
