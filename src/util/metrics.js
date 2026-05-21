// Lightweight in-memory metrics. Counters keyed by event name + sorted field pairs.
// Designed to be logged periodically (`snapshot()`) rather than scraped — for historical
// aggregation use the SQLite trades table directly (see scripts/metrics.js).

const counters = new Map();
const tickDurations = [];
const MAX_DURATION_SAMPLES = 1000;

const fmtKey = (event, fields) => {
  const keys = Object.keys(fields).sort();
  if (keys.length === 0) return event;
  return `${event}|${keys.map((k) => `${k}=${fields[k]}`).join(",")}`;
};

export const inc = (event, fields = {}) => {
  const key = fmtKey(event, fields);
  counters.set(key, (counters.get(key) ?? 0) + 1);
};

export const recordTickDuration = (ms) => {
  tickDurations.push(ms);
  if (tickDurations.length > MAX_DURATION_SAMPLES) tickDurations.shift();
};

const percentile = (sortedAsc, p) =>
  sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p))];

export const snapshot = () => {
  const events = {};
  for (const [key, count] of counters.entries()) {
    const [event, fieldsStr] = key.split("|");
    if (!events[event]) events[event] = [];
    const fields = {};
    if (fieldsStr) {
      for (const pair of fieldsStr.split(",")) {
        const [k, v] = pair.split("=");
        fields[k] = v;
      }
    }
    events[event].push({ ...fields, count });
  }
  let ticks = null;
  if (tickDurations.length > 0) {
    const sorted = [...tickDurations].sort((a, b) => a - b);
    ticks = {
      n: sorted.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      maxMs: sorted[sorted.length - 1],
    };
  }
  return { events, ticks };
};

export const reset = () => {
  counters.clear();
  tickDurations.length = 0;
};
