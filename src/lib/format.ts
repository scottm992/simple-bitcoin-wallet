/**
 * format.ts — pure display/parsing helpers for amounts and addresses.
 *
 * All satoshi amounts are `bigint` to avoid floating-point rounding on values
 * that can exceed 2^53 sats (21e6 BTC = 2.1e15 sats fits in 2^53, but
 * intermediate math is safer in bigint).
 */

/** Satoshis in one bitcoin. */
export const SATS_PER_BTC = 100_000_000n;

/** Total supply cap, in satoshis (21,000,000 BTC). */
export const MAX_SUPPLY_SATS = 21_000_000n * SATS_PER_BTC;

/** Thrown when a user-entered BTC string cannot be parsed strictly. */
export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmountError';
  }
}

/**
 * Formats a satoshi amount as a BTC string with trailing zeros trimmed.
 * Always shows at least one decimal place (e.g. `0` sats → `"0.0"`).
 * @param sats - The amount in satoshis (non-negative bigint).
 * @returns The BTC amount as a decimal string, e.g. `"0.0001"`, `"1.5"`.
 * @throws {RangeError} If `sats` is negative.
 */
export function satsToBtcString(sats: bigint): string {
  if (sats < 0n) {
    throw new RangeError('sats must be non-negative');
  }
  const whole = sats / SATS_PER_BTC;
  const frac = sats % SATS_PER_BTC;
  // 8-digit zero-padded fractional part, then trim trailing zeros.
  let fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '');
  if (fracStr === '') {
    fracStr = '0'; // always show at least one decimal
  }
  return `${whole.toString()}.${fracStr}`;
}

/**
 * Strictly parses a BTC amount string into satoshis. Rejects anything that is
 * not a plain non-negative decimal with at most 8 fractional digits.
 * @param btc - The BTC amount as a string (e.g. `"0.5"`, `"1"`, `".001"`).
 * @returns The amount in satoshis as a bigint.
 * @throws {InvalidAmountError} On malformed input or more than 8 decimals.
 */
export function btcStringToSats(btc: string): bigint {
  const trimmed = btc.trim();
  // Optional integer part, optional fractional part; at least one digit total.
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || trimmed === '' || trimmed === '.') {
    throw new InvalidAmountError('Not a valid number');
  }
  const wholePart = match[1] ?? '';
  const fracPart = match[2] ?? '';
  if (wholePart === '' && fracPart === '') {
    throw new InvalidAmountError('Not a valid number');
  }
  if (fracPart.length > 8) {
    throw new InvalidAmountError('Too many decimal places (max 8)');
  }
  const whole = wholePart === '' ? 0n : BigInt(wholePart);
  const frac = fracPart === '' ? 0n : BigInt(fracPart.padEnd(8, '0'));
  return whole * SATS_PER_BTC + frac;
}

/**
 * Formats a satoshi amount as a USD string given a BTC/USD price.
 * @param sats - The amount in satoshis (non-negative bigint).
 * @param btcUsdPrice - The BTC price in USD (number).
 * @param options - `{ withSymbol }` to control the leading `$` (default true).
 * @returns A USD string like `"$1,234.56"`.
 * @throws {RangeError} If `sats` is negative or the price is not finite/>= 0.
 */
export function satsToUsdString(
  sats: bigint,
  btcUsdPrice: number,
  options: { withSymbol?: boolean } = {},
): string {
  if (sats < 0n) {
    throw new RangeError('sats must be non-negative');
  }
  if (!Number.isFinite(btcUsdPrice) || btcUsdPrice < 0) {
    throw new RangeError('btcUsdPrice must be a finite, non-negative number');
  }
  const { withSymbol = true } = options;
  // sats → BTC (float is fine for display-only USD conversion).
  const btc = Number(sats) / 1e8;
  const usd = btc * btcUsdPrice;
  const formatted = usd.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return withSymbol ? `$${formatted}` : formatted;
}

/**
 * Splits a string (typically a bech32 address) into space-separated groups of
 * `groupSize` characters for easier visual verification on the review screen.
 * @param value - The address or string to chunk.
 * @param groupSize - Characters per group (default 4, must be >= 1).
 * @returns The chunked string, e.g. `"bc1q cr8t e4kr …"`.
 * @throws {RangeError} If `groupSize` < 1.
 */
export function chunkAddress(value: string, groupSize = 4): string {
  if (!Number.isInteger(groupSize) || groupSize < 1) {
    throw new RangeError('groupSize must be a positive integer');
  }
  const groups: string[] = [];
  for (let i = 0; i < value.length; i += groupSize) {
    groups.push(value.slice(i, i + groupSize));
  }
  return groups.join(' ');
}
