import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = join(tmpdir(), "wallet-ager-test-" + Date.now());
const WALLETS = join(TMP, "wallets.json");

before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Load config first so we can hijack the wallets path per-test.
const cfg = await import("../../src/config.js");
const { loadWallets } = await import("../../src/core/wallets.js");

const writeFile = (obj) => writeFileSync(WALLETS, JSON.stringify(obj, null, 2));

const minimalProfile = {
  activeHoursUtc: [0, 24],
  tradesPerDay: [1, 2],
  amountRangeNativeEth: [0.001, 0.002],
  gasMultiplierRange: [1.0, 1.2],
  slippageBps: [50, 100],
  dexWeights: { uniswap: 100 },
};

const setupFile = () => {
  cfg.config.paths.wallets = WALLETS;
};

describe("loadWallets — new format", () => {
  before(setupFile);

  test("loads bare-PK entries into the 'default' profile with derived ids", () => {
    writeFile({
      profiles: { default: minimalProfile },
      wallets: [
        "0x0000000000000000000000000000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000000000000000000000000000002",
      ],
    });
    const wallets = loadWallets();
    assert.equal(wallets.length, 2);
    assert.ok(wallets[0].id.startsWith("w-"));
    assert.equal(wallets[0].id.length, 10);
    assert.notEqual(wallets[0].id, wallets[1].id);
    assert.deepEqual(wallets[0].profile, minimalProfile);
  });

  test("supports object entries with explicit profile + id + overrides", () => {
    writeFile({
      profiles: {
        default: minimalProfile,
        night: { ...minimalProfile, activeHoursUtc: [22, 6] },
      },
      wallets: [
        {
          privateKey: "0x0000000000000000000000000000000000000000000000000000000000000003",
          id: "vip-001",
          profile: "night",
          overrides: { tradesPerDay: [10, 15] },
        },
      ],
    });
    const [w] = loadWallets();
    assert.equal(w.id, "vip-001");
    assert.deepEqual(w.profile.activeHoursUtc, [22, 6]);
    assert.deepEqual(w.profile.tradesPerDay, [10, 15]);
  });

  test("throws when profiles map lacks 'default' (bare PKs would have nothing to fall back to)", () => {
    writeFile({ profiles: { night: minimalProfile }, wallets: ["0x1".padEnd(66, "0")] });
    assert.throws(() => loadWallets(), /must include a "default" entry/);
  });

  test("throws on unknown profile reference", () => {
    writeFile({
      profiles: { default: minimalProfile },
      wallets: [{ privateKey: "0x0000000000000000000000000000000000000000000000000000000000000007", profile: "ghost" }],
    });
    assert.throws(() => loadWallets(), /unknown profile "ghost"/);
  });

  test("throws on invalid private key", () => {
    writeFile({ profiles: { default: minimalProfile }, wallets: ["0xnotreallyahex"] });
    assert.throws(() => loadWallets(), /invalid private key/);
  });

  test("throws on duplicate explicit id", () => {
    writeFile({
      profiles: { default: minimalProfile },
      wallets: [
        { privateKey: "0x0000000000000000000000000000000000000000000000000000000000000008", id: "x" },
        { privateKey: "0x0000000000000000000000000000000000000000000000000000000000000009", id: "x" },
      ],
    });
    assert.throws(() => loadWallets(), /duplicate wallet id: x/);
  });

  test("throws if a merged profile is missing required fields", () => {
    writeFile({
      profiles: { default: { ...minimalProfile, dexWeights: undefined } },
      wallets: ["0x000000000000000000000000000000000000000000000000000000000000000a"],
    });
    // dexWeights set to undefined still satisfies "in" check; instead omit the field entirely
    writeFile({
      profiles: { default: { activeHoursUtc: [0, 24] } },
      wallets: ["0x000000000000000000000000000000000000000000000000000000000000000b"],
    });
    assert.throws(() => loadWallets(), /missing "tradesPerDay"/);
  });
});
