import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { inc, recordTickDuration, reset, snapshot } from "../../src/util/metrics.js";

describe("metrics", () => {
  beforeEach(reset);

  test("inc + snapshot groups by event, flattens labels", () => {
    inc("trade", { dex: "uniswap", side: "buy", status: "submitted" });
    inc("trade", { dex: "uniswap", side: "buy", status: "submitted" });
    inc("trade", { dex: "uniswap", side: "sell", status: "submitted" });
    inc("trade", { dex: "bankr", side: "buy", status: "failed" });
    inc("safety", { verdict: "safe", cached: "yes" });

    const s = snapshot();
    assert.ok(s.events.trade);
    assert.ok(s.events.safety);

    const buyBucket = s.events.trade.find(
      (e) => e.dex === "uniswap" && e.side === "buy" && e.status === "submitted"
    );
    assert.equal(buyBucket.count, 2);

    const sellBucket = s.events.trade.find((e) => e.side === "sell");
    assert.equal(sellBucket.count, 1);
  });

  test("counts are isolated by full label combination", () => {
    inc("trade", { dex: "uniswap" });
    inc("trade", { dex: "bankr" });
    const s = snapshot();
    assert.equal(s.events.trade.length, 2);
  });

  test("recordTickDuration produces percentiles", () => {
    for (let i = 1; i <= 100; i++) recordTickDuration(i * 10);
    const s = snapshot();
    assert.equal(s.ticks.n, 100);
    assert.ok(s.ticks.p50Ms >= 500 && s.ticks.p50Ms <= 510);
    assert.ok(s.ticks.p95Ms >= 950 && s.ticks.p95Ms <= 960);
    assert.equal(s.ticks.maxMs, 1000);
  });

  test("snapshot.ticks is null when no samples recorded", () => {
    const s = snapshot();
    assert.equal(s.ticks, null);
  });

  test("reset clears counters and durations", () => {
    inc("trade");
    recordTickDuration(50);
    reset();
    const s = snapshot();
    assert.deepEqual(s.events, {});
    assert.equal(s.ticks, null);
  });
});
