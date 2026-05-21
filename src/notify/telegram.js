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

const formatLeg = (leg) => {
  if (!leg) return null;
  return `${fmt(leg.amountWei, leg.decimals)} ${leg.symbol}`;
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

// notifyTrade — `in` and `out` are objects shaped like { symbol, decimals, amountWei }.
// `out` is optional (some adapters don't return an expected output amount).
export const notifyTrade = ({
  walletId,
  dex,
  side,
  txHash,
  explorer,
  in: inLeg,
  out: outLeg,
}) => {
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

export const notifyError = ({ walletId, dex, error }) =>
  send(
    [
      `*ERROR* on *${escapeMd(dex)}*`,
      `wallet: \`${escapeMd(walletId)}\``,
      `msg:    ${escapeMd(error)}`,
    ].join("\n")
  );

// notifyApproval — ERC20 approval event. `amountWei == null` is treated as unlimited (e.g.
// Permit2 one-time MAX approval). `spenderLabel` is a friendly name to disambiguate the
// spender address (e.g. "Permit2", "Virtuals FRouter").
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

// Arbitrary informational text (boot, shutdown, periodic summary). Auto-escaped for MarkdownV2.
export const notifyInfo = (text) => send(escapeMd(text));
