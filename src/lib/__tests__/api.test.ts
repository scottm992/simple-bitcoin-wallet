/**
 * api.test.ts — regression tests for the untrusted-response hardening in api.ts:
 *   - F1: fee-rate estimates are clamped into a sane window.
 *   - F2: malformed / out-of-range numeric + string fields are rejected as a
 *         typed ApiResponseError, never a NaN or an uncaught BigInt() throw, and
 *         an implausible balance (> 21M BTC) is rejected.
 *
 * These reproduce the reviewer's exploit scenarios (a 5000 sat/vB fee, a
 * 21,000,000-BTC balance, a non-integer UTXO value) against the real functions.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getFeeEstimates,
  getAddressStats,
  getUtxos,
  getBtcUsdPrice,
  ApiResponseError,
  MAX_ACCEPTED_FEE_RATE,
  MIN_ACCEPTED_FEE_RATE,
} from '../api';
import { MAX_SUPPLY_SATS, SATS_PER_BTC } from '../format';

/** Installs a fetch stub that returns `body` (stringified) with status 200. */
function mockFetchJson(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

/** Installs a fetch stub that returns raw text (for non-JSON bodies). */
function mockFetchText(text: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(text, { status: 200 })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- F1: fee-rate clamp ----------------------------------------------------

describe('getFeeEstimates — fee-rate clamp (F1)', () => {
  it('clamps a hostile 5000 sat/vB estimate down to the accepted ceiling', async () => {
    mockFetchJson({ fastestFee: 5000, halfHourFee: 5000, hourFee: 5000, economyFee: 5000, minimumFee: 5000 });
    const fees = await getFeeEstimates('mainnet');
    expect(fees.fast).toBe(MAX_ACCEPTED_FEE_RATE);
    expect(fees.medium).toBe(MAX_ACCEPTED_FEE_RATE);
    expect(fees.slow).toBe(MAX_ACCEPTED_FEE_RATE);
  });

  it('clamps a zero / negative estimate up to the accepted floor', async () => {
    mockFetchJson({ fastestFee: 0, halfHourFee: -3, hourFee: 0, economyFee: 0, minimumFee: 0 });
    const fees = await getFeeEstimates('mainnet');
    expect(fees.fast).toBe(MIN_ACCEPTED_FEE_RATE);
    expect(fees.medium).toBe(MIN_ACCEPTED_FEE_RATE);
  });

  it('passes an ordinary in-range estimate through unchanged', async () => {
    mockFetchJson({ fastestFee: 25, halfHourFee: 12, hourFee: 4, economyFee: 2, minimumFee: 1 });
    const fees = await getFeeEstimates('mainnet');
    expect(fees).toEqual({ fast: 25, medium: 12, slow: 4 });
  });

  it('rejects a non-object fee response as a typed ApiResponseError', async () => {
    mockFetchText('null');
    await expect(getFeeEstimates('mainnet')).rejects.toBeInstanceOf(ApiResponseError);
  });
});

// --- F2: balance / value validation ----------------------------------------

describe('getAddressStats — response validation (F2)', () => {
  it('rejects an implausible 21,000,000-BTC balance (> supply cap)', async () => {
    const overCap = Number(MAX_SUPPLY_SATS + SATS_PER_BTC); // 21,000,001 BTC in sats
    mockFetchJson({
      chain_stats: { funded_txo_sum: overCap, spent_txo_sum: 0 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
    });
    await expect(getAddressStats('mainnet', 'bc1qexample')).rejects.toBeInstanceOf(ApiResponseError);
  });

  it('rejects a non-integer sat value instead of crashing BigInt()', async () => {
    mockFetchJson({
      chain_stats: { funded_txo_sum: 1.5, spent_txo_sum: 0 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
    });
    await expect(getAddressStats('mainnet', 'bc1qexample')).rejects.toBeInstanceOf(ApiResponseError);
  });

  it('rejects a missing/malformed stats object', async () => {
    mockFetchJson({ chain_stats: { funded_txo_sum: 100 } }); // no mempool_stats
    await expect(getAddressStats('mainnet', 'bc1qexample')).rejects.toBeInstanceOf(ApiResponseError);
  });

  it('accepts a well-formed balance', async () => {
    mockFetchJson({
      chain_stats: { funded_txo_sum: 150_000, spent_txo_sum: 50_000 },
      mempool_stats: { funded_txo_sum: 10_000, spent_txo_sum: 0 },
    });
    const stats = await getAddressStats('mainnet', 'bc1qexample');
    expect(stats.confirmedSats).toBe(100_000n);
    expect(stats.pendingSats).toBe(10_000n);
  });
});

describe('getUtxos — response validation (F2)', () => {
  it('rejects a non-integer UTXO value', async () => {
    mockFetchJson([{ txid: 'a'.repeat(64), vout: 0, value: '1e9', status: { confirmed: true } }]);
    await expect(getUtxos('mainnet', 'bc1qexample')).rejects.toBeInstanceOf(ApiResponseError);
  });

  it('rejects a malformed txid', async () => {
    mockFetchJson([{ txid: 'not-a-txid', vout: 0, value: 1000, status: { confirmed: true } }]);
    await expect(getUtxos('mainnet', 'bc1qexample')).rejects.toBeInstanceOf(ApiResponseError);
  });

  it('rejects a UTXO value above the supply cap', async () => {
    const overCap = Number(MAX_SUPPLY_SATS + 1n);
    mockFetchJson([{ txid: 'a'.repeat(64), vout: 0, value: overCap, status: { confirmed: true } }]);
    await expect(getUtxos('mainnet', 'bc1qexample')).rejects.toBeInstanceOf(ApiResponseError);
  });

  it('accepts a well-formed UTXO list', async () => {
    mockFetchJson([
      { txid: 'a'.repeat(64), vout: 0, value: 50_000, status: { confirmed: true, block_height: 800_000 } },
      { txid: 'b'.repeat(64), vout: 2, value: 10_000, status: { confirmed: false } },
    ]);
    const utxos = await getUtxos('mainnet', 'bc1qexample');
    expect(utxos).toHaveLength(2);
    expect(utxos[0]?.value).toBe(50_000n);
    expect(utxos[0]?.blockHeight).toBe(800_000);
    expect(utxos[1]?.confirmed).toBe(false);
  });
});

describe('getBtcUsdPrice — response validation (F2)', () => {
  it('rejects a NaN / non-number price', async () => {
    mockFetchJson({ USD: 'lots' });
    await expect(getBtcUsdPrice()).rejects.toBeInstanceOf(ApiResponseError);
  });

  it('accepts a plausible price', async () => {
    mockFetchJson({ USD: 62_500 });
    await expect(getBtcUsdPrice()).resolves.toBe(62_500);
  });
});
