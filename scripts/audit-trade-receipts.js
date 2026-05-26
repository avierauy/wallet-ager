// Audit all txHashes the daemon logged as "trade completed" against on-chain receipts.
// Reveals the false-positive rate where we logged success but the tx reverted on-chain.
//
// Usage: node --env-file=.env scripts/audit-trade-receipts.js <path-to-log-file>
import { readFileSync } from "node:fs";
import { publicClient } from "../src/core/rpc.js";

const logPath = process.argv[2];
if (!logPath) {
  console.error("Usage: node scripts/audit-trade-receipts.js <log-file>");
  process.exit(1);
}

// Strip ANSI escape codes for easier parsing
const text = readFileSync(logPath, "utf8").replace(/\[[0-9;]*m/g, "");

// Split on "trade completed" anchor (after ANSI strip)
const blocks = text.split(/trade completed/);
const trades = [];
for (let i = 1; i < blocks.length; i++) {
  const block = blocks[i].slice(0, 600);
  const walletId = block.match(/walletId: "([^"]+)"/)?.[1];
  const side = block.match(/side: "([^"]+)"/)?.[1];
  const token = block.match(/token: "([^"]+)"/)?.[1];
  const txHash = block.match(/txHash: "(0x[0-9a-fA-F]+)"/)?.[1];
  const source = block.match(/source: "([^"]+)"/)?.[1];
  if (walletId && txHash) trades.push({ walletId, side, token, txHash, source });
}

console.log(`Found ${trades.length} 'trade completed' events with txHash\n`);

let success = 0;
let reverted = 0;
let notFound = 0;
const failures = [];

for (const t of trades) {
  try {
    const r = await publicClient.getTransactionReceipt({ hash: t.txHash });
    const status = r.status;
    const marker = status === "success" ? "✓" : "✗ REVERTED";
    console.log(`${marker}  ${t.side.padEnd(4)} ${t.token.padEnd(10)} ${t.walletId.padEnd(15)} gas=${r.gasUsed} ${t.txHash}`);
    if (status === "success") success++;
    else { reverted++; failures.push(t); }
  } catch (err) {
    console.log(`?  ${t.side.padEnd(4)} ${t.token.padEnd(10)} ${t.walletId.padEnd(15)} ${t.txHash} (${err.message.slice(0,50)})`);
    notFound++;
  }
}

console.log(`\n========== SUMMARY ==========`);
console.log(`Total logged as 'trade completed': ${trades.length}`);
console.log(`  ✓ success on-chain:  ${success} (${((success/trades.length)*100).toFixed(1)}%)`);
console.log(`  ✗ REVERTED on-chain: ${reverted} (${((reverted/trades.length)*100).toFixed(1)}%)`);
console.log(`  ?  not found:        ${notFound}`);

if (failures.length > 0) {
  console.log(`\nREVERTED trades (false positives in our 'trade completed' log):`);
  for (const f of failures) {
    console.log(`  ${f.side} ${f.token} by ${f.walletId} via ${f.source || '?'}`);
    console.log(`    https://basescan.org/tx/${f.txHash}`);
  }
}

// Per-side breakdown of revert rate
const buys = trades.filter((t) => t.side === "buy");
const sells = trades.filter((t) => t.side === "sell");
const buyReverts = failures.filter((t) => t.side === "buy").length;
const sellReverts = failures.filter((t) => t.side === "sell").length;
console.log(`\nBy side:`);
console.log(`  BUYS:  ${buys.length} logged, ${buyReverts} reverted (${buys.length ? ((buyReverts/buys.length)*100).toFixed(1) : 0}%)`);
console.log(`  SELLS: ${sells.length} logged, ${sellReverts} reverted (${sells.length ? ((sellReverts/sells.length)*100).toFixed(1) : 0}%)`);
