import { parseAbiItem } from "viem";

// Anti-rug signal for fresh launchpad snipes (any venue). The launch-block sweeper — the deployer
// or a bundled MEV bot — grabs the float at the floor price in the deploy block, lets buyers pump,
// then dumps the whole bag, draining the venue so later sellers recover ~0. The tell is visible
// BEFORE we buy: a single externally-owned account already holds the vast majority of supply.
// Validated on the 2026-06-15 Clanker cycle: rug round-trips showed ~99% concentration in one EOA;
// recoverable ones stayed ≤77%.
//
// Why "largest EOA" and not "largest non-pool address": the liquidity venue is ALWAYS a contract —
// the V4 PoolManager (clanker/doppler/uniswap-v4), a Virtuals bonding pair, a V2/V3 pair — and so
// are Clanker's launch conduits. Restricting to EOAs excludes every venue source-agnostically, so
// we don't have to know each launchpad's venue address. This is what lets the same check cover
// Virtuals (a deployer self-buy on the bonding curve is an EOA holding most of the float) without
// special-casing it.
//
// KNOWN LIMITATION — this is a stopgap, not the definitive solution. The EOA filter works only
// because the confirmed sweepers self-snipe from plain EOAs. A deployer who sweeps via a CONTRACT
// wallet — a Gnosis Safe, an ERC-4337 smart account, or a custom bot contract — is indistinguishable
// here from a liquidity venue (also a contract) and slips through. The definitive fix needs a
// positive identification of the real liquidity venue per source (V4 PoolManager / Virtuals bonding
// pair / V2-V3 pair) so we can measure concentration in ANY non-venue holder, EOA or contract.
// Tracked as a follow-up; revisit if contract-wallet sweeps start showing up in the rug tail.

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const TOTAL_SUPPLY = parseAbiItem("function totalSupply() view returns (uint256)");
const ZERO = "0x0000000000000000000000000000000000000000";
const MINT_LOOKBACK = 10_000n; // ~5.5h on Base — fresh snipes mint ~7 blocks back; bounds the scan
const CHUNK = 800n;
const TOP_N_TO_CLASSIFY = 6; // only probe bytecode for the largest few holders

// Returns the fraction [0,1] of total supply held by the largest single EOA, or null if it can't
// be determined (RPC error, zero supply, or no mint within MINT_LOOKBACK — caller should fail-open
// rather than block on an indeterminate result).
export const maxEOAHolderFraction = async ({ publicClient, tokenAddress }) => {
  const supply = await publicClient.readContract({ address: tokenAddress, abi: [TOTAL_SUPPLY], functionName: "totalSupply" });
  if (!supply || supply === 0n) return null;

  const head = await publicClient.getBlockNumber();
  const floor = head > MINT_LOOKBACK ? head - MINT_LOOKBACK : 0n;
  const mints = await publicClient.getLogs({ address: tokenAddress, event: TRANSFER, args: { from: ZERO }, fromBlock: floor, toBlock: head });
  if (mints.length === 0) return null; // not a fresh mint within range — don't judge
  const fromBlock = mints[0].blockNumber;

  const bal = new Map();
  const bump = (a, v) => bal.set(a, (bal.get(a) ?? 0n) + v);
  for (let lo = fromBlock; lo <= head; lo += CHUNK + 1n) {
    const hi = lo + CHUNK > head ? head : lo + CHUNK;
    const logs = await publicClient.getLogs({ address: tokenAddress, event: TRANSFER, fromBlock: lo, toBlock: hi });
    for (const l of logs) {
      bump(l.args.from.toLowerCase(), -l.args.value);
      bump(l.args.to.toLowerCase(), l.args.value);
    }
  }

  const holders = [...bal.entries()]
    .filter(([a, v]) => a !== ZERO && v > 0n)
    .sort((a, b) => (b[1] > a[1] ? 1 : -1));
  // Largest holder that is an EOA (no bytecode). Venues/conduits are contracts and get skipped.
  for (const [addr, v] of holders.slice(0, TOP_N_TO_CLASSIFY)) {
    const code = await publicClient.getBytecode({ address: addr });
    if (!code || code === "0x") return Number((v * 1_000_000n) / supply) / 1_000_000;
  }
  return 0; // none of the top holders are EOAs → no single-wallet concentration risk
};
