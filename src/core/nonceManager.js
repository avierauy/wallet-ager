import { publicClient } from "./rpc.js";

// Per-wallet nonce state held in memory. On startup we read the chain's "pending" nonce; from
// then on we increment locally and only resync when we detect drift (or on explicit refresh).
// SQLite isn't authoritative — the chain is. Crash recovery just refetches.
const states = new Map(); // lowercaseAddress -> { next: number, inFlight: Set<number> }
const locks = new Map();  // lowercaseAddress -> Promise (serializes per-wallet tx submission)

const key = (account) => account.address.toLowerCase();

const ensure = async (account) => {
  const k = key(account);
  let s = states.get(k);
  if (s) return s;
  const next = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  s = { next, inFlight: new Set() };
  states.set(k, s);
  return s;
};

// withWalletLock: serializes operations per wallet. Two parallel callers for the same wallet
// will run sequentially; different wallets run concurrently.
export const withWalletLock = async (account, fn) => {
  const k = key(account);
  const prev = locks.get(k) ?? Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  locks.set(k, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Clean up if no one else queued behind us.
    if (locks.get(k) === gate) locks.delete(k);
  }
};

export const reserveNonce = async (account) => {
  const s = await ensure(account);
  const nonce = s.next++;
  s.inFlight.add(nonce);
  return nonce;
};

// Call after the tx is sent (regardless of confirmation) so we can clean up tracking.
// If `broadcast=false` (we never made it to the wire), we attempt to roll the counter back so
// the nonce isn't permanently skipped.
export const releaseNonce = (account, nonce, { broadcast }) => {
  const s = states.get(key(account));
  if (!s) return;
  s.inFlight.delete(nonce);
  if (!broadcast && s.next === nonce + 1 && s.inFlight.size === 0) {
    s.next = nonce;
  }
};

// Resync the local nonce with the chain. Use when we see NonceTooLow / known-from-pool errors.
export const resyncNonce = async (account) => {
  const s = await ensure(account);
  const chainNext = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  if (chainNext > s.next) s.next = chainNext;
  return s.next;
};

export const getState = (account) => states.get(key(account));

// Test/maintenance helper — drop in-memory state so the next access refetches.
export const _clearState = () => {
  states.clear();
  locks.clear();
};
