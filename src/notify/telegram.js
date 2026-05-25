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

// Render the wallet identification line: prefer the on-chain address (clickable Basescan
// link) and fall back to the wallet id for callers that don't have the address handy.
const renderWalletLine = ({ walletAddress, walletId, explorer }) => {
  if (walletAddress && explorer) {
    return `wallet: [\`${escapeMd(walletAddress)}\`](${explorer}/address/${walletAddress})`;
  }
  if (walletAddress) {
    return `wallet: \`${escapeMd(walletAddress)}\``;
  }
  return `wallet: \`${escapeMd(walletId ?? "?")}\``;
};

// Render the tx hash line with a clickable explorer link and the FULL hash (no truncation —
// the hash is high-value data the operator may want to copy verbatim).
const renderHashLine = ({ txHash, explorer }) => {
  if (!txHash) return null;
  const linkLine = explorer
    ? `[Open on ${escapeMd(explorerLabel(explorer))} ↗](${explorer}/tx/${txHash})`
    : null;
  return [`hash: \`${escapeMd(txHash)}\``, linkLine].filter(Boolean).join("\n");
};

// Token "source" comes from discovery (e.g. "clanker-v4", "doppler-bankr", "virtuals-Launched").
// When a token from a trusted launchpad swaps via Uniswap (most Clanker/Doppler tokens live
// in V4 pools), the dex field alone hides the actual origin — surface it as a "via:" line.
const LAUNCHPAD_SOURCE_RE = /^(clanker-|doppler-|virtuals-)/i;
const renderViaLine = (source) =>
  source && LAUNCHPAD_SOURCE_RE.test(source) ? `via: \`${escapeMd(source)}\`` : null;

export const notifyTrade = ({
  walletId,
  walletAddress,
  dex,
  side,
  source,
  txHash,
  explorer,
  in: inLeg,
  out: outLeg,
}) => {
  recordEvent("trades");
  if (!config.telegram.enabled || !config.telegram.notify.trades) return;

  const lines = [`*${escapeMd(side.toUpperCase())}* on *${escapeMd(dex)}*`];
  const viaLine = renderViaLine(source);
  if (viaLine) lines.push(viaLine);
  lines.push(renderWalletLine({ walletAddress, walletId, explorer }));
  lines.push(`spent: ${escapeMd(formatLeg(inLeg) ?? "?")}`);
  if (outLeg) lines.push(`got:   ${escapeMd("~" + formatLeg(outLeg))}`);
  const hashBlock = renderHashLine({ txHash, explorer });
  if (hashBlock) lines.push(hashBlock);
  return send(lines.join("\n"));
};

export const notifyError = ({ walletId, walletAddress, dex, source, error, explorer }) => {
  recordEvent("errors");
  if (!config.telegram.enabled || !config.telegram.notify.errors) return;
  const lines = [`*ERROR* on *${escapeMd(dex)}*`];
  const viaLine = renderViaLine(source);
  if (viaLine) lines.push(viaLine);
  lines.push(renderWalletLine({ walletAddress, walletId, explorer }));
  lines.push(`msg:    ${escapeMd(error)}`);
  return send(lines.join("\n"));
};

export const notifyApproval = ({
  walletId,
  walletAddress,
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
    renderWalletLine({ walletAddress, walletId, explorer }),
    `amount:  ${escapeMd(amountText)}`,
    `spender: ${escapeMd(spenderText)}`,
  ];
  const hashBlock = renderHashLine({ txHash, explorer });
  if (hashBlock) lines.push(hashBlock);
  return send(lines.join("\n"));
};

// notifyInfo — always live when telegram is enabled (boot, shutdown, batch summary header).
// Not toggle-able by design: it carries operational events the operator should never miss.
export const notifyInfo = (text) => {
  if (!config.telegram.enabled) return;
  return send(escapeMd(text));
};
