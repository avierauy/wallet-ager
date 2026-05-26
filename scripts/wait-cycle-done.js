// Poll DB + on-chain balances until the trading cycle is complete:
//   - For each wallet: submitted+dry-run buys today >= sampled allowance
//   - AND no wallet holds any discovered token (all sells settled)
//
// Exits 0 on completion, non-zero on timeout. Prints progress each poll so the parent can
// observe via Bash output. Designed to be wrapped in `run_in_background` so completion
// triggers a notification.
import { readFileSync } from "node:fs";
import { erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../src/config.js";
import { db } from "../src/core/db.js";
import { publicClient } from "../src/core/rpc.js";

const POLL_MS = 60_000;
const MAX_RUNTIME_MS = 90 * 60_000;            // 90 min hard cap
const QUIET_PERIOD_MS = 8 * 60_000;            // 8 min of no new trades after cap saturation
const startedAt = Date.now();

const walletsRaw = JSON.parse(readFileSync(config.paths.wallets, "utf8"));
const wallets = walletsRaw.wallets.map((pk) => {
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
  return { id: "w-" + account.address.slice(2, 10).toLowerCase(), address: account.address };
});

const today = () => new Date().toISOString().slice(0, 10);

const checkOnce = async () => {
  const date = today();
  const allowanceRows = db.prepare(
    `SELECT wallet_id, allowance FROM daily_allowances WHERE date = ?`
  ).all(date);
  const allowanceById = Object.fromEntries(allowanceRows.map((r) => [r.wallet_id, r.allowance]));

  const usedRows = db.prepare(
    `SELECT wallet_id, COUNT(*) AS n FROM trades
     WHERE side = 'buy' AND status IN ('submitted','dry-run')
       AND strftime('%Y-%m-%d', created_at/1000, 'unixepoch') = ?
     GROUP BY wallet_id`
  ).all(date);
  const usedById = Object.fromEntries(usedRows.map((r) => [r.wallet_id, r.n]));

  let walletsAtCap = 0;
  let totalUsed = 0;
  let totalAllowance = 0;
  let walletsWithAllowance = 0;
  for (const w of wallets) {
    const allowance = allowanceById[w.id];
    if (allowance == null) continue;
    walletsWithAllowance++;
    const used = usedById[w.id] ?? 0;
    totalUsed += used;
    totalAllowance += allowance;
    if (used >= allowance) walletsAtCap++;
  }

  const capSaturated = walletsWithAllowance > 0 && walletsAtCap === walletsWithAllowance;

  // Last completed trade timestamp (any side, status='submitted')
  const lastTradeRow = db.prepare(
    `SELECT MAX(confirmed_at) AS last_at FROM trades WHERE status = 'submitted'`
  ).get();
  const lastAt = lastTradeRow?.last_at ?? 0;
  const quietForMs = Date.now() - lastAt;

  // Pending sells = wallets still holding any discovered token
  let pendingSells = 0;
  if (capSaturated) {
    // Only check balances when we're saturating — saves RPC otherwise
    const traded = db.prepare(
      `SELECT DISTINCT token_out AS addr FROM trades
       WHERE side = 'buy' AND status IN ('submitted','dry-run')
         AND strftime('%Y-%m-%d', created_at/1000, 'unixepoch') = ?`
    ).all(date);
    for (const w of wallets) {
      for (const t of traded) {
        try {
          const bal = await publicClient.readContract({
            address: t.addr, abi: erc20Abi, functionName: "balanceOf",
            args: [w.address],
          });
          if (bal > 0n) pendingSells++;
        } catch {}
      }
    }
  }

  return {
    walletsWithAllowance,
    walletsAtCap,
    totalUsed,
    totalAllowance,
    capSaturated,
    quietForMs,
    pendingSells,
    lastTradeAt: lastAt ? new Date(lastAt).toISOString() : "never",
  };
};

const isComplete = (s) => {
  // Cycle complete when ALL wallets hit cap AND no pending sells AND quiet for QUIET_PERIOD_MS
  return s.walletsWithAllowance > 0
    && s.capSaturated
    && s.pendingSells === 0
    && s.quietForMs >= QUIET_PERIOD_MS;
};

let pollCount = 0;
while (true) {
  pollCount++;
  if (Date.now() - startedAt > MAX_RUNTIME_MS) {
    console.log(`[poll ${pollCount}] TIMEOUT after ${Math.round(MAX_RUNTIME_MS/60_000)}min — exiting non-zero`);
    process.exit(2);
  }
  let snap;
  try { snap = await checkOnce(); }
  catch (err) { console.log(`[poll ${pollCount}] check error: ${err.message}`); await new Promise((r) => setTimeout(r, POLL_MS)); continue; }

  console.log(`[poll ${pollCount}] wallets ${snap.walletsAtCap}/${snap.walletsWithAllowance} at cap | total buys ${snap.totalUsed}/${snap.totalAllowance} | pendingSells ${snap.pendingSells} | quiet ${Math.round(snap.quietForMs/1000)}s | last ${snap.lastTradeAt}`);

  if (isComplete(snap)) {
    console.log(`[poll ${pollCount}] CYCLE_COMPLETE — all ${snap.walletsAtCap} wallets saturated, no pending sells, ${Math.round(snap.quietForMs/1000)}s quiet`);
    process.exit(0);
  }

  await new Promise((r) => setTimeout(r, POLL_MS));
}
