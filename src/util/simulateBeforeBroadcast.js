// simulateBeforeBroadcast — universal eth_call pre-flight for any swap tx.
//
// Pattern: before sending a tx that might revert at the hook level (Clanker MEV hook
// anti-snipe window, V4 hook gating, transfer-tax tokens, etc.), simulate it via
// publicClient.call(). If the simulation reverts, throw PreSimulationRevert and let the
// caller decide what to do. No gas wasted on doomed txs.
//
// Discovered necessity: v13.16 added this pattern for Clanker buys (inline in
// clankerAggregator.simulateOrThrow). v13.18 generalizes to ALL swap paths (mirror of
// the v13.17 universal submitAndConfirm).
import { PreSimulationRevert } from "./errors.js";

// Best-effort revert reason extraction from viem's error shape. Returns short, safe-to-log.
const extractReason = (err) => {
  const msg = String(err.shortMessage ?? err.message ?? err);
  return msg.slice(0, 150);
};

export const simulateBeforeBroadcast = async ({ publicClient, account, tx }) => {
  try {
    await publicClient.call({
      account,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
    });
  } catch (err) {
    throw new PreSimulationRevert({
      reason: extractReason(err),
      target: tx.to,
    });
  }
};
