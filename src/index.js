import { config } from "./config.js";
import { ensureInitialSnapshot, fetchTokenPrices } from "./core/balanceTracker.js";
import "./core/db.js"; // trigger schema init
import { getActive as getActiveTokens } from "./core/tokenRegistry.js";
import { loadWallets } from "./core/wallets.js";
import { startBankrDiscovery, stopBankrDiscovery } from "./discovery/bankr.js";
import { startClankerDiscovery, stopClankerDiscovery } from "./discovery/clanker.js";
import { startSweeper, stopSweeper } from "./discovery/sweeper.js";
import { startUniswapDiscovery, stopUniswapDiscovery } from "./discovery/uniswap.js";
import { startVirtualsDiscovery, stopVirtualsDiscovery } from "./discovery/virtuals.js";
import { notifyInfo, startBatchTimer } from "./notify/telegram.js";
import { startDailyCleanup, stopDailyCleanup } from "./orchestrator/dailyCleanup.js";
import { startWalletLoop } from "./orchestrator.js";
import { initSniper, _stopAll as stopSniper } from "./orchestrator/sniper.js";
import { logger } from "./util/logger.js";
import { snapshot } from "./util/metrics.js";
import { createSemaphore } from "./util/semaphore.js";

const METRICS_LOG_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_SNAPSHOT_CONCURRENCY = 20;

async function main() {
  const wallets = loadWallets();
  const tokens = getActiveTokens(); // snapshot for startup snapshotting/logging; orchestrator re-reads per tick
  logger.info(
    {
      chain: config.chain.name,
      chainId: config.chain.chainId,
      walletCount: wallets.length,
      tokenCount: tokens.length,
      dryRun: config.runtime.dryRun,
      zeroExEnabled: Boolean(config.apis.zeroEx),
      telegramEnabled: config.telegram.enabled,
      maxConcurrency: config.runtime.maxConcurrency,
    },
    "wallet-ager starting"
  );

  if (config.runtime.dryRun) {
    logger.warn("DRY_RUN=true — no transactions will be broadcast");
  }

  // Fetch prices once, then snapshot wallets in parallel (skipping any with existing initials).
  logger.info({ tokens: tokens.length }, "fetching initial token prices");
  const prices = await fetchTokenPrices(tokens);
  logger.info("snapshotting initial wallet values");
  const startupSem = createSemaphore(STARTUP_SNAPSHOT_CONCURRENCY);
  await Promise.all(
    wallets.map((wallet) =>
      startupSem.run(async () => {
        try {
          await ensureInitialSnapshot({ wallet, tokens, prices });
        } catch (err) {
          logger.warn({ walletId: wallet.id, err: err.message }, "initial snapshot failed (continuing)");
        }
      })
    )
  );

  if (config.telegram.enabled) {
    await notifyInfo(
      `wallet-ager started — ${wallets.length} wallets, chain=${config.chain.name}, dry-run=${config.runtime.dryRun}`
    );
  }

  initSniper(wallets);

  for (const wallet of wallets) {
    startWalletLoop({ wallet });
  }

  setInterval(() => logger.info(snapshot(), "metrics snapshot"), METRICS_LOG_INTERVAL_MS);
  startBatchTimer();
  startVirtualsDiscovery();
  startUniswapDiscovery();
  startBankrDiscovery();
  startClankerDiscovery();
  startSweeper();
  startDailyCleanup({ wallets });

  const shutdown = async (sig) => {
    logger.info({ sig }, "shutdown signal — exiting");
    stopVirtualsDiscovery();
    stopUniswapDiscovery();
    stopBankrDiscovery();
    stopClankerDiscovery();
    stopSweeper();
    stopSniper();
    stopDailyCleanup();
    if (config.telegram.enabled) {
      try { await notifyInfo(`wallet-ager shutting down (${sig})`); } catch {}
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, "fatal");
  process.exit(1);
});
