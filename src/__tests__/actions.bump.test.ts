/**
 * actions.bump.test.ts — prepareBump / bumpAndBroadcast (the Speed-up flow's
 * coordination layer).
 *
 * Proves, with getTransaction and broadcastTx mocked (no real network):
 *  - prepareBump costs exactly ONE getTransaction call;
 *  - confirmed / non-signaling / foreign-input transactions are rejected with
 *    the right machine-readable CannotBumpError reason;
 *  - input prevout addresses are mapped to derivation paths by LOCAL
 *    derivation over BOTH chains, including addresses past the high-water mark
 *    but inside the gap window (zero network requests for the mapping);
 *  - output classification: external recipient + our change; the self-send
 *    edge (receive-chain output = recipient, change-chain output = change);
 *    the self-sweep single-output edge; and honest unsupported-shape
 *    dead-ends;
 *  - bumpAndBroadcast threads allowHighFee with send-identical semantics and
 *    never broadcasts when the engine rejects.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock only the two endpoints this flow touches; the rest of api.ts stays real.
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    getTransaction: vi.fn(),
    broadcastTx: vi.fn(async (_network: 'mainnet' | 'testnet', _txHex: string) => 'f'.repeat(64)),
  };
});

import { prepareBump, bumpAndBroadcast } from '../actions';
import { broadcastTx, getTransaction } from '../lib/api';
import {
  CannotBumpError,
  FeeTooHighError,
  deriveAddress,
  getSendRecord,
  recordSend,
  type AccountSnapshot,
  type ApiTransaction,
} from '../lib';
import { setUnlocked, lockNow } from '../session';

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Our addresses (local derivation, both chains).
const r0 = deriveAddress(ABANDON, 'mainnet', 0, 0); // receive #0 (used)
const c0 = deriveAddress(ABANDON, 'mainnet', 1, 0); // change #0 (used)
const c1 = deriveAddress(ABANDON, 'mainnet', 1, 1); // change #1 — PAST the high-water mark, inside the gap window

// A genuinely foreign recipient (the BIP173 spec example P2WPKH — not derived
// from ABANDON on either chain).
const EXTERNAL = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
// A second foreign address (legacy, also not ours).
const EXTERNAL_2 = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

const PENDING_TXID = '11'.repeat(32);

const ACCOUNT: AccountSnapshot = {
  confirmedSats: 0n,
  pendingSats: 0n,
  utxos: [],
  receiveAddress: deriveAddress(ABANDON, 'mainnet', 0, 1).address,
  receiveIndex: 1,
  changeAddress: c1.address,
  activity: [],
  usedAddresses: [r0.address, c0.address],
  receiveHighWater: 0,
  changeHighWater: 0,
};

/** A well-formed pending tx of OURS: 2 inputs (one per chain), recipient + change. */
function makePendingTx(overrides: Partial<ApiTransaction> = {}): ApiTransaction {
  return {
    txid: PENDING_TXID,
    confirmed: false,
    feeSats: 1_000n,
    weight: 832,
    vsize: 208,
    vin: [
      { txid: 'aa'.repeat(32), vout: 0, sequence: 0xfffffffd, prevout: { value: 60_000n, address: r0.address } },
      { txid: 'bb'.repeat(32), vout: 1, sequence: 0xfffffffd, prevout: { value: 40_000n, address: c0.address } },
    ],
    vout: [
      { value: 80_000n, address: EXTERNAL },
      { value: 19_000n, address: c1.address },
    ],
    ...overrides,
  };
}

function mockTx(tx: ApiTransaction): void {
  vi.mocked(getTransaction).mockResolvedValue(tx);
}

/**
 * Seeds the F15 local send record for the payment being bumped — what this
 * wallet would have written at broadcast time. Happy-path prepareBump tests
 * need one (v1.1 writes a record for every send it broadcasts).
 */
function seedRecord(recipient: string, amountSats: bigint, txid: string = PENDING_TXID): void {
  expect(recordSend('mainnet', txid, { recipient, amountSats })).toBe(true);
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'did-not-throw';
  } catch (e) {
    expect(e).toBeInstanceOf(CannotBumpError);
    return (e as CannotBumpError).reason;
  }
}

afterEach(() => {
  lockNow();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('prepareBump — dead-end detection (typed reasons)', () => {
  it("a confirmed payment → 'confirmed'", async () => {
    setUnlocked(ABANDON);
    mockTx(makePendingTx({ confirmed: true }));
    expect(await reasonOf(prepareBump('mainnet', PENDING_TXID, ACCOUNT))).toBe('confirmed');
  });

  it("any input at 0xffffffff or 0xfffffffe (pre-v1.1 sends) → 'not-signaling'", async () => {
    setUnlocked(ABANDON);
    for (const seq of [0xffffffff, 0xfffffffe]) {
      const tx = makePendingTx();
      mockTx({ ...tx, vin: [tx.vin[0]!, { ...tx.vin[1]!, sequence: seq }] });
      expect(await reasonOf(prepareBump('mainnet', PENDING_TXID, ACCOUNT))).toBe('not-signaling');
    }
  });

  it("an input spending an address we don't derive → 'foreign-inputs'", async () => {
    setUnlocked(ABANDON);
    const tx = makePendingTx();
    mockTx({
      ...tx,
      vin: [tx.vin[0]!, { ...tx.vin[1]!, prevout: { value: 40_000n, address: EXTERNAL_2 } }],
    });
    expect(await reasonOf(prepareBump('mainnet', PENDING_TXID, ACCOUNT))).toBe('foreign-inputs');
  });

  it("an input with no prevout (coinbase-style) → 'foreign-inputs'", async () => {
    setUnlocked(ABANDON);
    const tx = makePendingTx();
    const noPrevout = { txid: tx.vin[1]!.txid, vout: 1, sequence: 0xfffffffd };
    mockTx({ ...tx, vin: [tx.vin[0]!, noPrevout] });
    expect(await reasonOf(prepareBump('mainnet', PENDING_TXID, ACCOUNT))).toBe('foreign-inputs');
  });

  it("shapes this wallet never builds → 'unsupported-shape'", async () => {
    setUnlocked(ABANDON);
    const base = makePendingTx();
    // Three outputs.
    mockTx({
      ...base,
      vout: [
        { value: 40_000n, address: EXTERNAL },
        { value: 30_000n, address: c1.address },
        { value: 29_000n, address: c0.address },
      ],
    });
    expect(await reasonOf(prepareBump('mainnet', PENDING_TXID, ACCOUNT))).toBe('unsupported-shape');
    // Two foreign recipients.
    mockTx({
      ...base,
      vout: [
        { value: 50_000n, address: EXTERNAL },
        { value: 49_000n, address: EXTERNAL_2 },
      ],
    });
    expect(await reasonOf(prepareBump('mainnet', PENDING_TXID, ACCOUNT))).toBe('unsupported-shape');
    // An output without an address (nonstandard script).
    mockTx({ ...base, vout: [{ value: 99_000n }] });
    expect(await reasonOf(prepareBump('mainnet', PENDING_TXID, ACCOUNT))).toBe('unsupported-shape');
    // Ambiguous self-send: two change-chain outputs.
    mockTx({
      ...base,
      vout: [
        { value: 50_000n, address: c0.address },
        { value: 49_000n, address: c1.address },
      ],
    });
    expect(await reasonOf(prepareBump('mainnet', PENDING_TXID, ACCOUNT))).toBe('unsupported-shape');
  });
});

describe('prepareBump — mapping and classification', () => {
  it('maps inputs to derivation paths over BOTH chains and identifies recipient/change — one fetch only', async () => {
    setUnlocked(ABANDON);
    seedRecord(EXTERNAL, 80_000n);
    mockTx(makePendingTx());
    const prepared = await prepareBump('mainnet', PENDING_TXID, ACCOUNT);

    // Exactly ONE network call (the tx fetch); the address map is local-only.
    expect(vi.mocked(getTransaction)).toHaveBeenCalledTimes(1);

    // Inputs mapped to signing paths, in order, values preserved.
    expect(prepared.utxos).toHaveLength(2);
    expect(prepared.utxos[0]).toEqual({
      txid: 'aa'.repeat(32),
      vout: 0,
      value: 60_000n,
      path: r0.path,
      address: r0.address,
    });
    expect(prepared.utxos[1]).toEqual({
      txid: 'bb'.repeat(32),
      vout: 1,
      value: 40_000n,
      path: c0.path,
      address: c0.address,
    });

    // Output classification: the foreign output is the recipient; ours is the
    // change — even though c1 (change #1) is PAST the high-water mark (0),
    // the gap window in the local map still recognizes it.
    expect(prepared.recipient).toBe(EXTERNAL);
    expect(prepared.recipientAmountSats).toBe(80_000n);
    expect(prepared.changeAddress).toBe(c1.address);
    expect(prepared.oldFeeSats).toBe(1_000n);
    expect(prepared.oldVsize).toBe(208);
    expect(prepared.oldRateSatVb).toBeCloseTo(1_000 / 208, 6);
    expect(prepared.txid).toBe(PENDING_TXID);
  });

  it('self-send: the receive-chain output is the recipient, the change-chain output is change', async () => {
    setUnlocked(ABANDON);
    seedRecord(r0.address, 50_000n);
    mockTx(
      makePendingTx({
        vout: [
          { value: 50_000n, address: r0.address },
          { value: 49_000n, address: c0.address },
        ],
      }),
    );
    const prepared = await prepareBump('mainnet', PENDING_TXID, ACCOUNT);
    expect(prepared.recipient).toBe(r0.address);
    expect(prepared.recipientAmountSats).toBe(50_000n);
    expect(prepared.changeAddress).toBe(c0.address);
  });

  it('self-sweep: a single all-ours output is simply the recipient (no change)', async () => {
    setUnlocked(ABANDON);
    seedRecord(r0.address, 99_000n);
    mockTx(makePendingTx({ vout: [{ value: 99_000n, address: r0.address }] }));
    const prepared = await prepareBump('mainnet', PENDING_TXID, ACCOUNT);
    expect(prepared.recipient).toBe(r0.address);
    expect(prepared.recipientAmountSats).toBe(99_000n);
    expect(prepared.changeAddress).toBeNull();
  });
});

describe('bumpAndBroadcast — build + broadcast threading', () => {
  it('builds the replacement from the prepared data, broadcasts real signed hex, and records the replacement (F15)', async () => {
    setUnlocked(ABANDON);
    seedRecord(EXTERNAL, 80_000n);
    mockTx(makePendingTx());
    const prepared = await prepareBump('mainnet', PENDING_TXID, ACCOUNT);

    const result = await bumpAndBroadcast({
      network: 'mainnet',
      prepared,
      feeRateSatVb: 20,
      allowHighFee: false,
    });
    expect(result.txid).toBe('f'.repeat(64));
    expect(result.sendRecorded).toBe(true);

    const mock = vi.mocked(broadcastTx);
    expect(mock).toHaveBeenCalledTimes(1);
    const [network, txHex] = mock.mock.calls[0] ?? [];
    expect(network).toBe('mainnet');
    expect(typeof txHex).toBe('string');
    expect((txHex as string).length).toBeGreaterThan(100);
    expect(/^[0-9a-f]+$/i.test(txHex as string)).toBe(true);

    // F15: the replacement got its OWN record under the RETURNED txid — same
    // (verified) recipient, same amount (change absorbed the bump).
    expect(getSendRecord('mainnet', result.txid)).toEqual({
      recipient: EXTERNAL,
      amountSats: 80_000n,
    });
  });

  it('the 25% consent rule blocks before broadcast without allowHighFee, and passes with it (F10 semantics)', async () => {
    setUnlocked(ABANDON);
    seedRecord(EXTERNAL, 5_000n);
    // Small recipient amount, large change: a 20 sat/vB bump fee (4,160 sats)
    // dwarfs the 5,000-sat payment → consent required.
    mockTx(
      makePendingTx({
        vout: [
          { value: 5_000n, address: EXTERNAL },
          { value: 94_000n, address: c1.address },
        ],
      }),
    );
    const prepared = await prepareBump('mainnet', PENDING_TXID, ACCOUNT);

    await expect(
      bumpAndBroadcast({ network: 'mainnet', prepared, feeRateSatVb: 20, allowHighFee: false }),
    ).rejects.toBeInstanceOf(FeeTooHighError);
    expect(vi.mocked(broadcastTx)).not.toHaveBeenCalled();

    const result = await bumpAndBroadcast({
      network: 'mainnet',
      prepared,
      feeRateSatVb: 20,
      allowHighFee: true,
    });
    expect(result.txid).toBe('f'.repeat(64));
    expect(vi.mocked(broadcastTx)).toHaveBeenCalledTimes(1);
  });

  it('a hostile rate stays blocked even with allowHighFee — nothing reaches broadcast', async () => {
    setUnlocked(ABANDON);
    seedRecord(EXTERNAL, 80_000n);
    mockTx(makePendingTx());
    const prepared = await prepareBump('mainnet', PENDING_TXID, ACCOUNT);
    await expect(
      bumpAndBroadcast({ network: 'mainnet', prepared, feeRateSatVb: 5_000, allowHighFee: true }),
    ).rejects.toBeInstanceOf(FeeTooHighError);
    expect(vi.mocked(broadcastTx)).not.toHaveBeenCalled();
  });
});

// --- F15: recipient verification against the local send record --------------

describe('prepareBump — F15 recipient verification (Round 8 exploit regression)', () => {
  it("the reviewer's exploit: a substituted recipient ADDRESS → 'recipient-mismatch', hard fail", async () => {
    setUnlocked(ABANDON);
    // What the user actually confirmed at send time:
    seedRecord(EXTERNAL, 80_000n);
    // A hostile getTransaction response: real owned inputs, real owned change,
    // same value — only the recipient address swapped for the attacker's.
    const tx = makePendingTx();
    mockTx({
      ...tx,
      vout: [
        { value: 80_000n, address: EXTERNAL_2 }, // attacker
        { value: 19_000n, address: c1.address },
      ],
    });
    expect(await reasonOf(prepareBump('mainnet', PENDING_TXID, ACCOUNT))).toBe(
      'recipient-mismatch',
    );
    expect(vi.mocked(broadcastTx)).not.toHaveBeenCalled();
  });

  it("a substituted recipient AMOUNT → 'recipient-mismatch', hard fail", async () => {
    setUnlocked(ABANDON);
    seedRecord(EXTERNAL, 80_000n);
    const tx = makePendingTx();
    mockTx({
      ...tx,
      vout: [
        { value: 79_000n, address: EXTERNAL }, // same address, wrong amount
        { value: 19_000n, address: c1.address },
      ],
    });
    expect(await reasonOf(prepareBump('mainnet', PENDING_TXID, ACCOUNT))).toBe(
      'recipient-mismatch',
    );
  });

  it("no local record (wallet restored on a new device) → 'unverified' honest dead-end", async () => {
    setUnlocked(ABANDON);
    mockTx(makePendingTx()); // nothing seeded
    expect(await reasonOf(prepareBump('mainnet', PENDING_TXID, ACCOUNT))).toBe('unverified');
  });

  it("a record on the OTHER network does not count (practice/live never cross) → 'unverified'", async () => {
    setUnlocked(ABANDON);
    expect(recordSend('testnet', PENDING_TXID, { recipient: EXTERNAL, amountSats: 80_000n })).toBe(
      true,
    );
    mockTx(makePendingTx());
    expect(await reasonOf(prepareBump('mainnet', PENDING_TXID, ACCOUNT))).toBe('unverified');
  });

  it('an uppercase-bech32 recipient recorded at send time still verifies (case normalization)', async () => {
    setUnlocked(ABANDON);
    seedRecord(EXTERNAL.toUpperCase(), 80_000n);
    mockTx(makePendingTx());
    const prepared = await prepareBump('mainnet', PENDING_TXID, ACCOUNT);
    expect(prepared.recipient).toBe(EXTERNAL);
  });
});

describe('bumpAndBroadcast — F15 record chain', () => {
  it("a bump of a bump verifies via the replacement's OWN record (sweep: reduced amount recorded)", async () => {
    setUnlocked(ABANDON);
    // A sweep original: 100k in, 99k to the recipient, no change.
    seedRecord(EXTERNAL, 99_000n);
    mockTx(makePendingTx({ vout: [{ value: 99_000n, address: EXTERNAL }] }));
    const prepared = await prepareBump('mainnet', PENDING_TXID, ACCOUNT);
    expect(prepared.changeAddress).toBeNull();

    // Bump at 20 sat/vB: fee 4,160 (vsize 208), so the recipient amount drops
    // to 95,840. The replacement's record must carry the REDUCED amount.
    const result = await bumpAndBroadcast({
      network: 'mainnet',
      prepared,
      feeRateSatVb: 20,
      allowHighFee: false,
    });
    expect(result.sendRecorded).toBe(true);
    expect(getSendRecord('mainnet', result.txid)).toEqual({
      recipient: EXTERNAL,
      amountSats: 95_840n,
    });

    // The replacement later shows up pending; its fetched view matches its own
    // record, so a second bump verifies — the chain of trust is unbroken.
    mockTx({
      txid: result.txid,
      confirmed: false,
      feeSats: 4_160n,
      weight: 832,
      vsize: 208,
      vin: makePendingTx().vin,
      vout: [{ value: 95_840n, address: EXTERNAL }],
    });
    const rePrepared = await prepareBump('mainnet', result.txid, ACCOUNT);
    expect(rePrepared.recipientAmountSats).toBe(95_840n);
    expect(rePrepared.recipient).toBe(EXTERNAL);
  });

  it('a storage failure never blocks the broadcast — it surfaces as sendRecorded: false', async () => {
    setUnlocked(ABANDON);
    seedRecord(EXTERNAL, 80_000n);
    mockTx(makePendingTx());
    const prepared = await prepareBump('mainnet', PENDING_TXID, ACCOUNT);

    // Break storage AFTER prepare (the verification read already happened).
    const saved = localStorage.getItem('sbw.sends.v1');
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'sbw.sends.v1' ? saved : null),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
    });

    const result = await bumpAndBroadcast({
      network: 'mainnet',
      prepared,
      feeRateSatVb: 20,
      allowHighFee: false,
    });
    // The payment went out; only the verification coverage was lost.
    expect(result.txid).toBe('f'.repeat(64));
    expect(result.sendRecorded).toBe(false);
    expect(vi.mocked(broadcastTx)).toHaveBeenCalledTimes(1);
  });
});
