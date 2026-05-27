// Global process guards — keep the daemon alive against background-task failures from
// transitive deps. Concrete trigger that motivated this module: @uniswap/smart-order-router
// fires unawaited subgraph refreshes; when they reject with "Failed to get subgraph pools
// from any providers", Node 22 (with no unhandledRejection listener) promotes the rejection
// to uncaughtException, where brotli's own re-throwing handler (loaded transitively by SOR)
// kills the process with exit 7. Registering listeners on both events short-circuits that
// chain — the rejection is observed here and never reaches brotli's handler.
//
// MUST be the very first import in src/index.js so these listeners are registered before any
// module that pulls in brotli/SOR is evaluated.

import { logger } from "./logger.js";

// Lazy + best-effort: don't import telegram statically (avoid load-order coupling), and never
// let a notification path failure cascade back into the guard itself.
const safeNotify = (text) => {
  setImmediate(async () => {
    try {
      const mod = await import("../notify/telegram.js");
      if (mod.notifyInfo) await mod.notifyInfo(text);
    } catch {
      // swallow — Telegram is best-effort; the log line above is the durable record
    }
  });
};

// Known background-task rejections from transitive deps that we already classify elsewhere
// and don't need a Telegram ping for. They still hit the log at WARN for the audit trail.
// Pattern sources:
//   `invalid bytes32 string` — SOR TokenProvider.getTokens parses token name/symbol with
//      parseBytes32String; a token with non-null-terminated encoding throws. Observed on
//      a Clanker fresh launch 2026-05-27. The main quote() catches its own promise; the
//      noisy one is the unawaited side-fetch inside CachingTokenProviderWithFallback.
//   `failed to get subgraph pools|subgraph` — SOR fires unawaited subgraph refreshes; the
//      v13.0 catch motivated this whole file. Already covered by the uniswap adapter's
//      own soft-error handling for the foreground path.
const KNOWN_RECOVERABLE_REJECTIONS = /invalid bytes32 string|failed to get subgraph pools|subgraph pools/i;

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.warn({ err: msg, stack }, "unhandled promise rejection — daemon stays alive");
  if (!KNOWN_RECOVERABLE_REJECTIONS.test(msg)) {
    safeNotify(`daemon: unhandled rejection — ${msg.slice(0, 200)}`);
  }
});

process.on("uncaughtException", (err) => {
  logger.error({ err: err.message, stack: err.stack }, "uncaught exception — daemon stays alive");
  safeNotify(`daemon: uncaught exception — ${err.message.slice(0, 200)}`);
});
