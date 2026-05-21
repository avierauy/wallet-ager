// Retry helper for transient errors. Conservative classifier (default-deny on retry) so we
// never re-broadcast something that the chain rejected for a real reason like slippage,
// honeypot, or insufficient balance.

// Patterns we treat as transient (worth retrying with a fresh quote / chain re-read):
//   - allowance race after a just-confirmed approve (RPC saw stale state)
//   - nonce desync after viem's auto-fetch
//   - mempool pricing churn
//   - network / 5xx errors from the RPC provider
const TRANSIENT_PATTERNS = [
  /insufficient allowance/i,
  /nonce too low/i,
  /nonce has already been used/i,
  /known transaction/i,
  /replacement transaction underpriced/i,
  /transaction underpriced/i,
  /fetch failed/i,
  /econnreset|etimedout|enetunreach|enotfound/i,
  /\b5\d\d\b/, // any 3-digit 5xx mentioned in the message
  /could not be detected/i,
  /request timed out|request timeout/i,
  /service unavailable/i,
];

export const isTransientError = (err, seen = new Set()) => {
  if (!err || seen.has(err)) return false;
  seen.add(err);
  const msg = String(err.shortMessage ?? err.message ?? err);
  for (const re of TRANSIENT_PATTERNS) if (re.test(msg)) return true;
  if (err.cause) return isTransientError(err.cause, seen);
  return false;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const withRetry = async (
  fn,
  {
    maxAttempts = 3,
    delays = [2000, 5000, 10000],
    onRetry = () => {},
    isTransient = isTransientError,
  } = {}
) => {
  if (maxAttempts < 1) throw new Error("withRetry: maxAttempts must be >= 1");
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) throw err;
      if (!isTransient(err)) throw err;
      const nextDelayMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
      try { onRetry({ attempt, err, nextDelayMs }); } catch {}
      if (nextDelayMs > 0) await sleep(nextDelayMs);
    }
  }
  throw lastErr;
};
