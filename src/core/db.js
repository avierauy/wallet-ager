import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";

const configured = config.db.path;
const isMemory = configured === ":memory:";
const dbPath = isMemory ? configured : resolve(configured);
if (!isMemory) mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// Live migration — add columns added after the original schema was deployed.
const ensureColumn = (table, column, definition) => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((r) => r.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};
try {
  // Only attempt migration if the table already exists. The CREATE TABLE below handles fresh dbs.
  const existing = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='discovered_tokens'`).get();
  if (existing) ensureColumn("discovered_tokens", "pool_metadata", "TEXT");
} catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_state (
    wallet_id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    last_nonce INTEGER,
    last_action_at INTEGER,
    next_action_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id TEXT NOT NULL,
    dex TEXT NOT NULL,
    side TEXT NOT NULL,
    token_in TEXT NOT NULL,
    token_out TEXT NOT NULL,
    amount_in TEXT NOT NULL,
    amount_out_min TEXT NOT NULL,
    tx_hash TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    confirmed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

  CREATE TABLE IF NOT EXISTS approvals (
    wallet_id TEXT NOT NULL,
    token TEXT NOT NULL,
    spender TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    PRIMARY KEY (wallet_id, token, spender)
  );

  CREATE TABLE IF NOT EXISTS wallet_balance_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id TEXT NOT NULL,
    is_initial INTEGER NOT NULL,
    native_wei TEXT NOT NULL,
    tokens_value_wei TEXT NOT NULL,
    total_wei TEXT NOT NULL,
    block_number INTEGER,
    taken_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_wallet ON wallet_balance_snapshots(wallet_id, taken_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_initial
    ON wallet_balance_snapshots(wallet_id) WHERE is_initial = 1;

  CREATE TABLE IF NOT EXISTS discovered_tokens (
    address TEXT COLLATE NOCASE NOT NULL,
    chain TEXT NOT NULL,
    symbol TEXT,
    decimals INTEGER NOT NULL,
    tradeable_on TEXT NOT NULL,
    virtuals_state TEXT,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    pool_metadata TEXT,
    discovered_at INTEGER NOT NULL,
    safety_checked_at INTEGER,
    last_traded_at INTEGER,
    ttl_expires_at INTEGER,
    PRIMARY KEY (address, chain)
  );

  CREATE INDEX IF NOT EXISTS idx_discovered_status ON discovered_tokens(status, chain);

  CREATE TABLE IF NOT EXISTS daily_allowances (
    wallet_id TEXT NOT NULL,
    date TEXT NOT NULL,
    allowance INTEGER NOT NULL,
    sampled_at INTEGER NOT NULL,
    PRIMARY KEY (wallet_id, date)
  );

  CREATE TABLE IF NOT EXISTS token_safety (
    token TEXT COLLATE NOCASE NOT NULL,
    chain TEXT NOT NULL,
    is_safe INTEGER NOT NULL,
    is_honeypot INTEGER,
    buy_tax REAL,
    sell_tax REAL,
    transfer_tax REAL,
    simulation_success INTEGER,
    risk_level INTEGER,
    raw_response TEXT,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (token, chain)
  );
`);

export const upsertTokenSafety = (row) =>
  db
    .prepare(
      `INSERT OR REPLACE INTO token_safety
       (token, chain, is_safe, is_honeypot, buy_tax, sell_tax, transfer_tax,
        simulation_success, risk_level, raw_response, checked_at)
       VALUES (@token, @chain, @is_safe, @is_honeypot, @buy_tax, @sell_tax, @transfer_tax,
               @simulation_success, @risk_level, @raw_response, @checked_at)`
    )
    .run(row);

export const getTokenSafety = ({ token, chain }) =>
  db.prepare(`SELECT * FROM token_safety WHERE token = ? AND chain = ?`).get(token, chain);

export const insertBalanceSnapshot = (row) =>
  db
    .prepare(
      `INSERT INTO wallet_balance_snapshots
       (wallet_id, is_initial, native_wei, tokens_value_wei, total_wei, block_number, taken_at)
       VALUES (@wallet_id, @is_initial, @native_wei, @tokens_value_wei, @total_wei, @block_number, @taken_at)`
    )
    .run(row);

export const getInitialSnapshot = (walletId) =>
  db
    .prepare(`SELECT * FROM wallet_balance_snapshots WHERE wallet_id = ? AND is_initial = 1`)
    .get(walletId);

export const getLatestSnapshot = (walletId) =>
  db
    .prepare(
      `SELECT * FROM wallet_balance_snapshots WHERE wallet_id = ? ORDER BY taken_at DESC LIMIT 1`
    )
    .get(walletId);

// Source preserves a launchpad-specific label even if a generic listener (e.g. uniswap V4
// Initialize) fires later for the same token. Clanker / Doppler / Virtuals labels stick;
// generic uniswap-vX labels yield to launchpad ones.
export const upsertDiscoveredToken = (row) =>
  db
    .prepare(
      `INSERT INTO discovered_tokens
        (address, chain, symbol, decimals, tradeable_on, virtuals_state, source, status,
         pool_metadata, discovered_at, safety_checked_at, last_traded_at, ttl_expires_at)
       VALUES (@address, @chain, @symbol, @decimals, @tradeable_on, @virtuals_state, @source, @status,
               @pool_metadata, @discovered_at, @safety_checked_at, @last_traded_at, @ttl_expires_at)
       ON CONFLICT(address, chain) DO UPDATE SET
         symbol            = excluded.symbol,
         decimals          = excluded.decimals,
         tradeable_on      = excluded.tradeable_on,
         virtuals_state    = excluded.virtuals_state,
         source            = CASE
           WHEN discovered_tokens.source LIKE 'clanker-%'
             OR discovered_tokens.source LIKE 'doppler-%'
             OR discovered_tokens.source LIKE 'virtuals-%'
           THEN discovered_tokens.source
           ELSE excluded.source
         END,
         status            = excluded.status,
         pool_metadata     = COALESCE(excluded.pool_metadata, discovered_tokens.pool_metadata),
         safety_checked_at = excluded.safety_checked_at,
         last_traded_at    = COALESCE(excluded.last_traded_at, discovered_tokens.last_traded_at),
         ttl_expires_at    = excluded.ttl_expires_at`
    )
    .run(row);

export const listDiscoveredTokens = ({ chain, status }) => {
  const rows = status
    ? db
        .prepare(`SELECT * FROM discovered_tokens WHERE chain = ? AND status = ?`)
        .all(chain, status)
    : db.prepare(`SELECT * FROM discovered_tokens WHERE chain = ?`).all(chain);
  return rows;
};

export const setDiscoveredTokenStatus = ({ address, chain, status }) =>
  db
    .prepare(
      `UPDATE discovered_tokens SET status = ? WHERE address = ? AND chain = ?`
    )
    .run(status, address, chain);

export const touchDiscoveredTradedAt = ({ address, chain, at }) =>
  db
    .prepare(
      `UPDATE discovered_tokens SET last_traded_at = ? WHERE address = ? AND chain = ?`
    )
    .run(at, address, chain);

export const touchDiscoveredSafetyAt = ({ address, chain, at }) =>
  db
    .prepare(
      `UPDATE discovered_tokens SET safety_checked_at = ? WHERE address = ? AND chain = ?`
    )
    .run(at, address, chain);

export const recordApproval = (row) =>
  db
    .prepare(
      `INSERT OR REPLACE INTO approvals (wallet_id, token, spender, tx_hash, granted_at)
       VALUES (@wallet_id, @token, @spender, @tx_hash, @granted_at)`
    )
    .run(row);

export const hasApproval = ({ wallet_id, token, spender }) =>
  !!db
    .prepare(
      `SELECT 1 FROM approvals WHERE wallet_id = ? AND lower(token) = lower(?) AND lower(spender) = lower(?)`
    )
    .get(wallet_id, token, spender);

// Drop all approval rows for a given token (across wallets/spenders). Called by the
// sweeper when a token is marked EXPIRED or UNSAFE — we never trade those again, so
// the approval cache row is stale forever. Returns the number of rows removed.
export const deleteApprovalsForToken = (token) =>
  db.prepare(`DELETE FROM approvals WHERE lower(token) = lower(?)`).run(token).changes;

export const insertTrade = (row) =>
  db
    .prepare(
      `INSERT INTO trades (wallet_id, dex, side, token_in, token_out, amount_in, amount_out_min, status, created_at)
       VALUES (@wallet_id, @dex, @side, @token_in, @token_out, @amount_in, @amount_out_min, @status, @created_at)`
    )
    .run(row).lastInsertRowid;

export const updateTrade = (id, patch) => {
  const cols = Object.keys(patch);
  const sql = `UPDATE trades SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`;
  db.prepare(sql).run({ ...patch, id });
};

// --- Daily allowance persistence -------------------------------------------------
// `used` count for a wallet on `date` is always derived live from the trades table —
// authoritative single source of truth. We persist only the sampled allowance so the
// cap stays stable across daemon restarts within the same UTC day.

export const getDailyAllowance = ({ wallet_id, date }) =>
  db
    .prepare(`SELECT allowance FROM daily_allowances WHERE wallet_id = ? AND date = ?`)
    .get(wallet_id, date)?.allowance ?? null;

export const upsertDailyAllowance = ({ wallet_id, date, allowance, sampled_at = Date.now() }) =>
  db
    .prepare(
      `INSERT OR REPLACE INTO daily_allowances (wallet_id, date, allowance, sampled_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(wallet_id, date, allowance, sampled_at);

// Count buys that were actually broadcast (status='submitted') by this wallet on the
// given UTC date. Aging-mode + sniper buys all flow through insertTrade so this captures
// both. Dry-run trades are also marked 'submitted' from the executor's perspective and
// should count toward the daily cap.
export const countSubmittedBuysOnDate = ({ wallet_id, date }) => {
  // SQLite has no native UTC date helper from a millisecond epoch — convert in SQL:
  // (created_at / 1000) is unix seconds; strftime('%Y-%m-%d', ., 'unixepoch') gives UTC.
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM trades
       WHERE wallet_id = ?
         AND side = 'buy'
         AND status IN ('submitted', 'dry-run')
         AND strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') = ?`
    )
    .get(wallet_id, date);
  return row?.n ?? 0;
};
