import { maxUint160, parseAbi } from "viem";
import { publicClient } from "../core/rpc.js";
import { config } from "../config.js";

const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

const PERMIT_TYPES = {
  PermitSingle: [
    { name: "details", type: "PermitDetails" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
};

const PERMIT_EXPIRATION_SECS = 30n * 24n * 60n * 60n; // 30 days, matches Uniswap UI default
const SIG_DEADLINE_SECS = 30n * 60n; // 30 min

export const readPermit2Nonce = async ({ owner, token, spender }) => {
  const [, , nonce] = await publicClient.readContract({
    address: config.chain.permit2,
    abi: PERMIT2_ABI,
    functionName: "allowance",
    args: [owner, token, spender],
  });
  return nonce;
};

export const signPermitSingle = async ({ walletClient, account, token, spender }) => {
  const nonce = await readPermit2Nonce({ owner: account.address, token, spender });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const permit = {
    details: {
      token,
      amount: maxUint160,
      expiration: Number(now + PERMIT_EXPIRATION_SECS),
      nonce: Number(nonce),
    },
    spender,
    sigDeadline: now + SIG_DEADLINE_SECS,
  };
  const signature = await walletClient.signTypedData({
    account,
    domain: {
      name: "Permit2",
      chainId: config.chain.chainId,
      verifyingContract: config.chain.permit2,
    },
    types: PERMIT_TYPES,
    primaryType: "PermitSingle",
    message: permit,
  });
  return { permit, signature };
};

