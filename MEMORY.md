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
  - Virtuals post-grad → router custom `0xc8f6...9265` (selector `0xf2c42696`).
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
