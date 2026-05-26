// Systematic probe of the Clanker quote API to find any hidden slippage / strategy / behavior
// flag that we missed. Tests strategy variants, body methods, header variations, etc.
//
// Usage: node --env-file=.env scripts/explore-clanker-api.js [<token-address>]
import { config } from "../src/config.js";

const TOKEN_OUT = process.argv[2] || "0x94578B02fCC42d1413070B84dCFf2f3E354465b5";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const WALLET = "0x56dac66DB126D5ad9ABA4422717D68aC5774f1B8";
const AMOUNT = "300000000000000"; // 0.0003 ETH
const BASE_URL = "https://www.clanker.world/api/quotes";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const callApi = async (extraParams = {}, headers = {}, method = "GET", body = null) => {
  const params = new URLSearchParams({
    chainId: "8453",
    inputToken: NATIVE,
    outputToken: TOKEN_OUT,
    inputAmount: AMOUNT,
    swapperAccount: WALLET,
    strategy: "best",
    ...extraParams,
  });
  const url = method === "GET" ? `${BASE_URL}?${params.toString()}` : BASE_URL;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const t0 = Date.now();
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    const dt = Date.now() - t0;
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, dt, parsed };
  } catch (err) {
    return { error: err.message, dt: Date.now() - t0 };
  }
};

// Extract the embedded slippage from a successful response's calldata.
// KyberSwap encoding: amountIn appears as `swapAmount`, minReturnAmount is what we want.
// The exact field varies but we can compare swap.amountOut (expected) vs outputAmount (user receives).
const extractSlippageInfo = (parsed) => {
  if (!parsed.success) return { error: parsed.error };
  const out = parsed.outputAmount?.toString().replace("__bigint__:", "");
  const swap = parsed.details?.swaps?.[0]?.[0] || {};
  const expected = swap.amountOut?.toString() || null;
  const provider = parsed.provider;
  let feeRatio = null;
  if (expected && out) {
    feeRatio = (Number(out) / Number(expected));
  }
  return {
    provider,
    expectedAmountOut: expected ? expected.slice(0, 12) + "..." : null,
    userOutputAmount: out ? out.slice(0, 12) + "..." : null,
    feeRatio: feeRatio !== null ? feeRatio.toFixed(6) : null,
    gas: parsed.details?.totalGas,
    routerAddress: parsed.details?.routerAddress,
    activatedFeatures: parsed.activatedFeatures,
  };
};

const tests = [
  { name: "baseline (strategy=best)", extra: {} },
  { name: "strategy=cheap", extra: { strategy: "cheap" } },
  { name: "strategy=safe", extra: { strategy: "safe" } },
  { name: "strategy=fast", extra: { strategy: "fast" } },
  { name: "strategy=stable", extra: { strategy: "stable" } },
  { name: "slippageBps=5000 (50%)", extra: { slippageBps: "5000" } },
  { name: "slippage=50 (50%)", extra: { slippage: "50" } },
  { name: "slippageTolerance=5000", extra: { slippageTolerance: "5000" } },
  { name: "maxSlippage=5000", extra: { maxSlippage: "5000" } },
  { name: "slippagePercent=50", extra: { slippagePercent: "50" } },
  { name: "minReceivedPct=50", extra: { minReceivedPct: "50" } },
  { name: "tolerance=5000", extra: { tolerance: "5000" } },
];

const run = async () => {
  console.log(`Token: ${TOKEN_OUT}`);
  console.log(`Wallet: ${WALLET}`);
  console.log(`Amount: ${AMOUNT} wei (0.0003 ETH)\n`);

  console.log("===== GET with various params =====\n");
  for (const t of tests) {
    const r = await callApi(t.extra);
    if (r.error) {
      console.log(`${t.name.padEnd(40)} → ERROR ${r.error}`);
      continue;
    }
    const info = extractSlippageInfo(r.parsed);
    console.log(`${t.name.padEnd(40)} → status=${r.status} dt=${r.dt}ms provider=${info.provider || '?'} feeRatio=${info.feeRatio} gas=${info.gas || '?'}`);
    await sleep(300);
  }

  console.log("\n===== Method/header variations =====\n");
  const variations = [
    { name: "POST with body", method: "POST", body: { chainId: 8453, inputToken: NATIVE, outputToken: TOKEN_OUT, inputAmount: AMOUNT, swapperAccount: WALLET, strategy: "best", slippageBps: 5000 } },
    { name: "GET + content-type json", headers: { "content-type": "application/json" } },
    { name: "GET + x-api-key (test)", headers: { "x-api-key": "test" } },
  ];
  for (const v of variations) {
    const r = await callApi({}, v.headers || {}, v.method || "GET", v.body);
    console.log(`${v.name.padEnd(40)} → status=${r.status} dt=${r.dt}ms ${r.parsed?.success ? 'OK' : (r.parsed?.error || r.parsed?.raw || 'fail')}`);
    await sleep(300);
  }

  console.log("\n===== Comparing the embedded slippage =====\n");
  // Make 3 consecutive calls with no params, see if feeRatio is stable
  for (let i = 1; i <= 3; i++) {
    const r = await callApi({});
    const info = extractSlippageInfo(r.parsed);
    console.log(`call #${i}: provider=${info.provider} expectedOut=${info.expectedAmountOut} userOut=${info.userOutputAmount} feeRatio=${info.feeRatio}`);
    await sleep(500);
  }
};

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });
