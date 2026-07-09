/**
 * vault.ts — encrypted seed storage in localStorage.
 *
 * The mnemonic is encrypted with AES-256-GCM. The key is derived from the
 * user's password via scrypt (N=2^17 by default). A second, independent
 * ciphertext can optionally be stored, wrapped by a key derived from a WebAuthn
 * passkey's PRF output (Face ID / Touch ID / platform authenticator), so the
 * user can unlock without typing the password — while the password ciphertext
 * always remains as a fallback.
 *
 * Security invariants:
 * - Secrets (mnemonic, derived keys) are never logged and never placed in any
 *   Error message.
 * - Fresh random salt and IV per encryption.
 * - GCM authentication failure (wrong password / tampered ciphertext) surfaces
 *   as a typed {@link WrongPasswordError} / {@link VaultCorruptError}.
 */
import { scrypt } from '@noble/hashes/scrypt.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, utf8 } from '@scure/base';
import type { Network } from './wallet';

/** localStorage key under which the entire vault is stored. */
const VAULT_KEY = 'sbw.vault.v1';

/** Scrypt KDF parameters. */
export interface KdfParams {
  /** CPU/memory cost (power of two). Production default 2^17. */
  readonly N: number;
  readonly r: number;
  readonly p: number;
  /** Derived key length in bytes. */
  readonly dkLen: number;
}

/** Production-default scrypt parameters. */
export const DEFAULT_KDF_PARAMS: KdfParams = { N: 2 ** 17, r: 8, p: 1, dkLen: 32 };

/** The passkey-wrapped ciphertext, stored alongside the password ciphertext. */
interface PasskeyBlob {
  /** WebAuthn credential id (base64url as returned by the browser, stored base64). */
  readonly credentialIdB64: string;
  /** Random salt fed to the PRF extension to derive the same secret each time. */
  readonly prfSaltB64: string;
  /** HKDF salt used to derive the AES key from the PRF output. */
  readonly hkdfSaltB64: string;
  /** AES-GCM IV for this ciphertext. */
  readonly ivB64: string;
  /** AES-256-GCM ciphertext of the mnemonic. */
  readonly ciphertextB64: string;
}

/** The on-disk vault document (versioned JSON). */
export interface Vault {
  readonly version: 1;
  readonly kdf: 'scrypt';
  readonly kdfParams: KdfParams;
  /** scrypt salt (base64). */
  readonly saltB64: string;
  /** AES-GCM IV for the password ciphertext (base64). */
  readonly ivB64: string;
  /** AES-256-GCM ciphertext of the mnemonic (base64). */
  readonly ciphertextB64: string;
  /** The active network (not secret). */
  readonly network: Network;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** Optional passkey unlock material. */
  readonly passkey?: PasskeyBlob;
  /**
   * Last-known next-unused receive index per network (not secret — an index,
   * not an address or key). Lets Receive fall back to a locally-derived
   * address at the right index when account discovery is unavailable.
   */
  readonly lastReceiveIndex?: Partial<Record<Network, number>>;
  /**
   * Last-known highest USED index per chain, per network (not secret). Later
   * discovery scans anchor their gap window at these high-water marks, so a
   * fast first-paint scan can never terminate below funds a previous scan
   * already found.
   */
  readonly lastHighWater?: Partial<Record<Network, { receive: number; change: number }>>;
}

/** Thrown when the supplied password fails GCM authentication. */
export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect password');
    this.name = 'WrongPasswordError';
  }
}

/** Thrown when no vault exists but one was required. */
export class NoVaultError extends Error {
  constructor() {
    super('No vault found');
    this.name = 'NoVaultError';
  }
}

/** Thrown when the stored vault is malformed or its ciphertext is tampered. */
export class VaultCorruptError extends Error {
  constructor(message = 'Vault is corrupt') {
    super(message);
    this.name = 'VaultCorruptError';
  }
}

/** Thrown when a passkey operation fails or is unavailable/cancelled. */
export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyError';
  }
}

/** Returns the WebCrypto SubtleCrypto instance, or throws if unavailable. */
function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('WebCrypto is not available in this environment');
  }
  return c.subtle;
}

/** Fills a fresh random byte array of the given length via the platform CSPRNG. */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Imports raw bytes as a non-extractable AES-GCM CryptoKey. */
async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Copies a Uint8Array into a standalone ArrayBuffer (avoids SharedArrayBuffer typing). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/** AES-256-GCM encrypt `plaintext` (bytes) under `key` with `iv`. */
async function aesGcmEncrypt(key: CryptoKey, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(plaintext));
  return new Uint8Array(ct);
}

/** AES-256-GCM decrypt `ciphertext` under `key` with `iv`. */
async function aesGcmDecrypt(key: CryptoKey, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(ciphertext));
  return new Uint8Array(pt);
}

/** Derives the AES key from a password + salt using scrypt. */
function deriveKeyFromPassword(password: string, salt: Uint8Array, params: KdfParams): Uint8Array {
  return scrypt(utf8.decode(password.normalize('NFKD')), salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: params.dkLen,
  });
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

/** Reads and parses the stored vault, or returns null if none exists. */
function readVault(): Vault | null {
  const raw = globalThis.localStorage?.getItem(VAULT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Vault;
  } catch {
    throw new VaultCorruptError('Stored vault is not valid JSON');
  }
}

/** Serialises and stores the vault. */
function writeVault(vault: Vault): void {
  globalThis.localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
}

/** Returns true if a vault is present in storage. */
export function vaultExists(): boolean {
  return !!globalThis.localStorage?.getItem(VAULT_KEY);
}

/** Permanently deletes the vault from storage. */
export function deleteVault(): void {
  globalThis.localStorage?.removeItem(VAULT_KEY);
}

/** Returns the network stored in the vault, or null if no vault exists. */
export function getVaultNetwork(): Network | null {
  const vault = readVault();
  return vault ? vault.network : null;
}

/**
 * Updates the vault's stored network (not secret). No-op semantics: throws if
 * there is no vault.
 * @throws {NoVaultError} If no vault exists.
 */
export function setVaultNetwork(network: Network): void {
  const vault = readVault();
  if (!vault) throw new NoVaultError();
  writeVault({ ...vault, network });
}

/**
 * Returns the cached last-known next-unused receive index for a network, or
 * null when none has been recorded (fresh wallet / never discovered). Not a
 * secret — it is a derivation index, not an address or key.
 */
export function getCachedReceiveIndex(network: Network): number | null {
  const vault = readVault();
  const idx = vault?.lastReceiveIndex?.[network];
  return typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 ? idx : null;
}

/**
 * Records the last-known next-unused receive index for a network alongside the
 * vault (non-secret), so Receive can derive the right address locally when
 * discovery is unavailable. Silently no-ops without a vault or on a bogus index.
 */
export function setCachedReceiveIndex(network: Network, index: number): void {
  if (!Number.isInteger(index) || index < 0) return;
  const vault = readVault();
  if (!vault) return;
  writeVault({ ...vault, lastReceiveIndex: { ...vault.lastReceiveIndex, [network]: index } });
}

/**
 * Returns the cached per-chain high-water marks (highest used index) for a
 * network, or null when none recorded. Not secret — indices, not keys.
 */
export function getCachedHighWater(network: Network): { receive: number; change: number } | null {
  const vault = readVault();
  const hw = vault?.lastHighWater?.[network];
  if (!hw) return null;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= -1;
  return ok(hw.receive) && ok(hw.change) ? { receive: hw.receive, change: hw.change } : null;
}

/**
 * Records the per-chain high-water marks for a network alongside the vault
 * (non-secret). Silently no-ops without a vault or on bogus values.
 */
export function setCachedHighWater(
  network: Network,
  marks: { receive: number; change: number },
): void {
  if (!Number.isInteger(marks.receive) || !Number.isInteger(marks.change)) return;
  if (marks.receive < -1 || marks.change < -1) return;
  const vault = readVault();
  if (!vault) return;
  writeVault({ ...vault, lastHighWater: { ...vault.lastHighWater, [network]: marks } });
}

// ---------------------------------------------------------------------------
// Password vault
// ---------------------------------------------------------------------------

/**
 * Creates and stores a new encrypted vault for `mnemonic`, overwriting any
 * existing vault.
 * @param mnemonic - The mnemonic to protect (secret).
 * @param password - The user's password.
 * @param network - The active network to store alongside.
 * @param params - Scrypt parameters (defaults to {@link DEFAULT_KDF_PARAMS};
 *   tests may inject a lower N for speed).
 * @returns The stored {@link Vault} document.
 */
export async function createVault(
  mnemonic: string,
  password: string,
  network: Network,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<Vault> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const keyBytes = deriveKeyFromPassword(password, salt, params);
  const key = await importAesKey(keyBytes);
  const ciphertext = await aesGcmEncrypt(key, iv, utf8.decode(mnemonic));
  const vault: Vault = {
    version: 1,
    kdf: 'scrypt',
    kdfParams: params,
    saltB64: base64.encode(salt),
    ivB64: base64.encode(iv),
    ciphertextB64: base64.encode(ciphertext),
    network,
    createdAt: new Date().toISOString(),
  };
  writeVault(vault);
  return vault;
}

/**
 * Unlocks the vault with a password and returns the decrypted mnemonic.
 * @param password - The user's password.
 * @returns The decrypted mnemonic string.
 * @throws {NoVaultError} If no vault exists.
 * @throws {WrongPasswordError} If the password fails GCM authentication.
 * @throws {VaultCorruptError} If the stored data is malformed.
 */
export async function unlockVault(password: string): Promise<string> {
  const vault = readVault();
  if (!vault) throw new NoVaultError();
  let salt: Uint8Array;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    salt = base64.decode(vault.saltB64);
    iv = base64.decode(vault.ivB64);
    ciphertext = base64.decode(vault.ciphertextB64);
  } catch {
    throw new VaultCorruptError();
  }
  const keyBytes = deriveKeyFromPassword(password, salt, vault.kdfParams);
  const key = await importAesKey(keyBytes);
  let plaintext: Uint8Array;
  try {
    plaintext = await aesGcmDecrypt(key, iv, ciphertext);
  } catch {
    // GCM auth failure: wrong password or tampered ciphertext. Do not leak which.
    throw new WrongPasswordError();
  }
  return utf8.encode(plaintext);
}

// ---------------------------------------------------------------------------
// Passkey (WebAuthn PRF) unlock
// ---------------------------------------------------------------------------

/** The `prf` results shape returned in getClientExtensionResults(). */
interface PrfExtensionResults {
  prf?: { results?: { first?: ArrayBuffer | Uint8Array } };
}

/** True if this environment plausibly supports WebAuthn platform authenticators. */
export function isPasskeySupported(): boolean {
  return (
    typeof globalThis.PublicKeyCredential !== 'undefined' &&
    typeof globalThis.navigator !== 'undefined' &&
    typeof globalThis.navigator.credentials !== 'undefined' &&
    typeof globalThis.navigator.credentials.create === 'function' &&
    typeof globalThis.navigator.credentials.get === 'function'
  );
}

/** Extracts the `prf.results.first` bytes from a credential, or throws. */
function extractPrfFirst(cred: PublicKeyCredential): Uint8Array {
  const ext = cred.getClientExtensionResults() as PrfExtensionResults;
  const first = ext.prf?.results?.first;
  if (!first) {
    throw new PasskeyError('Passkey did not return a PRF result (not supported)');
  }
  return first instanceof Uint8Array ? first : new Uint8Array(first);
}

/** Derives the AES wrapping key bytes from a PRF secret via HKDF-SHA256. */
function wrapKeyFromPrf(prf: Uint8Array, hkdfSalt: Uint8Array): Uint8Array {
  return hkdf(sha256, prf, hkdfSalt, utf8.decode('sbw-passkey-wrap-v1'), 32);
}

/** rpId for WebAuthn — the current hostname (localhost in dev). */
function rpId(): string {
  return globalThis.location?.hostname || 'localhost';
}

/**
 * Options passed to {@link probePasskeyPrf}. The `userInitiated` flag is a hard
 * gate: this probe creates a real platform credential (see below), so it must
 * never fire from a passive capability check.
 */
export interface ProbePasskeyOptions {
  /**
   * Must be `true`, and must be set from within a user gesture where the user
   * has explicitly opted into setting up quick unlock. If false/absent the probe
   * refuses to run and returns false — this is the F7 fail-closed guard against
   * silently creating an orphan credential.
   */
  readonly userInitiated: boolean;
}

/**
 * Feature-detects PRF support by attempting a create/get. Returns true only if a
 * platform passkey with the `prf` extension can produce a PRF output here.
 *
 * IMPORTANT (F7): this necessarily *creates a real platform credential* — there
 * is no standard way to probe PRF without a WebAuthn ceremony. WebAuthn also
 * provides no reliable programmatic delete for platform credentials, so the
 * credential can be left behind ("orphaned"). Therefore this function:
 *   - refuses to run unless `opts.userInitiated === true` (so it can never be
 *     triggered by a passive/automatic capability check), and
 *   - best-effort signals the credential as unknown via
 *     `PublicKeyCredential.signalUnknownCredential` where the browser supports
 *     it, so a compliant authenticator can prune it.
 *
 * For a cheap, side-effect-free capability check, use {@link isPasskeySupported}
 * instead — call this only right before {@link enablePasskeyUnlock} when the
 * user has explicitly chosen to set up quick unlock.
 */
export async function probePasskeyPrf(opts: ProbePasskeyOptions): Promise<boolean> {
  if (!opts.userInitiated) return false; // F7: never create a credential passively
  if (!isPasskeySupported()) return false;
  try {
    const cred = (await navigator.credentials.create({
      publicKey: buildCreateOptions(randomBytes(32)),
    })) as PublicKeyCredential | null;
    if (!cred) return false;
    const ext = cred.getClientExtensionResults() as PrfExtensionResults & { prf?: { enabled?: boolean } };
    const supported = ext.prf?.enabled === true || !!ext.prf?.results?.first;
    // Best-effort cleanup so we don't leave a throwaway credential behind.
    await signalUnknownCredential(cred.rawId);
    return supported;
  } catch {
    return false;
  }
}

/**
 * Tells the authenticator (where supported) that a credential id is not one we
 * recognise, so a spec-compliant platform can prune the throwaway probe
 * credential. A no-op on browsers without `signalUnknownCredential`.
 */
async function signalUnknownCredential(rawId: ArrayBuffer): Promise<void> {
  const PKC = globalThis.PublicKeyCredential as
    | (typeof globalThis.PublicKeyCredential & {
        signalUnknownCredential?: (opts: { rpId: string; credentialId: string }) => Promise<void>;
      })
    | undefined;
  if (!PKC || typeof PKC.signalUnknownCredential !== 'function') return;
  try {
    await PKC.signalUnknownCredential({
      rpId: rpId(),
      credentialId: base64UrlNoPad(new Uint8Array(rawId)),
    });
  } catch {
    /* browser rejected / unsupported — best effort only */
  }
}

/** Encodes bytes as unpadded base64url, as required by the credential-signal API. */
function base64UrlNoPad(bytes: Uint8Array): string {
  return base64.encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Builds the credential-creation options with the PRF extension enabled. */
function buildCreateOptions(challenge: Uint8Array): PublicKeyCredentialCreationOptions {
  const userId = randomBytes(16);
  return {
    challenge: toArrayBuffer(challenge),
    rp: { name: 'Simple Bitcoin Wallet', id: rpId() },
    user: {
      id: toArrayBuffer(userId),
      name: 'wallet',
      displayName: 'Wallet',
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 }, // ES256
      { type: 'public-key', alg: -257 }, // RS256
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    },
    timeout: 60_000,
    extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
  };
}

/**
 * Enables passkey unlock: creates a platform passkey with the PRF extension,
 * derives a wrapping key from its PRF output, and stores a second ciphertext of
 * the mnemonic wrapped by that key — alongside (never replacing) the password
 * ciphertext.
 *
 * Uses the two-step create-then-get flow so the PRF output is obtained reliably
 * on platforms that do not evaluate PRF during creation.
 *
 * @param mnemonic - The mnemonic to wrap (secret). Must match the vault's.
 * @throws {NoVaultError} If no password vault exists yet.
 * @throws {PasskeyError} On any WebAuthn/PRF failure (caller should fall back).
 */
export async function enablePasskeyUnlock(mnemonic: string): Promise<void> {
  const vault = readVault();
  if (!vault) throw new NoVaultError();
  if (!isPasskeySupported()) throw new PasskeyError('Passkeys are not supported here');

  const prfSalt = randomBytes(32);

  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: buildCreateOptions(randomBytes(32)),
    })) as PublicKeyCredential | null;
  } catch (err) {
    throw new PasskeyError(`Passkey creation failed: ${errName(err)}`);
  }
  if (!cred) throw new PasskeyError('Passkey creation returned no credential');

  const credentialId = new Uint8Array(cred.rawId);

  // Step 2: evaluate the PRF with a fixed salt via an assertion.
  const prf = await evaluatePrf(credentialId, prfSalt);

  const hkdfSalt = randomBytes(16);
  const iv = randomBytes(12);
  const wrapKeyBytes = wrapKeyFromPrf(prf, hkdfSalt);
  const wrapKey = await importAesKey(wrapKeyBytes);
  const ciphertext = await aesGcmEncrypt(wrapKey, iv, utf8.decode(mnemonic));

  const passkey: PasskeyBlob = {
    credentialIdB64: base64.encode(credentialId),
    prfSaltB64: base64.encode(prfSalt),
    hkdfSaltB64: base64.encode(hkdfSalt),
    ivB64: base64.encode(iv),
    ciphertextB64: base64.encode(ciphertext),
  };
  writeVault({ ...vault, passkey });
}

/** Runs a WebAuthn assertion that evaluates the PRF for `credentialId` + `salt`. */
async function evaluatePrf(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<Uint8Array> {
  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: toArrayBuffer(randomBytes(32)),
        rpId: rpId(),
        allowCredentials: [{ type: 'public-key', id: toArrayBuffer(credentialId) }],
        userVerification: 'required',
        timeout: 60_000,
        extensions: {
          prf: { eval: { first: toArrayBuffer(prfSalt) } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (err) {
    throw new PasskeyError(`Passkey assertion failed: ${errName(err)}`);
  }
  if (!assertion) throw new PasskeyError('Passkey assertion returned no credential');
  return extractPrfFirst(assertion);
}

/**
 * Unlocks the vault using the stored passkey (Face ID / Touch ID). Falling back
 * to the password on a thrown {@link PasskeyError} is the caller's responsibility.
 * @returns The decrypted mnemonic.
 * @throws {NoVaultError} If no vault exists.
 * @throws {PasskeyError} If passkey unlock is not configured or fails.
 * @throws {VaultCorruptError} If the passkey ciphertext is malformed.
 */
export async function unlockWithPasskey(): Promise<string> {
  const vault = readVault();
  if (!vault) throw new NoVaultError();
  if (!vault.passkey) throw new PasskeyError('Passkey unlock is not enabled');
  if (!isPasskeySupported()) throw new PasskeyError('Passkeys are not supported here');

  let credentialId: Uint8Array;
  let prfSalt: Uint8Array;
  let hkdfSalt: Uint8Array;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    credentialId = base64.decode(vault.passkey.credentialIdB64);
    prfSalt = base64.decode(vault.passkey.prfSaltB64);
    hkdfSalt = base64.decode(vault.passkey.hkdfSaltB64);
    iv = base64.decode(vault.passkey.ivB64);
    ciphertext = base64.decode(vault.passkey.ciphertextB64);
  } catch {
    throw new VaultCorruptError('Passkey blob is corrupt');
  }

  const prf = await evaluatePrf(credentialId, prfSalt);
  const wrapKeyBytes = wrapKeyFromPrf(prf, hkdfSalt);
  const wrapKey = await importAesKey(wrapKeyBytes);
  let plaintext: Uint8Array;
  try {
    plaintext = await aesGcmDecrypt(wrapKey, iv, ciphertext);
  } catch {
    throw new PasskeyError('Passkey unlock failed to decrypt');
  }
  return utf8.encode(plaintext);
}

/** Returns true if the vault has passkey unlock configured. */
export function isPasskeyEnabled(): boolean {
  const vault = readVault();
  return !!vault?.passkey;
}

/**
 * Disables passkey unlock by removing the passkey ciphertext. The password
 * vault is untouched. No-op if no vault or no passkey configured.
 */
export function disablePasskeyUnlock(): void {
  const vault = readVault();
  if (!vault || !vault.passkey) return;
  const { passkey: _passkey, ...rest } = vault;
  void _passkey;
  writeVault(rest);
}

/** Returns an error's name/message without leaking secret material. */
function errName(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  return 'Error';
}
