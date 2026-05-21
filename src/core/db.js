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
    discovered_at INTEGER NOT NULL,
    safety_checked_at INTEGER,
    last_traded_at INTEGER,
    ttl_expires_at INTEGER,
    PRIMARY KEY (address, chain)
  );

  CREATE INDEX IF NOT EXISTS idx_discovered_status ON discovered_tokens(status, chain);

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

export const upsertDiscoveredToken = (row) =>
  db
    .prepare(
      `INSERT INTO discovered_tokens
        (address, chain, symbol, decimals, tradeable_on, virtuals_state, source, status,
         discovered_at, safety_checked_at, last_traded_at, ttl_expires_at)
       VALUES (@address, @chain, @symbol, @decimals, @tradeable_on, @virtuals_state, @source, @status,
               @discovered_at, @safety_checked_at, @last_traded_at, @ttl_expires_at)
       ON CONFLICT(address, chain) DO UPDATE SET
         symbol            = excluded.symbol,
         decimals          = excluded.decimals,
         tradeable_on      = excluded.tradeable_on,
         virtuals_state    = excluded.virtuals_state,
         source            = excluded.source,
         status            = excluded.status,
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
