/**
 * api.ts — thin REST client for two public Esplora-shaped APIs.
 *
 * v1.2.0 SPLITS the base URL by concern (a trust-model change; Round 13 audit
 * OWED). CHAIN DATA (address stats / utxos / txs / one-tx fetch / broadcast) now
 * goes to blockstream.info via {@link chainApiBaseUrl}: the owner's IP is
 * currently HTTP-429 rate-limited by mempool.space while blockstream serves the
 * same connection flawlessly, and blockstream's address/tx endpoints return
 * byte-identical shapes (chain_stats / mempool_stats, same field names —
 * live-verified), so every F2 ingest validator transfers unchanged. FEES + PRICE
 * (getFeeEstimates / getBtcUsdPrice) stay on mempool.space via {@link apiBaseUrl}
 * — blockstream serves a DIFFERENT fee shape (a confirmation-target map) and no
 * price endpoint, so keeping them here leaves the F1-audited fee path
 * byte-identical.
 *
 * Every call is network-scoped. Non-discovery GETs (fees / price / one-tx
 * fetch) get a single retry on transport failure; the DISCOVERY GETs
 * (stats / utxos / txs) do NOT retry (§1c, v1.1.1): against a stall-throttler a
 * per-request retry doubles offered load exactly when we're being punished, and
 * the run-level self-heal is the retry. POST (broadcast) never retries. All
 * requests are bounded by an AbortController timeout. Errors are typed to
 * distinguish a transport failure ({@link ApiNetworkError}) from an API-level
 * rejection ({@link ApiResponseError}).
 */
import type { Network } from './wallet';
import { MAX_SUPPLY_SATS } from './format';

/** Default per-request timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Timeout for address-discovery GETs (stats / utxos / txs). Deliberately short:
 * a stall-throttler hangs burst traffic until the client gives up, so a long
 * timeout turns a throttled burst into minutes of dead air. Kept provider-
 * agnostic on purpose (v1.2.0 moved chain data to blockstream, which serves
 * cleanly today, but mempool.space's stall-throttle tier — the 2026-07-09
 * behavior — may return, and this defense must survive a future fail-back). 8s
 * per request, and NO per-request retry (§1c) — a retry only piles more load
 * onto a stall-throttler — keeps a stalled lane from wedging a scan.
 */
const DISCOVERY_TIMEOUT_MS = 8_000;

/**
 * How long a discovery scan PAUSES in-run when a chain-data GET is rejected with
 * an explicit HTTP 429 (see {@link isRateLimitError}). Sized to the field-measured
 * token bucket (owner's IP vs mempool.space, 2026-07-10): the limiter refills at
 * ~1 request/second, so a ~12s wait restores ~12 tokens — roughly a full scan
 * wave — before the scan retries the paused request. Honoring the server's stated
 * wait REDUCES offered load; it is emphatically NOT the §1c-forbidden per-request
 * transport retry (which DOUBLED load against a silent staller that returned no
 * error). The COUNT of pauses per run is capped by the orchestrator
 * (`MAX_RATE_LIMIT_PAUSES`, actions.ts), so a persistent 429 wall still cuts the
 * run onto the backoff ladder rather than parking it in a pause loop.
 */
export const RATE_LIMIT_PAUSE_MS = 12_000;

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

/**
 * Hard cap on the vin/vout vector sizes we will ingest for a single
 * transaction (F2). Our own wallet's transactions carry a handful of inputs
 * and 1–2 outputs; 200 is far above anything this app will ever have built,
 * while still rejecting a hostile response designed to exhaust memory. A
 * legitimate foreign monster-tx over the cap surfaces as a typed error (it
 * could never be fee-bumped by this wallet anyway).
 */
const MAX_TX_VECTOR_ENTRIES = 200;

/**
 * Hard cap on a transaction's claimed weight (F2): the Bitcoin consensus block
 * weight limit. Anything above is a hostile/broken response, not a real tx.
 */
const MAX_TX_WEIGHT = 4_000_000;

/**
 * Hard cap on an ingested address string's length (F2). The longest standard
 * address form (bech32/bech32m) is 90 characters per BIP-173; 100 leaves slack
 * without admitting hostile megabyte "addresses" into app state.
 */
const MAX_ADDRESS_LENGTH = 100;

/**
 * Base URL for the mempool.space REST API (mainnet / testnet). Since v1.2.0 this
 * serves ONLY the fee-estimate + price path (getFeeEstimates / getBtcUsdPrice):
 * blockstream has a different fee shape and no price endpoint, so keeping these
 * here leaves the F1-audited fee path byte-identical. Chain data moved to
 * {@link chainApiBaseUrl}. Also used by the Activity screen's explorer deep-link
 * (display-only).
 */
export function apiBaseUrl(network: Network): string {
  return network === 'mainnet'
    ? 'https://mempool.space/api'
    : 'https://mempool.space/testnet/api';
}

/**
 * Base URL for the CHAIN-DATA REST API (address stats / utxos / txs / one-tx
 * fetch / broadcast). v1.2.0 points these at blockstream.info: the owner's IP is
 * currently HTTP-429 rate-limited by mempool.space while blockstream serves the
 * same connection flawlessly, and blockstream's Esplora address/tx endpoints
 * return byte-identical shapes to mempool.space (chain_stats / mempool_stats,
 * same field names — live-verified), so every F2 ingest validator below
 * transfers unchanged. Split out from {@link apiBaseUrl} so fees/price can stay
 * on mempool.space (see there). Trust-model change — Round 13 audit OWED.
 */
export function chainApiBaseUrl(network: Network): string {
  return network === 'mainnet'
    ? 'https://blockstream.info/api'
    : 'https://blockstream.info/testnet/api';
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

/**
 * Whether `err` is an explicit HTTP 429 (Too Many Requests). This is the ONE api
 * rejection the discovery layer treats specially: a 429 is the server explicitly
 * PRICING a wait (a token bucket refilling at ~1/s in tonight's field probes),
 * not a silent stall. The orchestrator honors it as a bounded in-run PAUSE (see
 * {@link RATE_LIMIT_PAUSE_MS}) that REDUCES offered load — the opposite of the
 * §1c-forbidden transport retry, which doubled load against a stall-throttler
 * that returns no error at all. Everything else (transport failure, any other
 * non-2xx, a malformed body) is unaffected and propagates exactly as before.
 */
export function isRateLimitError(err: unknown): boolean {
  return err instanceof ApiResponseError && err.status === 429;
}

// ---------------------------------------------------------------------------
// Untrusted-response validation (F2)
//
// Every numeric/string field consumed from an untrusted Esplora endpoint
// (blockstream.info for chain data, mempool.space for fees/price — v1.2.0) is
// validated on ingest so a hostile or buggy response surfaces as a typed
// ApiResponseError rather
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

/** Validates an unsigned 32-bit integer field (e.g. an input's nSequence). */
function asU32(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new ApiResponseError(200, `Malformed ${what}: not a u32 integer`);
  }
  return v;
}

/**
 * Validates an OPTIONAL address string field (F2): standard outputs always
 * carry `scriptpubkey_address`, but nonstandard ones (e.g. OP_RETURN) omit it —
 * on both networks (the same esplora code serves mainnet and testnet, verified
 * against live responses). Present-but-wrong-type or absurdly long values are
 * rejected; absent/null values return undefined.
 */
function optionalAddress(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_ADDRESS_LENGTH) {
    throw new ApiResponseError(200, `Malformed ${what}: not a plausible address string`);
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

/** The previous output an input spends, as reported by the API. */
export interface ApiTxPrevout {
  /** The value of the spent output, in sats. */
  readonly value: bigint;
  /** The address of the spent output; absent for nonstandard scripts. */
  readonly address?: string;
}

/** One input of a fetched transaction. */
export interface ApiTxVin {
  /** The funding transaction id. */
  readonly txid: string;
  /** The output index within the funding transaction. */
  readonly vout: number;
  /** The input's nSequence (BIP125: signals RBF when < 0xfffffffe). */
  readonly sequence: number;
  /** The spent output's value/address; absent for coinbase inputs. */
  readonly prevout?: ApiTxPrevout;
}

/** One output of a fetched transaction. */
export interface ApiTxVout {
  /** The output value, in sats. */
  readonly value: bigint;
  /** The output's address; absent for nonstandard scripts (e.g. OP_RETURN). */
  readonly address?: string;
}

/** A full transaction, fetched by txid and validated on ingest (F2). */
export interface ApiTransaction {
  readonly txid: string;
  readonly confirmed: boolean;
  /** The fee the transaction pays, in sats. */
  readonly feeSats: bigint;
  /** The transaction weight, in weight units. */
  readonly weight: number;
  /** The virtual size, in vBytes: ceil(weight / 4). */
  readonly vsize: number;
  readonly vin: readonly ApiTxVin[];
  readonly vout: readonly ApiTxVout[];
}

/** Per-request options for GETs: an abort signal and a timeout override. */
interface GetOpts {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
  /**
   * Whether to retry once on transport failure. Defaults to true. The discovery
   * GETs (stats / utxos / txs) pass `false` (§1c): retrying a stall-throttled
   * burst just doubles offered load; the run-level self-heal is their retry.
   */
  readonly retry?: boolean;
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
 * GET a URL as text. By default one retry on transport failure after a short,
 * jittered backoff (300–800 ms) — enough to step out of a blip without piling
 * on. Callers pass `retry: false` to disable it entirely: the discovery GETs do
 * (§1c), because retrying a stall-throttled burst only deepens the throttle.
 * Never retries API rejections, and never retries once the caller's signal has
 * aborted.
 */
async function getText(url: string, opts: GetOpts = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = opts.retry === false ? 1 : 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
  const raw = await getJson<unknown>(`${chainApiBaseUrl(network)}/address/${encodeURIComponent(address)}`, {
    signal,
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    retry: false,
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
    `${chainApiBaseUrl(network)}/address/${encodeURIComponent(address)}/utxo`,
    { signal, timeoutMs: DISCOVERY_TIMEOUT_MS, retry: false },
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
 *
 * F19: the returned string is the RELAY'S ECHO of the txid (an Esplora relay
 * answers a successful POST /tx with the txid as plain text) — callers must
 * NEVER treat it as the authoritative transaction id. The txid is derivable
 * locally from the signed bytes (`BuiltTx.txid`, tx.ts), and trusting a remote
 * echo for a locally-derivable fact violates the F15
 * never-trust-the-API-for-derivable-facts principle: a hostile relay could
 * return a wrong/garbage id, poisoning the displayed id and mis-keying the F15
 * send record. The broadcast paths in `actions.ts` therefore use `built.txid`
 * for the record and the returned {@link BroadcastResult}; the body is kept
 * ONLY for error surfacing on non-2xx (unchanged) and as a diagnostic echo — a
 * divergent echo on success is deliberately NOT a failure mode.
 *
 * @param network - The active network.
 * @param txHex - The serialized transaction (hex).
 * @returns The relay's response body (its echo of the txid) — diagnostics only.
 * @throws {ApiResponseError} With the API's error text on rejection.
 * @throws {ApiNetworkError} On transport failure.
 */
export async function broadcastTx(network: Network, txHex: string): Promise<string> {
  const res = await fetchOnce(
    `${chainApiBaseUrl(network)}/tx`,
    { method: 'POST', body: txHex, headers: { 'Content-Type': 'text/plain' } },
    DEFAULT_TIMEOUT_MS,
  );
  const body = (await res.text()).trim();
  if (!res.ok) {
    throw new ApiResponseError(res.status, body);
  }
  return body; // the relay's txid echo — never authoritative (F19, see above)
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
    `${chainApiBaseUrl(network)}/address/${encodeURIComponent(address)}/txs`,
    { signal, timeoutMs: DISCOVERY_TIMEOUT_MS, retry: false },
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
 * Fetches one transaction by txid — the data source for the Speed-up (RBF
 * fee-bump) flow. The `txidArg` is validated as 64-hex BEFORE the URL is built,
 * so a malformed/hostile identifier can never reach the request path.
 *
 * Every consumed field is validated on ingest (F2), and validation is
 * network-stable: the same esplora code serves mainnet and testnet, so the
 * response shape is identical on both (verified against live responses). The
 * only legitimately absent fields are `vin[].prevout` (coinbase inputs) and
 * `scriptpubkey_address` (nonstandard scripts) — both are typed as optional
 * rather than rejected, so validation is never flaky across networks.
 *
 * Cross-field integrity (F2): the response's own txid must equal the requested
 * txid, duplicate input outpoints are rejected, and — whenever every input
 * carries a prevout — the claimed `fee` must equal
 * `sum(prevout values) − sum(output values)` exactly. A hostile response
 * cannot understate or inflate the fee baseline the bump economics build on.
 *
 * @param network - The active network.
 * @param txidArg - The transaction id to fetch (64 lowercase hex chars).
 * @param signal - Optional abort signal.
 * @throws {ApiResponseError} Status 400 for a malformed `txidArg` (rejected
 *   client-side, no request made); status 200 for a malformed response field.
 * @throws {ApiNetworkError} On transport failure.
 */
export async function getTransaction(
  network: Network,
  txidArg: string,
  signal?: AbortSignal,
): Promise<ApiTransaction> {
  if (!/^[0-9a-f]{64}$/.test(txidArg)) {
    throw new ApiResponseError(400, 'Invalid txid argument (expected 64 lowercase hex chars)');
  }
  const raw = await getJson<unknown>(`${chainApiBaseUrl(network)}/tx/${txidArg}`, { signal });
  const obj = asObject(raw, 'transaction');

  const responseTxid = txid(obj['txid'], 'tx txid');
  if (responseTxid !== txidArg) {
    throw new ApiResponseError(200, 'Malformed transaction: txid does not match the request');
  }
  const status = asObject(obj['status'], 'tx status');
  const confirmed = asBool(status['confirmed'], 'tx confirmed');
  const feeSats = satAmount(obj['fee'], 'tx fee');
  const weight = nonNegInt(obj['weight'], 'tx weight');
  if (weight === 0 || weight > MAX_TX_WEIGHT) {
    throw new ApiResponseError(200, 'Malformed tx weight: outside the plausible range');
  }
  const vsize = Math.ceil(weight / 4);

  const vinRaw = asArray(obj['vin'], 'tx vin');
  const voutRaw = asArray(obj['vout'], 'tx vout');
  if (vinRaw.length === 0 || vinRaw.length > MAX_TX_VECTOR_ENTRIES) {
    throw new ApiResponseError(200, `Malformed tx vin: implausible entry count (${vinRaw.length})`);
  }
  if (voutRaw.length === 0 || voutRaw.length > MAX_TX_VECTOR_ENTRIES) {
    throw new ApiResponseError(200, `Malformed tx vout: implausible entry count (${voutRaw.length})`);
  }

  const seenOutpoints = new Set<string>();
  const vin: ApiTxVin[] = vinRaw.map((entry) => {
    const v = asObject(entry, 'vin');
    const inTxid = txid(v['txid'], 'vin txid');
    const inVout = nonNegInt(v['vout'], 'vin vout');
    const outpoint = `${inTxid}:${inVout}`;
    if (seenOutpoints.has(outpoint)) {
      throw new ApiResponseError(200, 'Malformed tx vin: duplicate input outpoint');
    }
    seenOutpoints.add(outpoint);
    const sequence = asU32(v['sequence'], 'vin sequence');
    const prevoutRaw = v['prevout'];
    if (prevoutRaw === null || prevoutRaw === undefined) {
      // Coinbase inputs carry no prevout; typed as optional, never rejected.
      return { txid: inTxid, vout: inVout, sequence };
    }
    const po = asObject(prevoutRaw, 'vin prevout');
    const address = optionalAddress(po['scriptpubkey_address'], 'prevout address');
    const prevout: ApiTxPrevout = {
      value: satAmount(po['value'], 'prevout value'),
      ...(address !== undefined ? { address } : {}),
    };
    return { txid: inTxid, vout: inVout, sequence, prevout };
  });

  const vout: ApiTxVout[] = voutRaw.map((entry) => {
    const o = asObject(entry, 'vout');
    const address = optionalAddress(o['scriptpubkey_address'], 'vout address');
    const out: ApiTxVout = {
      value: satAmount(o['value'], 'vout value'),
      ...(address !== undefined ? { address } : {}),
    };
    return out;
  });

  // Cross-field integrity: with every prevout present, the claimed fee must be
  // exactly inputs − outputs. (Skipped only for coinbase-style inputs, which
  // this wallet can never bump anyway.)
  if (vin.every((v) => v.prevout !== undefined)) {
    const totalIn = vin.reduce((sum, v) => sum + (v.prevout?.value ?? 0n), 0n);
    const totalOut = vout.reduce((sum, o) => sum + o.value, 0n);
    if (totalIn < totalOut || totalIn - totalOut !== feeSats) {
      throw new ApiResponseError(200, 'Malformed transaction: fee does not match inputs − outputs');
    }
  }

  return { txid: responseTxid, confirmed, feeSats, weight, vsize, vin, vout };
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
