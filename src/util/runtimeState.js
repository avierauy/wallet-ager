// Tiny in-memory runtime flags shared across modules. Lives in its own file so callers
// can import without circular dependencies (sniper -> telegramBot -> sniper would loop).
//
// Currently holds:
//   - paused: when true, tryFireSniperBuy short-circuits. Toggled via Telegram /pause
//     and /resume commands. Lost on daemon restart (intentional — restart = resume).
//   - startedAt: epoch ms when the daemon was initialized, for uptime reporting.

let paused = false;
let startedAt = Date.now();

export const isPaused = () => paused;
export const setPaused = (v) => { paused = Boolean(v); };

export const getStartedAt = () => startedAt;
export const markStarted = () => { startedAt = Date.now(); };

// Test helper.
export const _reset = () => { paused = false; startedAt = Date.now(); };
