/**
 * api.ts — thin REST client for the public mempool.space API.
 *
 * Every call is network-scoped. GETs get a single retry; POST (broadcast) does
 * not retry. All requests are bounded by an AbortController timeout. Errors are
 * typed to distinguish a transport failure ({@link ApiNetworkError}) from an
 * API-level rejection ({@link ApiResponseError}).
 */
import type { Network } from './wallet';

/** Default per-request timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15_000;

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

/** Performs a single fetch bounded by an AbortController timeout. */
async function fetchOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw new ApiNetworkError('Network request failed', err);
  } finally {
    clearTimeout(timer);
  }
}

/** GET a URL as text, with one retry on transport failure. */
async function getText(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchOnce(url, { method: 'GET' }, timeoutMs);
      const body = await res.text();
      if (!res.ok) {
        throw new ApiResponseError(res.status, body);
      }
      return body;
    } catch (err) {
      // Retry only transport failures, never API rejections.
      if (err instanceof ApiResponseError) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new ApiNetworkError('Network request failed', lastErr);
}

/** GET a URL and parse it as JSON. */
async function getJson<T>(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const text = await getText(url, timeoutMs);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new ApiResponseError(200, `Malformed JSON response: ${String(err)}`);
  }
}

/** Shape of mempool.space's `/address/:addr` response (subset used). */
interface RawAddressStats {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
}

/**
 * Fetches confirmed and pending balance for an address.
 * @param network - The active network.
 * @param address - The address to query.
 */
export async function getAddressStats(network: Network, address: string): Promise<AddressStats> {
  const raw = await getJson<RawAddressStats>(`${apiBaseUrl(network)}/address/${encodeURIComponent(address)}`);
  const funded = BigInt(raw.chain_stats.funded_txo_sum);
  const spent = BigInt(raw.chain_stats.spent_txo_sum);
  const memFunded = BigInt(raw.mempool_stats.funded_txo_sum);
  const memSpent = BigInt(raw.mempool_stats.spent_txo_sum);
  return {
    confirmedSats: funded - spent,
    pendingSats: memFunded - memSpent,
    fundedSats: funded,
    spentSats: spent,
  };
}

/** Shape of mempool.space's `/address/:addr/utxo` response entries. */
interface RawUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

/**
 * Fetches the unspent outputs for an address.
 * @param network - The active network.
 * @param address - The address to query.
 */
export async function getUtxos(network: Network, address: string): Promise<ApiUtxo[]> {
  const raw = await getJson<RawUtxo[]>(`${apiBaseUrl(network)}/address/${encodeURIComponent(address)}/utxo`);
  return raw.map((u) => {
    const utxo: ApiUtxo = {
      txid: u.txid,
      vout: u.vout,
      value: BigInt(u.value),
      confirmed: u.status.confirmed,
      ...(u.status.block_height !== undefined ? { blockHeight: u.status.block_height } : {}),
    };
    return utxo;
  });
}

/** Shape of mempool.space's `/v1/fees/recommended` response. */
interface RawFees {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

/**
 * Fetches recommended fee rates, mapped to fast/medium/slow (sat/vByte).
 * @param network - The active network.
 */
export async function getFeeEstimates(network: Network): Promise<FeeEstimates> {
  const raw = await getJson<RawFees>(`${apiBaseUrl(network)}/v1/fees/recommended`);
  return {
    fast: raw.fastestFee,
    medium: raw.halfHourFee,
    slow: raw.hourFee,
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

/** Shape of mempool.space's `/address/:addr/txs` entries (subset used). */
interface RawTx {
  txid: string;
  status: { confirmed: boolean; block_time?: number };
  vin: { prevout: { scriptpubkey_address?: string; value: number } | null }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}

/**
 * Fetches recent transactions touching an address, with the net value change
 * for that address computed per transaction.
 * @param network - The active network.
 * @param address - The address to query.
 */
export async function getAddressTxs(network: Network, address: string): Promise<AddressTx[]> {
  const raw = await getJson<RawTx[]>(`${apiBaseUrl(network)}/address/${encodeURIComponent(address)}/txs`);
  return raw.map((tx) => {
    let net = 0n;
    for (const vout of tx.vout) {
      if (vout.scriptpubkey_address === address) net += BigInt(vout.value);
    }
    for (const vin of tx.vin) {
      if (vin.prevout && vin.prevout.scriptpubkey_address === address) net -= BigInt(vin.prevout.value);
    }
    const out: AddressTx = {
      txid: tx.txid,
      confirmed: tx.status.confirmed,
      netSats: net,
      ...(tx.status.block_time !== undefined ? { blockTime: tx.status.block_time } : {}),
    };
    return out;
  });
}

/** Shape of mempool.space's `/v1/prices` response (subset used). */
interface RawPrices {
  USD: number;
}

/**
 * Fetches the current BTC/USD price. Always queries mainnet regardless of the
 * active network (there is no meaningful testnet price).
 * @returns The BTC price in USD.
 */
export async function getBtcUsdPrice(): Promise<number> {
  const raw = await getJson<RawPrices>('https://mempool.space/api/v1/prices');
  return raw.USD;
}
