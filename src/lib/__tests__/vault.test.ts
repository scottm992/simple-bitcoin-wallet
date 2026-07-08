import { describe, it, expect, beforeEach } from 'vitest';
import {
  createVault,
  unlockVault,
  vaultExists,
  deleteVault,
  getVaultNetwork,
  setVaultNetwork,
  isPasskeyEnabled,
  disablePasskeyUnlock,
  WrongPasswordError,
  VaultCorruptError,
  NoVaultError,
  type KdfParams,
} from '../vault';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Fast scrypt for tests only; production default is N=2^17.
const FAST_KDF: KdfParams = { N: 2 ** 8, r: 8, p: 1, dkLen: 32 };
const VAULT_KEY = 'sbw.vault.v1';

beforeEach(() => {
  localStorage.clear();
});

describe('vault password roundtrip', () => {
  it('encrypts and decrypts the mnemonic', async () => {
    expect(vaultExists()).toBe(false);
    await createVault(ABANDON, 'hunter2', 'mainnet', FAST_KDF);
    expect(vaultExists()).toBe(true);
    const out = await unlockVault('hunter2');
    expect(out).toBe(ABANDON);
  });

  it('throws WrongPasswordError on a bad password', async () => {
    await createVault(ABANDON, 'correct horse', 'mainnet', FAST_KDF);
    await expect(unlockVault('wrong password')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('throws on tampered ciphertext', async () => {
    await createVault(ABANDON, 'pw', 'testnet', FAST_KDF);
    const raw = JSON.parse(localStorage.getItem(VAULT_KEY)!) as { ciphertextB64: string };
    // Flip a character in the base64 ciphertext.
    const flipped = raw.ciphertextB64.slice(0, -2) + (raw.ciphertextB64.slice(-2, -1) === 'A' ? 'B' : 'A') + raw.ciphertextB64.slice(-1);
    localStorage.setItem(VAULT_KEY, JSON.stringify({ ...raw, ciphertextB64: flipped }));
    await expect(unlockVault('pw')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('does not store the mnemonic in plaintext anywhere in the vault', async () => {
    await createVault(ABANDON, 'pw', 'mainnet', FAST_KDF);
    const raw = localStorage.getItem(VAULT_KEY)!;
    expect(raw).not.toContain('abandon');
    expect(raw).not.toContain(ABANDON);
  });

  it('uses a fresh random salt and IV per encryption', async () => {
    await createVault(ABANDON, 'pw', 'mainnet', FAST_KDF);
    const v1 = JSON.parse(localStorage.getItem(VAULT_KEY)!) as { saltB64: string; ivB64: string; ciphertextB64: string };
    await createVault(ABANDON, 'pw', 'mainnet', FAST_KDF);
    const v2 = JSON.parse(localStorage.getItem(VAULT_KEY)!) as { saltB64: string; ivB64: string; ciphertextB64: string };
    expect(v1.saltB64).not.toBe(v2.saltB64);
    expect(v1.ivB64).not.toBe(v2.ivB64);
    expect(v1.ciphertextB64).not.toBe(v2.ciphertextB64);
  });
});

describe('vault management', () => {
  it('stores and updates the network', async () => {
    await createVault(ABANDON, 'pw', 'mainnet', FAST_KDF);
    expect(getVaultNetwork()).toBe('mainnet');
    setVaultNetwork('testnet');
    expect(getVaultNetwork()).toBe('testnet');
    // Still unlockable after network change.
    expect(await unlockVault('pw')).toBe(ABANDON);
  });

  it('deleteVault removes the vault', async () => {
    await createVault(ABANDON, 'pw', 'mainnet', FAST_KDF);
    deleteVault();
    expect(vaultExists()).toBe(false);
    expect(getVaultNetwork()).toBeNull();
  });

  it('unlock/setNetwork throw when no vault exists', async () => {
    await expect(unlockVault('pw')).rejects.toBeInstanceOf(NoVaultError);
    expect(() => setVaultNetwork('mainnet')).toThrow(NoVaultError);
  });

  it('throws VaultCorruptError on malformed JSON', async () => {
    localStorage.setItem(VAULT_KEY, '{not valid json');
    expect(() => getVaultNetwork()).toThrow(VaultCorruptError);
  });

  it('passkey is not enabled by default and disabling is a safe no-op', async () => {
    await createVault(ABANDON, 'pw', 'mainnet', FAST_KDF);
    expect(isPasskeyEnabled()).toBe(false);
    expect(() => disablePasskeyUnlock()).not.toThrow();
  });
});
