import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readPermit2Nonce } from "../../src/util/permit2.js";

// Random unused address — nonce must be 0 because nothing has been permitted.
const FRESH = "0x000000000000000000000000000000000000dEaD";
const TIBBIR = "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00";
const UR = "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7";

describe("Permit2 allowance read (Base mainnet)", () => {
  test("a never-permitted (owner, token, spender) triple returns nonce 0", async () => {
    const nonce = await readPermit2Nonce({ owner: FRESH, token: TIBBIR, spender: UR });
    assert.equal(nonce, 0);
  });
});
