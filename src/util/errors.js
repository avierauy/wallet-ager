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
