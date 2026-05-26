// Look at recent Transfer events on a token to see if anyone has sold (token → user)
// from the pool. If buys happen but no sells, that confirms a hook block / one-way pool.
import { parseAbiItem } from "viem";
import { config } from "../src/config.js";
import { publicClient } from "../src/core/rpc.js";
import { db } from "../src/core/db.js";

const TOKEN = (process.argv[2] || "").toLowerCase();
if (!TOKEN) { console.error("Usage: <token-addr>"); process.exit(1); }

const row = db.prepare("SELECT * FROM discovered_tokens WHERE lower(address) = ?").get(TOKEN);
const meta = JSON.parse(row.pool_metadata);
const POOL_MANAGER = config.chain.dexes.uniswap.v4PoolManager.toLowerCase();

const Transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const head = await publicClient.getBlockNumber();
const CHUNK = 9000n;
const all = [];
for (let start = head - 100_000n; start <= head; start += CHUNK + 1n) {
  const end = start + CHUNK > head ? head : start + CHUNK;
  try {
    const logs = await publicClient.getLogs({ address: TOKEN, event: Transfer, fromBlock: start, toBlock: end });
    all.push(...logs);
  } catch {}
}
console.log(`Token: ${row.symbol} ${TOKEN}`);
console.log(`Hook: ${meta.hooks}`);
console.log(`Total transfers found: ${all.length} in last 100k blocks\n`);

// Categorize:
// - mints (from = 0x0)
// - BUYS:  from = PoolManager → to = user (pool gave tokens out)
// - SELLS: from = user → to = PoolManager (user gave tokens to pool)
let mints = 0, buys = 0, sells = 0, other = 0;
const buySamples = [];
const sellSamples = [];
const ZERO = "0x0000000000000000000000000000000000000000";
for (const t of all) {
  const from = t.args.from.toLowerCase();
  const to = t.args.to.toLowerCase();
  if (from === ZERO) mints++;
  else if (from === POOL_MANAGER) { buys++; if (buySamples.length < 3) buySamples.push(t); }
  else if (to === POOL_MANAGER) { sells++; if (sellSamples.length < 3) sellSamples.push(t); }
  else other++;
}
console.log(`mints (from 0x0):                  ${mints}`);
console.log(`buys  (PoolManager → user):        ${buys}`);
console.log(`sells (user → PoolManager):        ${sells}  ← if 0, nobody can sell`);
console.log(`other (user-to-user transfers):    ${other}`);

console.log(`\nUnique routers/aggregators handling buys (last 100 buy txs):`);
const buyTxs = all.filter((t) => t.args.from.toLowerCase() === POOL_MANAGER).slice(-100).map((t) => t.transactionHash);
const targets = {};
for (const h of buyTxs) {
  try {
    const tx = await publicClient.getTransaction({ hash: h });
    const to = (tx.to ?? "null").toLowerCase();
    targets[to] = (targets[to] ?? 0) + 1;
  } catch {}
}
for (const [addr, count] of Object.entries(targets).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${addr}: ${count}`);
}

if (sells > 0) {
  console.log(`\nUnique routers handling sells (last 100 sell txs):`);
  const sellTxs = all.filter((t) => t.args.to.toLowerCase() === POOL_MANAGER).slice(-100).map((t) => t.transactionHash);
  const stargets = {};
  for (const h of sellTxs) {
    try {
      const tx = await publicClient.getTransaction({ hash: h });
      const to = (tx.to ?? "null").toLowerCase();
      stargets[to] = (stargets[to] ?? 0) + 1;
    } catch {}
  }
  for (const [addr, count] of Object.entries(stargets).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${addr}: ${count}`);
  }
} else {
  console.log(`\n⚠ NO SELLS observed in 100k blocks — confirmed one-way pool (hook blocking)`);
}
