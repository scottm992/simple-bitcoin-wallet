/**
 * api.ts — thin REST client for the public mempool.space API.
 *
 * Every call is network-scoped. GETs get a single retry; POST (broadcast) does
 * not retry. All requests are bounded by an AbortController timeout. Errors are
 * typed to distinguish a transport failure ({@link ApiNetworkError}) from an
 * API-level rejection ({@link ApiResponseError}).
 */
import type { Network } from './wallet';
import { MAX_SUPPLY_SATS } from './format';

/** Default per-request timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Timeout for address-discovery GETs (stats / utxos / txs). Deliberately short:
 * mempool.space stalls burst traffic until the client gives up, so a long
 * timeout turns a throttled burst into minutes of dead air. 8s per request,
 * with one short-backoff retry, keeps a stalled lane from wedging a scan.
 */
const DISCOVERY_TIMEOUT_MS = 8_000;

/**
 * Fee-rate sanity window (sat/vByte) applied to untrusted estimates from
 * mempool.space (F1). A legitimate rate is ~1–50 even in heavy congestion; we
 * accept a generous ceiling but clamp anything outside `[MIN, MAX]` so a
 * compromised/buggy endpoint can't push a wallet-draining rate into the signer.
 */
export const MIN_ACCEPTED_FEE_RATE = 1;
export const MAX_ACCEPTED_FEE_RATE = 500;

/**
 * Hard cap on the number of array entries we will ingest from a single list
 * endpoint (utxos / txs), so a hostile response can't exhaust memory (F2).
 */
const MAX_ARRAY_ENTRIES = 5_000;

/** Base URL for the mempool.space REST API for a given network. */
export function apiBaseUrl(network: Network): string {
  return network === 'mainnet'
    ? 'https://mempool.space/api'
    : 'https://mempool.space/testnet/api';
}

/** A transport-level failure: DNS, connection, timeout/abort, offline. */
export class ApiNetworkError extends Error {
  /** The underlying cause, if any. */
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ApiNetworkError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** An API-level rejection: a non-2xx HTTP response. Carries status + body text. */
export class ApiResponseError extends Error {
  /** The HTTP status code. */
  readonly status: number;
  /** The raw response body text, surfaced for diagnostics (e.g. broadcast errors). */
  readonly body: string;
  constructor(status: number, body: string) {
    super(`API error ${status}: ${body || '(no body)'}`);
    this.name = 'ApiResponseError';
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Untrusted-response validation (F2)
//
// Every numeric/string field consumed from mempool.space is validated on ingest
// so a hostile or buggy response surfaces as a typed ApiResponseError rather
// than a NaN, a thrown BigInt(), or an implausible balance wedging the wallet.
// ---------------------------------------------------------------------------

/** Asserts `v` is a JSON object (not null, not an array). */
function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ApiResponseError(200, `Malformed ${what}: expected an object`);
  }
  return v as Record<string, unknown>;
}

/** Asserts `v` is an array no larger than `MAX_ARRAY_ENTRIES`. */
function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) {
    throw new ApiResponseError(200, `Malformed ${what}: expected an array`);
  }
  if (v.length > MAX_ARRAY_ENTRIES) {
    throw new ApiResponseError(200, `Malformed ${what}: too many entries (${v.length})`);
  }
  return v;
}

/**
 * Validates a satoshi value: a safe, non-negative integer no larger than the
 * 21M-BTC supply cap. Returns it as a bigint. Rejects floats, NaN, negatives,
 * non-numbers, and implausibly large aggregates (F2).
 */
function satAmount(v: unknown, what: string): bigint {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
    throw new ApiResponseError(200, `Malformed ${what}: not a non-negative integer`);
  }
  const sats = BigInt(v);
  if (sats > MAX_SUPPLY_SATS) {
    throw new ApiResponseError(200, `Malformed ${what}: exceeds the 21M BTC supply cap`);
  }
  return sats;
}

/** Validates a non-negative integer (e.g. a vout / block height). */
function nonNegInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
    throw new ApiResponseError(200, `Malformed ${what}: not a non-negative integer`);
  }
  return v;
}

/** Validates a lowercase-hex transaction id (64 hex chars). */
function txid(v: unknown, what: string): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) {
    throw new ApiResponseError(200, `Malformed ${what}: not a valid txid`);
  }
  return v;
}

/** Validates a boolean field. */
function asBool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') {
    throw new ApiResponseError(200, `Malformed ${what}: not a boolean`);
  }
  return v;
}

/** Confirmed + pending balance for an address, in satoshis. */
export interface AddressStats {
  /** Confirmed (in-chain) balance in sats. */
  readonly confirmedSats: bigint;
  /** Net pending (mempool) balance change in sats (can be negative). */
  readonly pendingSats: bigint;
  /** Total funded (received) in sats, confirmed only. */
  readonly fundedSats: bigint;
  /** Total spent in sats, confirmed only. */
  readonly spentSats: bigint;
}

/** A confirmed or unconfirmed unspent output, as returned by the API. */
export interface ApiUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly value: bigint;
  readonly confirmed: boolean;
  /** Block height of confirmation, if confirmed. */
  readonly blockHeight?: number;
}

/** Recommended fee rates mapped to three tiers, in sat/vByte. */
export interface FeeEstimates {
  readonly fast: number;
  readonly medium: number;
  readonly slow: number;
}

/** A simplified transaction summary for one address. */
export interface AddressTx {
  readonly txid: string;
  readonly confirmed: boolean;
  /** Unix timestamp of the confirming block, if confirmed. */
  readonly blockTime?: number;
  /** Net value change for the queried address, in sats (can be negative). */
  readonly netSats: bigint;
}

/** Per-request options for GETs: an abort signal and a timeout override. */
interface GetOpts {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
}

/**
 * Performs a single fetch bounded by an AbortController timeout, additionally
 * aborted when the caller's `signal` fires (so an in-flight discovery run can
 * be cancelled as a whole).
 */
async function fetchOnce(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw new ApiNetworkError('Network request failed', err);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** A short sleep used between retry attempts; resolves early if aborted. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done);
  });
}

/**
 * GET a URL as text, with one retry on transport failure after a short,
 * jittered backoff (300–800 ms) — enough to step out of a throttled burst
 * without piling on. Never retries API rejections, and never retries once the
 * caller's signal has aborted.
 */
async function getText(url: string, opts: GetOpts = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await sleep(300 + Math.floor(Math.random() * 500), opts.signal);
    }
    if (opts.signal?.aborted) break;
    try {
      const res = await fetchOnce(url, { method: 'GET' }, timeoutMs, opts.signal);
      const body = await res.text();
      if (!res.ok) {
        throw new ApiResponseError(res.status, body);
      }
      return body;
    } catch (err) {
      // Retry only transport failures, never API rejections.
      if (err instanceof ApiResponseError) throw err;
      lastErr = err;
      if (opts.signal?.aborted) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new ApiNetworkError('Network request failed', lastErr);
}

/** GET a URL and parse it as JSON. */
async function getJson<T>(url: string, opts: GetOpts = {}): Promise<T> {
  const text = await getText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new ApiResponseError(200, `Malformed JSON response: ${String(err)}`);
  }
}

/**
 * Fetches confirmed and pending balance for an address. Every numeric field is
 * validated on ingest (F2): integers only, non-negative, ≤ 21M BTC. A malformed
 * value surfaces as an {@link ApiResponseError} rather than a NaN or a thrown
 * BigInt wedging the wallet into the network-error state.
 * @param network - The active network.
 * @param address - The address to query.
 */
export async function getAddressStats(
  network: Network,
  address: string,
  signal?: AbortSignal,
): Promise<AddressStats> {
  const raw = await getJson<unknown>(`${apiBaseUrl(network)}/address/${encodeURIComponent(address)}`, {
    signal,
    timeoutMs: DISCOVERY_TIMEOUT_MS,
  });
  const obj = asObject(raw, 'address stats');
  const chain = asObject(obj['chain_stats'], 'chain_stats');
  const mem = asObject(obj['mempool_stats'], 'mempool_stats');
  const funded = satAmount(chain['funded_txo_sum'], 'chain funded_txo_sum');
  const spent = satAmount(chain['spent_txo_sum'], 'chain spent_txo_sum');
  const memFunded = satAmount(mem['funded_txo_sum'], 'mempool funded_txo_sum');
  const memSpent = satAmount(mem['spent_txo_sum'], 'mempool spent_txo_sum');
  return {
    confirmedSats: funded - spent,
    pendingSats: memFunded - memSpent,
    fundedSats: funded,
    spentSats: spent,
  };
}

/**
 * Fetches the unspent outputs for an address. Every entry is validated on ingest
 * (F2): txids must be well-formed, values are non-negative integers ≤ 21M BTC,
 * and the array is size-capped. A malformed entry surfaces as an
 * {@link ApiResponseError}, never a thrown BigInt or a bad UTXO into signing.
 * @param network - The active network.
 * @param address - The address to query.
 */
export async function getUtxos(
  network: Network,
  address: string,
  signal?: AbortSignal,
): Promise<ApiUtxo[]> {
  const raw = await getJson<unknown>(
    `${apiBaseUrl(network)}/address/${encodeURIComponent(address)}/utxo`,
    { signal, timeoutMs: DISCOVERY_TIMEOUT_MS },
  );
  const arr = asArray(raw, 'utxo list');
  return arr.map((entry) => {
    const u = asObject(entry, 'utxo');
    const status = asObject(u['status'], 'utxo status');
    const confirmed = asBool(status['confirmed'], 'utxo confirmed');
    const blockHeight = status['block_height'];
    const utxo: ApiUtxo = {
      txid: txid(u['txid'], 'utxo txid'),
      vout: nonNegInt(u['vout'], 'utxo vout'),
      value: satAmount(u['value'], 'utxo value'),
      confirmed,
      ...(blockHeight !== undefined ? { blockHeight: nonNegInt(blockHeight, 'utxo block_height') } : {}),
    };
    return utxo;
  });
}

/**
 * Clamps an untrusted fee-rate estimate into the accepted `[MIN, MAX]` window
 * (F1). A non-finite/≤0 value falls back to the minimum accepted rate rather
 * than propagating a bad number into fee math.
 */
function clampFeeRate(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : MIN_ACCEPTED_FEE_RATE;
  if (n < MIN_ACCEPTED_FEE_RATE) return MIN_ACCEPTED_FEE_RATE;
  if (n > MAX_ACCEPTED_FEE_RATE) return MAX_ACCEPTED_FEE_RATE;
  return n;
}

/**
 * Fetches recommended fee rates, mapped to fast/medium/slow (sat/vByte). Each
 * rate is clamped into the sane `[MIN_ACCEPTED_FEE_RATE, MAX_ACCEPTED_FEE_RATE]`
 * window (F1) so a compromised/spiking endpoint can't push a wallet-draining
 * fee rate downstream.
 * @param network - The active network.
 */
export async function getFeeEstimates(network: Network): Promise<FeeEstimates> {
  const raw = await getJson<unknown>(`${apiBaseUrl(network)}/v1/fees/recommended`);
  const obj = asObject(raw, 'fee estimates');
  return {
    fast: clampFeeRate(obj['fastestFee']),
    medium: clampFeeRate(obj['halfHourFee']),
    slow: clampFeeRate(obj['hourFee']),
  };
}

/**
 * Broadcasts a raw signed transaction. Does not retry.
 * @param network - The active network.
 * @param txHex - The serialized transaction (hex).
 * @returns The broadcast transaction id.
 * @throws {ApiResponseError} With the API's error text on rejection.
 * @throws {ApiNetworkError} On transport failure.
 */
export async function broadcastTx(network: Network, txHex: string): Promise<string> {
  const res = await fetchOnce(
    `${apiBaseUrl(network)}/tx`,
    { method: 'POST', body: txHex, headers: { 'Content-Type': 'text/plain' } },
    DEFAULT_TIMEOUT_MS,
  );
  const body = (await res.text()).trim();
  if (!res.ok) {
    throw new ApiResponseError(res.status, body);
  }
  return body; // mempool.space returns the txid as plain text
}

/**
 * Fetches recent transactions touching an address, with the net value change
 * for that address computed per transaction. Every field is validated on ingest
 * (F2): txids well-formed, per-output/input values are non-negative integers
 * ≤ 21M BTC, and both the tx list and each tx's vin/vout arrays are size-capped.
 * A malformed entry surfaces as an {@link ApiResponseError}.
 * @param network - The active network.
 * @param address - The address to query.
 */
export async function getAddressTxs(
  network: Network,
  address: string,
  signal?: AbortSignal,
): Promise<AddressTx[]> {
  const raw = await getJson<unknown>(
    `${apiBaseUrl(network)}/address/${encodeURIComponent(address)}/txs`,
    { signal, timeoutMs: DISCOVERY_TIMEOUT_MS },
  );
  const arr = asArray(raw, 'tx list');
  return arr.map((entry) => {
    const tx = asObject(entry, 'tx');
    const status = asObject(tx['status'], 'tx status');
    const confirmed = asBool(status['confirmed'], 'tx confirmed');
    const blockTime = status['block_time'];

    let net = 0n;
    for (const voutEntry of asArray(tx['vout'], 'tx vout')) {
      const vout = asObject(voutEntry, 'vout');
      if (vout['scriptpubkey_address'] === address) net += satAmount(vout['value'], 'vout value');
    }
    for (const vinEntry of asArray(tx['vin'], 'tx vin')) {
      const vin = asObject(vinEntry, 'vin');
      const prevout = vin['prevout'];
      if (prevout !== null && prevout !== undefined) {
        const po = asObject(prevout, 'prevout');
        if (po['scriptpubkey_address'] === address) net -= satAmount(po['value'], 'prevout value');
      }
    }
    const out: AddressTx = {
      txid: txid(tx['txid'], 'tx txid'),
      confirmed,
      netSats: net,
      ...(blockTime !== undefined ? { blockTime: nonNegInt(blockTime, 'tx block_time') } : {}),
    };
    return out;
  });
}

/**
 * Fetches the current BTC/USD price. Always queries mainnet regardless of the
 * active network (there is no meaningful testnet price). The value is validated
 * as a finite, positive, plausibly-bounded number (F2) so a malformed price
 * can't feed a NaN/absurd figure into the USD display.
 * @returns The BTC price in USD.
 */
export async function getBtcUsdPrice(): Promise<number> {
  const raw = await getJson<unknown>('https://mempool.space/api/v1/prices');
  const obj = asObject(raw, 'prices');
  const usd = obj['USD'];
  // A generous upper bound: reject clearly-bogus prices while never rejecting a
  // real one. 1e9 USD/BTC is orders of magnitude beyond any plausible market.
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0 || usd > 1e9) {
    throw new ApiResponseError(200, 'Malformed price: not a plausible positive number');
  }
  return usd;
}
