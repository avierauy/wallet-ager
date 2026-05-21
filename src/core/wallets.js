import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";

const REQUIRED_PROFILE_FIELDS = [
  "activeHoursUtc",
  "tradesPerDay",
  "amountRangeNativeEth",
  "gasMultiplierRange",
  "slippageBps",
  "dexWeights",
];

// Accept both "0x…" and bare 64-char hex (common when exporting from some wallets).
const PK_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const normalizePk = (pk) => (pk.startsWith("0x") ? pk : "0x" + pk);

const deriveId = (address) => `w-${address.slice(2, 10).toLowerCase()}`;

const validateProfile = (p, ctx) => {
  for (const k of REQUIRED_PROFILE_FIELDS) {
    if (!(k in p)) throw new Error(`profile for ${ctx} is missing "${k}"`);
  }
};

export const loadWallets = () => {
  const path = resolve(config.paths.wallets);
  const raw = JSON.parse(readFileSync(path, "utf8"));

  if (!raw.profiles || typeof raw.profiles !== "object") {
    throw new Error(`${path}: missing "profiles" object`);
  }
  if (!Array.isArray(raw.wallets)) {
    throw new Error(`${path}: "wallets" must be an array`);
  }
  if (!("default" in raw.profiles)) {
    throw new Error(`${path}: profiles must include a "default" entry (used by bare-PK wallets)`);
  }

  const seen = new Set();

  return raw.wallets.map((entry, idx) => {
    const isBarePk = typeof entry === "string";
    const rawPk = isBarePk ? entry : entry?.privateKey;
    if (!rawPk || !PK_RE.test(rawPk)) {
      throw new Error(`wallets[${idx}] has invalid private key`);
    }
    const account = privateKeyToAccount(normalizePk(rawPk));

    const profileName = isBarePk ? "default" : entry.profile ?? "default";
    if (!(profileName in raw.profiles)) {
      throw new Error(`wallets[${idx}] references unknown profile "${profileName}"`);
    }
    const id = isBarePk ? deriveId(account.address) : entry.id ?? deriveId(account.address);
    if (seen.has(id)) throw new Error(`duplicate wallet id: ${id}`);
    seen.add(id);

    const overrides = isBarePk ? {} : entry.overrides ?? {};
    const profile = { ...raw.profiles[profileName], ...overrides };
    validateProfile(profile, `${id} (profile=${profileName})`);

    return { id, account, profile };
  });
};
