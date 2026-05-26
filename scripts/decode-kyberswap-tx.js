// Direct verification: check the on-chain allowance state right BEFORE the swap tx, on
// CLNK token, for each candidate spender. Whichever has non-zero allowance is the one
// that was authorized to pull the tokens.
import { erc20Abi, parseAbi } from "viem";
import { config } from "../src/config.js";
import { publicClient } from "../src/core/rpc.js";

const TX = (process.argv[2] || "0x1c2034385686e61ab9e22eae8bf95e1eed45c296704e95aecac09f6e1f96e62a").toLowerCase();
const TOKEN = "0x6d0fd889108168111126a068273c8eaf3fce0b07";
const PERMIT2 = config.chain.permit2.toLowerCase();
const KYBERSWAP_ROUTER = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5";
const KYBERSWAP_EXECUTOR_OBSERVED = "0x8f10b468b06c6fd214b65f87778827f7d113f996";
const OKX_ROUTER = "0xc8f6b8ba0dc0f175b568b99440b0867f69a29265";
const UR = config.chain.dexes.uniswap.universalRouter.toLowerCase();

const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

const log = (...a) => console.log(...a);

const main = async () => {
  const tx = await publicClient.getTransaction({ hash: TX });
  const SIGNER = tx.from.toLowerCase();
  const BEFORE = tx.blockNumber - 1n;
  log(`[setup] signer=${SIGNER}`);
  log(`[setup] check allowances at block ${BEFORE} (just before tx ${TX.slice(0, 12)}...)\n`);

  const candidates = [
    { name: "Permit2", addr: PERMIT2 },
    { name: "KyberSwap Router (0x6131...)", addr: KYBERSWAP_ROUTER },
    { name: "KyberSwap Executor (0x8f10...)", addr: KYBERSWAP_EXECUTOR_OBSERVED },
    { name: "OKX Router (0xc8f6...)", addr: OKX_ROUTER },
    { name: "Universal Router (0xfdf6...)", addr: UR },
  ];

  log(`[direct ERC20 allowance] CLNK.allowance(signer, spender):`);
  for (const c of candidates) {
    try {
      const a = await publicClient.readContract({
        address: TOKEN, abi: erc20Abi, functionName: "allowance",
        args: [SIGNER, c.addr],
        blockNumber: BEFORE,
      });
      const status = a > 0n ? "✓ authorized" : "  zero";
      log(`  ${status}  ${c.name}: ${a}`);
    } catch (err) {
      log(`  ERR    ${c.name}: ${err.message}`);
    }
  }

  log(`\n[Permit2.allowance] CLNK in Permit2 for each spender:`);
  for (const c of candidates) {
    if (c.addr === PERMIT2) continue;
    try {
      const [amount, expiration, nonce] = await publicClient.readContract({
        address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance",
        args: [SIGNER, TOKEN, c.addr],
        blockNumber: BEFORE,
      });
      const status = amount > 0n ? "✓ authorized via Permit2" : "  zero in Permit2";
      log(`  ${status}  → ${c.name}: amount=${amount} exp=${expiration} nonce=${nonce}`);
    } catch (err) {
      log(`  ERR    ${c.name}: ${err.message}`);
    }
  }

  // Also dump calldata function selector + first part
  log(`\n[calldata] selector=${tx.input.slice(0, 10)}`);
  log(`[calldata] first 200 chars: ${tx.input.slice(0, 202)}`);
};

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
