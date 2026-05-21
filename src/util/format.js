import { formatUnits } from "viem";

// fmt(amountWei, decimals): pretty-print a wei BigInt with up to `maxFrac` fractional digits,
// trimming trailing zeros. Returns "?" if the amount is null/undefined.
export const fmt = (wei, decimals, maxFrac = 6) => {
  if (wei == null) return "?";
  const w = typeof wei === "bigint" ? wei : BigInt(wei);
  const full = formatUnits(w, decimals);
  const [whole, frac = ""] = full.split(".");
  if (!frac) return whole;
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
};
