import { config } from "../config.js";
import { getTokenSafety, upsertTokenSafety } from "../core/db.js";
import { logger } from "../util/logger.js";

const HONEYPOT_API = "https://api.honeypot.is/v2/IsHoneypot";

// Tunables — adjust via env later if needed.
export const SAFETY_THRESHOLDS = {
  maxBuyTaxPct: 5,
  maxSellTaxPct: 10,
  maxTransferTaxPct: 5,
  cacheTtlMsSafe: 6 * 60 * 60 * 1000, // 6h for safe verdicts
  cacheTtlMsUnsafe: 30 * 60 * 1000,   // 30min for unsafe (allow re-check sooner if token was just deployed)
};

const fetchHoneypotApi = async (token) => {
  const url = new URL(HONEYPOT_API);
  url.searchParams.set("address", token);
  url.searchParams.set("chainID", String(config.chain.chainId));
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) {
    // honeypot.is hasn't indexed this pair yet — common for tokens we discover seconds after
    // pool creation. Distinct from "unreachable" so the caller can treat as PENDING and retry.
    const body = await res.text();
    const e = new Error(`honeypot.is has not indexed this pair yet: ${body}`);
    e.pending = true;
    throw e;
  }
  if (!res.ok) throw new Error(`honeypot.is ${res.status}: ${await res.text()}`);
  return res.json();
};

const evaluateSafety = (apiResult) => {
  const sim = apiResult.simulationResult ?? {};
  const hp = apiResult.honeypotResult ?? {};
  const buyTax = sim.buyTax ?? 0;
  const sellTax = sim.sellTax ?? 0;
  const transferTax = sim.transferTax ?? 0;
  const simulationSuccess = apiResult.simulationSuccess === true;

  const reasons = [];
  if (hp.isHoneypot) reasons.push(`honeypot: ${hp.honeypotReason || "yes"}`);
  if (!simulationSuccess) reasons.push(`simulation failed: ${apiResult.simulationError || "unknown"}`);
  if (buyTax > SAFETY_THRESHOLDS.maxBuyTaxPct) reasons.push(`buyTax ${buyTax}% > ${SAFETY_THRESHOLDS.maxBuyTaxPct}%`);
  if (sellTax > SAFETY_THRESHOLDS.maxSellTaxPct) reasons.push(`sellTax ${sellTax}% > ${SAFETY_THRESHOLDS.maxSellTaxPct}%`);
  if (transferTax > SAFETY_THRESHOLDS.maxTransferTaxPct) reasons.push(`transferTax ${transferTax}% > ${SAFETY_THRESHOLDS.maxTransferTaxPct}%`);

  return {
    safe: reasons.length === 0,
    reasons,
    isHoneypot: !!hp.isHoneypot,
    buyTax,
    sellTax,
    transferTax,
    simulationSuccess,
    riskLevel: apiResult.summary?.riskLevel ?? null,
  };
};

const persistVerdict = (token, verdict, raw) => {
  upsertTokenSafety({
    token,
    chain: config.chain.name,
    is_safe: verdict.safe ? 1 : 0,
    is_honeypot: verdict.isHoneypot ? 1 : 0,
    buy_tax: verdict.buyTax,
    sell_tax: verdict.sellTax,
    transfer_tax: verdict.transferTax,
    simulation_success: verdict.simulationSuccess ? 1 : 0,
    risk_level: verdict.riskLevel,
    raw_response: JSON.stringify(raw),
    checked_at: Date.now(),
  });
};

const cachedVerdict = (token) => {
  const row = getTokenSafety({ token, chain: config.chain.name });
  if (!row) return null;
  const ageMs = Date.now() - row.checked_at;
  const ttl = row.is_safe ? SAFETY_THRESHOLDS.cacheTtlMsSafe : SAFETY_THRESHOLDS.cacheTtlMsUnsafe;
  if (ageMs > ttl) return null;
  return {
    safe: !!row.is_safe,
    reasons: row.is_safe ? [] : ["(cached unsafe verdict)"],
    isHoneypot: !!row.is_honeypot,
    buyTax: row.buy_tax,
    sellTax: row.sell_tax,
    transferTax: row.transfer_tax,
    simulationSuccess: !!row.simulation_success,
    riskLevel: row.risk_level,
    cached: true,
    checkedAt: row.checked_at,
  };
};

// checkToken — used before BUY. Cached.
export const checkToken = async (token) => {
  const cached = cachedVerdict(token);
  if (cached) return cached;
  try {
    const raw = await fetchHoneypotApi(token);
    const verdict = evaluateSafety(raw);
    persistVerdict(token, verdict, raw);
    return { ...verdict, cached: false };
  } catch (err) {
    logger.warn({ err: err.message, token }, "honeypot.is check failed");
    if (err.pending) {
      // Recoverable: the pair just isn't indexed yet. Caller (discovery) should record as
      // PENDING and let the sweeper retry instead of marking unsafe permanently.
      return {
        safe: false,
        pending: true,
        reasons: [err.message],
        isHoneypot: null,
        buyTax: null,
        sellTax: null,
        transferTax: null,
        simulationSuccess: false,
        riskLevel: null,
        cached: false,
      };
    }
    // True failure: API down, 5xx, network error. Stay conservative and don't trade.
    return {
      safe: false,
      reasons: [`honeypot.is unreachable: ${err.message}`],
      isHoneypot: null,
      buyTax: null,
      sellTax: null,
      transferTax: null,
      simulationSuccess: false,
      riskLevel: null,
      cached: false,
    };
  }
};

// checkBeforeSell — fresh check (no cache), to detect rugs since the original buy.
export const checkBeforeSell = async (token) => {
  try {
    const raw = await fetchHoneypotApi(token);
    const verdict = evaluateSafety(raw);
    persistVerdict(token, verdict, raw);
    return { ...verdict, cached: false };
  } catch (err) {
    logger.warn({ err: err.message, token }, "honeypot.is pre-sell check failed");
    // For sells, if the API is down we still TRY — the tx itself will revert if the token is truly unsellable.
    return { safe: true, reasons: ["api-down-allow-attempt"], cached: false };
  }
};
