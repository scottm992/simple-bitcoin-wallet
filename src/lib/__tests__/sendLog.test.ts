/**
 * sendLog.test.ts — the local send record (F15).
 *
 * The log is the Speed-up flow's verification baseline: what THIS wallet
 * broadcast, keyed by txid, per network. These tests prove the storage
 * behavior the security fix depends on: round-tripping (bigint-exact),
 * per-network isolation (practice/live never cross), the bounded-size
 * eviction, best-effort failure (a broken localStorage returns false, never
 * throws), corruption tolerance (degrades to "no record", self-heals on the
 * next write), and bech32 case normalization.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getSendRecord,
  MAX_SEND_RECORDS_PER_NETWORK,
  normalizeRecipientAddress,
  recordSend,
  SEND_LOG_STORAGE_KEY,
} from '../sendLog';

const TXID = 'ab'.repeat(32);
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

function txidN(n: number): string {
  return n.toString(16).padStart(64, '0');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('recordSend / getSendRecord — round trip', () => {
  it('stores and returns the record exactly (bigint amount preserved)', () => {
    expect(recordSend('mainnet', TXID, { recipient: RECIPIENT, amountSats: 80_000n })).toBe(true);
    expect(getSendRecord('mainnet', TXID)).toEqual({ recipient: RECIPIENT, amountSats: 80_000n });
  });

  it('returns null for a txid never recorded', () => {
    expect(getSendRecord('mainnet', TXID)).toBeNull();
  });

  it('replaces (not duplicates) a record for the same txid — an idempotent re-broadcast', () => {
    recordSend('mainnet', TXID, { recipient: RECIPIENT, amountSats: 80_000n });
    recordSend('mainnet', TXID, { recipient: RECIPIENT, amountSats: 80_000n });
    expect(getSendRecord('mainnet', TXID)).toEqual({ recipient: RECIPIENT, amountSats: 80_000n });
    const doc = JSON.parse(localStorage.getItem(SEND_LOG_STORAGE_KEY) ?? '{}') as {
      mainnet: unknown[];
    };
    expect(doc.mainnet).toHaveLength(1);
  });
});

describe('per-network isolation (practice and live never cross)', () => {
  it('a mainnet record is invisible on testnet, and vice versa', () => {
    recordSend('mainnet', TXID, { recipient: RECIPIENT, amountSats: 80_000n });
    expect(getSendRecord('testnet', TXID)).toBeNull();

    const tTxid = 'cd'.repeat(32);
    recordSend('testnet', tTxid, { recipient: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', amountSats: 5_000n });
    expect(getSendRecord('mainnet', tTxid)).toBeNull();
    // Neither network's write clobbered the other's records.
    expect(getSendRecord('mainnet', TXID)).not.toBeNull();
    expect(getSendRecord('testnet', tTxid)).not.toBeNull();
  });
});

describe('bounded storage — oldest-first eviction', () => {
  it(`keeps only the most recent ${MAX_SEND_RECORDS_PER_NETWORK} records per network`, () => {
    for (let i = 0; i < MAX_SEND_RECORDS_PER_NETWORK + 1; i++) {
      recordSend('mainnet', txidN(i), { recipient: RECIPIENT, amountSats: BigInt(i + 1) });
    }
    // The oldest record was evicted; the newest and the second-oldest survive.
    expect(getSendRecord('mainnet', txidN(0))).toBeNull();
    expect(getSendRecord('mainnet', txidN(1))).toEqual({ recipient: RECIPIENT, amountSats: 2n });
    expect(
      getSendRecord('mainnet', txidN(MAX_SEND_RECORDS_PER_NETWORK)),
    ).toEqual({ recipient: RECIPIENT, amountSats: BigInt(MAX_SEND_RECORDS_PER_NETWORK + 1) });
    const doc = JSON.parse(localStorage.getItem(SEND_LOG_STORAGE_KEY) ?? '{}') as {
      mainnet: unknown[];
    };
    expect(doc.mainnet).toHaveLength(MAX_SEND_RECORDS_PER_NETWORK);
  });
});

describe('best-effort failure and corruption tolerance', () => {
  it('returns false (never throws) when storage writes fail', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
    });
    expect(recordSend('mainnet', TXID, { recipient: RECIPIENT, amountSats: 80_000n })).toBe(false);
  });

  it('treats a corrupted document as empty and self-heals on the next write', () => {
    localStorage.setItem(SEND_LOG_STORAGE_KEY, 'not json at all');
    expect(getSendRecord('mainnet', TXID)).toBeNull();
    expect(recordSend('mainnet', TXID, { recipient: RECIPIENT, amountSats: 80_000n })).toBe(true);
    expect(getSendRecord('mainnet', TXID)).toEqual({ recipient: RECIPIENT, amountSats: 80_000n });
  });

  it('skips malformed entries but keeps well-formed ones', () => {
    localStorage.setItem(
      SEND_LOG_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        mainnet: [
          { txid: 'nope', recipient: RECIPIENT, amountSats: '1' }, // bad txid
          { txid: TXID, recipient: RECIPIENT, amountSats: 80000 }, // amount not a string
          { txid: TXID, recipient: RECIPIENT, amountSats: '80000' }, // good
        ],
        testnet: [],
      }),
    );
    expect(getSendRecord('mainnet', TXID)).toEqual({ recipient: RECIPIENT, amountSats: 80_000n });
  });
});

describe('normalizeRecipientAddress — bech32 case, base58 preserved', () => {
  it('lowercases bech32 (BIP173 case-insensitivity) and trims whitespace', () => {
    expect(normalizeRecipientAddress(` ${RECIPIENT.toUpperCase()} `)).toBe(RECIPIENT);
    expect(normalizeRecipientAddress('tb1QW508D6QEJxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(
      'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
    );
  });

  it('preserves base58 (case-sensitive) verbatim', () => {
    expect(normalizeRecipientAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(
      '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
    );
  });

  it('an uppercase bech32 recipient recorded at send time still matches later', () => {
    recordSend('mainnet', TXID, { recipient: RECIPIENT.toUpperCase(), amountSats: 80_000n });
    const rec = getSendRecord('mainnet', TXID);
    expect(rec?.recipient).toBe(RECIPIENT); // stored canonical (lowercase)
  });
});
