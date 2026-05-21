// Historical metrics from the SQLite trades table. Run: `npm run metrics` or
// `npm run metrics -- --hours 6` to override the window.
import { db } from "../src/core/db.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const hours = Number(args.hours ?? 24);
const since = Date.now() - hours * 60 * 60 * 1000;

const trades = db
  .prepare(
    `SELECT dex, side, status, COUNT(*) AS n
     FROM trades
     WHERE created_at >= ?
     GROUP BY dex, side, status
     ORDER BY dex, side, status`
  )
  .all(since);

const total = trades.reduce((s, r) => s + r.n, 0);
console.log(`\nLast ${hours}h — ${total} trades across ${trades.length} buckets:\n`);
console.table(trades);

const errors = db
  .prepare(
    `SELECT error, COUNT(*) AS n
     FROM trades
     WHERE status IN ('failed', 'skipped')
       AND created_at >= ?
       AND error IS NOT NULL
     GROUP BY error
     ORDER BY n DESC
     LIMIT 20`
  )
  .all(since);

if (errors.length > 0) {
  console.log("\nTop failure/skip reasons:\n");
  console.table(errors);
}

const perWallet = db
  .prepare(
    `SELECT wallet_id,
            SUM(status='submitted') AS submitted,
            SUM(status='skipped')   AS skipped,
            SUM(status='failed')    AS failed,
            SUM(status='dry-run')   AS dry_run,
            COUNT(*) AS total
     FROM trades
     WHERE created_at >= ?
     GROUP BY wallet_id
     ORDER BY total DESC
     LIMIT 30`
  )
  .all(since);

if (perWallet.length > 0) {
  console.log("\nTop wallets by activity (last", hours + "h):\n");
  console.table(perWallet);
}

const safetyCache = db
  .prepare(
    `SELECT token, is_safe, buy_tax, sell_tax, simulation_success,
            datetime(checked_at/1000, 'unixepoch') AS checked
     FROM token_safety
     ORDER BY checked_at DESC
     LIMIT 20`
  )
  .all();

if (safetyCache.length > 0) {
  console.log("\nMost recent safety verdicts:\n");
  console.table(safetyCache);
}
