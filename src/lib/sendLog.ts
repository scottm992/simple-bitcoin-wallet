/**
 * sendLog.ts — the local send record (F15).
 *
 * A NON-SECRET, per-network localStorage log of this wallet's own broadcasts:
 * txid → { recipient, amountSats }. Written at broadcast time — the one moment
 * the destination is known from the USER's own confirmed input rather than
 * from any server — and read back by the Speed-up flow, which refuses to bump
 * a payment whose API-reported recipient/amount don't match the record. This
 * is what stops a hostile chain API from substituting an attacker's address
 * into a fee bump: the wallet never signs a bump to a destination it didn't
 * itself send to.
 *
 * Deliberately its own tiny module with its own storage key — vault.ts (the
 * audited crypto module) is untouched. Nothing here is secret: recipients and
 * amounts of our own outgoing transactions are already public on-chain data,
 * exactly like the cached scan indexes stored alongside the vault.
 *
 * Storage is bounded ({@link MAX_SEND_RECORDS_PER_NETWORK} most-recent records
 * per network) and best-effort: a write failure must NEVER break broadcasting
 * — callers get `false` back and the payment itself is unaffected (it just
 * won't be speed-up-able later; see prepareBump's 'unverified' dead-end).
 */
import type { Network } from './wallet';

/** The localStorage key holding the send log (versioned JSON document). */
export const SEND_LOG_STORAGE_KEY = 'sbw.sends.v1';

/**
 * Most-recent records kept per network. 200 outgoing payments is far beyond
 * anything still pending (only pending payments can be bumped); older records
 * are evicted oldest-first so storage stays bounded forever.
 */
export const MAX_SEND_RECORDS_PER_NETWORK = 200;

/** What this wallet knows, first-hand, about one of its own broadcasts. */
export interface SendRecord {
  /** The recipient address the user confirmed at send time (normalized). */
  readonly recipient: string;
  /** The amount actually paid to that recipient, in sats. */
  readonly amountSats: bigint;
}

/** One stored entry (JSON-safe: bigint kept as a decimal string). */
interface StoredEntry {
  readonly txid: string;
  readonly recipient: string;
  readonly amountSats: string;
}

/** The versioned document under {@link SEND_LOG_STORAGE_KEY}. */
interface StoredDoc {
  readonly version: 1;
  readonly mainnet: StoredEntry[];
  readonly testnet: StoredEntry[];
}

/**
 * Canonicalizes a recipient address for storage/comparison. Bech32/bech32m is
 * case-insensitive (BIP173: all-upper and all-lower are both valid), and the
 * chain API always reports the lowercase form — so bech32-looking addresses
 * are lowercased to prevent a false mismatch when the user typed an uppercase
 * address. Base58 (legacy) is case-SENSITIVE and preserved verbatim.
 */
export function normalizeRecipientAddress(address: string): string {
  const trimmed = address.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('bc1') || lower.startsWith('tb1')) return lower;
  return trimmed;
}

function emptyDoc(): StoredDoc {
  return { version: 1, mainnet: [], testnet: [] };
}

/**
 * Validates stored entries on read. The log lives in same-origin localStorage
 * (not attacker-supplied in our threat model), but a corrupted or hand-edited
 * document must degrade to "no record" (a fail-safe dead-end), never a crash.
 */
function sanitizeEntries(v: unknown): StoredEntry[] {
  if (!Array.isArray(v)) return [];
  const out: StoredEntry[] = [];
  for (const e of v) {
    if (typeof e !== 'object' || e === null) continue;
    const entry = e as Record<string, unknown>;
    const txid = entry['txid'];
    const recipient = entry['recipient'];
    const amountSats = entry['amountSats'];
    if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid)) continue;
    if (typeof recipient !== 'string' || recipient.length === 0 || recipient.length > 100) continue;
    // ≤ 16 decimal digits covers the 21M-BTC supply (2.1e15 sats).
    if (typeof amountSats !== 'string' || !/^\d{1,16}$/.test(amountSats)) continue;
    out.push({ txid, recipient, amountSats });
    if (out.length >= MAX_SEND_RECORDS_PER_NETWORK) break;
  }
  return out;
}

/** Reads the document, tolerating absence/corruption (→ empty, self-healing). */
function readDoc(): StoredDoc {
  try {
    const raw = localStorage.getItem(SEND_LOG_STORAGE_KEY);
    if (raw === null) return emptyDoc();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyDoc();
    const doc = parsed as Record<string, unknown>;
    return {
      version: 1,
      mainnet: sanitizeEntries(doc['mainnet']),
      testnet: sanitizeEntries(doc['testnet']),
    };
  } catch {
    return emptyDoc();
  }
}

/**
 * Records one broadcast: txid → recipient + amount, per network (practice and
 * live never mix). A record for the same txid is replaced (an idempotent
 * re-broadcast writes identical data); the list is capped at
 * {@link MAX_SEND_RECORDS_PER_NETWORK}, evicting oldest-first.
 *
 * @returns `true` when persisted; `false` on any storage failure (quota,
 *   disabled storage, …). Best-effort by design: the caller's broadcast has
 *   already succeeded and must not be failed retroactively — but the caller
 *   surfaces the `false` so verification coverage is never silently lost.
 */
export function recordSend(network: Network, txid: string, record: SendRecord): boolean {
  try {
    const doc = readDoc();
    const list = doc[network].filter((e) => e.txid !== txid);
    list.push({
      txid,
      recipient: normalizeRecipientAddress(record.recipient),
      amountSats: record.amountSats.toString(),
    });
    while (list.length > MAX_SEND_RECORDS_PER_NETWORK) list.shift();
    const next: StoredDoc =
      network === 'mainnet' ? { ...doc, mainnet: list } : { ...doc, testnet: list };
    localStorage.setItem(SEND_LOG_STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/**
 * Looks up the record for one txid on one network. `null` means "this device
 * never broadcast that transaction" (or the record was evicted/corrupted) —
 * callers treat that as fail-safe "cannot verify", never as permission.
 */
export function getSendRecord(network: Network, txid: string): SendRecord | null {
  const entry = readDoc()[network].find((e) => e.txid === txid);
  if (entry === undefined) return null;
  try {
    return { recipient: entry.recipient, amountSats: BigInt(entry.amountSats) };
  } catch {
    return null;
  }
}

/**
 * Removes the entire send log (both networks). Part of the wallet-removal
 * wipe (F23, round 19): the log maps this DEVICE to the wallet's on-chain
 * txid cluster, so leaving it behind after "Remove this wallet from this
 * phone" would quietly contradict the removal the user asked for. Best-effort
 * like every other sendLog write — a storage failure must never break the
 * wipe itself.
 */
export function clearSendLog(): void {
  try {
    localStorage.removeItem(SEND_LOG_STORAGE_KEY);
  } catch {
    /* storage unavailable — nothing to clear or nothing we can do */
  }
}
