// Typed errors that the executor recognizes and routes to non-failure outcomes.
//
// SkipExecution: thrown by adapters when a pre-flight check determines the trade can't
// usefully proceed and the executor should treat the call as a clean skip — same outcome
// surface as a safety-check rejection (status="skipped", no Telegram error, no daily slot
// consumed). Use for cases where retrying would not change the outcome and broadcasting
// is wasteful (e.g., planned amount below the adapter's minimum viable size).

export class SkipExecution extends Error {
  constructor(message) {
    super(message);
    this.name = "SkipExecution";
  }
}

// OnChainRevert: thrown by adapters when a broadcast tx confirms with status="reverted".
// The executor catches this and marks the trade as `reverted` (not `failed`) so we can
// distinguish on-chain reverts from RPC/network failures. Carries the txHash for forensics.
//
// Important contract: this is NOT a transient error — withRetry will NOT retry it (the same
// calldata would revert again with the same on-chain state). Retry is the caller's choice
// at a higher level (e.g., the sniper sell scheduler retries sells with a slippage bump).
export class OnChainRevert extends Error {
  constructor({ txHash, gasUsed, reason }) {
    super(`tx reverted on-chain (hash=${txHash}, gasUsed=${gasUsed}${reason ? `, reason=${reason}` : ""})`);
    this.name = "OnChainRevert";
    this.txHash = txHash;
    this.gasUsed = gasUsed;
    this.reason = reason ?? null;
  }
}
