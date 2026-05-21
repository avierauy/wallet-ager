// Verifies the Telegram bot wiring end-to-end by sending one of each message type.
// Run: `npm run telegram-test`.
import { config } from "../src/config.js";
import { notifyApproval, notifyError, notifyInfo, notifyTrade } from "../src/notify/telegram.js";

console.log("Telegram config:");
console.log("  enabled :", config.telegram.enabled);
console.log("  token   :", config.telegram.token ? "(set)" : "(missing)");
console.log("  chat ID :", config.telegram.chatId || "(missing)");

if (!config.telegram.enabled) {
  console.error(
    "\nTelegram is disabled. Set BOTH TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env, then re-run."
  );
  process.exit(1);
}

console.log("\n1) notifyInfo …");
await notifyInfo("wallet-ager: telegram test (notifyInfo) ok");
console.log("   sent");

console.log("2) notifyTrade — BUY …");
await notifyTrade({
  walletId: "w-test01",
  dex: "uniswap",
  side: "buy",
  txHash: "0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1",
  explorer: config.chain.blockExplorer,
  in: { symbol: "ETH", decimals: 18, amountWei: 1_000_000_000_000_000n }, // 0.001 ETH
  out: { symbol: "TIBBIR", decimals: 18, amountWei: 12_345_678_900_000_000_000n }, // ~12.345 TIBBIR
});
console.log("   sent");

console.log("3) notifyTrade — SELL …");
await notifyTrade({
  walletId: "w-test01",
  dex: "uniswap",
  side: "sell",
  txHash: "0xfeed1234deadbeef5678fa00c0ffee99b00c0deef111222333aabbccdd0e0f01",
  explorer: config.chain.blockExplorer,
  in: { symbol: "TIBBIR", decimals: 18, amountWei: 5_234_876_543_210_000_000_000n }, // 5234.876543 TIBBIR
  out: { symbol: "ETH", decimals: 18, amountWei: 820_456_000_000_000n }, // 0.000820 ETH
});
console.log("   sent");

console.log("4) notifyApproval — Permit2 (unlimited) …");
await notifyApproval({
  walletId: "w-test01",
  tokenSymbol: "TIBBIR",
  decimals: 18,
  amountWei: null, // → "unlimited"
  spender: config.chain.permit2,
  spenderLabel: "Permit2",
  txHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  explorer: config.chain.blockExplorer,
});
console.log("   sent");

console.log("5) notifyApproval — Virtuals FRouter (exact amount) …");
await notifyApproval({
  walletId: "w-test01",
  tokenSymbol: "VIRTUAL",
  decimals: 18,
  amountWei: 2_829_825_900_591_169_448n,
  spender: config.chain.dexes.virtuals.preGradApproveSpender,
  spenderLabel: "Virtuals FRouter",
  txHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
  explorer: config.chain.blockExplorer,
});
console.log("   sent");

console.log("6) notifyError …");
await notifyError({
  walletId: "w-test01",
  dex: "bankr",
  error: "this is a test error message — ignore",
});
console.log("   sent");

console.log("\nAll six messages dispatched. Check your Telegram chat.");
