import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { escapeMd } from "../../src/notify/telegram.js";

describe("telegram MarkdownV2 escaping", () => {
  test("escapes all reserved characters", () => {
    const input = "_*[]()~`>#+-=|{}.!";
    const out = escapeMd(input);
    for (const ch of input) {
      assert.ok(out.includes(`\\${ch}`), `missing escape for "${ch}" in: ${out}`);
    }
  });

  test("leaves regular characters intact", () => {
    assert.equal(escapeMd("hola mundo 123"), "hola mundo 123");
  });

  test("handles non-string input via String()", () => {
    assert.equal(escapeMd(42), "42");
    assert.equal(escapeMd(0n), "0");
  });
});
