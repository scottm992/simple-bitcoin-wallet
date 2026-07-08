import { describe, it, expect } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hex } from '@scure/base';
import {
  generateMnemonic,
  validateMnemonic,
  normalizeMnemonic,
  deriveReceiveAddress,
  deriveChangeAddress,
  deriveAddressRange,
  derivePrivateKeyForPath,
  derivationPath,
  accountPath,
} from '../wallet';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('BIP39', () => {
  it('derives the known seed vector for the test mnemonic (empty passphrase)', () => {
    // BIP39 official vector for the abandon…about mnemonic with passphrase "TREZOR".
    const seed = mnemonicToSeedSync(ABANDON, 'TREZOR');
    expect(hex.encode(seed)).toBe(
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
    );
  });

  it('generateMnemonic produces 12 valid words', () => {
    const m = generateMnemonic();
    expect(m.split(' ')).toHaveLength(12);
    expect(validateMnemonic(m)).toBe(true);
    for (const w of m.split(' ')) {
      expect(wordlist).toContain(w);
    }
  });

  it('generateMnemonic is unique across calls', () => {
    const set = new Set<string>();
    for (let i = 0; i < 20; i++) set.add(generateMnemonic());
    expect(set.size).toBe(20);
  });

  it('validateMnemonic tolerates case and extra whitespace', () => {
    expect(validateMnemonic(`  ${ABANDON.toUpperCase()}  `)).toBe(true);
    expect(validateMnemonic(ABANDON.replace(/ /g, '   '))).toBe(true);
    expect(validateMnemonic('not a real mnemonic phrase at all here nope')).toBe(false);
  });

  it('normalizeMnemonic collapses whitespace and lowercases', () => {
    expect(normalizeMnemonic('  ABANDON   ABOUT ')).toBe('abandon about');
  });
});

describe('BIP84 derivation vectors', () => {
  it('derives the spec receive/change addresses for mainnet', () => {
    expect(deriveReceiveAddress(ABANDON, 'mainnet', 0).address).toBe(
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    );
    expect(deriveReceiveAddress(ABANDON, 'mainnet', 1).address).toBe(
      'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
    );
    expect(deriveChangeAddress(ABANDON, 'mainnet', 0).address).toBe(
      'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
    );
  });

  it('exposes the correct path and a 33-byte public key', () => {
    const a = deriveReceiveAddress(ABANDON, 'mainnet', 0);
    expect(a.path).toBe("m/84'/0'/0'/0/0");
    expect(a.publicKey).toHaveLength(33);
  });

  it('uses coin type 1 for testnet and yields tb1 addresses', () => {
    expect(accountPath('testnet')).toBe("m/84'/1'/0'");
    const a = deriveReceiveAddress(ABANDON, 'testnet', 0);
    expect(a.address.startsWith('tb1')).toBe(true);
    expect(a.path).toBe("m/84'/1'/0'/0/0");
  });

  it('deriveAddressRange matches individual derivations', () => {
    const range = deriveAddressRange(ABANDON, 'mainnet', 0, 0, 3);
    expect(range.map((r) => r.address)).toEqual([
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
      deriveReceiveAddress(ABANDON, 'mainnet', 2).address,
    ]);
  });

  it('derivationPath builds the expected string and rejects bad indices', () => {
    expect(derivationPath('mainnet', 1, 5)).toBe("m/84'/0'/0'/1/5");
    expect(() => derivationPath('mainnet', 0, -1)).toThrow();
  });

  it('derivePrivateKeyForPath returns a 32-byte key', () => {
    const priv = derivePrivateKeyForPath(ABANDON, "m/84'/0'/0'/0/0");
    expect(priv).toHaveLength(32);
  });
});
