// Per-wallet daily roundtrip counter.
//
// Semantic: one "trade" = one round-trip (buy + matching sell). The buy consumes a slot
// against the wallet's `profile.tradesPerDay` allowance. The sell — even if it spans the
// UTC day boundary, or fires after several retries — does NOT consume an additional slot.
//
// We sample the allowance once per UTC day so the cap is stable: a wallet that drew "4"
// today doesn't randomly shift to "5" mid-day. The state is in-memory; on daemon restart
// the counter resets, which is acceptable for a discovery-driven sniper (worst case: a
// restarted daemon allows one extra round-trip for the day).
import { sampleUniformInt } from "./randomizer.js";

// walletId → { date: "YYYY-MM-DD", allowance: number, used: number }
const dailyState = new Map();

const utcDateKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

const ensureToday = ({ walletId, profile, rng }) => {
  const today = utcDateKey();
  const state = dailyState.get(walletId);
  if (state && state.date === today) return state;
  // Fresh day (or first access) — sample a stable allowance for the rest of the UTC day.
  const range = profile?.tradesPerDay ?? [0, 0];
  const allowance = sampleUniformInt(range, rng);
  const fresh = { date: today, allowance, used: 0 };
  dailyState.set(walletId, fresh);
  return fresh;
};

// Returns true if the wallet still has room for another buy today.
export const canTrade = ({ wallet, rng = Math.random }) => {
  if (!wallet?.id) return false;
  const state = ensureToday({ walletId: wallet.id, profile: wallet.profile, rng });
  return state.used < state.allowance;
};

// Record that a buy fired (call after the executor reports submitted/dry-run, not on failure).
export const recordTrade = ({ wallet, rng = Math.random }) => {
  if (!wallet?.id) return;
  const state = ensureToday({ walletId: wallet.id, profile: wallet.profile, rng });
  state.used += 1;
};

// Read-only snapshot for diagnostics + metrics.
export const getDailyState = ({ wallet, rng = Math.random }) => {
  if (!wallet?.id) return null;
  const state = ensureToday({ walletId: wallet.id, profile: wallet.profile, rng });
  return { ...state, remaining: Math.max(0, state.allowance - state.used) };
};

// Test helpers.
export const _resetAll = () => dailyState.clear();
export const _state = () => Object.fromEntries(dailyState);
