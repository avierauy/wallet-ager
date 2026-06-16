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

// Stagger range format: "min-max" in ms, both non-negative integers, max >= min. "0-0" means
// no stagger (fires immediately). Throws on invalid input — config errors should be loud.
const parseStaggerRange = (raw, name) => {
  const parts = String(raw).split("-").map((s) => Number(s.trim()));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    throw new Error(`${name}: invalid stagger range "${raw}" — expected "min-max" (e.g. "2000-30000")`);
  }
  const [min, max] = parts;
  if (min < 0 || max < 0 || max < min) {
    throw new Error(`${name}: invalid stagger range "${raw}" — both ≥0 and max ≥ min`);
  }
  return [min, max];
};

const positiveInt = (raw, name) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name}: must be a positive integer, got "${raw}"`);
  return n;
};

const readJson = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));

const chain = required("CHAIN");
const chainConfig = readJson(`./config/chains/${chain}.json`);

export const config = {
  chain: chainConfig,
  rpc: {
    primary: required("RPC_URL"),
    // Global fallback — applied to every RPC client (discovery + swap). Use only with rate-limit-
    // generous providers (paid backups). Public RPCs here will burn quota on discovery polling.
    fallback: optional("RPC_URL_FALLBACK")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Swap-only fallback — appended to swap-path clients (executor, adapters, watchdog retry,
    // nonceManager). Discovery/snapshots stay on `primary + fallback`. Safe slot for public RPCs.
    swapFallback: optional("RPC_URL_SWAP_FALLBACK")
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
  discovery: {
    // How often the sweeper re-runs safety on active discovered tokens.
    recheckHours: Number(optional("DISCOVERY_RECHECK_HOURS", "6")),
    // How long a discovered token can sit untraded before it's evicted (expired).
    ttlHours: Number(optional("DISCOVERY_TTL_HOURS", "48")),
  },
  safety: {
    // "simulation" (default) — on-chain buy + roundtrip via AlphaRouter (covers V2/V3/V4).
    // "honeypot"             — external honeypot.is API (legacy; coverage gaps on V4).
    provider: optional("SAFETY_PROVIDER", "simulation"),
  },
  // Sniper fanout — when a fresh launch is discovered, N random eligible wallets snipe it,
  // each fired after a random delay in [staggerMin, staggerMax] ms. Universal across all
  // discovery sources (Clanker / Doppler / Virtuals / generic Uniswap) — per-wallet cooldown
  // (sniperState) already prevents cross-source overlap. Defaults preserve pre-v13.13 behavior
  // (1 wallet, immediate fire). v13.15: replaced 8 per-source env vars with a single pair.
  sniper: {
    fanout:    positiveInt(optional("SNIPER_FANOUT", "1"), "SNIPER_FANOUT"),
    staggerMs: parseStaggerRange(optional("SNIPER_FANOUT_STAGGER_MS", "0-0"), "SNIPER_FANOUT_STAGGER_MS"),
    // v13.24 anti-rug: skip a launch snipe when a single EOA already holds more than this % of
    // supply at buy-time. The launch-block sweeper (deployer/MEV bot) loads the bag then dumps on
    // our buy, draining the venue. Validated 2026-06-15: total rugs concentrate ~99% in one EOA;
    // partial-recover snipes ran up to 77% (those are also skipped at the 51 default — i.e. block
    // any majority holder). Venue-agnostic (pools/curves/pairs are contracts) → applies to every
    // sniper source incl. Virtuals bonding-curve self-buys. Set to 100+ to disable.
    maxSupplyConcentrationPct: Number(optional("SNIPER_MAX_SUPPLY_CONCENTRATION_PCT", "51")),
  },
};
