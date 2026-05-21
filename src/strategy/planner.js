import {
  ethFloatToWei,
  sampleLognormal,
  samplePick,
  sampleUniform,
  sampleUniformInt,
  sampleWeighted,
} from "./randomizer.js";

// planAction: pure. Returns the next action a wallet should take, or null if none viable.
// Inputs:
//   profile        — wallet.profile (from config/wallets.json)
//   tokens         — array of { address, symbol, decimals, tradeableOn, virtualsState? }
//   balances       — { [tokenAddress.toLowerCase()]: bigint }  current token balances of this wallet
//   nativeBalance  — bigint, wallet's ETH balance
//   rng            — () => number in [0,1)
//
// Output ActionPlan (or null):
//   { dex, side, token, amountInWei, slippageBps, gasMultiplier }
//   For buys: amountInWei is ETH spent. For sells: amountInWei is token spent.

const SELL_FRACTION_RANGE = [0.1, 0.7]; // sell 10-70% of holdings when selling
const BUY_BIAS_WHEN_LOW = 0.85;         // 85% chance to buy if we have no balance

const candidateTokensFor = (dex, tokens) =>
  tokens.filter((t) => Array.isArray(t.tradeableOn) && t.tradeableOn.includes(dex));

const has = (balances, token) => (balances[token.address.toLowerCase()] ?? 0n) > 0n;

export const planAction = ({ profile, tokens, balances, nativeBalance, rng }) => {
  const minNative = BigInt(profile.minNativeBalanceWei ?? "0");
  if (nativeBalance <= minNative) return null;

  const dex = sampleWeighted(profile.dexWeights, rng);
  const candidates = candidateTokensFor(dex, tokens);
  if (candidates.length === 0) return null;

  // Prefer tokens this wallet already holds for selling, to keep round-trip activity natural.
  const heldCandidates = candidates.filter((t) => has(balances, t));
  const token = heldCandidates.length > 0 && rng() < 0.5
    ? samplePick(heldCandidates, rng)
    : samplePick(candidates, rng);

  const holdsToken = has(balances, token);
  const side = !holdsToken
    ? "buy"
    : rng() < BUY_BIAS_WHEN_LOW && balances[token.address.toLowerCase()] < 1n
      ? "buy"
      : rng() < 0.5
        ? "buy"
        : "sell";

  let amountInWei;
  if (side === "buy") {
    const eth = sampleLognormal(profile.amountRangeNativeEth, rng);
    amountInWei = ethFloatToWei(eth);
    // Cap by available native balance minus reserve for gas + minNative.
    const usable = nativeBalance - minNative;
    if (amountInWei > usable) amountInWei = usable;
  } else {
    const bal = balances[token.address.toLowerCase()];
    const frac = sampleUniform(SELL_FRACTION_RANGE, rng);
    amountInWei = (bal * BigInt(Math.floor(frac * 10_000))) / 10_000n;
    if (amountInWei <= 0n) return null;
  }

  return {
    dex,
    side,
    token,
    amountInWei,
    slippageBps: sampleUniformInt(profile.slippageBps, rng),
    gasMultiplier: sampleUniform(profile.gasMultiplierRange, rng),
  };
};
