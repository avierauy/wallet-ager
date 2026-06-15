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

---

## Session 2026-05-26 madrugada — v13.16, v13.17, live cycle full 38 wallets, root cause hook anti-snipe

### Worked on
Tres bloques principales:
1. **v13.16 — pre-simulation en Clanker aggregator**: validación en vivo de v13.14 reveló 100% revert rate en buys Clanker. Causa: API hardcoda slippage tight, precio se mueve entre quote/broadcast. Fix: `publicClient.call()` pre-flight ANTES del broadcast. Si reverte la sim, fallback a UR.
2. **v13.17 — receipt-check universal**: audit del v13.16 cazó 1 false positive en 17 trades (5.9%) — un buy logueado como "completed" pero on-chain reverted. Causa: adapters no esperaban receipt post-broadcast. Fix: helper `submitAndConfirm` + typed error `OnChainRevert`, aplicado a TODOS los swap paths (clankerAggregator, uniswap/UR, directSwap, bankr, virtuals).
3. **Live cycle full 38 wallets**: corrida de 90 min en mainnet, 172 buys ejecutados (100% cap diario), 149 sells matched. Cero false positives confirmados. Cascada de fallbacks operando: Clanker API → UR directSwap → AlphaRouter en 3 capas.

### Completed

**v13.16** (commit `4cb96c5`):
- `src/adapters/clankerAggregator.js:simulateOrThrow` — eth_call con misma calldata que el broadcast. Si reverte, throw `clanker-api: simulation reverted (<reason>)` → dispatcher cae a UR.
- 3 nuevos tests en `clankerAggregator.test.js` + 1 en `executor-clanker-routing.test.js`.
- 278/278 tests.

**v13.17** (commit `58e5622`):
- `src/util/errors.js` — nueva typed error `OnChainRevert({ txHash, gasUsed, reason })`. Comentario explícito: NO es transient, withRetry no debe retryear.
- `src/util/submitAndConfirm.js` (nuevo) — wrapper universal: broadcast + waitForReceipt 60s + throw OnChainRevert on `status: reverted`. Detecta sendTransaction vs writeContract por shape del tx.
- 5 swap broadcast paths refactoreados para usar el helper: clankerAggregator, uniswap.submitRoute, directSwap.submitUR, bankr.submitZeroExSwap, virtuals.buyPreGrad/sellPreGrad.
- Special handling clankerAggregator: re-throw OnChainRevert como `clanker-api:` para activar fallback UR (caso race sim-pass / chain-revert).
- Special handling virtuals: catch OnChainRevert en executeBuyFlow → convert a SkipExecution (preserva "BondingV5 graduated → skip not fail").
- Executor: nueva branch para OnChainRevert → status="reverted" en DB con txHash, daily cap NO consumido, Telegram notifica con prefix "on-chain revert:".
- Aging-mode orchestrator: sell handoff a retry scheduler ahora triggea también con status="reverted".
- 5 tests submitAndConfirm + 2 tests clankerAggregator (race scenario).
- 285/285 tests passing.

**Live validation cycle full** (38 wallets, 90 min):
- 172 buys submitted (100% del cap diario × allowances)
- 149 sells matched (1:1 con buys completed)
- ~5 failed trades (cascadas completas exhaustas — Clanker→UR directSwap→AlphaRouter todas revertían)
- 0 false positives "trade completed" (v13.17 fix verificado)
- Cycle parcial: completó al hard cap de 90 min con 28/38 wallets at cap (74%), 90% de buys totales
- Métricas observadas:
  - 100% Clanker buys → fallback UR (Clanker API slippage no funciona para fresh launches)
  - SELLS Clanker via Clanker API: 100% éxito (KyberSwap ~70%, 0x ~30%)
  - Race sim-pass / chain-revert observado vías sniper sell (caught by OnChainRevert re-throw como clanker-api:)

**Root cause hook anti-snipe time-based** (gran hallazgo de la sesión):
- 3 tokens quedaron stuck post-daemon-stop: 2x EIKO, 1x TEST4 (todos Clanker, mismo hook `0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC`)
- Daemon murió ~05:33 antes que el scheduled sell (delay 1-3min post buy 05:31) firme
- sell-positions.js intentó liquidar ~05:34 → revert en UR / `no route found` en AlphaRouter
- Inspección on-chain via `inspect-token-trade-history.js`: el pool NO es one-way (4 sells observadas), pero 0 sells via UR. Sells via ERC-4337 EntryPoint, OKX Dex Router, Clanker Factory. Comparativa con HUDAI (mismo hook, vendido OK via UR) demuestra que NO es token-template restriction.
- Forensics con `simulate-stuck-sell.js`: a las ~07:00 (~1.5h después del buy) la SIMULACIÓN del mismo sell via UR **succeeded**. Hace 1h revertía. → confirma anti-snipe window time-based del hook.
- Re-intento sells: 3/3 ✓ una vez que la ventana expiró. Cero positions stuck al final.

**Scripts forensics nuevos** (reusables):
- `scripts/find-stuck-positions.js` — focused (only tokens we bought) + parallel + progressive output. 2s vs 30+min de la versión anterior.
- `scripts/liquidate-via-alpha-router.js` — fallback liquidator vía adapter uniswap (AlphaRouter handles V2/V3/V4).
- `scripts/diagnose-stuck-token.js` — Quoter both directions, hook bytecode size, failed tx forensics.
- `scripts/inspect-token-trade-history.js` — sells/buys ratio + router distribution per token.
- `scripts/simulate-stuck-sell.js` — construye UR.execute calldata exacta + eth_call para revert reason.

### Decisiones clave

- **v13.16 pre-simulation**: gasta ~30ms eth_call por intento. Vale la pena: evita 100% de los gas-waste reverts on buys Clanker.
- **v13.17 universal**: aplicado a TODOS los paths, no solo Clanker. Cost: 2-4s adicionales esperando receipt por swap. Beneficio: zero false positives, retry/fallback inteligente.
- **NO DB wipes desde ahora**: cambio de política. Histórico de ciclos por wallet es operacionalmente útil (caps, cooldowns, approval cache, EXPIRED bookkeeping carrying forward).
- **Root cause documentado**: Clanker hook `0xb429d62f...` tiene anti-snipe window time-based (~1h+). El sniper's sell delay (1-3 min) es **demasiado corto** para esto. Daemons que matamos antes que el retry naturally cleared the window pierden las posiciones temporalmente.

### Rechazado / Pendiente para próxima sesión

- **v13.18 (skip Clanker API en buys)**: NO se hace. El fallback UR existing maneja el caso correctamente. La rare casualidad de que un Clanker API quote pase la sim sigue valiendo intentar.
- **Pending — ajustar sell delay para Clanker**: actualmente `sellDelayMin: [1, 3]` minutos. Para Clanker tokens debería ser [10, 30] min o más, para que la primera sell attempt caiga DESPUÉS de que el anti-snipe window cierre. Posible v13.18 alternativo.
- **Pending — retry-with-backoff para sells**: la lógica actual (v13.5) reintenta 5 veces × 30s = 2.5 min de ventana de retry. Insuficiente para hook windows de ~1h. Considerar extender o hacer retry-while-daemon-alive con backoff exponencial.
- **Pending — RPC inconsistencies en receipt fetching**: Infura load-balanced nodes a veces NO devuelven receipts incluso cuando getTransaction sí. Audit script needs retry + fallback (parcialmente implementado en este session).

### Pickup point
Daemon parado, sin zombies. **DB persistida** (no wipe per nueva política). Stuck positions: cero. Receipt audit corriendo background. Pendiente: commit v13.16 + v13.17 docs + SilverBullet update (commits ya pusheados al main pero MEMORY.md falta). Decisión técnica abierta: extender sell delay Clanker / retry-with-backoff.

---

## Session 2026-05-26 mañana — v13.18 pre-sim universal + Clanker retry window + forensic correction

### Worked on
Tres tareas encadenadas a partir de la decisión de "no v13.18 skip-Clanker-buy" y la pregunta del usuario sobre por qué EIKO/TEST4 quedaron stuck:
1. **Pre-sim sells universal**: applicar el patrón v13.16 (eth_call antes de broadcast) a TODOS los swap paths para evitar gas waste en reverts.
2. **Sniper retry window per-source**: Clanker sells exhausted el retry default (5×30s=2.5min) demasiado rápido. Per-source override.
3. **Forensic tracker pasivo**: standalone script que computa el hook window real desde DB.

### Completed (commit `44158d7`)

**v13.18-A: pre-sim universal**:
- `src/util/errors.js`: nuevo `PreSimulationRevert({ reason, target })`. Distinct de OnChainRevert (este NO se broadcast, no se gasta gas).
- `src/util/simulateBeforeBroadcast.js` (NUEVO): wrapper de `publicClient.call`. On revert, throw PreSimulationRevert. 4 tests.
- Aplicado a: `uniswap.submitRoute`, `directSwap.submitUR`, `bankr.submitZeroExSwap`, `virtuals.buyPreGrad/sellPreGrad`. clankerAggregator ya tenía `simulateOrThrow` inline (preserva special prefix `clanker-api:` para fallback) — left as-is.
- Virtuals: catch incluye PreSimulationRevert junto a OnChainRevert → SkipExecution.

**v13.18-B: executor + orchestrator handling**:
- Executor catches PreSimulationRevert → status `pre-sim-reverted` en DB, no Telegram noise, daily cap NO consumido.
- Aging orchestrator: sell handoff a sniper retry scheduler triggea también con `pre-sim-reverted`.
- Executor escribe `trades.confirmed_at = Date.now()` al confirmar tx exitosa. La columna existía en schema desde v1 pero nunca se escribía. Pre-v13.18 trades quedan con `null`; tracker maneja ambos casos.

**v13.18-C: per-source retry config**:
- `src/orchestrator/sniper.js`: nuevo `retryConfigForToken(token)` que routea por `source`.
- Clanker tokens: `SNIPER_CLANKER_SELL_RETRY_INTERVAL_MS=60000` (1min), `SNIPER_CLANKER_SELL_MAX_ATTEMPTS=10` → **10 min total retry window**.
- Non-Clanker: default unchanged (5×30s=2.5min).

**v13.18-D: forensic tracker** (`scripts/clanker-window-tracker.js`):
- Standalone read-only. Lee discovered_tokens + trades. Para cada Clanker token que tradeamos: compute `first_sell_OK_time - discovered_at`.
- Output: per-token table + distribution (min/P50/P90/P99/max) + recommended retry config.

### Hallazgo grande — corrección del modelo previo

**El forensic me contradijo**. Mi narrativa previa (en este MEMORY y en SilverBullet decisions/2026-05-26-clanker-hook-antisnipe-window) decía "hook anti-snipe window ~30-90 min". **Eso estaba mal**.

Data real del cycle 2026-05-26 (n=93 Clanker tokens que tradeamos):
- **min: 73s (1.2 min)**
- **P50: 124s (2.1 min)**
- **P90: 166s (2.8 min)**
- **P99: 183s (3.0 min)**
- **max: 190s (3.2 min)**

**El hook window típico es 1-3 min, no horas.** 99% de los Clanker tokens cleareare su window dentro de 3 minutos. Lo que vimos con EIKO/TEST4 (3 min después del buy → fail; 1.5h después → OK) son **outliers** del 1%, no el caso típico.

Implicaciones:
- v13.18 retry config calibrada contra esta data real (no contra mi sobre-estimación previa)
- Defaults 10×1min = 10min cubren P99 con 3× headroom
- Causa real del stuck de EIKO/TEST4 sigue siendo el daemon-killed scenario (murió a los ~2min post-buy, antes que el primer sell scheduled se disparara)
- Si el daemon hubiera vivido 5-10 min más, la retry loop default probablemente los habría agarrado dentro del window normal

**Decisión documentada en [[decisions/2026-05-26-clanker-hook-antisnipe-window]]** que fue escrita ANTES de tener forensic data, así que tiene la sobre-estimación. La data corregida queda en este MEMORY entry + el commit message de v13.18. No reescribo el decisions/ file viejo — queda como registro histórico de cómo evolutionó nuestro entendimiento; el siguiente decisions/ file (si surge otro hallazgo) puede referirlo con `superseded-by:` per la convención SilverBullet.

### Decisiones clave

- **Pre-sim universal aplicado pero clankerAggregator NO refactorizado** para mantener su semántica `clanker-api:` prefix (que el dispatcher usa para fallback a UR). Refactor cosmético posponed.
- **Sniper Clanker retry: 10min total** (vs 60min de mi propuesta inicial). Calibrado contra P99 + headroom, no over-engineering.
- **Tests 289/289** después de los cambios. Baseline 285 v13.17 + 4 nuevos pre-sim helper.

### Pickup point para próxima sesión

Repo limpio, todo pusheado al main:
- `4cb96c5` v13.16 (pre-sim Clanker buys)
- `58e5622` v13.17 (receipt-check universal)
- `fe4a6c1` docs session previo + scripts forensics
- `44158d7` v13.18 (pre-sim universal + retry window + tracker)

DB persistida con histórico del cycle 2026-05-26 (172 buys + 149 sells + reverted/failed + EXPIRED). Próxima corrida del daemon va a mostrar:
- `pre-sim-reverted` status en trades cuando hook windows bloqueen
- Clanker sells retryeando 10× en 10min antes de exhaust
- `confirmed_at` poblado en todos los trades nuevos (forensics más confiables)

Cuando juntemos data de varios cycles, re-correr `clanker-window-tracker.js` afinará el P99 — si vemos windows >3min consistentemente, subir `SNIPER_CLANKER_SELL_RETRY_INTERVAL_MS` o `SNIPER_CLANKER_SELL_MAX_ATTEMPTS`.

## Session 2026-05-27 madrugada — v13.19 stuck-sell watchdog + bytes32 SOR tolerance

### Contexto

Live cycle continuó del 2026-05-26 PM al 2026-05-27 AM (UTC). Dos days back-to-back saturados 62/62 wallets. Pero el cycle del 2026-05-27 cerró con **10 Clanker-v4 positions stuck** (~01:14 UTC), buys entre 00:00 y 00:37. La retry config v13.18 (10×1min = 10 min) fue insuficiente para esos 10 tokens — la cola larga del hook window es más gruesa de lo que el forensic inicial midió.

Adicional: a las 01:24:55 surgió un **`unhandled rejection — invalid bytes32 string - no null terminator`** desde SOR's `TokenProvider.getTokens` parseando metadata corrupta de algún token Clanker. processGuards de v13.0 lo catcheó (daemon survived) pero generó spam Telegram.

### Diagnóstico de las 10 stuck

- TODAS clanker-v4 (MEMES, Veil MCP, MDSP, PAYDAI, Gitlawbase AI, MINNING, GLAWB, VNEM, MONKEY, PERCOCHAOS)
- TODAS dex=uniswap (Universal Router via AlphaRouter)
- Buys agrupados en 37 min
- Sniper retry chain expiró ~10 min después de cada buy → stuck
- bytes32 error **separado** — ocurrió 37+ min después que todos los retry windows expiraron. NO causa raíz.

### Cambios v13.19 (commit `deba9fe`)

**A) Stuck-sell watchdog** (`src/orchestrator/stuckSellWatchdog.js`)
- `setInterval` (default `STUCK_SELL_WATCHDOG_INTERVAL_MS=10min`)
- Query: today's buys con status `submitted`/`dry-run` sin matching sell + older than `MIN_AGE_MS` (default 15min, past sniper retry)
- Fire one sell por stuck vía `executor.executeAction`, slippage max (`sellSlippageBpsMax` o 2500bps), `silentOnFail=true`
- dailyCleanup a las 23:30 sigue siendo owner del dust notification
- 8 unit tests cubriendo age filter, matching-sell exclude, failed-sell-not-closed, scoping, dedup, dry-run inclusion

**B) Bytes32 SOR tolerance**
- `src/adapters/uniswap.js`: `SUBGRAPH_SOFT_ERROR` regex extendido con `invalid bytes32 string`. Foreground path → "no route found" (executor lo trata como failed trade).
- `src/util/processGuards.js`: nuevo `KNOWN_RECOVERABLE_REJECTIONS` regex (bytes32 + subgraph). Sigue logueando WARN para audit, pero NO Telegram — silencia el spam del SOR background side-fetch.

**C) Wiring**
- `src/index.js`: `startStuckSellWatchdog`/`stopStuckSellWatchdog` integrados en startup/shutdown.

### Validación in-prod

Daemon restart post-fix a las 02:59:38 UTC heredando las 10 stuck:

| Tiempo | Evento | Stuck |
|---|---|---|
| 03:12:57 | watchdog scheduled (startup done) | 10 |
| 03:19:24 | aging tick cierra MONKEY natural | 9 |
| 03:22:57 | watchdog tick 1 — 9 sells paralelas, 8 OK + 1 Clanker revert | 1 |
| 03:32:57 | watchdog tick 2 — MINNING cerrada | **0** |

Cycle: buys=sells=268, zero stuck. Daemon stopped 03:33 UTC.

bytes32 silencer: armado pero no surface durante esta corrida. Unverified end-to-end.

### Hallazgo — corrección del modelo previo

**La cola larga de outliers es más gruesa de lo que v13.18 estimó.** El forensic inicial decía P99=3min con outliers ~1%. Realidad observada en este cycle: **10/268 buys = 3.7% outliers**. El window puede durar horas (validado: aging cerró MONKEY a las 2.9h post-buy; watchdog cerró los demás entre 3.3h y 3.5h post-buy).

Esto NO invalida v13.18 — el retry inicial sigue cubriendo el 96.3% de los casos eficientemente. El watchdog es safety net para la cola larga.

### Decisiones clave

- **Watchdog complementa, no reemplaza** la retry config de sniper. v13.18 sigue siendo first line of defense; watchdog cubre cola larga.
- **silentOnFail=true** en watchdog. dailyCleanup a las 23:30 owns la notif definitiva de dust.
- **No implementamos OKX/multi-router fallback** (opción rechazada anteriormente, ahora también — watchdog + aging cierra 100% asumiendo daemon vivo).
- **Defaults 10min/15min** calibrados: rapid recovery sin race con sniper retry (15 > 10 Clanker window).
- **Tests 297/297** (8 nuevos del watchdog test).

### Pickup point para próxima sesión

Repo limpio, todo pusheado al main:
- `deba9fe` v13.19 (stuck watchdog + bytes32 tolerance)

DB persistida con dos cycles consecutivos clean. Stuck positions: 0. Daemon parado, sin zombies.

**Pendientes**:
- Investigar si SOR side-fetches corrompen state del provider durante watcher cascades — el cycle previo tuvo dos cascades (21:09 y 01:26), el segundo correlaciona con el bytes32 unhandled rejection (1.5min después).
- Si vemos 3%+ stuck en otro cycle, considerar revisar Plan C (OKX adapter) con la data nueva.
- bytes32 silencer end-to-end test: necesitamos un token con metadata corrupta para verificar in-prod.

## Session 2026-05-28 → 2026-05-29 — v13.20 parallel price fetch + ciclo full clanker-v4

### Contexto

Restart del daemon post-v13.19 para correr otro ciclo. Tras arrancar (`npm start` con DRY_RUN=false), Agustin notó que el Telegram "wallet-ager started" no llegaba tras 5+ minutos. Diagnóstico encontró que `fetchTokenPrices` (`src/core/balanceTracker.js`) es **serial** (`for...of await`) sobre todo el token registry. Registry creció orgánicamente de ~35 tokens (v13.2 timeframe) a **932 hoy** debido al policy de DB-persiste-cross-runs (2026-05-26+). Con AlphaRouter quoteando a ~2-5s por token, startup proyectaba ~50min worst-case y bloqueaba sniper/discovery/watchdog en ese tiempo.

### Cambio v13.20 (commit `3899aaf`)

`src/core/balanceTracker.js`:
- Nueva const `PRICE_FETCH_CONCURRENCY = 20` (matchea `STARTUP_SNAPSHOT_CONCURRENCY` del `ensureInitialSnapshot` que ya estaba paralelizado)
- `Promise.all(tokens.map(token => sem.run(async () => { ... })))` reemplaza el loop serial
- Per-token logic idéntica (NATIVE_SENTINEL shortcut, noRouteCache hit/miss, AlphaRouter quote, success/fail set en shared Map)
- Tests 297/297 sin nuevos tests (paralelización es transformación pura)

### Validación in-prod

Restart con v13.20:
- snapshotting phase a **T+1m40s** (vs ~50min serial estimado)
- sniper initialized a **T+1m44s**
- Ciclo completo posterior: **195 trades** (98 buys + 97 sells)
- Zero crashes, zero unhandled rejections
- Cierre verificado con `scripts/find-stuck-positions.js` sobre 83 wallets / 1029 buy pairs: **zero non-zero positions, wallets clean**

### Análisis de distribución de buys

Pregunta de Agustin: "por qué solo veo buys procesadas de clanker-v4". Análisis sobre 195 trades del ciclo:

| Source | Discovery (tokens added) | Pool became tradeable | Buys ejecutadas |
|---|---|---|---|
| **clanker-v4** | 322 | 74 | **98** ✓ |
| doppler-unknown | 343 | 13 | 0 |
| uniswap-v4-fee8388608 | 516 | 12 | 0 |
| uniswap-v4 (otros fees) | 142 | 9 | 0 |
| virtuals-Launched | 2 | 0 | 0 |
| uniswap-v3 | 4 | 0 | 0 |

**3 razones estructurales (no bug, no regresión):**
1. **Doppler**: 2,950 polling timeouts → hook anti-snipe bloquea entry. Documentado en v13.9, sigue siendo estructural.
2. **Uniswap V4 orgánico**: el sniper.js solo dispara para sources matching `clanker-*|doppler-*|virtuals-*`. Pools V4 orgánicos van al registry para que aging los pickee, NO sniper.
3. **Virtuals**: bajo flow (2 Launched + 3 Graduated en ~22h) + 23 skips por pre-flight A (ETH amount).

**Aging mode prácticamente silent** (1 línea en 22h de uptime). Probablemente el daily cap ya está saturado por sniper antes de que aging tique, o el tick interval es agresivamente alto. Pendiente investigar.

### Decisiones clave

- **Paralelizar fetchTokenPrices** con semaphore=20 (matchea el resto del codebase). No tocar concurrency knob por ahora.
- **NO persistir noRouteCache** a DB en esta sesión (out-of-scope). Si registry crece >3000, reconsiderar.
- **NO tag git v13.20-*** — la práctica de tag-per-version se discontinuó después de v13.9. Rollback usa git revert por SHA.
- **Distribución 100% clanker-v4 NO es bug** — es estructural. Memory project nueva agregada (`project_source_distribution_structural.md`) para no levantar falsa alarma futura.

### Telegram bot inbound — 1 fallo durante sesión

`telegramBot: send failed` a las 20:51:48 con `400 Bad Request: message is too long`. Probablemente respuesta a `/status` o `/recent` del bot inbound que generó >4096 chars. **El outbound (notifyTrade, los 195 trades) funcionó OK** — solo el inbound bot reply falla. Pendiente: truncar/paginar respuestas del bot.

### Pickup point para próxima sesión

Repo pusheado al main:
- `3899aaf` v13.20 (parallel price fetch)

DB persistida con ciclo limpio del 2026-05-27/28 (98 buys + 97 sells, zero stuck). Daemon parado, sin zombies. Tests 297/297.

**Pendientes operacionales**:
- **Aging silent**: 1 línea aging en 22h. Verificar configuración de tick interval y consumo del daily cap por sniper.
- **Telegram bot reply truncation**: 1 send-fail por `message is too long`. Truncar o paginar `/status` y `/recent`.
- **bytes32 silencer**: sigue armado pero no surface end-to-end aún (segundo ciclo consecutivo).
- **OKX adapter / Plan C**: descartado nuevamente. Si vemos otra vez 3%+ stuck en un cycle, reconsiderar.

**Pendientes de v13.x previos que siguen abiertos**:
- Sweeper TTL en vivo (≥6h uptime continuous) — sigue pendiente confirmar primer sweep summary.
- Investigar correlación SOR side-fetches ↔ watcher cascades.

## Session 2026-06-14 — v13.21 RPC fallback split (WIP huérfano rescatado + commiteado)

### Contexto

Al cargar el contexto vivo, se encontró una discrepancia: el último resumen (2026-05-28→29) cerraba "repo limpio, pusheado", pero `git status` mostraba **16 archivos modificados sin commitear**. Era una sesión posterior **nunca documentada** (sin commit, sin MEMORY.md, sin SilverBullet) que quedó ~2 semanas en el working tree. Reconstruido el cambio desde el código + un comentario en `rpc.js`.

### ⚠️ Gap de forensics — el outage NO está documentado

El cambio v13.21 está motivado por un **outage de Infura el 2026-06-01 (~7h)**, pero ese es **todo** el detalle que existe en cualquier lado — un one-liner en `rpc.js:23`. Agustin lo encontró en logs (no fue una pelea de >2 intentos, por eso no va a ERRORS.md). No hay forensics del incidente: no se sabe si el daemon quedó caído las 7h, si se perdieron posiciones, ni si fue Infura down total vs rate-limit. **Si surge el detalle, capturarlo retroactivamente.**

### Cambio v13.21 (commit `4b76fb2`, pusheado)

Split del transporte RPC único en **dos clientes** en `src/core/rpc.js`:
- `publicClient` (discovery / watchers / snapshots / price quotes): `primary + RPC_URL_FALLBACK` solamente. **Nunca** toca el RPC público → el polling constante de discovery no quema el rate-limit budget del público.
- `swapPublicClient` (executor, adapters, sniper sell-retry, watchdog, dailyCleanup, nonceManager, permit2, waitForAllowance): `primary + RPC_URL_FALLBACK + RPC_URL_SWAP_FALLBACK`. Un swap puede aterrizar aunque Infura degrade, con el RPC público como **last resort estricto** (viem fallback default `rank:false`, solo avanza en fallo).

Detalles:
- `buildTransport(urls)` parametrizado + `dedupe()`. 14 archivos de swap-path re-importan `swapPublicClient as publicClient`. 7 archivos de discovery quedan en `publicClient`.
- `swapFallback` es `optional()` → si queda vacío, `swapPublicClient` === `publicClient` (backward-compatible, cero cambio).
- Efecto colateral menor: `checkBondingCurve` (safety Virtuals) ahora lee vía `swapPublicClient` porque reusa los `quote*` del adapter virtuals; `simulateRoundtrip` (safety V2/V3/V4) sigue en discovery `publicClient`. Inofensivo (read-only), inconsistencia de clasificación no corregida.
- Tests 297/297.

### Fix del `.env.example` (parte de este commit)

El example original ponía el **mismo nodo público en los dos fallbacks** (`RPC_URL_FALLBACK` Y `RPC_URL_SWAP_FALLBACK` = publicnode). Eso (a) metía discovery en el público —rompiendo la premisa del split— y (b) `dedupe` colapsaba el swap client al de discovery, anulando el feature. Corregido: `RPC_URL_FALLBACK=` vacío, público solo en `RPC_URL_SWAP_FALLBACK`, + comentario inline documentando cada knob.

**Acción requerida en `.env` real:** agregar `RPC_URL_SWAP_FALLBACK=https://base-rpc.publicnode.com` y vaciar el público de `RPC_URL_FALLBACK`. Sin esto el bot corre igual pero v13.21 no hace nada.

### Nuevas env vars

- `RPC_URL_SWAP_FALLBACK` — fallback solo-swap. Slot seguro para RPC público.
- `RPC_URL_FALLBACK` — ahora explícitamente "todo cliente"; usar vacío o backup PAGO.

### Pickup point

Repo pusheado al main (`4b76fb2`). DB persistida. Daemon parado. Tests 297/297. SilverBullet actualizado a v13.21 ([[decisions/2026-06-14-v13.21-rpc-fallback-split]]).

**Pendiente inmediato:** Agustin va a correr el daemon esta noche (real, fondos reales) — primera corrida con v13.21. Antes debe editar su `.env` real con el nuevo knob. Sugerido: `npm run dry-run` para verificar boot limpio antes del `npm start`.

**Gap abierto:** forensics del outage 2026-06-01 (ver arriba).

## Session 2026-06-15 — forensics outage RESUELTO (era sleep, no Infura) + v13.22 no-route notify suppression

### Contexto
Carga de contexto + dos tareas encadenadas: (1) cerrar el gap de forensics del "outage de Infura 2026-06-01" usando el `data/daemon-2026-06-01.log` (6.9MB, que seguía en disco); (2) Agustin reportó spam de `no route found` / `price quote fail` en Telegram que "no pasaba en versiones anteriores".

### Hallazgo 1 — el "outage de Infura" NO fue Infura. Fue **sleep de la máquina**.

Evidencia convergente:
- **Windows Power-Troubleshooter** (fuente dura): `Sleep 2026-06-01T02:55:15Z → Wake 2026-06-01T11:53:02Z` = ~8h58m de suspend. Wake Source: Unknown.
- **Log del daemon**: silencio total `04:51:14 → 12:08:05` (~7h17m, reloj local). **Mismo proceso** (no hay línea de boot en el gap). El `metrics snapshot` corre cada 5min como reloj hasta 04:51:03 y después nada hasta 12:08:05 — un `setInterval` no se saltea 7h con el event loop vivo. Al despertar: 12.576 watcher-errors en 1h (re-suscripción de filtros expirados) + 40 trades reanudados.
- Los últimos errores antes del freeze eran `HTTP request failed … fetch failed` a Infura = stack de red local cayendo al suspender, NO Infura devolviendo 4xx/5xx.

**Implicación incómoda:** v13.21 (split RPC con público como fallback) está **mal motivado**. Durante un sleep no corre nada — un fallback de RPC no ayuda a un proceso suspendido, y al despertar la recuperación de filtros de viem ya self-healed sola. v13.21 no es dañino (sigue siendo resiliencia razonable para una degradación real de Infura) pero **no habría prevenido ni mitigado este incidente**. Mitigación real = OS-level: `powercfg /change standby-timeout-ac 0` (+ hibernate off) mientras corre el daemon, o correr headless en máquina que no duerme.

### Hallazgo 2 — el spam de Telegram es `no route found` del **sniper**, no aging

- `price quote failed; valuing at 0` → **`logger.warn` puro** (balanceTracker.js:58), NUNCA va a Telegram. Lo que ve en consola (pino-pretty stdout), no Telegram. Falsa alarma.
- `no route found` → SÍ va a Telegram vía `executor.notifyError` en el catch de `status:failed` cuando `!silentOnFail`. Path existe **desde el commit inicial** — no es regresión de código.
- **Atribución correcta (timestamp + walletId): 80/82 fallos no-route eran SNIPER clanker fanout buys** cayendo al fallback UR antes de que el pool fresco rutee (los otros 2, aging). `fireOneSniperBuy` arma el plan **sin `silentOnFail`** → cada miss esperado pingueaba Telegram.
  - **Nota metodológica**: mi primera atribución dio "todo aging / 15:1 buy" — estaba MAL (grep `-B14` contaminado con campos de bloques vecinos + bug en awk de proximidad por líneas). El `execution failed` log NO trae `side` ni `source`. La atribución por timestamp+walletId es la válida. Lección registrable: no atribuir por distancia-en-líneas cuando hay log intercalado (watchers/fanout).

### Cambio v13.22 (commit `c9580f7`, pusheado)
`src/core/executor.js`:
- `NO_NOTIFY_FAILURE_RE = /no route found/i` + predicado puro exportado `shouldNotifyFailure(errMessage, silentOnFail)`.
- Gateado el `notifyError` del catch genérico de `failed`. **NO tocado**: path `OnChainRevert` (revert gasta gas ≠ no-route), plan de buy del sniper, y fallos accionables tipo "wallet sin gas" — todos siguen notificando.
- `logger.error` + `inc("trade",{status:"failed"})` **preservados** → la tasa de no-route sigue observable (Agustin quiere monitorearla a futuro para detectar si UR/AlphaRouter empieza a fallar de más).
- `test/unit/executor.test.js`: +5 tests del predicado. **302/302**.

### Rechazado
- **Opción B** (filtrar aging buy-pool con noRouteCache) — el usuario la eligió primero, pero la atribución corregida mostró que rinde ~2% (solo 2/82 son aging). Diferida como mejora de eficiencia separada, no como fix del spam.
- **Opción A′** (silentOnFail en sniper buy) — equivalente pero más invasiva; A cubre 100% en un punto.

### Pendientes / follow-ups
- **Monitor de no-route rate** (cuando Agustin diga): contador dedicado `inc("trade",{status:"failed",reason:"no-route"})` o script pasivo estilo `clanker-window-tracker.js` que compute no-route rate por fuente/hora sobre la DB. Para validar que el 80/82 no escale.
- **Prevenir sleep de la máquina** mientras corre el daemon (raíz del incidente 06-01). Operacional, no código.
- v13.21 sigue sin su primera corrida real validada (la del 06-01 fue pre-v13.21 y murió por sleep).

### Pickup point
Repo pusheado a main: `c9580f7` (v13.22). DB persistida. Tests 302/302. SilverBullet actualizado ([[decisions/2026-06-15-v13.22-no-route-notify-suppression]]) + gap de forensics del 06-01 cerrado retroactivamente en [[decisions/2026-06-14-v13.21-rpc-fallback-split]].
