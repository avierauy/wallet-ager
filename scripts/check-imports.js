// Verifica que todos los módulos compilen y se importen sin errores.
// Requiere que .env exista con CHAIN y RPC_URL definidos.
import { config } from "../src/config.js";
import { publicClient } from "../src/core/rpc.js";
import * as uniswap from "../src/adapters/uniswap.js";
import * as bankr from "../src/adapters/bankr.js";
import * as virtuals from "../src/adapters/virtuals.js";
import * as telegram from "../src/notify/telegram.js";
import * as honeypot from "../src/safety/honeypot.js";
import * as orchestrator from "../src/orchestrator.js";
import { db } from "../src/core/db.js";
import { logger } from "../src/util/logger.js";

logger.info({ chain: config.chain.name, chainId: config.chain.chainId }, "config ok");

const block = await publicClient.getBlockNumber();
logger.info({ block: block.toString() }, "rpc ok");

logger.info(
  {
    uniswap: Object.keys(uniswap),
    bankr: Object.keys(bankr),
    virtuals: Object.keys(virtuals),
    telegram: Object.keys(telegram),
    honeypot: Object.keys(honeypot),
    orchestrator: Object.keys(orchestrator),
  },
  "modules loaded"
);

const row = db.prepare("SELECT count(*) as n FROM trades").get();
logger.info({ trades: row.n }, "db ok");
