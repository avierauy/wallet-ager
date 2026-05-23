// Per-wallet daily roundtrip counter — PERSISTENT across daemon restarts.
//
// Semantic: one "trade" = one round-trip (buy + matching sell). The buy consumes a slot
// against the wallet's `profile.tradesPerDay` allowance. The sell — even if it spans the
// UTC day boundary, or fires after several retries — does NOT consume an additional slot.
//
// State model:
//   * `allowance`: sampled once per UTC day per wallet and persisted to the
//     `daily_allowances` table. Stable across restarts within the same day. Re-sampled
//     when a new UTC date is observed.
//   * `used`:      derived live from the `trades` table on each check
//     (count of side='buy' with status IN ('submitted','dry-run') on this UTC date).
//     This means restarting the daemon does NOT reset the count — the source of truth is
//     the trade history itself.
import { countSubmittedBuysOnDate, db, getDailyAllowance, upsertDailyAllowance } from "../core/db.js";
import { sampleUniformInt } from "./randomizer.js";

const utcDateKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

// Resolve today's allowance: read from DB or sample + persist. Pure read on the
// trades table for `used`. Returns { date, allowance, used, remaining }.
const resolveToday = ({ walletId, profile, rng }) => {
  const date = utcDateKey();
  let allowance = getDailyAllowance({ wallet_id: walletId, date });
  if (allowance == null) {
    const range = profile?.tradesPerDay ?? [0, 0];
    allowance = sampleUniformInt(range, rng);
    upsertDailyAllowance({ wallet_id: walletId, date, allowance });
  }
  const used = countSubmittedBuysOnDate({ wallet_id: walletId, date });
  const remaining = Math.max(0, allowance - used);
  return { date, allowance, used, remaining };
};

// Returns true if the wallet still has room for another buy today.
export const canTrade = ({ wallet, rng = Math.random }) => {
  if (!wallet?.id) return false;
  const { remaining } = resolveToday({ walletId: wallet.id, profile: wallet.profile, rng });
  return remaining > 0;
};

// No-op now: the source of truth is the trades table, so recording is implicit when
// executor.insertTrade + updateTrade(submitted) commit a buy. Kept as an exported
// function so call sites don't have to change and so tests can still observe the
// "consume slot" intent.
export const recordTrade = ({ wallet, rng = Math.random } = {}) => {
  // intentionally empty — used is derived from DB. The function exists so callers can
  // express the intent "this trade should count" and remain decoupled from the storage.
  // (We still need rng in the signature for symmetry; canTrade samples allowance lazily.)
  if (wallet?.id) resolveToday({ walletId: wallet.id, profile: wallet.profile, rng });
};

// Read-only snapshot for diagnostics + metrics.
export const getDailyState = ({ wallet, rng = Math.random }) => {
  if (!wallet?.id) return null;
  return resolveToday({ walletId: wallet.id, profile: wallet.profile, rng });
};

// Test-only helper: wipes both daily_allowances and any buy trades from the in-memory
// test DB so each test starts clean. Production code should never call this.
export const _resetAll = () => {
  db.exec(`DELETE FROM daily_allowances; DELETE FROM trades;`);
};
