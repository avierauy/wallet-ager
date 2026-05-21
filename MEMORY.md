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
