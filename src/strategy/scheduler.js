import { sampleUniform, sampleUniformInt } from "./randomizer.js";

// Returns true if `nowUtcHour` falls within [startHour, endHour]. Handles overnight wraps:
// e.g. [22, 3] means active 22:00-23:59 and 00:00-03:00.
export const isWithinActiveHours = (nowUtcHour, [startHour, endHour]) => {
  if (startHour === endHour) return true;
  return startHour < endHour
    ? nowUtcHour >= startHour && nowUtcHour < endHour
    : nowUtcHour >= startHour || nowUtcHour < endHour;
};

// Returns the duration (ms) of the wallet's daily active window. Handles overnight wraps.
const activeWindowMs = ([startHour, endHour]) => {
  const hours = startHour === endHour
    ? 24
    : startHour < endHour
      ? endHour - startHour
      : 24 - startHour + endHour;
  return hours * 60 * 60 * 1000;
};

// Picks the delay (ms) until the next action for a wallet, given its profile.
// Total daily actions are `tradesPerDay`; we spread them across the active window with random jitter
// so wallets don't cluster on the hour boundary.
export const nextDelayMs = ({ profile, rng, nowMs = Date.now() }) => {
  const tradesPerDay = sampleUniformInt(profile.tradesPerDay, rng);
  if (tradesPerDay <= 0) return null;
  const windowMs = activeWindowMs(profile.activeHoursUtc);
  const meanGap = windowMs / tradesPerDay;
  // Jitter the gap by ±50% so it doesn't look mechanical.
  const jitter = sampleUniform([0.5, 1.5], rng);
  return Math.floor(meanGap * jitter);
};

// Picks an initial "first action at" for a freshly-started wallet — a random point in the next
// active window to avoid every wallet firing at startup time.
export const initialDelayMs = ({ profile, rng }) => {
  const windowMs = activeWindowMs(profile.activeHoursUtc);
  return Math.floor(sampleUniform([0, windowMs / 4], rng));
};
