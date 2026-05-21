// Token registry — merges the static set (config/tokens.json) with the runtime-discovered set
// persisted in discovered_tokens. The planner queries getActive() once per tick so newly added
// tokens become tradeable immediately without restarting the daemon.
//
// Static tokens are authoritative. If the same address exists both in tokens.json and in the
// discovered table, the static entry wins (the json reflects an operator's deliberate choice).
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import {
  listDiscoveredTokens,
  setDiscoveredTokenStatus,
  touchDiscoveredSafetyAt,
  touchDiscoveredTradedAt,
  upsertDiscoveredToken,
} from "./db.js";
import { loadTokens } from "./tokens.js";

const ACTIVE = "active";
const UNSAFE = "unsafe";
const EXPIRED = "expired";
const PENDING = "pending";

const parseTradeable = (s) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const rowToToken = (row) => ({
  address: row.address,
  symbol: row.symbol ?? "?",
  decimals: row.decimals,
  tradeableOn: parseTradeable(row.tradeable_on),
  ...(row.virtuals_state ? { virtualsState: row.virtuals_state } : {}),
  // expose source for the planner / metrics; static tokens don't carry one
  source: row.source,
  discoveredAt: row.discovered_at,
  lastTradedAt: row.last_traded_at,
  safetyCheckedAt: row.safety_checked_at,
});

let staticTokens = null;
const getStatic = () => {
  if (!staticTokens) staticTokens = loadTokens();
  return staticTokens;
};

// Tests can call this after manipulating tokens.json to force a reload.
export const _resetStaticCache = () => { staticTokens = null; };

// Read-side: full merged list for the planner. Filters expired or unsafe rows.
export const getActive = ({ chain = config.chain.name } = {}) => {
  const stat = getStatic();
  const staticAddrs = new Set(stat.map((t) => t.address.toLowerCase()));
  const discovered = listDiscoveredTokens({ chain, status: ACTIVE })
    .map(rowToToken)
    .filter((t) => !staticAddrs.has(t.address.toLowerCase()));
  return [...stat, ...discovered];
};

// Add or refresh a discovered token. Caller is responsible for safety checks before calling
// with status=active; passing status=pending records the discovery without making it tradeable.
export const add = ({
  address,
  symbol,
  decimals,
  tradeableOn,
  virtualsState,
  source,
  status = ACTIVE,
  ttlExpiresAt = null,
  chain = config.chain.name,
}) => {
  if (!address) throw new Error("tokenRegistry.add: address is required");
  if (!Array.isArray(tradeableOn) || tradeableOn.length === 0) {
    throw new Error("tokenRegistry.add: tradeableOn must be a non-empty array");
  }
  upsertDiscoveredToken({
    address,
    chain,
    symbol: symbol ?? null,
    decimals: Number(decimals),
    tradeable_on: JSON.stringify(tradeableOn),
    virtuals_state: virtualsState ?? null,
    source,
    status,
    discovered_at: Date.now(),
    safety_checked_at: status === ACTIVE ? Date.now() : null,
    last_traded_at: null,
    ttl_expires_at: ttlExpiresAt,
  });
  logger.info(
    { address, symbol, source, status, tradeableOn },
    "token added to registry"
  );
};

export const markUnsafe = ({ address, chain = config.chain.name, reason }) => {
  setDiscoveredTokenStatus({ address, chain, status: UNSAFE });
  logger.warn({ address, reason }, "token marked unsafe");
};

export const markExpired = ({ address, chain = config.chain.name, reason }) => {
  setDiscoveredTokenStatus({ address, chain, status: EXPIRED });
  logger.info({ address, reason }, "token expired from registry");
};

// Called by the executor after a successful submit. Static tokens are silently no-op'd
// (UPDATE matches zero rows). Used by the sweeper to compute TTL eviction.
export const markTraded = ({ address, chain = config.chain.name, at = Date.now() }) => {
  touchDiscoveredTradedAt({ address, chain, at });
};

// Called by the sweeper after a successful re-safety probe to push out the next check.
export const refreshSafetyChecked = ({ address, chain = config.chain.name, at = Date.now() }) => {
  touchDiscoveredSafetyAt({ address, chain, at });
};

// Test-friendly helper to inspect all rows regardless of status.
export const _listAll = ({ chain = config.chain.name } = {}) =>
  listDiscoveredTokens({ chain }).map(rowToToken);

export const STATUS = { ACTIVE, UNSAFE, EXPIRED, PENDING };
