/**
 * actions.highfee.test.ts — proves the F10 informed-consent flag is threaded all
 * the way through `signAndBroadcast` to the engine and on to broadcast:
 *   - without `allowHighFee`, a small send at an honest rate is rejected by the
 *     engine's percentage rule BEFORE any broadcast attempt;
 *   - with `allowHighFee: true`, the same params build, sign, and reach
 *     `broadcastTx` (mocked — no real network).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock only the broadcast endpoint; everything else in api.ts stays real.
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    broadcastTx: vi.fn(async (_network: 'mainnet' | 'testnet', _txHex: string) => 'f'.repeat(64)),
  };
});

import { signAndBroadcast } from '../actions';
import { broadcastTx } from '../lib/api';
import { FeeTooHighError, deriveReceiveAddress, getSendRecord, type WalletUtxo } from '../lib';
import { setUnlocked, lockNow } from '../session';

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECIPIENT = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';

const addr0 = deriveReceiveAddress(ABANDON, 'mainnet', 0);
const CHANGE = deriveReceiveAddress(ABANDON, 'mainnet', 2).address;

const UTXOS: readonly WalletUtxo[] = [
  { txid: 'a'.repeat(64), vout: 0, value: 100_000n, path: addr0.path, address: addr0.address },
];

/** Small send at an honest 30 sat/vB — fee ≈ 4,230 sats, > 25% of 10,000. */
const SMALL_SEND = {
  network: 'mainnet' as const,
  utxos: UTXOS,
  recipient: RECIPIENT,
  amountSats: 10_000n,
  feeRateSatVb: 30,
  changeAddress: CHANGE,
  sendMax: false,
};

afterEach(() => {
  lockNow();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('signAndBroadcast — allowHighFee threading (F10)', () => {
  it('without consent the engine rejects before broadcast is ever attempted', async () => {
    setUnlocked(ABANDON);
    await expect(signAndBroadcast({ ...SMALL_SEND, allowHighFee: false })).rejects.toBeInstanceOf(
      FeeTooHighError,
    );
    expect(vi.mocked(broadcastTx)).not.toHaveBeenCalled();
  });

  it('with informed consent the same small send builds, signs, and reaches broadcast', async () => {
    setUnlocked(ABANDON);
    const result = await signAndBroadcast({ ...SMALL_SEND, allowHighFee: true });
    expect(result.txid).toBe('f'.repeat(64));

    const mock = vi.mocked(broadcastTx);
    expect(mock).toHaveBeenCalledTimes(1);
    const [network, txHex] = mock.mock.calls[0] ?? [];
    expect(network).toBe('mainnet');
    // A real signed transaction hex went out the door.
    expect(typeof txHex).toBe('string');
    expect((txHex as string).length).toBeGreaterThan(100);
    expect(/^[0-9a-f]+$/i.test(txHex as string)).toBe(true);

    // F15: the local send record was written, keyed by the RETURNED txid, with
    // the user-confirmed recipient and the exact recipient-output amount.
    expect(result.sendRecorded).toBe(true);
    expect(getSendRecord('mainnet', result.txid)).toEqual({
      recipient: RECIPIENT,
      amountSats: 10_000n,
    });
  });

  it('consent still cannot push a hostile 5000 sat/vB rate through to broadcast', async () => {
    setUnlocked(ABANDON);
    await expect(
      signAndBroadcast({ ...SMALL_SEND, feeRateSatVb: 5000, sendMax: true, allowHighFee: true }),
    ).rejects.toBeInstanceOf(FeeTooHighError);
    expect(vi.mocked(broadcastTx)).not.toHaveBeenCalled();
  });
});
