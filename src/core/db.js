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
