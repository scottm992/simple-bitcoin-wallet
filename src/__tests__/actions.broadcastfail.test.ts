/**
 * actions.broadcastfail.test.ts — the actions layer around a REJECTED
 * broadcast, and the sub-1 custom-rate path end to end (mocked relay).
 *
 * Two properties the custom fee-rate feature leans on:
 *  - a broadcast rejection (e.g. the node's "min relay fee not met", reachable
 *    with a sub-1 custom rate on a busy network) propagates as the typed
 *    ApiResponseError with its body intact (the UI classifies it — never
 *    swallowed), and records NOTHING in the F15 send log: recordSend fires
 *    only after a successful broadcast, so a refused payment can never gain a
 *    phantom "this went out" record;
 *  - a 0.1 sat/vB rate passes through signAndBroadcast unchanged: the actions
 *    layer adds no floor of its own (MIN_CUSTOM_FEE_RATE lives in the Send
 *    screen's validation; the engine accepts any positive finite rate).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock only the broadcast endpoint; everything else in api.ts stays real.
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    broadcastTx: vi.fn(),
  };
});

import { signAndBroadcast } from '../actions';
import { broadcastTx } from '../lib/api';
import {
  ApiResponseError,
  SEND_LOG_STORAGE_KEY,
  deriveReceiveAddress,
  getSendRecord,
  type WalletUtxo,
} from '../lib';
import { setUnlocked, lockNow } from '../session';

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECIPIENT = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';

const addr0 = deriveReceiveAddress(ABANDON, 'mainnet', 0);
const CHANGE = deriveReceiveAddress(ABANDON, 'mainnet', 2).address;

const UTXOS: readonly WalletUtxo[] = [
  { txid: 'a'.repeat(64), vout: 0, value: 100_000n, path: addr0.path, address: addr0.address },
];

/** A 20k-sat send at the 0.1 sat/vB floor — fee ≈ 15 sats, no consent needed. */
const SUB1_SEND = {
  network: 'mainnet' as const,
  utxos: UTXOS,
  recipient: RECIPIENT,
  amountSats: 20_000n,
  feeRateSatVb: 0.1,
  changeAddress: CHANGE,
  sendMax: false,
  allowHighFee: false,
};

/** The verbatim body shape Esplora relays from Bitcoin Core on a floor reject. */
const MIN_RELAY_BODY =
  'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met, 14 < 141"}';

afterEach(() => {
  lockNow();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('signAndBroadcast — broadcast rejection (fee below the relay floor)', () => {
  it('propagates the typed error with its body intact and records NO send-log entry', async () => {
    setUnlocked(ABANDON);
    vi.mocked(broadcastTx).mockRejectedValueOnce(new ApiResponseError(400, MIN_RELAY_BODY));

    // The error reaches the caller as-is — the Review sheet's classifier needs
    // the name and body verbatim, so nothing here may wrap or swallow it.
    await expect(signAndBroadcast({ ...SUB1_SEND })).rejects.toMatchObject({
      name: 'ApiResponseError',
      body: expect.stringContaining('min relay fee not met') as unknown,
    });

    // F15: recordSend only ever fires AFTER a successful broadcast — a refused
    // payment leaves the send log untouched (no phantom record to verify a
    // future bump against).
    expect(localStorage.getItem(SEND_LOG_STORAGE_KEY)).toBeNull();
  });

  it('a 0.1 sat/vB send passes the whole actions path and records on success', async () => {
    setUnlocked(ABANDON);
    vi.mocked(broadcastTx).mockResolvedValueOnce('relay-echo-ignored');

    const result = await signAndBroadcast({ ...SUB1_SEND });
    // Locally computed txid (F19), real signed hex out the door.
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(vi.mocked(broadcastTx)).toHaveBeenCalledTimes(1);

    // The success-path record carries the user-confirmed recipient and exact
    // amount — proving the sub-1 rate flowed through build → sign → broadcast
    // → record with no layer re-flooring or rejecting it.
    expect(result.sendRecorded).toBe(true);
    expect(getSendRecord('mainnet', result.txid)).toEqual({
      recipient: RECIPIENT,
      amountSats: 20_000n,
    });
  });
});
