// MUST be first — installs global process guards before brotli/SOR get loaded transitively.
// See src/util/processGuards.js for the full rationale.
import "./util/processGuards.js";
import { drainAccumulatedVirtual } from "./adapters/virtuals.js";
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
import { startTelegramBot, stopTelegramBot } from "./notify/telegramBot.js";
import { startDailyCleanup, stopDailyCleanup } from "./orchestrator/dailyCleanup.js";
import { startWalletLoop } from "./orchestrator.js";
import { initSniper, _state as sniperState, _stopAll as stopSniper } from "./orchestrator/sniper.js";
import { startStuckSellWatchdog, stopStuckSellWatchdog } from "./orchestrator/stuckSellWatchdog.js";
import { logger } from "./util/logger.js";
import { snapshot } from "./util/metrics.js";
import { markStarted } from "./util/runtimeState.js";
import { createSemaphore } from "./util/semaphore.js";

const METRICS_LOG_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_SNAPSHOT_CONCURRENCY = 20;

async function main() {
  markStarted(); // record uptime baseline for the Telegram /status command
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

  // One-shot legacy cleanup: prior sessions could leave VIRTUAL accumulated in wallets
  // when the agent-token sell did not auto-convert back to ETH. Each Virtuals cycle now
  // closes the roundtrip itself (see executeSellFlow), but wallets that built up balance
  // before this change still hold VIRTUAL. Drain it here so the next Virtuals snipe starts
  // from virtualBalance < DUST and the pre-flight A check can correctly bail when the
  // planned ETH is too small. Best-effort: errors are logged and the daemon continues.
  if (!config.runtime.dryRun) {
    await Promise.all(wallets.map(async (wallet) => {
      try {
        const r = await drainAccumulatedVirtual({ account: wallet.account });
        if (r.drained) {
          logger.info(
            { walletId: wallet.id, virtualAmountWei: r.virtualAmountWei, txHash: r.txHash },
            "startup: drained accumulated VIRTUAL to ETH"
          );
        }
      } catch (err) {
        logger.warn({ walletId: wallet.id, err: err.message }, "startup VIRTUAL drain failed (continuing)");
      }
    }));
  }

  initSniper(wallets);

  for (const wallet of wallets) {
    startWalletLoop({ wallet });
  }

  setInterval(() => logger.info(snapshot(), "metrics snapshot"), METRICS_LOG_INTERVAL_MS);
  startBatchTimer();
  startTelegramBot({ wallets, sniperState });
  startVirtualsDiscovery();
  startUniswapDiscovery();
  startBankrDiscovery();
  startClankerDiscovery();
  startSweeper();
  startDailyCleanup({ wallets });
  startStuckSellWatchdog({ wallets });

  const shutdown = async (sig) => {
    logger.info({ sig }, "shutdown signal — exiting");
    stopTelegramBot();
    stopVirtualsDiscovery();
    stopUniswapDiscovery();
    stopBankrDiscovery();
    stopClankerDiscovery();
    stopSweeper();
    stopSniper();
    stopDailyCleanup();
    stopStuckSellWatchdog();
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
