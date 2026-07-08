/**
 * display.ts — UI-only formatting helpers layered on top of format.ts.
 *
 * These never touch secrets. They format amounts for the balance display, build
 * the `bitcoin:` URI for QR/share, and expose the BIP39 wordlist for restore
 * autocomplete.
 */
import { satsToBtcString, satsToUsdString, SATS_PER_BTC } from './lib';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** The three display units the balance cycles through. */
export type DisplayUnit = 'usd' | 'btc' | 'sats';

/** Cycles USD → BTC → sats → USD. */
export function nextUnit(unit: DisplayUnit): DisplayUnit {
  return unit === 'usd' ? 'btc' : unit === 'btc' ? 'sats' : 'usd';
}

/** Formats sats as a fixed 8-decimal BTC string (official amount, per DESIGN §3). */
export function fmtBtc(sats: bigint): string {
  const whole = sats / SATS_PER_BTC;
  const frac = (sats % SATS_PER_BTC).toString().padStart(8, '0');
  return `${whole.toString()}.${frac}`;
}

/** Formats sats as an integer with thousands separators, lowercase "sats". */
export function fmtSats(sats: bigint): string {
  return `${sats.toLocaleString('en-US')} sats`;
}

/**
 * Formats a USD amount, or a graceful placeholder when the price is unavailable.
 * @param sats - Amount in sats.
 * @param btcUsd - The price, or null when offline.
 */
export function fmtUsd(sats: bigint, btcUsd: number | null): string {
  if (btcUsd === null) return '$—';
  return satsToUsdString(sats, btcUsd);
}

/** The balance's secondary line: a compact BTC string (trims trailing zeros). */
export function fmtBtcCompact(sats: bigint): string {
  return `${satsToBtcString(sats)} BTC`;
}

/** Converts USD (as a number) to sats given a price. Floors to whole sats. */
export function usdToSats(usd: number, btcUsd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0 || !Number.isFinite(btcUsd) || btcUsd <= 0) return 0n;
  const btc = usd / btcUsd;
  return BigInt(Math.floor(btc * 1e8));
}

/** Converts sats to a USD number (for live conversion display). */
export function satsToUsdNumber(sats: bigint, btcUsd: number): number {
  return (Number(sats) / 1e8) * btcUsd;
}

/** Builds a BIP21 `bitcoin:` URI for QR / share. */
export function bitcoinUri(address: string): string {
  return `bitcoin:${address}`;
}

/** The BIP39 English wordlist, for restore autocomplete + confirm decoys. */
export const bip39Words: readonly string[] = wordlist;

/** True if `w` is in the BIP39 wordlist (exact, lowercased). */
export function isBip39Word(w: string): boolean {
  return wordlist.includes(w.trim().toLowerCase());
}
