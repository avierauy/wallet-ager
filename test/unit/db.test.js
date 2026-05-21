import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  db,
  recordApproval,
  hasApproval,
  insertTrade,
  updateTrade,
} from "../../src/core/db.js";

const reset = () => {
  db.exec("DELETE FROM trades; DELETE FROM approvals; DELETE FROM wallet_state");
};

describe("sqlite persistence", () => {
  beforeEach(reset);

  test("recordApproval + hasApproval are case-insensitive on addresses", () => {
    recordApproval({
      wallet_id: "w001",
      token: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
      spender: "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
      tx_hash: "0xdeadbeef",
      granted_at: 1234567890,
    });
    assert.ok(
      hasApproval({
        wallet_id: "w001",
        token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        spender: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      })
    );
  });

  test("recordApproval is idempotent (REPLACE on conflict)", () => {
    const row = {
      wallet_id: "w001",
      token: "0x1111111111111111111111111111111111111111",
      spender: "0x2222222222222222222222222222222222222222",
      tx_hash: "0x01",
      granted_at: 1,
    };
    recordApproval(row);
    recordApproval({ ...row, tx_hash: "0x02", granted_at: 2 });
    const count = db.prepare("SELECT count(*) as n FROM approvals").get().n;
    assert.equal(count, 1);
  });

  test("insertTrade returns id, updateTrade patches fields", () => {
    const id = insertTrade({
      wallet_id: "w001",
      dex: "uniswap",
      side: "buy",
      token_in: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      token_out: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00",
      amount_in: "1000000000000000",
      amount_out_min: "0",
      status: "pending",
      created_at: 1,
    });
    assert.ok(typeof id === "number" || typeof id === "bigint");

    updateTrade(id, { status: "confirmed", tx_hash: "0xfeed", confirmed_at: 2 });
    const row = db.prepare("SELECT * FROM trades WHERE id = ?").get(id);
    assert.equal(row.status, "confirmed");
    assert.equal(row.tx_hash, "0xfeed");
    assert.equal(row.confirmed_at, 2);
  });
});
