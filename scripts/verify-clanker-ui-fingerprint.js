// Final pass: identify token origin (which factory minted it) and characterize each top router.
import { parseAbiItem } from "viem";
import { config } from "../src/config.js";
import { publicClient } from "../src/core/rpc.js";

const TOKEN = (process.argv[2] || "0x6d0FD889108168111126A068273c8eAf3fce0b07").toLowerCase();
const UNIVERSAL_ROUTER = config.chain.dexes.uniswap.universalRouter.toLowerCase();
const POOL_MANAGER = config.chain.dexes.uniswap.v4PoolManager.toLowerCase();
const PERMIT2 = config.chain.permit2.toLowerCase();
const ZEROEX_SETTLER = config.chain.dexes.bankr.settler.toLowerCase();
const VIRTUALS_POSTGRAD = config.chain.dexes.virtuals.postGradRouter.toLowerCase();
const VIRTUALS_PREGRAD = config.chain.dexes.virtuals.preGradRouter.toLowerCase();
const CLANKER_FACTORY = config.chain.dexes.clanker.factory.toLowerCase();
const DOPPLER_AIRLOCK = config.chain.dexes.doppler.airlock.toLowerCase();

const KNOWN = {
  [UNIVERSAL_ROUTER]: "Uniswap Universal Router",
  [POOL_MANAGER]: "Uniswap V4 PoolManager",
  [PERMIT2]: "Permit2",
  [ZEROEX_SETTLER]: "0x Settler (Bankr backend)",
  [VIRTUALS_POSTGRAD]: "Virtuals post-grad router",
  [VIRTUALS_PREGRAD]: "Virtuals pre-grad router",
  [CLANKER_FACTORY]: "Clanker Factory",
  [DOPPLER_AIRLOCK]: "Doppler Airlock",
};

const Transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const log = (...a) => console.log(...a);

const main = async () => {
  log(`[setup] token=${TOKEN}\n`);

  // ───────── ORIGIN CHECK ─────────
  log(`[origin] checking who minted this token`);
  // Use eth_getCode to verify it's a contract
  const code = await publicClient.getBytecode({ address: TOKEN });
  log(`[origin] bytecode size: ${(code.length - 2) / 2} bytes`);

  // Find the contract creation tx via the first Transfer(from=0x0, to=...) event
  const head = await publicClient.getBlockNumber();
  log(`[origin] searching first Transfer from 0x0 (mint event)...`);
  const CHUNK = 9000n;
  let mintTx = null;
  // Walk back in chunks from head until we find any transfer, then narrow to find the first
  for (let blocksBack = 0n; blocksBack < 500_000n; blocksBack += CHUNK + 1n) {
    const end = head - blocksBack;
    const start = end - CHUNK > 0n ? end - CHUNK : 0n;
    try {
      const logs = await publicClient.getLogs({
        address: TOKEN, event: Transfer,
        args: { from: "0x0000000000000000000000000000000000000000" },
        fromBlock: start, toBlock: end,
      });
      if (logs.length > 0) {
        // earliest in this batch
        const earliest = logs.reduce((a, b) => (a.blockNumber < b.blockNumber ? a : b));
        mintTx = earliest;
        // try to find any earlier mint in previous chunks
        for (let bb = blocksBack + CHUNK + 1n; bb < 500_000n; bb += CHUNK + 1n) {
          const e2 = head - bb;
          const s2 = e2 - CHUNK > 0n ? e2 - CHUNK : 0n;
          try {
            const logs2 = await publicClient.getLogs({
              address: TOKEN, event: Transfer,
              args: { from: "0x0000000000000000000000000000000000000000" },
              fromBlock: s2, toBlock: e2,
            });
            if (logs2.length > 0) {
              const earlier = logs2.reduce((a, b) => (a.blockNumber < b.blockNumber ? a : b));
              if (earlier.blockNumber < mintTx.blockNumber) mintTx = earlier;
            } else {
              break; // no mints in this older chunk, we found the genesis chunk
            }
          } catch { break; }
        }
        break;
      }
    } catch {}
  }

  if (mintTx) {
    const tx = await publicClient.getTransaction({ hash: mintTx.transactionHash });
    log(`[origin] first mint tx: ${mintTx.transactionHash}`);
    log(`[origin]   block=${mintTx.blockNumber}  caller=${tx.from}  to=${tx.to}`);
    log(`[origin]   minted to=${mintTx.args.to}  amount=${mintTx.args.value}`);
    const minter = (tx.to ?? "").toLowerCase();
    if (minter === CLANKER_FACTORY) log(`[origin]   ✓ MINTED BY CLANKER FACTORY → token is Clanker`);
    else if (minter === DOPPLER_AIRLOCK) log(`[origin]   ✓ MINTED BY DOPPLER AIRLOCK → token is Doppler`);
    else if (minter.includes("virtual") || KNOWN[minter]?.toLowerCase().includes("virtual")) log(`[origin]   ✓ minted via Virtuals`);
    else log(`[origin]   ⚠ unknown minter ${minter} (${KNOWN[minter] ?? "not in known set"}) — token may be neither Clanker nor Doppler nor Virtuals`);
  } else {
    log(`[origin] could not find mint event in last 500k blocks`);
  }

  // ───────── ROUTER TALLY (sells only — buys obscure UI fingerprint with WETH wrappers) ─────────
  log(`\n[routers] tallying SELL txs only (no ETH paid, more revealing of UI pattern)`);
  const SCAN_BLOCKS = 200_000n;
  const fromBlock = head - SCAN_BLOCKS;
  const all = [];
  for (let start = fromBlock; start <= head; start += CHUNK + 1n) {
    const end = start + CHUNK > head ? head : start + CHUNK;
    try {
      const logs = await publicClient.getLogs({ address: TOKEN, event: Transfer, fromBlock: start, toBlock: end });
      all.push(...logs);
    } catch {}
  }
  const uniqueTxs = [...new Set(all.map((t) => t.transactionHash))];
  log(`[routers] ${uniqueTxs.length} unique txs touching the token`);

  const sellsByRouter = {};
  const SAMPLE = Math.min(uniqueTxs.length, 400);
  let sells = 0;
  for (let i = 0; i < SAMPLE; i++) {
    const tx = await publicClient.getTransaction({ hash: uniqueTxs[i] });
    if (tx.value > 0n) continue; // skip buys (ETH paid)
    sells++;
    const to = (tx.to ?? "null").toLowerCase();
    if (!sellsByRouter[to]) sellsByRouter[to] = { count: 0, samples: [] };
    sellsByRouter[to].count++;
    if (sellsByRouter[to].samples.length < 3) sellsByRouter[to].samples.push(tx);
  }
  log(`[routers] sampled ${SAMPLE} txs → ${sells} sells, ${Object.keys(sellsByRouter).length} distinct sell-routers\n`);

  const ranked = Object.entries(sellsByRouter).sort((a, b) => b[1].count - a[1].count);
  log(`[routers] top routers BY SELLS (most UI-revealing path):`);
  for (const [addr, info] of ranked.slice(0, 8)) {
    const sel = info.samples[0]?.input.slice(0, 10);
    let codeSize = "?";
    try {
      const c = await publicClient.getBytecode({ address: addr });
      codeSize = c ? `${(c.length - 2) / 2}` : "0";
    } catch {}
    log(`  ${addr}  sells=${info.count.toString().padStart(3)}  selector=${sel}  codeSize=${codeSize}B  ${KNOWN[addr] ?? ""}`);
  }
};

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
