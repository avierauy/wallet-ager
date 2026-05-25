// Telegram bot — inbound command handler.
//
// Uses long-polling via Bot API getUpdates with timeout=25s. No webhook means we don't
// need to expose a port; the bot reaches out to api.telegram.org. The loop is best-effort:
// transient network errors are caught and retried on the next tick. A graceful stop is
// supported via stopBot().
//
// Security: every update is verified to come from the configured TELEGRAM_CHAT_ID. Updates
// from any other chat are dropped silently (no response — don't help attackers probe).

import { config } from "../config.js";
import { countTradesTodayByWallet, listRecentTrades } from "../core/db.js";
import { getDailyState } from "../strategy/dailyCounter.js";
import { logger } from "../util/logger.js";
import { getStartedAt, isPaused, setPaused } from "../util/runtimeState.js";
import {
  handleHelp,
  handlePause,
  handleRecent,
  handleResume,
  handleStatus,
  handleUnknown,
  handleWallets,
} from "./telegramCommands.js";

const TELEGRAM_API = "https://api.telegram.org";
const POLL_TIMEOUT_S = 25;
const ERROR_BACKOFF_MS = 5000;

let stopped = false;
let lastUpdateId = 0;
let walletsRef = [];
let stateProviders = null;
let pollTask = null;

const send = async (text) => {
  if (!config.telegram.enabled) return;
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${config.telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, "telegramBot: send failed");
    }
  } catch (err) {
    logger.warn({ err: err.message }, "telegramBot: send threw");
  }
};

// Compute today's aggregate totals across all wallets from the per-wallet counters.
const aggregateTotals = (wallets) => {
  const t = { buys_submitted: 0, buys_failed: 0, sells_submitted: 0, sells_failed: 0 };
  for (const w of wallets) {
    const c = countTradesTodayByWallet({ wallet_id: w.id });
    t.buys_submitted += (c.buy_submitted ?? 0) + (c["buy_dry-run"] ?? 0);
    t.buys_failed += c.buy_failed ?? 0;
    t.sells_submitted += (c.sell_submitted ?? 0) + (c["sell_dry-run"] ?? 0);
    t.sells_failed += c.sell_failed ?? 0;
  }
  return t;
};

const dispatch = async (text) => {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();
  switch (cmd) {
    case "/status": {
      const enabledSniperCount = walletsRef.filter((w) => w.profile.sniper?.enabled).length;
      return handleStatus({
        startedAt: getStartedAt(),
        paused: isPaused(),
        version: config.runtime?.version ?? process.env.npm_package_version ?? "dev",
        walletCount: walletsRef.length,
        enabledSniperCount,
        sniperState: stateProviders?.sniperState?.() ?? null,
        dailyTotals: aggregateTotals(walletsRef),
      });
    }
    case "/wallets": {
      const enriched = walletsRef.map((w) => ({
        id: w.id,
        address: w.account.address,
        dailyState: getDailyState({ wallet: w }),
        todayCounts: countTradesTodayByWallet({ wallet_id: w.id }),
      }));
      return handleWallets({ wallets: enriched });
    }
    case "/recent": {
      const trades = listRecentTrades(5);
      return handleRecent({ trades, explorer: config.chain.blockExplorer });
    }
    case "/pause":
      setPaused(true);
      return handlePause();
    case "/resume":
      setPaused(false);
      return handleResume();
    case "/help":
    case "/start":
      return handleHelp();
    default:
      return handleUnknown(cmd);
  }
};

const handleUpdate = async (update) => {
  // Only react to text messages from the authorized chat. Filter early.
  const msg = update.message;
  if (!msg || typeof msg.text !== "string") return;
  if (String(msg.chat?.id) !== String(config.telegram.chatId)) return;
  if (!msg.text.startsWith("/")) return;
  try {
    const reply = await dispatch(msg.text);
    if (reply) await send(reply);
  } catch (err) {
    logger.error({ err: err.message, text: msg.text }, "telegramBot: command threw");
    await send(`\\*command failed\\*: ${err.message.slice(0, 200)}`);
  }
};

const pollOnce = async () => {
  const url = `${TELEGRAM_API}/bot${config.telegram.token}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${lastUpdateId + 1}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`getUpdates not ok: ${JSON.stringify(json).slice(0, 200)}`);
  for (const update of json.result) {
    if (update.update_id > lastUpdateId) lastUpdateId = update.update_id;
    await handleUpdate(update);
  }
};

const loop = async () => {
  while (!stopped) {
    try {
      await pollOnce();
    } catch (err) {
      if (stopped) return;
      logger.warn({ err: err.message }, "telegramBot: poll failed, backing off");
      await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
    }
  }
};

export const startTelegramBot = ({ wallets, sniperState }) => {
  if (!config.telegram.enabled) {
    logger.info("telegramBot: disabled (no TELEGRAM_BOT_TOKEN or CHAT_ID)");
    return;
  }
  walletsRef = wallets;
  stateProviders = { sniperState };
  stopped = false;
  // Skip historical updates that piled up while the daemon was down. Using offset=-1
  // returns the latest update only; we initialize lastUpdateId from it so the next
  // getUpdates starts from the next one. If there are no updates, lastUpdateId stays 0.
  fetch(`${TELEGRAM_API}/bot${config.telegram.token}/getUpdates?offset=-1`)
    .then(async (res) => {
      if (!res.ok) return;
      const json = await res.json();
      if (json.ok && json.result.length > 0) {
        lastUpdateId = json.result[json.result.length - 1].update_id;
      }
    })
    .catch(() => {})
    .finally(() => { pollTask = loop(); });
  logger.info({ chatId: config.telegram.chatId }, "telegramBot: started");
};

export const stopTelegramBot = () => {
  stopped = true;
  pollTask = null;
};

// Test helper — drives a single dispatch round without starting the loop.
export const _testDispatch = async ({ text, wallets, sniperState }) => {
  walletsRef = wallets ?? [];
  stateProviders = { sniperState: sniperState ?? (() => ({ pendingSells: 0, cooldowns: 0 })) };
  return dispatch(text);
};
