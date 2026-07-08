/**
 * wallet.ts — key generation and BIP84 native-segwit address derivation.
 *
 * Security notes:
 * - Private keys are never held in long-lived state. Callers pass the mnemonic
 *   (or a seed) into a derivation function; the derived key is used and then
 *   goes out of scope when the function returns.
 * - Randomness comes from `@scure/bip39`, which uses the platform CSPRNG
 *   (`crypto.getRandomValues`) under the hood.
 */
import { generateMnemonic as bip39Generate, mnemonicToSeedSync, validateMnemonic as bip39Validate } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { p2wpkh, NETWORK, TEST_NETWORK } from '@scure/btc-signer';

/** The Bitcoin network a wallet operates on. */
export type Network = 'mainnet' | 'testnet';

/** BIP44 chain index: 0 = external/receive, 1 = internal/change. */
export type Chain = 0 | 1;

/** A derived address together with the metadata needed to spend from it. */
export interface DerivedAddress {
  /** The bech32 P2WPKH address (bc1… on mainnet, tb1… on testnet). */
  readonly address: string;
  /** The full BIP32 derivation path, e.g. `m/84'/0'/0'/0/0`. */
  readonly path: string;
  /** The 33-byte compressed public key. */
  readonly publicKey: Uint8Array;
}

/**
 * Maps a {@link Network} to the `@scure/btc-signer` network descriptor used for
 * address encoding.
 */
export function btcNetwork(network: Network): typeof NETWORK {
  return network === 'mainnet' ? NETWORK : TEST_NETWORK;
}

/**
 * The SLIP-44 coin type used in the BIP84 derivation path.
 * mainnet → 0, testnet → 1.
 */
function coinType(network: Network): number {
  return network === 'mainnet' ? 0 : 1;
}

/**
 * The BIP84 account-level path for the given network, account 0.
 * mainnet → `m/84'/0'/0'`, testnet → `m/84'/1'/0'`.
 */
export function accountPath(network: Network): string {
  return `m/84'/${coinType(network)}'/0'`;
}

/**
 * The full BIP84 derivation path for a specific address.
 * @param network - The active network.
 * @param chain - 0 for receive addresses, 1 for change addresses.
 * @param index - The address index within the chain (>= 0).
 */
export function derivationPath(network: Network, chain: Chain, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError('Address index must be a non-negative integer');
  }
  return `${accountPath(network)}/${chain}/${index}`;
}

/**
 * Generates a fresh 12-word BIP39 mnemonic (128 bits of entropy) using the
 * platform CSPRNG.
 * @returns A space-separated 12-word mnemonic phrase.
 */
export function generateMnemonic(): string {
  return bip39Generate(wordlist, 128);
}

/**
 * Normalises a mnemonic for validation/derivation: lower-cases and collapses
 * runs of whitespace to single spaces, trimming the ends. BIP39 mnemonics are
 * defined over the lower-case English wordlist, so this makes validation
 * tolerant of stray whitespace and capitalisation from copy/paste.
 * @param phrase - The raw user-entered phrase.
 * @returns The normalised phrase.
 */
export function normalizeMnemonic(phrase: string): string {
  return phrase.normalize('NFKD').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Validates a BIP39 mnemonic (checksum + wordlist membership), tolerant of
 * case and extra whitespace.
 * @param phrase - The candidate mnemonic.
 * @returns `true` if the normalised phrase is a valid BIP39 mnemonic.
 */
export function validateMnemonic(phrase: string): boolean {
  return bip39Validate(normalizeMnemonic(phrase), wordlist);
}

/**
 * Derives the binary seed from a mnemonic. Callers should treat the returned
 * bytes as secret and let them go out of scope promptly.
 * @param mnemonic - A valid BIP39 mnemonic.
 * @param passphrase - Optional BIP39 passphrase ("25th word"). Defaults to "".
 * @returns The 64-byte seed.
 * @throws {Error} If the mnemonic is invalid.
 */
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Uint8Array {
  const normalized = normalizeMnemonic(mnemonic);
  if (!bip39Validate(normalized, wordlist)) {
    throw new Error('Invalid mnemonic');
  }
  return mnemonicToSeedSync(normalized, passphrase);
}

/**
 * Derives the HD node at `path` from a mnemonic. Internal helper; the returned
 * {@link HDKey} carries the private key and must not be persisted.
 */
function deriveNode(mnemonic: string, path: string): HDKey {
  const seed = mnemonicToSeed(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const node = root.derive(path);
  if (!node.publicKey) {
    throw new Error('Derivation failed: missing public key');
  }
  return node;
}

/**
 * Derives a single address (receive or change) from a mnemonic.
 * @param mnemonic - A valid BIP39 mnemonic (secret; goes out of scope on return).
 * @param network - The active network.
 * @param chain - 0 for receive, 1 for change.
 * @param index - The address index.
 * @returns The derived address, path, and public key.
 */
export function deriveAddress(
  mnemonic: string,
  network: Network,
  chain: Chain,
  index: number,
): DerivedAddress {
  const path = derivationPath(network, chain, index);
  const node = deriveNode(mnemonic, path);
  const publicKey = node.publicKey;
  if (!publicKey) {
    throw new Error('Derivation failed: missing public key');
  }
  const payment = p2wpkh(publicKey, btcNetwork(network));
  return { address: payment.address ?? '', path, publicKey };
}

/**
 * Derives a receive address (chain 0) at the given index.
 * @see deriveAddress
 */
export function deriveReceiveAddress(mnemonic: string, network: Network, index: number): DerivedAddress {
  return deriveAddress(mnemonic, network, 0, index);
}

/**
 * Derives a change address (chain 1) at the given index.
 * @see deriveAddress
 */
export function deriveChangeAddress(mnemonic: string, network: Network, index: number): DerivedAddress {
  return deriveAddress(mnemonic, network, 1, index);
}

/**
 * Derives a contiguous range of addresses for one chain. Useful for gap-limit
 * scanning and address lists in the UI.
 * @param mnemonic - A valid BIP39 mnemonic (secret).
 * @param network - The active network.
 * @param chain - 0 for receive, 1 for change.
 * @param start - The first index (>= 0).
 * @param count - How many addresses to derive (>= 0).
 * @returns An array of derived addresses of length `count`.
 */
export function deriveAddressRange(
  mnemonic: string,
  network: Network,
  chain: Chain,
  start: number,
  count: number,
): DerivedAddress[] {
  if (!Number.isInteger(start) || start < 0) {
    throw new RangeError('start must be a non-negative integer');
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError('count must be a non-negative integer');
  }
  // Derive once from the seed and reuse the root for the whole range.
  const seed = mnemonicToSeed(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const out: DerivedAddress[] = [];
  for (let i = start; i < start + count; i++) {
    const path = derivationPath(network, chain, i);
    const node = root.derive(path);
    const publicKey = node.publicKey;
    if (!publicKey) {
      throw new Error('Derivation failed: missing public key');
    }
    const payment = p2wpkh(publicKey, btcNetwork(network));
    out.push({ address: payment.address ?? '', path, publicKey });
  }
  return out;
}

/**
 * Derives the private key for a specific path at signing time. The returned
 * bytes are secret; use immediately and let them go out of scope. Do not store.
 * @param mnemonic - A valid BIP39 mnemonic (secret).
 * @param path - A full derivation path, e.g. `m/84'/0'/0'/0/0`.
 * @returns The 32-byte private key.
 * @throws {Error} If the node has no private key (e.g. hardened path issues).
 */
export function derivePrivateKeyForPath(mnemonic: string, path: string): Uint8Array {
  const node = deriveNode(mnemonic, path);
  if (!node.privateKey) {
    throw new Error('Derivation failed: missing private key');
  }
  return node.privateKey;
}
