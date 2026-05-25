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

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.warn({ err: msg, stack }, "unhandled promise rejection — daemon stays alive");
  safeNotify(`daemon: unhandled rejection — ${msg.slice(0, 200)}`);
});

process.on("uncaughtException", (err) => {
  logger.error({ err: err.message, stack: err.stack }, "uncaught exception — daemon stays alive");
  safeNotify(`daemon: uncaught exception — ${err.message.slice(0, 200)}`);
});
