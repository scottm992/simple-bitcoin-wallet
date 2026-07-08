import { describe, it, expect, vi } from 'vitest';
import {
  discoverAccount,
  AccountDiscoveryError,
  type AccountApi,
  type AddressDeriver,
} from '../account';
import type { AddressStats, AddressTx, ApiUtxo } from '../api';
import type { Chain, DerivedAddress } from '../wallet';

// --- test helpers ----------------------------------------------------------

/** Deterministic fake address for a chain+index, e.g. "addr-0-3". */
function fakeAddress(chain: Chain, index: number): string {
  return `addr-${chain}-${index}`;
}

/** A deriver that produces predictable addresses/paths without any secrets. */
const deriver: AddressDeriver = (chain, index): DerivedAddress => ({
  address: fakeAddress(chain, index),
  path: `m/84'/1'/0'/${chain}/${index}`,
  publicKey: new Uint8Array([chain, index]),
});

const EMPTY_STATS: AddressStats = {
  confirmedSats: 0n,
  pendingSats: 0n,
  fundedSats: 0n,
  spentSats: 0n,
};

/**
 * Builds a mock AccountApi from a map of address -> partial data. Any address
 * not in the map is treated as never-used (empty).
 */
function mockApi(fixtures: Record<string, {
  stats?: Partial<AddressStats>;
  utxos?: ApiUtxo[];
  txs?: AddressTx[];
}>): AccountApi {
  return {
    getAddressStats: vi.fn(async (_network, address: string): Promise<AddressStats> => {
      const f = fixtures[address];
      return f?.stats ? { ...EMPTY_STATS, ...f.stats } : EMPTY_STATS;
    }),
    getUtxos: vi.fn(async (_network, address: string): Promise<ApiUtxo[]> => {
      return fixtures[address]?.utxos ?? [];
    }),
    getAddressTxs: vi.fn(async (_network, address: string): Promise<AddressTx[]> => {
      return fixtures[address]?.txs ?? [];
    }),
  };
}

// --- happy path ------------------------------------------------------------

describe('discoverAccount — happy path', () => {
  it('aggregates balance, utxos, activity, and next addresses', async () => {
    const api = mockApi({
      // Receive chain 0: index 0 funded and still holding a UTXO.
      [fakeAddress(0, 0)]: {
        stats: { confirmedSats: 100_000n, fundedSats: 100_000n },
        utxos: [{ txid: 'aa', vout: 0, value: 100_000n, confirmed: true }],
        txs: [{ txid: 'aa', confirmed: true, blockTime: 1000, netSats: 100_000n }],
      },
      // Change chain 1: index 0 has change from a prior send.
      [fakeAddress(1, 0)]: {
        stats: { confirmedSats: 20_000n, fundedSats: 20_000n },
        utxos: [{ txid: 'bb', vout: 1, value: 20_000n, confirmed: true }],
        txs: [{ txid: 'bb', confirmed: true, blockTime: 2000, netSats: 20_000n }],
      },
    });

    const snap = await discoverAccount('testnet', deriver, api);

    expect(snap.confirmedSats).toBe(120_000n);
    expect(snap.pendingSats).toBe(0n);
    expect(snap.utxos).toHaveLength(2);
    // UTXOs carry their owning path + address so tx.ts can sign.
    const byTxid = new Map(snap.utxos.map((u) => [u.txid, u]));
    expect(byTxid.get('aa')?.path).toBe("m/84'/1'/0'/0/0");
    expect(byTxid.get('aa')?.address).toBe(fakeAddress(0, 0));
    expect(byTxid.get('bb')?.path).toBe("m/84'/1'/0'/1/0");

    // Next unused receive is index 1 (index 0 was used); same for change.
    expect(snap.receiveAddress).toBe(fakeAddress(0, 1));
    expect(snap.changeAddress).toBe(fakeAddress(1, 1));

    // Activity merged, newest (higher blockTime) first.
    expect(snap.activity.map((a) => a.txid)).toEqual(['bb', 'aa']);
  });

  it('returns index-0 addresses and zero balance for a fresh wallet', async () => {
    const api = mockApi({});
    const snap = await discoverAccount('testnet', deriver, api);
    expect(snap.confirmedSats).toBe(0n);
    expect(snap.utxos).toHaveLength(0);
    expect(snap.activity).toHaveLength(0);
    expect(snap.receiveAddress).toBe(fakeAddress(0, 0));
    expect(snap.changeAddress).toBe(fakeAddress(1, 0));
  });

  it('sums the net delta for a tx that touches multiple wallet addresses', async () => {
    // A send: chain-0 addr spends -50_000 for tx "cc"; change comes back +30_000
    // to chain-1 addr for the same tx. Wallet net delta should be -20_000.
    const api = mockApi({
      [fakeAddress(0, 0)]: {
        stats: { fundedSats: 50_000n, spentSats: 50_000n },
        txs: [{ txid: 'cc', confirmed: true, blockTime: 500, netSats: -50_000n }],
      },
      [fakeAddress(1, 0)]: {
        stats: { confirmedSats: 30_000n, fundedSats: 30_000n },
        txs: [{ txid: 'cc', confirmed: true, blockTime: 500, netSats: 30_000n }],
      },
    });
    const snap = await discoverAccount('testnet', deriver, api);
    expect(snap.activity).toHaveLength(1);
    expect(snap.activity[0]?.txid).toBe('cc');
    expect(snap.activity[0]?.netSats).toBe(-20_000n);
  });
});

// --- gap-limit logic -------------------------------------------------------

describe('discoverAccount — gap limit', () => {
  it('finds a used address across a gap and stops after 5 unused', async () => {
    // Receive index 3 is used, with a gap at 0,1,2. Should still be found.
    const api = mockApi({
      [fakeAddress(0, 3)]: {
        stats: { confirmedSats: 5_000n, fundedSats: 5_000n },
      },
    });
    const snap = await discoverAccount('testnet', deriver, api, { gapLimit: 5, maxIndex: 50 });
    expect(snap.confirmedSats).toBe(5_000n);
    // Next unused receive address is index 0 (the first gap), not index 4.
    expect(snap.receiveAddress).toBe(fakeAddress(0, 0));
    expect(snap.usedAddresses).toContain(fakeAddress(0, 3));
  });

  it('stops scanning after the gap limit of consecutive unused addresses', async () => {
    // Only index 0 is used on receive; the scan should stop well before maxIndex.
    const api = mockApi({
      [fakeAddress(0, 0)]: { stats: { confirmedSats: 1_000n, fundedSats: 1_000n } },
    });
    await discoverAccount('testnet', deriver, api, { gapLimit: 5, maxIndex: 50 });

    // Receive addresses queried: index 0 (used) + 5 unused (1..5) = through 5,
    // never reaching index 50. Change chain: 5 unused (0..4). Assert we did not
    // query anywhere near maxIndex on the receive chain.
    const stats = api.getAddressStats as ReturnType<typeof vi.fn>;
    const queried: string[] = stats.mock.calls.map((c) => c[1] as string);
    expect(queried).not.toContain(fakeAddress(0, 20));
    expect(queried).toContain(fakeAddress(0, 5));
    // Confirm the gap actually terminated the scan (index 6 not needed).
    expect(queried).not.toContain(fakeAddress(0, 6));
  });

  it('honors maxIndex as a hard cap even with no gap', async () => {
    // Every receive address is "used" → scan is capped at maxIndex.
    const api: AccountApi = {
      getAddressStats: vi.fn(async (_n, address: string): Promise<AddressStats> => {
        // chain-0 always used; chain-1 always unused.
        return address.startsWith('addr-0-')
          ? { ...EMPTY_STATS, confirmedSats: 1n, fundedSats: 1n }
          : EMPTY_STATS;
      }),
      getUtxos: vi.fn(async () => []),
      getAddressTxs: vi.fn(async () => []),
    };
    const snap = await discoverAccount('testnet', deriver, api, { gapLimit: 5, maxIndex: 3 });
    // Used receive addresses are indexes 0..3 (cap inclusive).
    expect(snap.usedAddresses).toEqual([
      fakeAddress(0, 0),
      fakeAddress(0, 1),
      fakeAddress(0, 2),
      fakeAddress(0, 3),
    ]);
    // Next unused receive is just past the cap.
    expect(snap.receiveAddress).toBe(fakeAddress(0, 3));
  });
});

// --- failure handling ------------------------------------------------------

describe('discoverAccount — failures', () => {
  it('wraps an api failure during scan in AccountDiscoveryError', async () => {
    const api: AccountApi = {
      getAddressStats: vi.fn(async () => {
        throw new Error('network down');
      }),
      getUtxos: vi.fn(async () => []),
      getAddressTxs: vi.fn(async () => []),
    };
    await expect(discoverAccount('testnet', deriver, api)).rejects.toBeInstanceOf(
      AccountDiscoveryError,
    );
  });

  it('wraps an api failure during utxo/activity fetch in AccountDiscoveryError', async () => {
    const api: AccountApi = {
      getAddressStats: vi.fn(async (_n, address: string): Promise<AddressStats> =>
        address === fakeAddress(0, 0)
          ? { ...EMPTY_STATS, confirmedSats: 1_000n, fundedSats: 1_000n }
          : EMPTY_STATS,
      ),
      getUtxos: vi.fn(async () => {
        throw new Error('utxo endpoint down');
      }),
      getAddressTxs: vi.fn(async () => []),
    };
    const err = await discoverAccount('testnet', deriver, api).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountDiscoveryError);
    expect((err as AccountDiscoveryError).cause).toBeInstanceOf(Error);
  });
});
