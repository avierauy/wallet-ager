import { config } from "../config.js";
import { fmt } from "../util/format.js";
import { logger } from "../util/logger.js";

const TELEGRAM_API = "https://api.telegram.org";

export const escapeMd = (s) =>
  String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, (c) => `\\${c}`);

const send = async (text) => {
  if (!config.telegram.enabled) return;
  try {
    const res = await fetch(
      `${TELEGRAM_API}/bot${config.telegram.token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, "telegram send failed");
    }
  } catch (err) {
    logger.warn({ err }, "telegram send threw");
  }
};

// Batch counters — incremented on every event regardless of the per-type live toggle.
// Reset each time startBatchTimer() fires its periodic summary.
const eventCounts = { trades: 0, approves: 0, errors: 0 };

const recordEvent = (type) => {
  if (!config.telegram.batchSummaryMin) return;
  eventCounts[type]++;
};

export const _getEventCounts = () => ({ ...eventCounts });
export const _resetEventCounts = () => {
  eventCounts.trades = 0;
  eventCounts.approves = 0;
  eventCounts.errors = 0;
};

// Pure: format the periodic summary text. Extracted so tests don't need timers.
export const buildBatchMessage = (counts, intervalMin) =>
  [
    `*Summary* — last ${escapeMd(String(intervalMin))}min`,
    `trades:   ${escapeMd(String(counts.trades))}`,
    `approves: ${escapeMd(String(counts.approves))}`,
    `errors:   ${escapeMd(String(counts.errors))}`,
  ].join("\n");

// Boot the periodic batch sender. Returns the interval handle (or null if disabled).
export const startBatchTimer = () => {
  const min = config.telegram.batchSummaryMin;
  if (!min || !config.telegram.enabled) return null;
  return setInterval(async () => {
    const snapshot = _getEventCounts();
    if (snapshot.trades === 0 && snapshot.approves === 0 && snapshot.errors === 0) return;
    _resetEventCounts();
    await send(buildBatchMessage(snapshot, min));
  }, min * 60 * 1000);
};

// Derive a friendly explorer name from its URL. "https://basescan.org" → "Basescan".
const explorerLabel = (url) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
    return host.charAt(0).toUpperCase() + host.slice(1);
  } catch {
    return "Explorer";
  }
};

const formatLeg = (leg) => {
  if (!leg) return null;
  return `${fmt(leg.amountWei, leg.decimals)} ${leg.symbol}`;
};

export const notifyTrade = ({
  walletId,
  dex,
  side,
  txHash,
  explorer,
  in: inLeg,
  out: outLeg,
}) => {
  recordEvent("trades");
  if (!config.telegram.enabled || !config.telegram.notify.trades) return;

  const lines = [
    `*${escapeMd(side.toUpperCase())}* on *${escapeMd(dex)}*`,
    `wallet: \`${escapeMd(walletId)}\``,
    `spent: ${escapeMd(formatLeg(inLeg) ?? "?")}`,
  ];
  if (outLeg) lines.push(`got:   ${escapeMd("~" + formatLeg(outLeg))}`);
  if (txHash) {
    const short = `${txHash.slice(0, 10)}…${txHash.slice(-6)}`;
    lines.push(`hash:  \`${escapeMd(short)}\``);
    if (explorer) {
      lines.push(`[Open on ${escapeMd(explorerLabel(explorer))} ↗](${explorer}/tx/${txHash})`);
    }
  }
  return send(lines.join("\n"));
};

export const notifyError = ({ walletId, dex, error }) => {
  recordEvent("errors");
  if (!config.telegram.enabled || !config.telegram.notify.errors) return;
  return send(
    [
      `*ERROR* on *${escapeMd(dex)}*`,
      `wallet: \`${escapeMd(walletId)}\``,
      `msg:    ${escapeMd(error)}`,
    ].join("\n")
  );
};

export const notifyApproval = ({
  walletId,
  tokenSymbol,
  decimals,
  amountWei,
  spender,
  spenderLabel,
  txHash,
  explorer,
}) => {
  recordEvent("approves");
  if (!config.telegram.enabled || !config.telegram.notify.approves) return;

  const amountText = amountWei == null ? "unlimited" : `${fmt(amountWei, decimals)} ${tokenSymbol}`;
  const shortSpender = spender ? `${spender.slice(0, 6)}…${spender.slice(-4)}` : "?";
  const spenderText = spenderLabel ? `${spenderLabel} (${shortSpender})` : shortSpender;

  const lines = [
    `*APPROVE* ${escapeMd(tokenSymbol)}`,
    `wallet:  \`${escapeMd(walletId)}\``,
    `amount:  ${escapeMd(amountText)}`,
    `spender: ${escapeMd(spenderText)}`,
  ];
  if (txHash) {
    const short = `${txHash.slice(0, 10)}…${txHash.slice(-6)}`;
    lines.push(`hash:    \`${escapeMd(short)}\``);
    if (explorer) {
      lines.push(`[Open on ${escapeMd(explorerLabel(explorer))} ↗](${explorer}/tx/${txHash})`);
    }
  }
  return send(lines.join("\n"));
};

// notifyInfo — always live when telegram is enabled (boot, shutdown, batch summary header).
// Not toggle-able by design: it carries operational events the operator should never miss.
export const notifyInfo = (text) => {
  if (!config.telegram.enabled) return;
  return send(escapeMd(text));
};
