// Forensic pasivo (v13.18): for each Clanker token we touched, compute the time delta
// between pool deploy (proxy: discovered_at) and the first SUCCESSFUL UR sell from any
// of our wallets. Aggregate to estimate the hook anti-snipe window threshold.
//
// Data sources:
//   - discovered_tokens.discovered_at — pool discovery time (close to deploy time for
//     Clanker, since we listen to TokenCreated and they emit at deploy)
//   - trades.created_at — when we issued the sell
//   - trades.confirmed_at — when we got the receipt back (v13.18 onward; null for older)
//   - trades.status — 'submitted' = successful, 'reverted'/'pre-sim-reverted' = failed
//
// Output: per-token row + summary (P50/P90/min/max time-from-discovery-to-first-sell-OK).
// Run: node --env-file=.env scripts/clanker-window-tracker.js
//
// Notes:
//   - Older trades (pre-v13.18) lack confirmed_at; we fall back to created_at for those.
//     That's an over-estimate of the window (we count the tx as "successful at issue time"
//     rather than "successful at confirmation time"), but the error is ~2-4s — negligible
//     vs the multi-minute windows we're trying to characterize.
//   - We don't have on-chain pool deploy block here, only discovered_at. For Clanker tokens
//     these are within a few seconds of each other (discovery handler runs on TokenCreated).
//   - Currently only counts our own sells; for a larger sample, the standalone could scan
//     PoolManager swap logs filtered by hook address. Future enhancement.
import { db } from "../src/core/db.js";

const rows = db.prepare(
  `SELECT d.address, d.symbol, d.source, d.discovered_at,
          MIN(CASE WHEN t.side='buy' AND t.status='submitted' THEN COALESCE(t.confirmed_at, t.created_at) END) AS first_buy_at,
          MIN(CASE WHEN t.side='sell' AND t.status='submitted' THEN COALESCE(t.confirmed_at, t.created_at) END) AS first_sell_at,
          COUNT(CASE WHEN t.side='buy' AND t.status='submitted' THEN 1 END) AS buys,
          COUNT(CASE WHEN t.side='sell' AND t.status='submitted' THEN 1 END) AS sells_ok,
          COUNT(CASE WHEN t.side='sell' AND t.status IN ('reverted','pre-sim-reverted','failed') THEN 1 END) AS sells_fail
     FROM discovered_tokens d
     LEFT JOIN trades t ON lower(t.token_in) = lower(d.address) OR lower(t.token_out) = lower(d.address)
    WHERE d.source LIKE 'clanker-%'
    GROUP BY d.address
   HAVING first_buy_at IS NOT NULL`
).all();

console.log(`Found ${rows.length} Clanker tokens we bought.\n`);

const samples = []; // ms: time from discovery → first successful sell
const noSell = [];

for (const r of rows) {
  if (r.first_sell_at) {
    const ageMs = r.first_sell_at - r.discovered_at;
    samples.push({ ageMs, ...r });
  } else {
    noSell.push(r);
  }
}

const sortedByAge = [...samples].sort((a, b) => a.ageMs - b.ageMs);
const fmt = (ms) => `${(ms / 1000).toFixed(0)}s (${(ms / 60000).toFixed(1)}min)`;

console.log(`=== Per-token first successful sell time (sorted) ===`);
console.log(`${"token".padEnd(12)} ${"sym".padEnd(10)} ${"buys".padEnd(5)} ${"ok".padEnd(4)} ${"fail".padEnd(5)} ${"age@first_sell"}`);
for (const s of sortedByAge.slice(0, 30)) {
  console.log(
    `${s.address.slice(0, 12)} ${(s.symbol ?? "?").padEnd(10)} ${String(s.buys).padEnd(5)} ${String(s.sells_ok).padEnd(4)} ${String(s.sells_fail).padEnd(5)} ${fmt(s.ageMs)}`
  );
}
if (sortedByAge.length > 30) console.log(`  ... and ${sortedByAge.length - 30} more`);

console.log(`\n=== Tokens with buys but NO successful sell yet (still stuck or sold elsewhere) ===`);
for (const r of noSell) {
  console.log(`  ${r.address.slice(0, 12)} ${r.symbol ?? "?"} | ${r.buys} buy(s), ${r.sells_fail} sell attempt(s) failed`);
}

if (sortedByAge.length === 0) {
  console.log("\nNo successful Clanker sells in DB yet.");
  process.exit(0);
}

const pct = (arr, p) => arr[Math.floor((arr.length - 1) * p)].ageMs;
console.log(`\n=== Summary (n=${samples.length} tokens with first-sell-OK) ===`);
console.log(`  min:    ${fmt(sortedByAge[0].ageMs)}`);
console.log(`  P50:    ${fmt(pct(sortedByAge, 0.5))}`);
console.log(`  P90:    ${fmt(pct(sortedByAge, 0.9))}`);
console.log(`  P99:    ${fmt(pct(sortedByAge, 0.99))}`);
console.log(`  max:    ${fmt(sortedByAge[sortedByAge.length - 1].ageMs)}`);

console.log(`\n=== Recommended SNIPER_CLANKER_SELL_RETRY_INTERVAL_MS coverage ===`);
const p90 = pct(sortedByAge, 0.9);
const headroom = p90 * 1.5;
console.log(`  P90 first-sell-OK: ${fmt(p90)}`);
console.log(`  Headroom 1.5×:     ${fmt(headroom)} ← target retry window`);
console.log(`  With 10 attempts:  ~${Math.ceil(headroom / 10 / 60000)} min per attempt`);
