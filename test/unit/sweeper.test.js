import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../src/core/db.js";
import {
  _listAll,
  _resetStaticCache,
  add,
  getActive,
  STATUS,
} from "../../src/core/tokenRegistry.js";

const rpc = await import("../../src/core/rpc.js");
const { sweepOnce } = await import("../../src/discovery/sweeper.js");

const VIRT_TOKEN = "0x" + "1".repeat(40);
const UNI_TOKEN = "0x" + "2".repeat(40);
const STALE_TOKEN = "0x" + "3".repeat(40);

const originalRead = rpc.publicClient.readContract;
const originalFetch = globalThis.fetch;
const restore = () => {
  rpc.publicClient.readContract = originalRead;
  globalThis.fetch = originalFetch;
};

const stubVirtualsSafety = (pct) => {
  // safetyRoundtripPct: total roundtrip loss as a percentage.
  // checkBondingCurve makes two getAmountsOut calls; return half the loss per call.
  rpc.publicClient.readContract = async ({ functionName, args }) => {
    if (functionName === "getAmountsOut") {
      const amountIn = args[2];
      return (amountIn * BigInt(Math.floor(100 - pct / 2))) / 100n;
    }
    throw new Error("unexpected: " + functionName);
  };
};

const stubHoneypot = (verdict) => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => verdict, text: async () => JSON.stringify(verdict),
  });
};
const safeVerdict = {
  simulationSuccess: true,
  honeypotResult: { isHoneypot: false },
  simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0 },
};
const honeypotVerdict = {
  simulationSuccess: true,
  honeypotResult: { isHoneypot: true, honeypotReason: "blacklisted" },
  simulationResult: { buyTax: 0, sellTax: 100, transferTax: 0 },
};

const seedToken = (overrides) =>
  add({
    address: overrides.address,
    symbol: overrides.symbol ?? "TKN",
    decimals: 18,
    tradeableOn: overrides.tradeableOn,
    virtualsState: overrides.virtualsState ?? null,
    source: overrides.source ?? "test",
    status: STATUS.ACTIVE,
  });

const setActivity = ({ address, discoveredAt, lastTradedAt }) => {
  db.prepare(
    `UPDATE discovered_tokens SET discovered_at = ?, last_traded_at = ? WHERE address = ?`
  ).run(discoveredAt, lastTradedAt, address);
};

describe("sweeper", () => {
  beforeEach(() => {
    db.exec("DELETE FROM discovered_tokens; DELETE FROM token_safety");
    _resetStaticCache();
  });
  afterEach(restore);

  test("TTL: an idle token (no trades, past ttl) is evicted to EXPIRED", async () => {
    seedToken({ address: STALE_TOKEN, tradeableOn: ["uniswap"] });
    const now = Date.now();
    setActivity({ address: STALE_TOKEN, discoveredAt: now - 80 * 60 * 60 * 1000, lastTradedAt: null });

    const summary = await sweepOnce({ now, ttlHours: 48 });
    assert.equal(summary.expired, 1);
    assert.equal(summary.rechecked, 0);
    assert.ok(!getActive().some((t) => t.address.toLowerCase() === STALE_TOKEN.toLowerCase()));
  });

  test("TTL: a recently traded token is NOT evicted, gets re-checked", async () => {
    seedToken({ address: UNI_TOKEN, tradeableOn: ["uniswap"] });
    const now = Date.now();
    setActivity({ address: UNI_TOKEN, discoveredAt: now - 100 * 60 * 60 * 1000, lastTradedAt: now - 30 * 60 * 1000 });
    stubHoneypot(safeVerdict);

    const summary = await sweepOnce({ now, ttlHours: 48 });
    assert.equal(summary.expired, 0);
    assert.equal(summary.rechecked, 1);
    assert.ok(getActive().some((t) => t.address.toLowerCase() === UNI_TOKEN.toLowerCase()));
  });

  test("re-safety: token now flagged honeypot is marked UNSAFE", async () => {
    seedToken({ address: UNI_TOKEN, tradeableOn: ["uniswap"] });
    const now = Date.now();
    setActivity({ address: UNI_TOKEN, discoveredAt: now - 1000, lastTradedAt: now - 500 });
    stubHoneypot(honeypotVerdict);

    const summary = await sweepOnce({ now });
    assert.equal(summary.markedUnsafe, 1);
    assert.ok(!getActive().some((t) => t.address.toLowerCase() === UNI_TOKEN.toLowerCase()));
  });

  test("dispatches by tradeableOn: virtuals tokens use bonding curve probe", async () => {
    seedToken({
      address: VIRT_TOKEN,
      tradeableOn: ["virtuals"],
      virtualsState: "pre-graduation",
    });
    const now = Date.now();
    setActivity({ address: VIRT_TOKEN, discoveredAt: now - 1000, lastTradedAt: now - 500 });
    stubVirtualsSafety(2); // 2% loss → safe

    const summary = await sweepOnce({ now });
    assert.equal(summary.rechecked, 1);
    assert.ok(getActive().some((t) => t.address.toLowerCase() === VIRT_TOKEN.toLowerCase()));
  });

  test("dispatches by tradeableOn: a virtuals token that drained gets UNSAFE", async () => {
    seedToken({
      address: VIRT_TOKEN,
      tradeableOn: ["virtuals"],
      virtualsState: "pre-graduation",
    });
    const now = Date.now();
    setActivity({ address: VIRT_TOKEN, discoveredAt: now - 1000, lastTradedAt: now - 500 });
    stubVirtualsSafety(90); // 90% loss → unsafe

    const summary = await sweepOnce({ now });
    assert.equal(summary.markedUnsafe, 1);
  });
});
