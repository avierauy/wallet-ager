import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";

export const loadTokens = () => {
  const path = resolve(config.paths.tokens);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw.tokens)) throw new Error(`${path}: expected { tokens: [...] }`);
  return raw.tokens;
};
