import { pino } from "pino";
import { config } from "../config.js";

const transport = config.log.pretty
  ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
  : undefined;

export const logger = pino({
  level: config.log.level,
  base: { app: "wallet-ager", chain: config.chain.name },
  transport,
});
