/**
 * api.tx.test.ts — getTransaction ingest validation (F2 discipline).
 *
 * Every field consumed from the untrusted /tx/:txid response is validated on
 * ingest; a hostile or malformed value must surface as a typed
 * ApiResponseError, never a NaN, an uncaught BigInt() throw, or bad data
 * flowing into the bump economics. The txid ARGUMENT is validated before any
 * URL is built (no request is made for a malformed identifier).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getTransaction, ApiResponseError } from '../api';

const TXID = 'ab'.repeat(32);
const IN_TXID = 'cd'.repeat(32);

/** A fresh, well-formed mainnet-shaped payload (identical shape on testnet). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePayload(): any {
  return {
    txid: TXID,
    version: 2,
    locktime: 0,
    vin: [
      {
        txid: IN_TXID,
        vout: 0,
        prevout: {
          scriptpubkey: '0014aabb',
          scriptpubkey_type: 'v0_p2wpkh',
          scriptpubkey_address: 'bc1qexampleinputaddress',
          value: 100_000,
        },
        scriptsig: '',
        is_coinbase: false,
        sequence: 0xfffffffd,
      },
    ],
    vout: [
      { scriptpubkey: '0014ccdd', scriptpubkey_address: 'bc1qexamplerecipient', value: 60_000 },
      { scriptpubkey: '0014eeff', scriptpubkey_address: 'bc1qexamplechange', value: 38_590 },
    ],
    size: 222,
    weight: 561,
    sigops: 1,
    fee: 1_410, // = 100,000 − (60,000 + 38,590): the identity must reconcile
    status: { confirmed: false },
  };
}

const fetchMock = vi.fn();

function stubFetchWith(payload: unknown): void {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function expectRejects(payload: unknown): Promise<void> {
  stubFetchWith(payload);
  await expect(getTransaction('mainnet', TXID)).rejects.toBeInstanceOf(ApiResponseError);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getTransaction — happy path', () => {
  it('parses a well-formed unconfirmed tx: fee, vsize = ceil(weight/4), vin/vout fields', async () => {
    stubFetchWith(makePayload());
    const tx = await getTransaction('mainnet', TXID);
    expect(tx.txid).toBe(TXID);
    expect(tx.confirmed).toBe(false);
    expect(tx.feeSats).toBe(1_410n);
    expect(tx.weight).toBe(561);
    expect(tx.vsize).toBe(Math.ceil(561 / 4)); // 141
    expect(tx.vin).toHaveLength(1);
    expect(tx.vin[0]?.txid).toBe(IN_TXID);
    expect(tx.vin[0]?.vout).toBe(0);
    expect(tx.vin[0]?.sequence).toBe(0xfffffffd);
    expect(tx.vin[0]?.prevout?.value).toBe(100_000n);
    expect(tx.vin[0]?.prevout?.address).toBe('bc1qexampleinputaddress');
    expect(tx.vout).toHaveLength(2);
    expect(tx.vout[0]?.value).toBe(60_000n);
    expect(tx.vout[0]?.address).toBe('bc1qexamplerecipient');
    // Exactly ONE request went out — no bursts.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://mempool.space/api/tx/${TXID}`);
  });

  it('uses the testnet base URL for testnet', async () => {
    stubFetchWith(makePayload());
    await getTransaction('testnet', TXID);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://mempool.space/testnet/api/tx/${TXID}`);
  });

  it('accepts a coinbase-style vin (no prevout) and an address-less vout (nonstandard script)', async () => {
    const p = makePayload();
    p.vin = [{ txid: '00'.repeat(32), vout: 0xffffffff, is_coinbase: true, sequence: 0xffffffff }];
    p.vout = [{ scriptpubkey: '6a04deadbeef', value: 0 }]; // OP_RETURN-ish, no address
    p.fee = 0;
    stubFetchWith(p);
    const tx = await getTransaction('mainnet', TXID);
    expect(tx.vin[0]?.prevout).toBeUndefined();
    expect(tx.vout[0]?.address).toBeUndefined();
    expect(tx.vout[0]?.value).toBe(0n);
  });
});

describe('getTransaction — txid argument validation (before any request)', () => {
  it('rejects malformed txid arguments without ever building a URL or fetching', async () => {
    stubFetchWith(makePayload());
    for (const bad of ['', 'xyz', 'AB'.repeat(32), 'ab'.repeat(31), `${'ab'.repeat(32)}0`, '../fees']) {
      await expect(getTransaction('mainnet', bad)).rejects.toBeInstanceOf(ApiResponseError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getTransaction — hostile/malformed responses are rejected typed (F2)', () => {
  it('rejects a response whose txid does not match the request', async () => {
    const p = makePayload();
    p.txid = 'ef'.repeat(32);
    await expectRejects(p);
  });

  it('rejects malformed fee values (float, negative, string, over-supply)', async () => {
    for (const fee of [1410.5, -1, '1410', 2_100_000_000_000_001]) {
      const p = makePayload();
      p.fee = fee;
      await expectRejects(p);
    }
  });

  it('rejects malformed weight (zero, negative, float, over consensus max)', async () => {
    for (const weight of [0, -4, 561.5, 4_000_001]) {
      const p = makePayload();
      p.weight = weight;
      await expectRejects(p);
    }
  });

  it('rejects a missing/malformed status.confirmed', async () => {
    const p1 = makePayload();
    delete p1.status;
    await expectRejects(p1);
    const p2 = makePayload();
    p2.status = { confirmed: 'false' };
    await expectRejects(p2);
  });

  it('rejects malformed vin vectors (not array, empty, oversized)', async () => {
    const p1 = makePayload();
    p1.vin = 'not-an-array';
    await expectRejects(p1);
    const p2 = makePayload();
    p2.vin = [];
    await expectRejects(p2);
    const p3 = makePayload();
    p3.vin = new Array(201).fill({});
    await expectRejects(p3);
  });

  it('rejects malformed vin fields (bad txid, bad vout, out-of-range sequence)', async () => {
    for (const mutate of [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vin: any) => (vin.txid = 'zz'.repeat(32)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vin: any) => (vin.vout = -1),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vin: any) => (vin.sequence = -1),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vin: any) => (vin.sequence = 0x1_0000_0000),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vin: any) => (vin.sequence = 1.5),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vin: any) => (vin.sequence = undefined),
    ]) {
      const p = makePayload();
      mutate(p.vin[0]);
      await expectRejects(p);
    }
  });

  it('rejects malformed prevout fields (bad value, wrong-type/oversized address)', async () => {
    for (const mutate of [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (po: any) => (po.value = 1.5),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (po: any) => (po.value = -100),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (po: any) => (po.value = 2_100_000_000_000_001),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (po: any) => (po.scriptpubkey_address = 12345),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (po: any) => (po.scriptpubkey_address = 'x'.repeat(101)),
    ]) {
      const p = makePayload();
      mutate(p.vin[0].prevout);
      await expectRejects(p);
    }
  });

  it('rejects duplicate input outpoints', async () => {
    const p = makePayload();
    p.vin = [p.vin[0], JSON.parse(JSON.stringify(p.vin[0]))];
    await expectRejects(p);
  });

  it('rejects malformed vout vectors and fields', async () => {
    const p1 = makePayload();
    p1.vout = [];
    await expectRejects(p1);
    const p2 = makePayload();
    p2.vout = new Array(201).fill({ value: 1 });
    await expectRejects(p2);
    const p3 = makePayload();
    p3.vout[0].value = 'lots';
    await expectRejects(p3);
    const p4 = makePayload();
    p4.vout[0].scriptpubkey_address = 'y'.repeat(101);
    await expectRejects(p4);
  });

  it('rejects a fee that does not reconcile with inputs − outputs (cross-field integrity)', async () => {
    const p1 = makePayload();
    p1.fee = 9_999; // real identity is 1,410
    await expectRejects(p1);
    // Outputs exceeding inputs is equally impossible.
    const p2 = makePayload();
    p2.vout[0].value = 200_000;
    await expectRejects(p2);
  });

  it('rejects a non-object / garbage response body', async () => {
    await expectRejects([1, 2, 3]);
    stubFetchWith(undefined as unknown);
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'not json' });
    await expect(getTransaction('mainnet', TXID)).rejects.toBeInstanceOf(ApiResponseError);
  });
});
