import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { maxEOAHolderFraction } from "../../src/safety/supplyConcentration.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const POOL = "0x498581fF718922c3f8e6A244956aF099B2652b2b"; // a contract (venue)
const CONDUIT = "0x63D2DfEA64b3433f4071a98665bcd7ca14d93496"; // a contract (Clanker conduit)
const SMART = "0x00000000000000000000000000000000c0000001"; // a contract holder (smart-wallet sweep)
const SWEEPER = "0x1af9109c7e37446a7eee48f5d1d01e58a2714414"; // EOA
const A = "0x00000000000000000000000000000000000000aa"; // EOA
const B = "0x00000000000000000000000000000000000000bb"; // EOA

const CONTRACTS = new Set([POOL, CONDUIT, SMART].map((a) => a.toLowerCase()));
const ev = (blk, from, to, value) => ({ blockNumber: BigInt(blk), args: { from, to, value: BigInt(value) } });

const mockClient = ({ supply, head, transfers }) => ({
  readContract: async () => (supply === null ? 0n : BigInt(supply)),
  getBlockNumber: async () => BigInt(head),
  getLogs: async ({ args, fromBlock, toBlock }) => {
    let evs = transfers.filter((t) => t.blockNumber >= fromBlock && t.blockNumber <= toBlock);
    if (args && args.from) evs = evs.filter((t) => t.args.from.toLowerCase() === args.from.toLowerCase());
    return evs;
  },
  getBytecode: async ({ address }) => (CONTRACTS.has(address.toLowerCase()) ? "0x60806040" : "0x"),
});

const run = (cfg) => maxEOAHolderFraction({ publicClient: mockClient(cfg), tokenAddress: "0xtok" });

describe("maxEOAHolderFraction", () => {
  test("rug: one EOA swept ~all supply → ~0.99", async () => {
    const frac = await run({ supply: 100, head: 12, transfers: [ev(10, ZERO, POOL, 100), ev(11, POOL, SWEEPER, 99)] });
    assert.ok(frac > 0.98 && frac <= 1.0, `expected ~0.99, got ${frac}`);
  });

  test("healthy: supply mostly in the pool (a contract), small EOA buyers → low", async () => {
    const frac = await run({ supply: 100, head: 12, transfers: [ev(10, ZERO, POOL, 100), ev(11, POOL, A, 5), ev(11, POOL, B, 7)] });
    assert.ok(frac < 0.10, `expected <0.10, got ${frac}`);
  });

  test("pool (contract) holds everything → no EOA concentration → 0", async () => {
    const frac = await run({ supply: 100, head: 12, transfers: [ev(10, ZERO, POOL, 100)] });
    assert.equal(frac, 0);
  });

  test("contract holders are skipped; the largest EOA is returned even if a contract holds more", async () => {
    // SMART (contract) holds 70%, A (EOA) holds 30% → max EOA is 30%, not 70%.
    const frac = await run({ supply: 100, head: 12, transfers: [ev(10, ZERO, POOL, 100), ev(11, POOL, SMART, 70), ev(11, POOL, A, 30)] });
    assert.ok(frac > 0.29 && frac < 0.31, `expected ~0.30, got ${frac}`);
  });

  test("clanker conduits net to ~0 and never count as a holder", async () => {
    const frac = await run({ supply: 100, head: 12, transfers: [
      ev(10, ZERO, CONDUIT, 100), ev(10, CONDUIT, POOL, 100), // pass-through nets to 0
      ev(11, POOL, SWEEPER, 90),
    ] });
    assert.ok(frac > 0.89 && frac < 0.91, `expected ~0.90, got ${frac}`);
  });

  test("no mint within range → null (fail-open)", async () => {
    const frac = await run({ supply: 100, head: 12, transfers: [ev(11, POOL, A, 5)] });
    assert.equal(frac, null);
  });

  test("zero supply → null", async () => {
    const frac = await run({ supply: null, head: 12, transfers: [ev(10, ZERO, POOL, 100)] });
    assert.equal(frac, null);
  });
});
