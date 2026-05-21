// Safety dispatcher. Picks the provider configured via SAFETY_PROVIDER (default: simulation).
// Discovery handlers, the sweeper, and the executor's pre-trade check all go through here.
import { config } from "../config.js";
import * as honeypot from "./honeypot.js";
import * as simulation from "./simulation.js";

const isHoneypot = () => config.safety.provider === "honeypot";

export const checkToken = (token) =>
  isHoneypot() ? honeypot.checkToken(token) : simulation.checkToken(token);

export const checkBeforeSell = (token) =>
  isHoneypot() ? honeypot.checkBeforeSell(token) : simulation.checkBeforeSell(token);

// Re-export the virtuals-specific check unchanged — it's an on-chain bonding-curve probe
// that doesn't depend on the configured external provider.
export { checkBondingCurve } from "./virtuals.js";
