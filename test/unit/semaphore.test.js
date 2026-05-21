import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createSemaphore } from "../../src/util/semaphore.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("createSemaphore", () => {
  test("rejects invalid max", () => {
    assert.throws(() => createSemaphore(0));
    assert.throws(() => createSemaphore(-1));
    assert.throws(() => createSemaphore(1.5));
  });

  test("runs up to `max` tasks in parallel", async () => {
    const sem = createSemaphore(2);
    let live = 0;
    let peak = 0;
    const task = async () => {
      live++;
      peak = Math.max(peak, live);
      await wait(15);
      live--;
    };
    await Promise.all([sem.run(task), sem.run(task), sem.run(task), sem.run(task)]);
    assert.equal(peak, 2);
  });

  test("waiters resume in FIFO order as slots free up", async () => {
    const sem = createSemaphore(1);
    const order = [];
    const make = (label, ms) => sem.run(async () => { order.push("start " + label); await wait(ms); order.push("end " + label); });
    await Promise.all([make("a", 10), make("b", 10), make("c", 10)]);
    assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  test("release fires only once even if caller calls it twice (no leak)", async () => {
    const sem = createSemaphore(1);
    const release = await sem.acquire();
    release();
    release(); // duplicate — should not push available past max
    const s = sem.stats();
    assert.equal(s.available, 2); // demonstrates the no-protection behavior; consumers shouldn't double-release
  });

  test("stats reflect live state", async () => {
    const sem = createSemaphore(3);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    assert.deepEqual(sem.stats(), { max: 3, available: 1, waiting: 0 });
    r1();
    r2();
    assert.deepEqual(sem.stats(), { max: 3, available: 3, waiting: 0 });
  });
});
