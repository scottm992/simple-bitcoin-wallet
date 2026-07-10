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
  getAddressTxs,
  getBtcUsdPrice,
  broadcastTx,
  getTransaction,
  isRateLimitError,
  ApiNetworkError,
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

/**
 * Installs a fetch stub that RECORDS its (url, init) arguments and returns
 * `body` with status 200. Used by the URL-split tests to pin which host each
 * endpoint targets.
 */
function captureFetch(body: string): ReturnType<typeof vi.fn> {
  const mock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(body, { status: 200 })),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
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

// --- v1.2.0: chain data → blockstream.info, fees/price → mempool.space -------

describe('chain-data / fee-price URL split (v1.2.0)', () => {
  it('chain-data endpoints hit the blockstream.info base (both networks)', async () => {
    // Address stats — mainnet then testnet on ONE recording mock.
    let m = captureFetch(
      JSON.stringify({
        chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
      }),
    );
    await getAddressStats('mainnet', 'bc1qexample');
    expect(String(m.mock.calls[0]?.[0])).toBe('https://blockstream.info/api/address/bc1qexample');
    await getAddressStats('testnet', 'bc1qexample');
    expect(String(m.mock.calls[1]?.[0])).toBe(
      'https://blockstream.info/testnet/api/address/bc1qexample',
    );

    // UTXOs.
    m = captureFetch('[]');
    await getUtxos('mainnet', 'bc1qexample');
    expect(String(m.mock.calls[0]?.[0])).toBe(
      'https://blockstream.info/api/address/bc1qexample/utxo',
    );

    // Address txs.
    m = captureFetch('[]');
    await getAddressTxs('mainnet', 'bc1qexample');
    expect(String(m.mock.calls[0]?.[0])).toBe(
      'https://blockstream.info/api/address/bc1qexample/txs',
    );

    // Broadcast (POST) — chain data too.
    m = captureFetch('f'.repeat(64));
    await broadcastTx('mainnet', 'deadbeef');
    expect(String(m.mock.calls[0]?.[0])).toBe('https://blockstream.info/api/tx');
    expect(m.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('fee + price endpoints STILL hit mempool.space (F1 fee path unmoved)', async () => {
    let m = captureFetch(JSON.stringify({ fastestFee: 5, halfHourFee: 3, hourFee: 1 }));
    await getFeeEstimates('mainnet');
    expect(String(m.mock.calls[0]?.[0])).toBe('https://mempool.space/api/v1/fees/recommended');
    await getFeeEstimates('testnet');
    expect(String(m.mock.calls[1]?.[0])).toBe(
      'https://mempool.space/testnet/api/v1/fees/recommended',
    );

    m = captureFetch(JSON.stringify({ USD: 60_000 }));
    await getBtcUsdPrice();
    expect(String(m.mock.calls[0]?.[0])).toBe('https://mempool.space/api/v1/prices');
  });
});

// --- v1.2.0: HTTP 429 — the pause lives ABOVE the api layer -----------------

describe('HTTP 429 (v1.2.0)', () => {
  it('isRateLimitError is true ONLY for a 429 ApiResponseError', () => {
    expect(isRateLimitError(new ApiResponseError(429, 'Too Many Requests'))).toBe(true);
    expect(isRateLimitError(new ApiResponseError(503, 'busy'))).toBe(false);
    expect(isRateLimitError(new ApiNetworkError('stalled'))).toBe(false);
    expect(isRateLimitError(new Error('nope'))).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });

  it('a 429 on broadcast / getTransaction / fees still THROWS a typed ApiResponseError (no pause here)', async () => {
    // The polite in-run pause is orchestrated in the discovery layer, NOT the api
    // layer: these non-discovery-wrapped calls surface a 429 exactly as any other
    // non-2xx, with no retry and no delay.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Too Many Requests', { status: 429 })),
    );
    await expect(broadcastTx('mainnet', 'deadbeef')).rejects.toMatchObject({ status: 429 });
    await expect(getFeeEstimates('mainnet')).rejects.toBeInstanceOf(ApiResponseError);
    await expect(getTransaction('mainnet', 'ab'.repeat(32))).rejects.toMatchObject({ status: 429 });
  });
});

// --- F19: broadcast error surfacing is unchanged -----------------------------

describe('broadcastTx — error surfacing (F19 non-regression)', () => {
  it('a non-2xx rejection still carries the relay status AND body text exactly as before', async () => {
    // F19 demotes the SUCCESS body to a diagnostic echo (actions.ts uses the
    // locally computed BuiltTx.txid); the FAILURE body is still read and
    // surfaced verbatim — no new failure mode, no changed one.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('sendrawtransaction RPC error: bad-txns-inputs-missingorspent', {
            status: 400,
          }),
      ),
    );
    await expect(broadcastTx('mainnet', 'deadbeef')).rejects.toMatchObject({
      status: 400,
      body: 'sendrawtransaction RPC error: bad-txns-inputs-missingorspent',
    });
  });
});

// --- §1c: discovery GETs must NOT retry; other GETs still do ----------------

describe('discovery-GET retry policy (§1c)', () => {
  it('getAddressStats does NOT retry a transport failure — one attempt, then throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('connection stalled');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(getAddressStats('mainnet', 'bc1qexample')).rejects.toBeInstanceOf(ApiNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getUtxos and getAddressTxs also do not retry (one attempt each)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('connection stalled');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(getUtxos('mainnet', 'bc1qexample')).rejects.toBeInstanceOf(ApiNetworkError);
    await expect(getAddressTxs('mainnet', 'bc1qexample')).rejects.toBeInstanceOf(ApiNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // exactly one per call, no retry
  });

  it('getFeeEstimates STILL retries once on a transport blip (non-discovery GET)', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new TypeError('transient blip');
      return new Response(JSON.stringify({ fastestFee: 5, halfHourFee: 3, hourFee: 1 }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fees = await getFeeEstimates('mainnet');
    expect(fees.fast).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(2); // retried once, then succeeded
  });
});
