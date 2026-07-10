/**
 * actions.f19.test.ts — F19 (Round 13): the locally computed txid is
 * authoritative; the relay's response body is a diagnostic echo only.
 *
 * A hostile broadcast relay (blockstream.info holds the sole relay position
 * since v1.2.0) could answer a successful POST /tx with a wrong-but-well-formed
 * txid or outright garbage. Pre-F19 that body keyed the F15 send record AND the
 * returned BroadcastResult.txid — poisoning the displayed id and silently
 * voiding the payment's Speed-up coverage (prepareBump would dead-end
 * 'unverified' for the real txid). The txid is derivable from the signed bytes
 * (BuiltTx.txid, deterministic via RFC6979), so ours is authoritative and the
 * echo is never consulted for identity.
 *
 * Proves, with broadcastTx mocked to LIE (no real network):
 *  - BroadcastResult.txid === the locally computed BuiltTx.txid, for sends AND
 *    bumps (buildAndSignTx / buildRbfBumpTx over the same params are
 *    deterministic, so the test can compute the expected id independently);
 *  - the F15 record is keyed by built.txid; NOTHING is recorded under the
 *    relay's lie;
 *  - the Speed-up chain still verifies end-to-end: prepareBump on the REAL
 *    txid finds the record and matches (F15 terminates entirely in local
 *    values — built.txid + sendLog — with zero relay influence).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// The relay LIES: a wrong-but-well-formed txid (the nastier case — it would
// pass any format filter) by default; individual tests may swap in garbage.
const RELAY_LIE_TXID = 'e'.repeat(64);
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    getTransaction: vi.fn(),
    broadcastTx: vi.fn(async (_network: 'mainnet' | 'testnet', _txHex: string) => RELAY_LIE_TXID),
  };
});

import { signAndBroadcast, bumpAndBroadcast, prepareBump } from '../actions';
import { broadcastTx, getTransaction } from '../lib/api';
import {
  buildAndSignTx,
  buildRbfBumpTx,
  deriveReceiveAddress,
  getSendRecord,
  type AccountSnapshot,
  type ApiTransaction,
  type WalletUtxo,
} from '../lib';
import { setUnlocked, lockNow } from '../session';

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// A genuinely FOREIGN recipient (the BIP173 spec example P2WPKH — not derived
// from ABANDON on either chain), so classifyBumpOutputs sees recipient+change,
// not a self-send. (The highfee test's recipient is ABANDON's change #0!)
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

const addr0 = deriveReceiveAddress(ABANDON, 'mainnet', 0);
const CHANGE = deriveReceiveAddress(ABANDON, 'mainnet', 2).address; // ours

const UTXOS: readonly WalletUtxo[] = [
  { txid: 'a'.repeat(64), vout: 0, value: 100_000n, path: addr0.path, address: addr0.address },
];

/** An ordinary send: 50k of a 100k UTXO at 5 sat/vB — no consent rules trip. */
const SEND = {
  network: 'mainnet' as const,
  utxos: UTXOS,
  recipient: RECIPIENT,
  amountSats: 50_000n,
  feeRateSatVb: 5,
  changeAddress: CHANGE,
  sendMax: false,
  allowHighFee: false,
};

/** The account snapshot prepareBump derives its owned-address map from. */
const ACCOUNT: AccountSnapshot = {
  confirmedSats: 100_000n,
  pendingSats: 0n,
  utxos: [...UTXOS],
  receiveAddress: deriveReceiveAddress(ABANDON, 'mainnet', 1).address,
  receiveIndex: 1,
  changeAddress: CHANGE,
  activity: [],
  usedAddresses: [addr0.address],
  receiveHighWater: 0,
  changeHighWater: -1,
};

/**
 * Independently computes the tx signAndBroadcast will build: same params +
 * mnemonic ⇒ byte-identical signed tx (RFC6979 deterministic signatures) ⇒ the
 * same locally computed txid. This is what makes the equality pins exact.
 */
function expectedBuild(): ReturnType<typeof buildAndSignTx> {
  return buildAndSignTx({ mnemonic: ABANDON, ...SEND });
}

afterEach(() => {
  lockNow();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('F19 — the local txid is authoritative, never the relay echo', () => {
  it('send: BroadcastResult.txid === built.txid and the F15 record is keyed by it — the well-formed LIE is ignored', async () => {
    setUnlocked(ABANDON);
    const built = expectedBuild();
    expect(built.txid).not.toBe(RELAY_LIE_TXID); // the lie is genuinely different

    const result = await signAndBroadcast(SEND);
    expect(vi.mocked(broadcastTx)).toHaveBeenCalledTimes(1); // the tx DID go out

    // The authoritative id is the locally computed one.
    expect(result.txid).toBe(built.txid);
    // The F15 record is keyed by it, carrying the user-confirmed values...
    expect(result.sendRecorded).toBe(true);
    expect(getSendRecord('mainnet', built.txid)).toEqual({
      recipient: RECIPIENT,
      amountSats: 50_000n,
    });
    // ...and NOTHING lives under the relay's lie.
    expect(getSendRecord('mainnet', RELAY_LIE_TXID)).toBeNull();
  });

  it('send: an outright-garbage echo changes nothing either (same authority)', async () => {
    setUnlocked(ABANDON);
    vi.mocked(broadcastTx).mockResolvedValueOnce('<html>502 gateway lol</html>');
    const built = expectedBuild();

    const result = await signAndBroadcast(SEND);
    expect(result.txid).toBe(built.txid);
    expect(getSendRecord('mainnet', built.txid)).not.toBeNull();
  });

  it('the Speed-up chain still verifies end-to-end: prepareBump on the REAL txid matches the record a lying relay could not mis-key', async () => {
    setUnlocked(ABANDON);
    const built = expectedBuild();
    await signAndBroadcast(SEND); // record now keyed by built.txid despite the lie

    // The payment later shows up pending under its REAL id (what the chain
    // actually carries — the relay's echo never existed on-chain). The fetched
    // view mirrors the tx we signed.
    const recipientSats = built.totalInputSats - built.feeSats - built.changeSats;
    expect(recipientSats).toBe(50_000n);
    const pending: ApiTransaction = {
      txid: built.txid,
      confirmed: false,
      feeSats: built.feeSats,
      weight: built.vsize * 4,
      vsize: built.vsize,
      vin: [
        {
          txid: 'a'.repeat(64),
          vout: 0,
          sequence: 0xfffffffd, // RBF_SEQUENCE — every v1.1+ send signals
          prevout: { value: 100_000n, address: addr0.address },
        },
      ],
      vout: [
        { value: recipientSats, address: RECIPIENT },
        { value: built.changeSats, address: CHANGE },
      ],
    };
    vi.mocked(getTransaction).mockResolvedValue(pending);

    // F15 verification passes — the chain of trust runs built.txid → sendLog →
    // prepareBump, with zero relay input anywhere.
    const prepared = await prepareBump('mainnet', built.txid, ACCOUNT);
    expect(prepared.txid).toBe(built.txid);
    expect(prepared.recipient).toBe(RECIPIENT);
    expect(prepared.recipientAmountSats).toBe(50_000n);

    // And the bump's OWN broadcast is equally echo-proof: the replacement's
    // record + returned id are the locally computed replacement txid.
    const expectedBump = buildRbfBumpTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: prepared.utxos,
      recipient: prepared.recipient,
      recipientAmountSats: prepared.recipientAmountSats,
      changeAddress: prepared.changeAddress,
      oldFeeSats: prepared.oldFeeSats,
      oldVsize: prepared.oldVsize,
      feeRateSatVb: 10,
      allowHighFee: false,
    });
    const bumped = await bumpAndBroadcast({
      network: 'mainnet',
      prepared,
      feeRateSatVb: 10,
      allowHighFee: false,
    });
    expect(bumped.txid).toBe(expectedBump.txid);
    expect(bumped.txid).not.toBe(RELAY_LIE_TXID);
    expect(getSendRecord('mainnet', expectedBump.txid)).toEqual({
      recipient: RECIPIENT,
      amountSats: expectedBump.totalInputSats - expectedBump.feeSats - expectedBump.changeSats,
    });
    expect(getSendRecord('mainnet', RELAY_LIE_TXID)).toBeNull();
  });
});
