// submitAndConfirm — universal wrapper for "broadcast a tx and verify it succeeded on-chain".
//
// Before v13.17 our adapters submitted via wallet.sendTransaction/writeContract and returned
// the txHash without waiting for the receipt. That caused false positives: a tx that
// reverted on-chain (e.g. slippage on a fresh launch) was logged as "trade completed" with
// daily-cap and Telegram side-effects applied — observed in v13.16 live validation.
//
// This helper centralizes:
//   1. Broadcast (sendTransaction or writeContract depending on shape)
//   2. waitForTransactionReceipt with a bounded timeout
//   3. status check → throw OnChainRevert on reverted, return { hash, gasUsed } on success
//
// Use this for every swap broadcast across all adapters. Approval txs already follow this
// pattern (waitForTransactionReceipt + recordApproval) so they can also adopt it for
// consistency, though they typically revert in less interesting ways.
import { OnChainRevert } from "./errors.js";

// Bounded receipt wait. Base block time is ~2s; 60s covers ~30 blocks of confirmation
// latency or any single RPC hiccup. Longer would mostly mean the tx never lands and our
// caller needs to handle that as a separate failure mode (currently surfaces as the
// underlying viem timeout error).
const DEFAULT_TIMEOUT_MS = 60_000;

export const submitAndConfirm = async ({
  publicClient,
  walletClient,
  tx,                 // either { to, data, value } for raw sendTransaction
                      // or { address, abi, functionName, args } for writeContract
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  const isContractCall = tx.abi && tx.functionName;
  const hash = isContractCall
    ? await walletClient.writeContract(tx)
    : await walletClient.sendTransaction(tx);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  if (receipt.status === "reverted") {
    throw new OnChainRevert({ txHash: hash, gasUsed: receipt.gasUsed });
  }
  return { hash, gasUsed: receipt.gasUsed, receipt };
};
