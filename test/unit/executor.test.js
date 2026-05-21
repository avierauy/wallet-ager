import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../src/core/db.js";
import { executeAction } from "../../src/core/executor.js";

// Module bindings from ESM are read-only, so we can't monkey-patch adapter exports. We exercise
// the executor via DRY_RUN (no adapter call ever) and via fetch stubbing for the honeypot.is
// call inside the safety module — full path is covered without touching modules.

const ACCOUNT = { address: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" };
const WALLET = { id: "w-exec-test", account: ACCOUNT, profile: {} };
const TOKEN = {
  address: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00",
  decimals: 18,
  symbol: "TIBBIR",
};
const PLAN_BUY = { dex: "uniswap", side: "buy", token: TOKEN, amountInWei: 10n ** 15n, slippageBps: 50 };

const originalFetch = globalThis.fetch;
const stubFetch = (body, ok = true) => {
  globalThis.fetch = async () => ({ ok, status: ok ? 200 : 503, json: async () => body, text: async () => JSON.stringify(body) });
};
const restoreFetch = () => { globalThis.fetch = originalFetch; };

const resetDb = () => db.exec("DELETE FROM trades; DELETE FROM approvals; DELETE FROM token_safety");

const safeResponse = {
  simulationSuccess: true,
  honeypotResult: { isHoneypot: false },
  simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0 },
  summary: { riskLevel: 1 },
};
const honeypotResponse = {
  simulationSuccess: true,
  honeypotResult: { isHoneypot: true, honeypotReason: "blacklisted seller" },
  simulationResult: { buyTax: 0, sellTax: 100, transferTax: 0 },
  summary: { riskLevel: 9 },
};

describe("executeAction (DRY_RUN env, fetch-stubbed safety)", () => {
  beforeEach(() => { resetDb(); });
  afterEach(restoreFetch);

  test("marks trade 'skipped' and persists reason when safety fails", async () => {
    stubFetch(honeypotResponse);
    const result = await executeAction({ wallet: WALLET, plan: PLAN_BUY });
    assert.equal(result.status, "skipped");
    assert.ok(result.error.includes("honeypot"));
    const row = db.prepare("SELECT * FROM trades WHERE wallet_id = ?").get(WALLET.id);
    assert.equal(row.status, "skipped");
    assert.ok(row.error.includes("honeypot"));
  });

  test("marks trade 'dry-run' when safety passes and DRY_RUN is true", async () => {
    stubFetch(safeResponse);
    const result = await executeAction({ wallet: WALLET, plan: PLAN_BUY });
    assert.equal(result.status, "dry-run");
    const row = db.prepare("SELECT * FROM trades WHERE wallet_id = ?").get(WALLET.id);
    assert.equal(row.status, "dry-run");
    assert.equal(row.tx_hash, null);
  });

  test("persists token_in/token_out correctly for a buy", async () => {
    stubFetch(safeResponse);
    await executeAction({ wallet: WALLET, plan: PLAN_BUY });
    const row = db.prepare("SELECT * FROM trades WHERE wallet_id = ?").get(WALLET.id);
    assert.equal(row.token_in.toLowerCase(), "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    assert.equal(row.token_out.toLowerCase(), TOKEN.address.toLowerCase());
    assert.equal(row.amount_in, PLAN_BUY.amountInWei.toString());
  });
});
