// Non-blocking poll-with-retry for V4 pool tradeability.
//
// Why this exists:
//   Most launchpad hooks (Clanker MEV, Doppler anti-snipe, etc.) enforce a brief blackout
//   window after pool creation — swaps revert for the first N blocks. A "real user" using the
//   launchpad's UI also has to wait. So instead of firing the sniper immediately and burning
//   gas-estimation cycles on a doomed tx, we probe the V4Quoter on a short interval until it
//   accepts the trade, then fire.
//
// Design:
//   - Non-blocking: each handler returns immediately after starting the poll. The poll
//     itself runs in the background via setTimeout (jittered).
//   - Probe is caller-supplied: Clanker passes a single Quoter call (we already know the
//     PoolKey from the hash match); Doppler passes the full resolveV4PoolKeyViaQuoter to
//     keep brute-forcing candidates.
//   - Cancellable: returns a stop() handle so callers can abort if the token gets evicted.
//   - Bounded: maxAttempts × intervalMs caps total polling at ~60s by default — enough to
//     clear Clanker's MEV window (observed ~30s) but short enough that we don't tail dead
//     listings forever.

const DEFAULTS = {
  intervalMs: 5000,
  jitterMs: 1000,
  maxAttempts: 12, // 12 × ~5.5s ≈ 66s total
};

// Test/CI knob: when V4_POLLER_DISABLED=1, the poll is a no-op (returns a stop() that does
// nothing and never invokes onReady/onTimeout). Lets unit tests for discovery handlers run
// without leaving 60s setTimeout chains around.
const DISABLED = () => process.env.V4_POLLER_DISABLED === "1";

// probe(): async fn returning a truthy result on success, falsy on retry.
// onReady(result): called once when probe succeeds.
// onTimeout(): called once if maxAttempts exhausted without success.
// Returns a stop() function that cancels any pending retry.
export const startV4Poll = ({ probe, onReady, onTimeout, options = {} }) => {
  if (DISABLED()) return () => {};
  const opts = { ...DEFAULTS, ...options };
  let cancelled = false;
  let attempt = 0;
  let timer = null;

  const tick = async () => {
    if (cancelled) return;
    attempt++;
    let result = null;
    try {
      result = await probe(attempt);
    } catch {
      // transient — fall through to retry
    }
    if (cancelled) return;
    if (result) {
      onReady(result, attempt);
      return;
    }
    if (attempt >= opts.maxAttempts) {
      onTimeout(attempt);
      return;
    }
    const delay = opts.intervalMs + Math.floor(Math.random() * opts.jitterMs);
    timer = setTimeout(tick, delay);
  };

  // First attempt runs on next tick; callers can register handlers between create + first probe.
  timer = setImmediate(tick);

  return () => {
    cancelled = true;
    if (timer) {
      // setImmediate handles are cleared via clearImmediate; setTimeout via clearTimeout.
      // We don't track which type the latest one is, so try both — they're no-ops on the
      // wrong type but never throw.
      try { clearTimeout(timer); } catch {}
      try { clearImmediate(timer); } catch {}
    }
  };
};
