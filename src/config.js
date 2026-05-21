import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";

const required = (key) => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
};

const optional = (key, fallback = "") => process.env[key] ?? fallback;

const parseBool = (val, fallback) => {
  if (val === undefined || val === "") return fallback;
  return val === "true" || val === "1" || val === "yes";
};

const readJson = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));

const chain = required("CHAIN");
const chainConfig = readJson(`./config/chains/${chain}.json`);

export const config = {
  chain: chainConfig,
  rpc: {
    primary: required("RPC_URL"),
    fallback: optional("RPC_URL_FALLBACK")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  apis: {
    zeroEx: optional("ZEROEX_API_KEY"),
    basescan: optional("BASESCAN_API_KEY"),
  },
  telegram: {
    token: optional("TELEGRAM_BOT_TOKEN"),
    chatId: optional("TELEGRAM_CHAT_ID"),
    enabled: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    notify: {
      trades: parseBool(process.env.TELEGRAM_NOTIFY_TRADES, true),
      approves: parseBool(process.env.TELEGRAM_NOTIFY_APPROVES, false),
      errors: parseBool(process.env.TELEGRAM_NOTIFY_ERRORS, true),
    },
    batchSummaryMin: Number(optional("TELEGRAM_BATCH_SUMMARY_MIN", "0")),
  },
  log: {
    level: optional("LOG_LEVEL", "info"),
    pretty: optional("LOG_PRETTY") === "true",
  },
  db: {
    path: optional("DB_PATH", "./data/wallet-ager.db"),
  },
  paths: {
    wallets: optional("WALLETS_CONFIG", "./config/wallets.json"),
    tokens: optional("TOKENS_CONFIG", "./config/tokens.json"),
  },
  runtime: {
    dryRun: optional("DRY_RUN") === "true" || process.argv.includes("--dry-run"),
    maxConcurrency: Number(optional("MAX_CONCURRENCY", "10")),
  },
};
