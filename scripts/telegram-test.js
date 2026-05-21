// Verifies the Telegram bot wiring end-to-end. Run: `npm run telegram-test`.
import { config } from "../src/config.js";
import { notifyError, notifyInfo, notifyTrade } from "../src/notify/telegram.js";

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

console.log("\nSending notifyInfo …");
await notifyInfo("wallet-ager: telegram test (notifyInfo) ok");
console.log("  sent");

console.log("Sending notifyTrade …");
await notifyTrade({
  walletId: "w-test01",
  dex: "uniswap",
  side: "buy",
  txHash: "0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1",
  explorer: config.chain.blockExplorer,
  in: { symbol: "ETH", decimals: 18, amountWei: 1_000_000_000_000_000n }, // 0.001 ETH
  out: { symbol: "TIBBIR", decimals: 18, amountWei: 12_345_678_900_000_000_000n }, // ~12.345 TIBBIR
});
console.log("  sent");

console.log("Sending notifyError …");
await notifyError({
  walletId: "w-test01",
  dex: "bankr",
  error: "this is a test error message — ignore",
});
console.log("  sent");

console.log("\nAll three messages dispatched. Check your Telegram chat.");
