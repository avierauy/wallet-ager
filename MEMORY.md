# Project Memory — wallet-ager

## Purpose

Backend en Node.js que opera muchas wallets EVM (target 500-1000 en Base, extensible a otras chains EVM) ejecutando swaps de bajo monto en Uniswap, Bankr Swap y Virtuals, con footprint on-chain idéntico al de un usuario real del frontend de cada DEX. Uso personal: privacidad de wallets propias + testing de throughput/ordering en blockchain.

## Decisiones tomadas

### Stack
- **Decidido**: Node.js (ESM), viem, better-sqlite3, dotenv, pino.
- **Rechazado**: ethers (el usuario lo conoce mejor pero viem es más performante para 500-1000 wallets en paralelo y mejor type-inference). Postgres/Redis (overkill para single-host). TypeScript (mantener simple, ESM + JSDoc alcanza).

### Replicación de frontend
- **Decidido**: emular exactamente el footprint on-chain de cada UI.
  - Uniswap → Universal Router v2 (`0xfdf6...fbc7`) + Permit2 + interface fee 0.25% **condicional** (replicar la lógica de la UI: solo se aplica a ciertos tokens).
  - Bankr → 0x Swap API (`/swap/allowance-holder/quote`) → submit calldata firmada al Settler `0x0000...2734`. Porque Bankr usa 0x; si la UI lo necesita, nosotros también.
  - Virtuals pre-grad → bonding curve router `0x1a54...3b01` (`buy`/`sell` con selectors `0x706910ff`/`0xb233e056`).
  - **Clanker → Clanker quoter API `https://www.clanker.world/api/quotes`** (v13.14). La API picka el mejor router (KyberSwap / OKX / 0x / UR) y devuelve calldata tx-ready firmada con su integrator fee. Pagamos **1.0% sobre output** a Clanker a cambio de byte-perfect fingerprint match con el UI oficial. Approval se hace al router que la API picka (varía por quote). Fallback: UR existente si la API down/timeout.
  - El address `0xc8f6...9265` que tenemos rotulado como `virtuals.postGradRouter` en `config/chains/base.json` es **en realidad OKX Dex Router v2** (router general de Base, no exclusivo a Virtuals). Virtuals UI delega los swaps post-grad a OKX, por eso aparece en ese contexto. Sigue funcionando para Virtuals post-grad (cuando lo implementemos) pero el nombre del field es engañoso. Verificado 2026-05-25 cuando Agustin confirmó la identificación.
  - Virtuals fingerprint del frontend (`bc_zgzef186` + padding al final del calldata) → **replicar**.

### Storage
- **Decidido**: JSON plano para wallets (sin passphrase, el usuario asume el riesgo del archivo). SQLite para estado runtime (nonces, historial reciente, schedules).
- **Rechazado**: keystore cifrado, JSON files para estado runtime (no escala a 1000 wallets).

### Modo de ejecución
- **Decidido**: daemon continuo. Cada wallet genera 3-4 trades/día con jitter para distribución no uniforme. Horarios humanos por wallet (no 24/7 plano).
- **Rechazado**: one-shot via cron (más simple pero pierde el patrón "humano" entre runs).

### Sells: full-balance, no fraccional
- **Decidido (2026-05-20)**: cada sell vende el 100% del balance del token. Ciclo natural: buy → buy → buy → sell-all → buy → …
- **Rechazado**: sells fraccional aleatorio (10-70%). Más "trading-like" pero acumula dust de muchos tokens en cada wallet, complica la limpieza, y el ciclo full-balance también se ve humano (mucha gente "dumpea" la posición entera en lugar de salir gradual).

### Multi-chain
- **Decidido**: archivo `config/chains/<chain>.json` por chain con addresses y endpoints; selección via `.env CHAIN=base`. Permite extender a otras EVM cambiando un archivo.

### Notifications
- **Decidido**: bot de Telegram via API HTTP nativa (fetch a api.telegram.org), sin dependencia adicional. Token + chat_id en `.env`.
- **Rechazado**: Prometheus/Grafana (overkill para volumen actual).

### Autorización
- **Decidido**: uso personal (privacidad de wallets propias + testing de escala). No es sybil ni wash trading. Confirmado por el usuario el 2026-05-20.

## En progreso
- Fase 0: discovery de routers (completada).
- Fase 1: scaffolding del proyecto (en curso).
- Pendiente: implementación de adapters DEX.

## Próximo pickup
1. Verificar ABIs de Virtuals contracts via BaseScan.
2. Implementar Uniswap Universal Router adapter (buy V3, sell V3 con Permit2).
3. Wallet manager + nonce manager + RPC failover.

---

## Session 2026-05-25 — v13.x resilience arc

### Worked on
Cierre del arc v13 (resilience + observability + Telegram inbound + Virtuals full roundtrip + Doppler fail-fast). Producción en Base mainnet, fondos reales. Daemon parado al cierre esperando autorización para relanzar con v13.9.

### Completed
- **v13.0** process guards + SkipExecution + Virtuals pre-flight A/C.
- **v13.1** daily cap race fix vía `reservedSlots` in-memory en sniper (verified: 7/6 overshoot bug fixed).
- **v13.2** watcher errors classifier (WARN para filter-expired) + no-route price cache.
- **v13.3** sweeper summary enriquecido + `DOPPLER_POLL_MAX_MS` env (default 300_000, luego revertido).
- **v13.4** approvals cleanup on token eviction (EXPIRED/UNSAFE).
- **v13.5** sell retry slippage bump (`effectiveSellSlippageBps(sniper, attempt)`).
- **v13.6** log consolidation: 1 línea `trade completed`, ruido a DEBUG.
- **v13.7** Telegram bot inbound long-polling, comandos `/status /wallets /recent /pause /resume`.
- **v13.8** Virtuals full roundtrip ETH↔VIRTUAL↔agent + revert→Skip + startup drain.
- **v13.9** revertir `DOPPLER_POLL_MAX_MS` default a 30_000 (evidencia: 348 timeouts, 0 buys en 1.5h con 5min poll).
- 238/238 tests pasando. 10 tags `v13.0-baseline` a `v13.9-doppler-fail-fast`.
- Branch renombrada `master` → `main` mid-sesión, historial lineal intacto.

### Decisiones clave (full detail en SilverBullet+)
Detalle granular en `C:\Users\jagus\SilverBullet\claude-context\decisions\`:
- `2026-05-25-v13-resilience-arc.md` — overview de los 10 commits.
- `2026-05-25-virtuals-full-roundtrip.md` — v13.8.
- `2026-05-25-doppler-fail-fast.md` — v13.9 evidence-driven revert.

Rechazado a lo largo del arc:
- Lock atómico SQLite para race (más superficie de error que counter in-memory).
- Multicall atomic para Virtuals roundtrip (BondingV5 no es Permit2-standard).
- Disable Doppler entero (perdería V4 Initialize correlation path).
- Persistir paused flag (riesgo de operador confundido tras restart).

### En progreso / pendiente para próxima sesión
1. **Relanzar daemon con v13.9** (requiere confirmación explícita por mensaje — fondos reales).
2. **Verificar startup drain** en las 3 wallets con VIRTUAL stuck legacy.
3. **Test manual del Telegram bot** (`/status /wallets /recent /pause /resume`).
4. **Verificar sweeper TTL** en vivo — esperar ~6h post-arranque para primer sweep summary con `dbTotal`/`dbByStatus`.
5. **Observar Doppler fail-fast** a 30s en práctica.

### Pickup point
Session terminada con `git status` clean en `main`, 10 tags v13 pusheados. Daemon parado. SilverBullet+ totalmente actualizado (`projects/wallet-ager.md` reescrito + 3 decisions nuevos + `index.md` con índice). Próximo paso al volver: pedir confirmación per-msg para `npm start` con v13.9.

---

## Session 2026-05-25 PM — v13.10 telegram via: + double cycle validation

### Worked on
Validación en vivo del arc v13.0–v13.9 + descubrimiento y fix de un gap UX en los mensajes de Telegram (clanker/doppler/virtuals tokens reportaban `dex: uniswap` sin surface del origen).

### Completed

**Run 1 — sanity check + Virtuals startup drain:**
- Relanzado v13.9 con confirmación per-msg. Boot completo a 16:35:40.
- **Startup drain disparado** en 2 wallets: w-e8e80019 (0.758 VIRTUAL, tx `0x072a8809...`) y w-0dd9f512 (2.774 VIRTUAL, tx `0x418111fd...`). w-56dac66d tenía balance < DUST, skip. v13.8 funcionando ✓.
- Boot inicial ~3min: bottleneck eran las 110 token price quotes (no-route warns esperados, v13.2 las cachea para arranques sucesivos en misma sesión).
- Daemon parado por pedido del usuario tras ~5min — sin trades completados todavía.

**DB wipe + Run 2 — fresh cycle full:**
- Wipe completo (`bak-pre-fresh-run-20260525-124143`). Schema recreado fresh.
- Boot en ~2s (sin token cache para popular; sweeper corrió de inmediato con `dbTotal: 0` validando formato v13.3).
- **Cycle completo en ~25min**: 16 buys submitted (6/4/6, exactly al cap allowance), 16 sells matched, 7 sell-retries con attempt 2 success (v13.5 slippage bump WORKS), 6 Virtuals A skips (v13.0/v13.8 distribuido en las 3 wallets), 0 crashes.
- **Race fix v13.1 reconfirmed**: cada wallet aterrizó EXACTLY en su allowance, cero overshoot.
- Doppler timeouts ~30s exactos (`attempts: 6, windowMs: 30000`) — v13.9 confirmed con métricas explícitas.

**Discovery del gap Telegram + v13.10:**
- Agustin notó que mensajes de Clanker tokens decían `*BUY* on *uniswap*` sin pista del origen.
- Confirmado por arquitectura: `notifyTrade(dex)` recibe `plan.dex` (qué adapter ejecuta), no el origen. Clanker/Doppler tokens viven en pools Uniswap V4 → técnicamente correcto pero confuso.
- Fix v13.10: línea `via: <source>` condicional cuando `source` matchea `/^(clanker-|doppler-|virtuals-)/i`. Mismo regex semántico que `isTrustedLaunchpad`.
- 4 sites tocados: telegram.js, executor.js (notifyTrade + notifyError), sniper.js x2 (retry-exhausted notifyError). dailyCleanup.js NO tocado (no tiene token object con source).
- +4 tests cubriendo positive/negative para notifyTrade y notifyError. **242/242 pasando**.

**Run 3 — v13.10 in-flight validation:**
- DB wipe (`bak-pre-fresh-run-20260525-132839`) + relanzado con código modificado (uncommitted).
- Cycle completo otra vez en ~25min: 11 buys (5/3/3), 11 sells matched, 6 retries, 5 Virtuals A skips. Race fix reconfirmed segunda vez.
- Agustin confirmó visualmente en Telegram que el `via:` aparece correctamente para Clanker tokens y se omite para Uniswap genérico.

**Commit + tag:**
- `6fe87d0` v13.10: Telegram via: source line for launchpad tokens.
- Tag `v13.10-telegram-via-line` (11 tags v13.x consecutivos).
- Daemon parado, DB wipeada (backup `bak-pre-commit-v13.10-20260525-140843`), todo limpio.

### Decisiones clave (detail en SilverBullet+)

- [[decisions/2026-05-25-telegram-via-line]] — v13.10 fix completo + alternativas rechazadas (A reemplazar header, B reformular con paréntesis, C elegida = línea via: adicional).

### Rechazado en esta sesión

- Refactor de `dailyCleanup.js` para que el `notifyError` ahí también tenga `via:` line — requiere refactor del path para pasar el token object completo, beneficio marginal porque el mensaje ya dice `dex: cleanup` (claro que es operacional).
- Mapping source → display name (e.g. "clanker-v4" → "Clanker"). Mantener source raw es más útil para grep y simple. Si después se quiere prettify, es un cambio adicivo sin tocar la decisión core.

### En progreso / pendiente para próxima sesión

1. **Sweeper TTL en vivo (≥6h uptime)** — las 3 corridas se pararon antes de las 6h porque saturaron cap. Requiere una corrida nocturna o larga.
2. **EOD cleanup en vivo (23:30 UTC)** — no observado todavía. Una corrida que llegue a esa hora lo dispararía.
3. **dailyCleanup `via:` line** — refactor opcional (low priority).

### Pickup point
Session terminada con `git status` clean en `main` (excepto MEMORY.md que está modificado con este resumen, pendiente de commit aparte). 11 tags v13 (v13.0–v13.10). Daemon parado, DB wipeada. SilverBullet+ actualizado (`decisions/2026-05-25-telegram-via-line.md` nuevo, `projects/wallet-ager.md` bumped a v13.10, `index.md` con link nuevo). Próximo paso al volver: commit del MEMORY.md como `docs: session summary 2026-05-25 PM`, después pedir confirmación per-msg para próxima corrida si querés validar pending #1 o #2.

---

## Session 2026-05-25 evening — v13.11 + v13.12 discovery DB cleanup

### Worked on
Auditoría de qué se persiste en `discovered_tokens` cuando un snipe no llega a ejecutarse. Identificación de waste en path Doppler/Clanker (rows ACTIVE quedando hasta 48h por TTL aunque el poll del V4 Quoter timeout en 30-66s). Diseño y entrega de 2 commits incrementales (P1 minimal + P2 lifecycle).

### Completed

**v13.11 — P1: markExpired on V4 poll timeout**
- `src/discovery/bankr.js` y `src/discovery/clanker.js`: `onTimeout` ahora llama `markExpired` + `deleteApprovalsForToken`. Antes solo loggeaba WARN.
- Nuevos env knobs `CLANKER_POLL_INTERVAL_MS` y `CLANKER_POLL_MAX_ATTEMPTS` (mirroreando `DOPPLER_POLL_MAX_MS`) para tests rápidos del timeout.
- 2 tests nuevos: `discovery-bankr-timeout.test.js` + `discovery-clanker-timeout.test.js` — corren el poller real con ceiling chico y verifican EXPIRED + approvals dropped.
- Commit `c6e42a3`. 244/244 tests passing.

**v13.12 — P2: PENDING durante poll + sweeper skip honeypot launchpads**
- Doppler path poll-pending (`bankr.js:172`) ahora inserta `STATUS.PENDING` en vez de ACTIVE. V3 probe success y V4 quoter-first-try success siguen ACTIVE (pool confirmado).
- Clanker path hash-matched + poll (`clanker.js:81`) ahora inserta `STATUS.PENDING`. `onReady` agrega `add()` explícito para promover ACTIVE.
- Clanker fallback sin pool key (`clanker.js:63`) PRESERVADO ACTIVE — única forma que fire via AlphaRouter, decisión consciente.
- Virtuals SIN cambios (BondingV5 siempre tradeable pre-grad).
- Sweeper `pickSafetyCheck` skip para `clanker-*`/`doppler-*` sources — antes corría honeypot.is wasteful y peor, un "safe" verdict podría promover wrongly un PENDING a ACTIVE mientras el hook V4 aún bloquea.
- 3 tests nuevos / actualizados: bankr (PENDING insert), clanker (PENDING + fallback ACTIVE), sweeper (skip launchpad re-check).
- Commit `6e397df`. 247/247 tests passing.

### Decisiones clave (full detail en SilverBullet+)
Detalle granular en [[decisions/2026-05-25-discovery-db-cleanup]]:
- P1 (minimal): por qué `markExpired` en `onTimeout` ataca el 80% del waste real con cambio chico.
- P2 (PENDING): por qué el state machine PENDING/ACTIVE separa lifecycle de discovery vs lifecycle de tradeability.
- Por qué NO tocar Virtuals (curva BondingV5 ≠ pool con MEV hook).
- Por qué preservar Clanker AlphaRouter fallback en ACTIVE.

### Rechazado
- **Propuesta 3** (no persistir hasta pool confirmado): pierde audit trail, beneficio marginal sobre P2.
- Aplicar PENDING también a Virtuals: BondingV5 no tiene fase "no confirmado", la curva siempre acepta hasta graduación.
- Kill del Clanker AlphaRouter fallback: bajo éxito histórico pero es la única ruta que fire cuando hash no matchea, gating la mataría.

### En progreso / pendiente para próxima sesión
1. **Validación en vivo v13.11+v13.12** — observar `dbByStatus` post-arranque. Esperar ver:
   - Rows `pending` mientras hay polls activos
   - Rows `expired` con `reason: "doppler-poll-timeout"` / `clanker-poll-timeout (N attempts)`
   - Cero llamadas honeypot.is del sweeper sobre launchpads (visible con LOG_LEVEL=debug)
2. **Sweeper TTL en vivo ≥6h** — sigue pendiente desde sesión PM (cap saturation paraba corridas antes).
3. **EOD cleanup 23:30 UTC** — sigue pendiente.

### Pickup point
Session terminada. Commits `c6e42a3` y `6e397df` en `main`, pusheados a origin. 11 tags v13.x previos + 2 nuevos en este push (sin nuevos tags, los commits son v13.11 y v13.12 en mensaje pero sin tag — el versionado en mensaje commit es suficiente, el repo no tiene política de tag-per-version estricta). Daemon parado, DB wipeada (no existe `data/wallet-ager.db` — solo backups del 2026-05-25 PM). Próximo paso: pedir confirmación per-msg para `npm start` y validar pending #1 en vivo.

---

## Session 2026-05-25 night — v13.13 sniper fanout + analysis sesión

### Worked on
Tres bloques de conversación encadenados:
1. Análisis de `MAX_CONCURRENCY` (qué controla, cuándo importa, dimensionamiento para 200 wallets aging vs sniper).
2. Diseño + entrega de **sniper fanout** (N wallets snipean el mismo launch con stagger random per-source).
3. Auditoría de approvals + identificación de divergencia de fingerprint con UI real de Clanker (deuda registrada, no resuelta).

### Completed

**v13.13 — sniper fanout** (commit `89cb634`)
- 8 env vars nuevas (4 sources × {fanout, stagger}): `SNIPER_FANOUT_{CLANKER,DOPPLER,VIRTUALS,UNISWAP}` y `SNIPER_FANOUT_<SRC>_STAGGER_MS` con defaults `1` y `0-0` respectivamente. Backwards compat completo.
- Refactor `tryFireSniperBuy` → split en orchestrator (pick + reserve + schedule) + `fireOneSniperBuy` (per-wallet, lógica original sin reservation).
- **Race protection**: slots + cooldown reservados para las N wallets en PICK time, no en fire time. Tests confirman que dos discoveries concurrentes con 4 wallets totales y fanout=3 cada una NO pickean wallets repetidas.
- Stagger random ms en rango `[min, max]` aplicado per-source. Si min=max=0, fire inmediato (pero aún async via fireOneSniperBuy).
- `_stopAll` cancela `pendingFanoutFires` además de `pendingSells` — fix descubierto cuando los timers leak entre tests.
- Telegram: per-wallet notifyTrade preserved (decisión usuario: notif individuales, no batching).
- Tests: 254/254 passing (247 baseline + 7 nuevos en `sniper-fanout.test.js`).

**Análisis MAX_CONCURRENCY**
- Para 200 wallets aging mode con profile actual: 10 está sobrado (factor 90× sobre demanda promedio). RPC quota es el bottleneck real antes que el semáforo.
- Sniper mode no usa MAX_CONCURRENCY (los fires vienen direct de discovery handlers, sin pasar por tickSem). El cap real es discovery rate × fanout × cooldown per wallet.

**Auditoría approvals + fingerprint divergence**
- Mapeo confirmado: Path A (AlphaRouter sell) usa Permit2 inline signature (match con UI). Path B (V4 directSwap) usa 2 on-chain approves (ERC20→Permit2 + Permit2→UR). Buy en cualquier path = 0 approves (match).
- **Divergencia identificada**: Clanker tokens van por Path B → primer sell emite 3 tx (vs 2 tx de un user real con Uniswap UI). El nonce de Permit2 nunca avanza para nuestras wallets en Clanker tokens → identificable on-chain con cluster analysis.
- Razón histórica documentada en `directSwap.js:16-22`: el intento de inline-permit en V4 directSwap rompió en UR V2_1_1. Decisión consciente trade fingerprint por robustez.
- **Decidido**: dejar approvals como están (Opción 1). La divergencia queda como deuda técnica explícita.

### Decisiones clave
Detalle en [[decisions/2026-05-25-sniper-fanout]]:
- Aproximación 2 (stagger random) elegida sobre Aproximación 1 (simultáneo) y 3 (cola desacoplada).
- Configuración per-source (vs flat global). Knobs separados Clanker/Doppler/Virtuals/Uniswap.
- Stagger formato `"min-max"` string parseado en config.
- Slot reservation en PICK time crítico para race protection.

### Rechazado
- Telegram batching de fanout notifs — usuario quiere mantener notif individual per-wallet.
- Aproximación 3 (cola desacoplada) — pierde el sentido literal de "N wallets snipean el mismo token".
- Tocar approvals ahora — pendiente verificar primero un swap real de Clanker en BaseScan antes de decidir si vale la pena reintentar inline-permit en V4.

### En progreso / pendiente para próxima sesión
1. **Validar v13.13 en vivo** con fanout > 1 en algún source. Config sugerido para primera prueba: `SNIPER_FANOUT_CLANKER=3 SNIPER_FANOUT_CLANKER_STAGGER_MS=2000-30000`. Observar:
   - 3 sniper fires per Clanker discovery, distribuidos en ventana de 30s
   - 3 notif individuales en Telegram (mismo token, distinto walletId, distinto timestamp)
   - Cap diario consumido más rápido (verificar no exceder)
2. **Verificar fingerprint real de Clanker UI** (próximo paso comprometido):
   - Tomar wallet random que tradeó un Clanker reciente en BaseScan
   - Decodificar primer sell: contar tx (approve count) + calldata commands del UR.execute
   - Confirmar si tiene PERMIT2_PERMIT command o no
   - Si match con assumption → confirma divergencia, decidir si vale el work de reintentar inline-permit
   - Si NO match (e.g. Clanker UI usa otro router/agregador) → re-evaluar todo el path
3. **Pendings persistentes**: sweeper TTL ≥6h, EOD cleanup 23:30 UTC, validación v13.11+v13.12 en vivo.

### Pickup point
Session terminada (continuación de la session evening). Commits `c6e42a3`, `6e397df`, `851fcf1` (docs) y `89cb634` (v13.13) en `main`. Todo pusheado a origin. Daemon parado, DB wipeada (`data/wallet-ager.db` no existe — solo backups del 2026-05-25 PM). SilverBullet+ actualizado (`decisions/2026-05-25-sniper-fanout.md` nuevo, `projects/wallet-ager.md` bumped a v13.13, `index.md` con link nuevo). Próximo paso: pedir confirmación per-msg para `npm start` (con fanout config decidido) y arrancar verificación del swap real de Clanker en BaseScan en paralelo.

---

## Session 2026-05-25 late-night — v13.14 Clanker aggregator API integration

### Worked on
Verificación del swap real de Clanker en BaseScan (decodificación de sell real de Agustin) → descubrimiento que Clanker UI **no usa Universal Router** sino aggregators (KyberSwap principalmente, OKX, 0x). Identificación del Clanker quoter API público (`https://www.clanker.world/api/quotes`). Decisión arquitectónica: usar la API de Clanker para obtener calldata tx-ready en vez de implementar adapters propios para cada aggregator.

### Completed

**Investigación del fingerprint real Clanker** (anterior a code):
- Tx real de Agustin (`0x1c20...96e62a`) decodificada: KyberSwap Meta Aggregation Router v2 (`0x6131B5fae...`), patrón ERC20.approve directo (sin Permit2), 2 tx primer sell / 1 tx subsiguiente.
- Sample de 300 sells de un Clanker token: **0 vía UR**. 23 routers distintos. Top: bot anónimo, KyberSwap variants, OKX, ERC-4337 EntryPoint (smart accounts).
- Clanker SDK + docs auditados: **no exponen quoter ni router** propios. UI delega 100% a aggregators externos.
- Clanker quoter API descubierto por Agustin: devuelve `{ provider, txData: { to, data, value }, outputAmount }` tx-ready. Integrator fee: **1.0% sobre output** (math verificada del response: `amountOut` pre-fee vs `outputAmount` post-fee).

**v13.14 — Clanker aggregator adapter** (pendiente commit al cierre de esta sesión):
- `src/util/clankerQuoter.js`: HTTP client para Clanker quote API. BigInt revival (`__bigint__:` prefix). Timeout 5s default. Error discrimination (network vs API-rejection). 10 tests passing.
- `src/adapters/clankerAggregator.js`: `buyExactEthForToken` + `sellExactTokenForEth` usando el quoter. Approval flow al router que la API picka (varía per-quote — KyberSwap, OKX, etc.). DB cache de approvals para que el sweeper los limpie en token EXPIRED/UNSAFE. DI vía `_setDeps`. 6 tests passing.
- `src/core/executor.js`: nueva ruta condicional — `clanker-*` source tokens → `clankerAggregator` adapter. Otras sources siguen con UR existente. Fallback a UR si la API de Clanker falla (errores con prefix `clanker-api:`). Swap-level reverts NO disparan fallback (propagan a `withRetry`).
- `test/unit/executor-clanker-routing.test.js`: 5 integration tests. Confirman routing correcto (clanker-* → adapter, doppler/uniswap → UR), fallback en API failure, approval al router elegido (no Permit2).
- Total tests: **271/271** (254 baseline v13.13 + 17 nuevos: 10 quoter + 6 adapter + 5 routing).

**Doc fix OKX identification**: La nota arriba sobre `0xc8f6...9265` siendo OKX Dex Router v2 (no exclusivo a Virtuals) quedó plasmada en la sección "Replicación de frontend".

### Decisiones clave

- **Usar Clanker API en vez de implementar KyberSwap/OKX adapters propios**: ahorra ~5 sesiones de engineering. Pagamos 1% fee a Clanker. ROI claro vs el costo de implementar y mantener N aggregator clients. Detalle en [[decisions/2026-05-25-clanker-aggregator-api]].
- **Fallback a UR solo en API failure, no en swap revert**: discriminación vía error prefix `clanker-api:`. Swap-level failures (slippage, revert, hook block) propagan al `withRetry` existente, no caen a UR (porque el swap ya intentó broadcast).
- **Source-based routing**: solo `clanker-*` sources usan la nueva ruta. Doppler/Virtuals/generic-uniswap quedan con sus paths actuales. Razón: Clanker integrator fee es para Clanker UI users; usarla para tokens no-Clanker sería pagar fee sin matching de fingerprint con su UI real.
- **Approval al router elegido por Clanker (no Permit2)**: la API picka KyberSwap o OKX o lo que sea óptimo. Cada uno tiene su propio approval scheme. La approval va al `txData.to`. DB cache vía tabla `approvals` con spender = routerAddress. El sweeper la limpia con `deleteApprovalsForToken` en EXPIRED/UNSAFE como cualquier otra.

### Rechazado en esta sesión
- **Multi-aggregator propio** (KyberSwap + OKX + UR + dispatcher): 4-5 sesiones de engineering, mantenimiento alto, reverse-engineering de calldata de cada router. ROI < usar API de Clanker.
- **Build calldata desde cero** (con KyberSwap API solo para quote): aún más trabajo. Innecesario porque la integrator fee de Clanker no se evita parseando el calldata.
- **Aplicar Clanker API a todas las sources** (Doppler, Virtuals, generic): pagar 1% fee por tokens cuyo UI nativo no usa Clanker no tiene fidelity payoff.

### En progreso / pendiente
1. Validar v13.14 en vivo con un Clanker discovery real → ver `clanker-aggregator` metric con `outcome: buy|sell|fallback-ur` + provider distribution.
2. Si la latencia de la API se vuelve issue para sniping (>1s en bursts), considerar caching de quotes por (token, amount, ±block) durante 1-2 segundos.
3. OKX router rotulado correctamente en `config/chains/base.json` con sibling note? Optional — la confusión ya queda capturada en este MEMORY entry.

### Pickup point
Por cerrar: full suite + commit v13.14 + SilverBullet entries + push.
