import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isExpiredFilterError, logWatcherError } from "../../src/util/watcherErrors.js";

describe("watcherErrors", () => {
  test("isExpiredFilterError matches the Infura expired-filter message", () => {
    const err = new Error(
      "Requested resource not found.\n\nURL: https://base-mainnet.infura.io/v3/abc\nRequest body: {\"method\":\"eth_getFilterChanges\",\"params\":[\"0x10ff...\"]}\n\nDetails: resource not found\nVersion: viem@2.50.4"
    );
    assert.equal(isExpiredFilterError(err), true);
  });

  test("isExpiredFilterError ignores unrelated errors", () => {
    assert.equal(isExpiredFilterError(new Error("ECONNRESET")), false);
    assert.equal(isExpiredFilterError(new Error("Internal JSON-RPC error")), false);
    assert.equal(isExpiredFilterError(new Error("Requested resource not found")), false); // missing method tag
  });

  test("isExpiredFilterError tolerates non-Error inputs", () => {
    assert.equal(isExpiredFilterError(null), false);
    assert.equal(isExpiredFilterError(undefined), false);
    assert.equal(isExpiredFilterError("some string"), false);
  });

  test("logWatcherError downgrades expired filters to warn", () => {
    const calls = [];
    const fakeLogger = {
      warn: (obj, msg) => calls.push({ level: "warn", obj, msg }),
      error: (obj, msg) => calls.push({ level: "error", obj, msg }),
    };
    const err = new Error("Requested resource not found\nRequest body: {\"method\":\"eth_getFilterChanges\"}");
    const level = logWatcherError(fakeLogger, err, "test: watcher error");
    assert.equal(level, "warn");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].level, "warn");
    assert.ok(calls[0].msg.includes("recoverable"));
  });

  test("logWatcherError keeps unknown errors at error level", () => {
    const calls = [];
    const fakeLogger = {
      warn: (obj, msg) => calls.push({ level: "warn", obj, msg }),
      error: (obj, msg) => calls.push({ level: "error", obj, msg }),
    };
    const level = logWatcherError(fakeLogger, new Error("ECONNRESET"), "test: watcher error");
    assert.equal(level, "error");
    assert.equal(calls[0].level, "error");
    assert.equal(calls[0].msg, "test: watcher error");
  });
});
