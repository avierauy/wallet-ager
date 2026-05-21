// Print current wallet values vs the initial snapshot. Run: `npm run balances`.
import { computeWalletValue, fetchTokenPrices } from "../src/core/balanceTracker.js";
import { getInitialSnapshot } from "../src/core/db.js";
import { loadTokens } from "../src/core/tokens.js";
import { loadWallets } from "../src/core/wallets.js";

const fmtEth = (wei) => (Number(wei) / 1e18).toFixed(6);
const fmtDiff = (diffWei) => {
  const sign = diffWei >= 0n ? "+" : "-";
  return sign + fmtEth(diffWei < 0n ? -diffWei : diffWei);
};
const pct = (now, init) => {
  if (init === 0n) return "n/a";
  const bps = ((now - init) * 10000n) / init;
  const sign = bps >= 0n ? "+" : "";
  return `${sign}${Number(bps) / 100}%`;
};

const wallets = loadWallets();
const tokens = loadTokens();

console.log(`Fetching prices for ${tokens.length} tokens via AlphaRouter…`);
const prices = await fetchTokenPrices(tokens);
const valuedTokens = [...prices.entries()].filter(([, v]) => v != null).length;
console.log(`  → ${valuedTokens}/${tokens.length} tokens priced (others valued at 0).\n`);

const rows = [];
let aggNativeNow = 0n;
let aggTokensNow = 0n;
let aggTotalNow = 0n;
let aggTotalInitial = 0n;
let initialCount = 0;

for (const wallet of wallets) {
  const value = await computeWalletValue({ wallet, tokens, prices });
  const initial = getInitialSnapshot(wallet.id);
  const initialTotal = initial ? BigInt(initial.total_wei) : null;
  const diff = initialTotal != null ? value.totalWei - initialTotal : null;
  rows.push({
    wallet: wallet.id,
    native: fmtEth(value.nativeWei),
    tokens: fmtEth(value.tokensValueWei),
    total: fmtEth(value.totalWei),
    initial: initialTotal != null ? fmtEth(initialTotal) : "(none)",
    diff: diff != null ? fmtDiff(diff) : "n/a",
    pct: initialTotal != null ? pct(value.totalWei, initialTotal) : "n/a",
  });
  aggNativeNow += value.nativeWei;
  aggTokensNow += value.tokensValueWei;
  aggTotalNow += value.totalWei;
  if (initialTotal != null) {
    aggTotalInitial += initialTotal;
    initialCount++;
  }
}

console.log("Per wallet:\n");
console.table(rows);

console.log("\nAggregate:");
console.log(`  Native (now):           ${fmtEth(aggNativeNow)} ETH`);
console.log(`  Tokens (now, in ETH):   ${fmtEth(aggTokensNow)} ETH`);
console.log(`  Total (now):            ${fmtEth(aggTotalNow)} ETH`);
if (initialCount > 0) {
  console.log(`  Total (initial, ${initialCount}/${wallets.length} wallets snapshotted): ${fmtEth(aggTotalInitial)} ETH`);
  const diff = aggTotalNow - aggTotalInitial;
  console.log(`  Net Δ:                  ${fmtDiff(diff)} ETH (${pct(aggTotalNow, aggTotalInitial)})`);
} else {
  console.log(`  No initial snapshots in DB yet (run the daemon at least once to capture them).`);
}
