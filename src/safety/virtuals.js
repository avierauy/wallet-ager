// Safety check for Virtuals pre-grad tokens. Honeypot.is can't evaluate these because
// they don't have Uniswap pools yet (they live exclusively on the bonding curve until
// graduation). Instead we quote a small roundtrip on the bonding curve itself:
//   probe VIRTUAL → agentToken → VIRTUAL
// If both directions return > 0 and the roundtrip loss is within bounds, the curve
// is operational and the token is tradeable.

import { quoteAgentToVirtual, quoteVirtualToAgent } from "../adapters/virtuals.js";
import { logger } from "../util/logger.js";

const PROBE_VIRTUAL_WEI = 10n ** 16n;   // 0.01 VIRTUAL — small enough to not move the curve much
const MAX_ROUNDTRIP_LOSS_PCT = 30;       // bonding curve fees + price impact on a small probe

export const checkBondingCurve = async ({ agentToken }) => {
  try {
    const agentOut = await quoteVirtualToAgent({ agentToken, amountInVirtualWei: PROBE_VIRTUAL_WEI });
    if (agentOut === 0n) {
      return { safe: false, reasons: ["bonding curve returns 0 agent for VIRTUAL probe"], cached: false };
    }
    const virtualBack = await quoteAgentToVirtual({ agentToken, amountInAgentWei: agentOut });
    if (virtualBack === 0n) {
      return { safe: false, reasons: ["bonding curve returns 0 VIRTUAL for agent probe"], cached: false };
    }
    const lossBps = Number(((PROBE_VIRTUAL_WEI - virtualBack) * 10000n) / PROBE_VIRTUAL_WEI);
    const lossPct = lossBps / 100;
    if (lossBps > MAX_ROUNDTRIP_LOSS_PCT * 100) {
      return {
        safe: false,
        reasons: [`bonding curve roundtrip loss ${lossPct.toFixed(2)}% > ${MAX_ROUNDTRIP_LOSS_PCT}%`],
        cached: false,
      };
    }
    return {
      safe: true,
      reasons: [],
      cached: false,
      isHoneypot: false,
      buyTax: 0,
      sellTax: lossPct,
      transferTax: 0,
      simulationSuccess: true,
      riskLevel: null,
    };
  } catch (err) {
    logger.warn({ agentToken, err: err.message }, "virtuals bonding curve probe failed");
    return { safe: false, reasons: [`virtuals quote failed: ${err.message}`], cached: false };
  }
};
