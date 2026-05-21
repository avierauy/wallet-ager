import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

// Static token list. Optional — the daemon runs on pure discovery if this file is absent
// (the registry merges in any discovered_tokens with status=active). An explicit file lets
// the operator pin a curated set that's always tradeable regardless of discovery.
export const loadTokens = () => {
  const path = resolve(config.paths.tokens);
  if (!existsSync(path)) {
    logger.info({ path }, "tokens config not found — running with discovery-only set");
    return [];
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw.tokens)) throw new Error(`${path}: expected { tokens: [...] }`);
  return raw.tokens;
};
