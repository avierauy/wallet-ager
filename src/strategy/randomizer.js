// Pure random helpers. The caller passes `rng` (() => number in [0,1)) so tests can seed it.

export const sampleUniform = ([lo, hi], rng) => lo + (hi - lo) * rng();

export const sampleUniformInt = ([lo, hi], rng) => Math.floor(sampleUniform([lo, hi + 1], rng));

// Lognormal feels more "human": clusters near the lower end of the range with occasional larger trades.
export const sampleLognormal = ([lo, hi], rng) => {
  const u = rng();
  // Skew toward `lo` — exponent < 1 stretches lower values.
  const skewed = Math.pow(u, 1.8);
  return lo + (hi - lo) * skewed;
};

export const sampleWeighted = (weights, rng) => {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) throw new Error("sampleWeighted: total weight must be > 0");
  let r = rng() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1][0];
};

export const samplePick = (arr, rng) => {
  if (arr.length === 0) throw new Error("samplePick: empty array");
  return arr[Math.floor(rng() * arr.length)];
};

// Convert a fractional ETH amount (e.g., 0.0015) to wei with full precision.
export const ethFloatToWei = (eth) => {
  const s = eth.toFixed(18);
  const [intPart, fracPart = ""] = s.split(".");
  return BigInt(intPart + fracPart.padEnd(18, "0"));
};
