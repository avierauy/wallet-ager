// Helper for viem.watchEvent onError handlers.
//
// The most common watcher failure on Infura is "Requested resource not found" on
// eth_getFilterChanges — the JSON-RPC filter expires after ~5min of inactivity and
// viem transparently recreates one on the next poll. Logging this at ERROR level
// pollutes the operator's view; it's recoverable and not actionable. Anything else
// (RPC 5xx, network errors, unexpected payloads) still goes to ERROR.

const EXPIRED_FILTER_RE = /Requested resource not found.*eth_getFilterChanges/s;

export const isExpiredFilterError = (err) => {
  const msg = err?.message ?? String(err);
  return EXPIRED_FILTER_RE.test(msg);
};

// Log a watcher error at the appropriate level. `label` is the human-readable
// context (e.g., "uniswap V4: watcher error"). Returns the chosen level for tests.
export const logWatcherError = (logger, err, label) => {
  if (isExpiredFilterError(err)) {
    logger.warn({ err: err.message }, `${label} (recoverable: expired filter)`);
    return "warn";
  }
  logger.error({ err: err.message }, label);
  return "error";
};
