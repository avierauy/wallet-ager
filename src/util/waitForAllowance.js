import { erc20Abi } from "viem";
import { swapPublicClient as publicClient } from "../core/rpc.js";

const DEFAULT_POLL_MS = 500;
const DEFAULT_TIMEOUT_MS = 15_000;

// Poll `allowance(owner, spender)` on `token` until it reaches `atLeast`. Used right after a
// successful approve receipt to guard against RPC load-balancers serving a stale view of state
// on the immediately following tx (the SliceOutOfBounds / "insufficient allowance" race we hit
// on Virtuals trades).
export const waitForAllowance = async ({
  owner,
  token,
  spender,
  atLeast,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  client = publicClient,
}) => {
  if (atLeast === 0n) return 0n; // nothing to wait for
  const deadline = Date.now() + timeoutMs;
  let last = 0n;
  while (true) {
    last = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    });
    if (last >= atLeast) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForAllowance timeout: ${token}→${spender} stayed at ${last} after ${timeoutMs}ms (needed ${atLeast})`
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
};
