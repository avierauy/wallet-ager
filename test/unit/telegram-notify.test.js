// Verifies the per-type live toggles and the batch-summary counter math. fetch is stubbed
// so we can assert exactly when (and only when) a message would be dispatched.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const cfg = await import("../../src/config.js");
const tg = await import("../../src/notify/telegram.js");

const originalFetch = globalThis.fetch;
let fetchCalls = [];
const stubFetch = () => {
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), body: init?.body });
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
};
const restoreFetch = () => { globalThis.fetch = originalFetch; };

const setFlags = (overrides) => {
  cfg.config.telegram.enabled = overrides.enabled ?? true;
  cfg.config.telegram.notify = {
    trades: overrides.trades ?? true,
    approves: overrides.approves ?? false,
    errors: overrides.errors ?? true,
  };
  cfg.config.telegram.batchSummaryMin = overrides.batchSummaryMin ?? 0;
  cfg.config.telegram.token = "test-token";
  cfg.config.telegram.chatId = "test-chat";
};

const aTrade = {
  walletId: "w-1", dex: "uniswap", side: "buy",
  txHash: "0x1111", explorer: "https://basescan.org",
  in:  { symbol: "ETH",    decimals: 18, amountWei: 10n ** 15n },
  out: { symbol: "TIBBIR", decimals: 18, amountWei: 10n ** 18n },
};
const anApprove = {
  walletId: "w-1", tokenSymbol: "TIBBIR", decimals: 18, amountWei: 10n ** 18n,
  spender: "0x1234567890123456789012345678901234567890", spenderLabel: "Permit2",
  txHash: "0x2222", explorer: "https://basescan.org",
};
const anError = { walletId: "w-1", dex: "uniswap", error: "boom" };

describe("notify toggles — live behavior", () => {
  beforeEach(() => { stubFetch(); tg._resetEventCounts(); });
  afterEach(restoreFetch);

  test("notifyTrade sends only when trades=true", async () => {
    setFlags({ trades: true });
    await tg.notifyTrade(aTrade);
    assert.equal(fetchCalls.length, 1);

    fetchCalls = [];
    setFlags({ trades: false });
    await tg.notifyTrade(aTrade);
    assert.equal(fetchCalls.length, 0);
  });

  test("notifyApproval sends only when approves=true (default false)", async () => {
    setFlags({ approves: false });
    await tg.notifyApproval(anApprove);
    assert.equal(fetchCalls.length, 0);

    setFlags({ approves: true });
    await tg.notifyApproval(anApprove);
    assert.equal(fetchCalls.length, 1);
  });

  test("notifyError sends only when errors=true", async () => {
    setFlags({ errors: true });
    await tg.notifyError(anError);
    assert.equal(fetchCalls.length, 1);

    fetchCalls = [];
    setFlags({ errors: false });
    await tg.notifyError(anError);
    assert.equal(fetchCalls.length, 0);
  });

  test("nothing fires when telegram.enabled=false, regardless of flags", async () => {
    setFlags({ enabled: false, trades: true, approves: true, errors: true });
    await tg.notifyTrade(aTrade);
    await tg.notifyApproval(anApprove);
    await tg.notifyError(anError);
    assert.equal(fetchCalls.length, 0);
  });
});

describe("notify toggles — batch counters", () => {
  beforeEach(() => { stubFetch(); tg._resetEventCounts(); });
  afterEach(restoreFetch);

  test("counters increment regardless of live flag, when batchSummaryMin > 0", async () => {
    setFlags({ trades: false, approves: false, errors: false, batchSummaryMin: 30 });
    await tg.notifyTrade(aTrade);
    await tg.notifyTrade(aTrade);
    await tg.notifyApproval(anApprove);
    await tg.notifyError(anError);
    assert.deepEqual(tg._getEventCounts(), { trades: 2, approves: 1, errors: 1 });
    // And nothing was dispatched live:
    assert.equal(fetchCalls.length, 0);
  });

  test("counters do NOT increment when batch is disabled (batchSummaryMin=0)", async () => {
    setFlags({ trades: true, batchSummaryMin: 0 });
    await tg.notifyTrade(aTrade);
    await tg.notifyTrade(aTrade);
    assert.deepEqual(tg._getEventCounts(), { trades: 0, approves: 0, errors: 0 });
  });
});

describe("buildBatchMessage", () => {
  test("formats the summary with counts and escapes the interval", () => {
    const text = tg.buildBatchMessage({ trades: 12, approves: 3, errors: 0 }, 30);
    assert.match(text, /\*Summary\* — last 30min/);
    assert.match(text, /trades:\s+12/);
    assert.match(text, /approves:\s+3/);
    assert.match(text, /errors:\s+0/);
  });
});

describe("via: line — token source on trade/error messages", () => {
  beforeEach(() => { stubFetch(); tg._resetEventCounts(); });
  afterEach(restoreFetch);

  const getBodyText = () => {
    const body = JSON.parse(fetchCalls[0].body);
    return body.text;
  };

  test("notifyTrade adds via: line when source matches launchpad prefix", async () => {
    setFlags({ trades: true });
    for (const source of ["clanker-v4", "doppler-bankr", "virtuals-Launched"]) {
      fetchCalls = [];
      await tg.notifyTrade({ ...aTrade, source });
      const text = getBodyText();
      assert.match(text, /\*BUY\* on \*uniswap\*/);
      assert.ok(text.includes(`via: \`${source.replace(/-/g, "\\-")}\``),
        `expected via line for source=${source}, got:\n${text}`);
    }
  });

  test("notifyTrade omits via: line for non-launchpad sources", async () => {
    setFlags({ trades: true });
    for (const source of [undefined, null, "", "uniswap-v4-fee8388608", "manual"]) {
      fetchCalls = [];
      await tg.notifyTrade({ ...aTrade, source });
      const text = getBodyText();
      assert.ok(!/\nvia:/.test(text), `unexpected via line for source=${source}: ${text}`);
    }
  });

  test("notifyError adds via: line when source matches launchpad prefix", async () => {
    setFlags({ errors: true });
    await tg.notifyError({ ...anError, source: "clanker-v4" });
    const text = getBodyText();
    assert.match(text, /\*ERROR\* on \*uniswap\*/);
    assert.ok(text.includes("via: `clanker\\-v4`"), `missing via line: ${text}`);
  });

  test("notifyError omits via: line when source missing", async () => {
    setFlags({ errors: true });
    await tg.notifyError({ ...anError });
    const text = getBodyText();
    assert.ok(!/\nvia:/.test(text), `unexpected via line: ${text}`);
  });
});
