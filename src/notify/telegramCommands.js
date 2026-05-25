// Pure command handlers for the Telegram bot. Each function takes a snapshot of
// dependencies (state readers + wallet list) and returns a MarkdownV2-escaped string.
// Keeping them pure means we can unit-test the formatting without mocking the bot
// transport.
//
// All numeric outputs are formatted with Spanish-friendly conventions per the operator's
// existing preferences (see notify/telegram.js usage).

import { escapeMd } from "./telegram.js";

const fmtUptime = (ms) => {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};

const fmtAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?");

// /status — daemon-wide snapshot.
// deps: { startedAt, paused, version, walletCount, enabledSniperCount, sniperState,
//         dailyTotals: { buys_submitted, buys_failed, sells_submitted, sells_failed } }
export const handleStatus = (deps) => {
  const uptime = fmtUptime(Date.now() - deps.startedAt);
  const totals = deps.dailyTotals ?? {};
  const lines = [
    `*wallet\\-ager status*`,
    `version: \`${escapeMd(deps.version ?? "unknown")}\``,
    `uptime: ${escapeMd(uptime)}`,
    `paused: ${deps.paused ? "🛑 YES" : "✅ no"}`,
    `wallets: ${deps.walletCount} \\(${deps.enabledSniperCount} sniper enabled\\)`,
    `pending sells: ${deps.sniperState?.pendingSells ?? 0}`,
    `cooldowns: ${deps.sniperState?.cooldowns ?? 0}`,
    ``,
    `*today's trades*`,
    `  buys: ${totals.buys_submitted ?? 0} ✓ ${totals.buys_failed ?? 0} ✗`,
    `  sells: ${totals.sells_submitted ?? 0} ✓ ${totals.sells_failed ?? 0} ✗`,
  ];
  return lines.join("\n");
};

// /wallets — per-wallet daily progress.
// deps: { wallets: [{ id, address, dailyState: { used, allowance, remaining },
//                     todayCounts: { buy_submitted, sell_submitted, ... } }] }
export const handleWallets = (deps) => {
  const lines = [`*wallets \\(${deps.wallets.length}\\)*`, ``];
  for (const w of deps.wallets) {
    const cap = w.dailyState ?? { used: "?", allowance: "?", remaining: "?" };
    const tc = w.todayCounts ?? {};
    const buys = (tc.buy_submitted ?? 0) + (tc.buy_dry_run ?? 0);
    const sells = (tc.sell_submitted ?? 0) + (tc.sell_dry_run ?? 0);
    lines.push(
      `\`${escapeMd(w.id)}\` \\(${escapeMd(fmtAddr(w.address))}\\)`,
      `  cap: ${cap.used}/${cap.allowance} \\(${cap.remaining} left\\)`,
      `  today: ${buys} buy \\| ${sells} sell`,
      ``
    );
  }
  return lines.join("\n").trimEnd();
};

// /recent — last N trades.
// deps: { trades: [{ side, dex, status, token_out, tx_hash, created_at, error }],
//         explorer? }
export const handleRecent = (deps) => {
  if (!deps.trades?.length) return `*no recent trades*`;
  const lines = [`*last ${deps.trades.length} trades*`, ``];
  for (const t of deps.trades) {
    const when = new Date(t.created_at).toISOString().replace("T", " ").slice(0, 19);
    const statusEmoji = t.status === "submitted" || t.status === "dry-run" ? "✓"
      : t.status === "skipped" ? "⊘" : "✗";
    const token = t.side === "buy" ? t.token_out : t.token_in;
    const hashLine = t.tx_hash
      ? (deps.explorer
          ? `    [tx ↗](${deps.explorer}/tx/${t.tx_hash})`
          : `    tx: \`${escapeMd(t.tx_hash.slice(0, 18))}…\``)
      : (t.error ? `    err: ${escapeMd(String(t.error).slice(0, 80))}` : "");
    lines.push(
      `${statusEmoji} ${escapeMd(when)} \\| ${escapeMd(t.side)} ${escapeMd(t.dex)} \`${escapeMd(fmtAddr(token))}\``,
    );
    if (hashLine) lines.push(hashLine);
  }
  return lines.join("\n");
};

export const handlePause = () => `🛑 *paused* — sniper will not fire new buys\\. Sends/retries continue\\.`;
export const handleResume = () => `✅ *resumed* — sniper firing re\\-enabled\\.`;

export const handleHelp = () => [
  `*available commands*`,
  `/status — daemon snapshot \\+ today's trade totals`,
  `/wallets — per\\-wallet daily cap progress`,
  `/recent — last 5 trades`,
  `/pause — stop sniper firing \\(in\\-flight retries continue\\)`,
  `/resume — re\\-enable sniper firing`,
  `/help — this message`,
].join("\n");

export const handleUnknown = (cmd) =>
  `unknown command: \`${escapeMd(cmd)}\`\\. send /help for the list\\.`;
