# Wallet Engine API Reference

Terse reference for every exported symbol under `src/lib/`. Import from the
barrel: `import { … } from '../lib'` (or the specific module). All satoshi
amounts are `bigint`. No function keeps private keys in long-lived state — pass
the mnemonic in at call time and let it go out of scope.

---

## `wallet.ts` — keys & BIP84 addresses

**Types**
- `Network = 'mainnet' | 'testnet'`
- `Chain = 0 | 1` — 0 = receive, 1 = change
- `DerivedAddress { address: string; path: string; publicKey: Uint8Array }`

**Functions**
- `generateMnemonic(): string` — fresh 12-word BIP39 mnemonic (128-bit entropy, platform CSPRNG).
- `validateMnemonic(phrase: string): boolean` — checksum + wordlist check, tolerant of case/whitespace.
- `normalizeMnemonic(phrase: string): string` — NFKD, lower-case, collapse whitespace.
- `mnemonicToSeed(mnemonic: string, passphrase?: string): Uint8Array` — 64-byte seed (throws on invalid mnemonic).
- `btcNetwork(network: Network)` — maps to the `@scure/btc-signer` network descriptor.
- `accountPath(network: Network): string` — e.g. `m/84'/0'/0'` (mainnet), `m/84'/1'/0'` (testnet).
- `derivationPath(network, chain, index): string` — full path for one address.
- `deriveAddress(mnemonic, network, chain, index): DerivedAddress`
- `deriveReceiveAddress(mnemonic, network, index): DerivedAddress` — chain 0.
- `deriveChangeAddress(mnemonic, network, index): DerivedAddress` — chain 1.
- `deriveAddressRange(mnemonic, network, chain, start, count): DerivedAddress[]` — batch derive (gap-limit scans).
- `derivePrivateKeyForPath(mnemonic, path): Uint8Array` — 32-byte private key for signing; do not persist.

---

## `tx.ts` — build & sign transactions

**Types**
- `WalletUtxo { txid: string; vout: number; value: bigint; path: string; address: string }`
- `BuildTxParams { mnemonic; network; utxos; recipient; amountSats: bigint; feeRateSatVb: number; changeAddress; sendMax?; allowHighFee? }`
- `BuiltTx { txHex; txid; feeSats: bigint; vsize: number; totalInputSats: bigint; changeSats: bigint }`
- `DUST_LIMIT_SATS = 546n`

**Fee-sanity constants (F1/F10)**: `MAX_FEE_RATE_SAT_VB = 500` (HARD), `MAX_FEE_ABSOLUTE_SATS = 1_000_000n` (HARD), `MAX_FEE_FRACTION = 0.25` (informed-consent).

**Errors**: `InsufficientFundsError` (`.available`, `.required`), `InvalidRecipientError`, `InvalidTxParamsError`, `FeeTooHighError` (`.feeSats`, `.feeRateSatVb`, `.comparedToSats`).

`buildAndSignTx` rejects (with `FeeTooHighError`):
- a fee rate above `MAX_FEE_RATE_SAT_VB` — **hard, never bypassable**;
- a computed fee above `MAX_FEE_ABSOLUTE_SATS` — **hard, never bypassable**;
- a computed fee above `MAX_FEE_FRACTION` of the amount being sent (amount + fee for a normal send; total input for `sendMax`) — bypassable **only** via `allowHighFee: true`, which the UI sets exclusively after the user confirms the real fee numbers on the compose screen ("Send anyway", F10).

**Functions**
- `buildAndSignTx(params: BuildTxParams): BuiltTx` — validates recipient for the network, runs largest-first coin selection with fee iteration, folds dust change into the fee, supports `sendMax`. Signs P2WPKH inputs, finalizes, returns hex + txid.
- `estimateSendFee({ utxos, amountSats, feeRateSatVb, sendMax? }): FeeSelection` — dry-runs the engine's OWN coin selection (dust-fold and sendMax sweep included) with no key material; returns the exact fee/change/inputs the build will use plus `needsHighFeeConsent` (whether the `MAX_FEE_FRACTION` rule would trip). `buildAndSignTx` consumes this same function, so a compose pre-check built on it can never drift from the build (F11). Replaces the former `estimateFeeSats` (removed — it was a parallel 2-output estimate that diverged at the dust-fold boundary).
  - `FeeSelection { selected; numInputs; totalInputSats; feeSats; changeSats; hasChange; sendAmountSats; needsHighFeeConsent }`
- `scriptForAddress(address: string, network: Network): Uint8Array` — output script for a destination; accepts bech32/bech32m/base58, rejects wrong-network bech32.

---

## `api.ts` — mempool.space REST client

Every call takes `network: Network` first. GETs retry once on transport failure; broadcast never retries. 15s timeout.

**Types**
- `AddressStats { confirmedSats; pendingSats; fundedSats; spentSats }` (all `bigint`)
- `ApiUtxo { txid; vout; value: bigint; confirmed: boolean; blockHeight? }`
- `FeeEstimates { fast; medium; slow }` (sat/vB numbers)
- `AddressTx { txid; confirmed; blockTime?; netSats: bigint }`

**Fee-rate clamp constants (F1)**: `MIN_ACCEPTED_FEE_RATE = 1`, `MAX_ACCEPTED_FEE_RATE = 500`. `getFeeEstimates` clamps every returned rate into this window.

**Validation (F2)**: every numeric/string field consumed from mempool.space is validated on ingest — integers only, non-negative, `≤ MAX_SUPPLY_SATS`, well-formed 64-hex txids, array size caps. A malformed field throws a typed `ApiResponseError` (never a NaN or an uncaught `BigInt()` throw).

**Errors**: `ApiNetworkError` (`.cause`) — transport; `ApiResponseError` (`.status`, `.body`) — non-2xx **or** malformed/out-of-range response.

**Functions**
- `apiBaseUrl(network): string`
- `getAddressStats(network, address): Promise<AddressStats>`
- `getUtxos(network, address): Promise<ApiUtxo[]>`
- `getFeeEstimates(network): Promise<FeeEstimates>`
- `broadcastTx(network, txHex): Promise<string>` — returns txid; surfaces API error text.
- `getAddressTxs(network, address): Promise<AddressTx[]>`
- `getBtcUsdPrice(): Promise<number>` — always mainnet `/v1/prices`.

---

## `vault.ts` — encrypted seed storage

Vault is versioned JSON under one localStorage key (`sbw.vault.v1`). Mnemonic is
AES-256-GCM encrypted; key = scrypt(password) (`N=2^17` default). Optional
passkey (WebAuthn PRF) stores a second, independent ciphertext; password always
remains a fallback. Secrets are never logged or placed in errors.

**Types / constants**
- `KdfParams { N; r; p; dkLen }`; `DEFAULT_KDF_PARAMS = { N: 2**17, r: 8, p: 1, dkLen: 32 }`
- `Vault { version:1; kdf:'scrypt'; kdfParams; saltB64; ivB64; ciphertextB64; network; createdAt; passkey? }`

**Errors**: `WrongPasswordError`, `NoVaultError`, `VaultCorruptError`, `PasskeyError`.

**Password functions**
- `createVault(mnemonic, password, network, params?=DEFAULT_KDF_PARAMS): Promise<Vault>`
- `unlockVault(password): Promise<string>` — throws `WrongPasswordError` on GCM auth failure.
- `vaultExists(): boolean`; `deleteVault(): void`
- `getVaultNetwork(): Network | null`; `setVaultNetwork(network): void`

**Passkey functions** (all fail gracefully with typed errors)
- `isPasskeySupported(): boolean` — cheap, side-effect-free capability check (use this by default).
- `probePasskeyPrf(opts: { userInitiated: boolean }): Promise<boolean>` — deeper PRF probe. **Creates a real platform credential** (WebAuthn has no side-effect-free PRF probe), so it refuses to run unless `userInitiated: true` and best-effort signals the throwaway credential for pruning (F7). Call only from an explicit user opt-in, immediately before `enablePasskeyUnlock`.
- `enablePasskeyUnlock(mnemonic): Promise<void>` — create platform passkey + store PRF-wrapped ciphertext.
- `unlockWithPasskey(): Promise<string>`
- `isPasskeyEnabled(): boolean`; `disablePasskeyUnlock(): void`

---

## `format.ts` — display helpers

**Constants**: `SATS_PER_BTC = 100_000_000n`, `MAX_SUPPLY_SATS`.
**Error**: `InvalidAmountError`.

**Functions**
- `satsToBtcString(sats: bigint): string` — trims trailing zeros, always ≥ 1 decimal.
- `btcStringToSats(btc: string): bigint` — strict parse; rejects > 8 decimals / malformed (`InvalidAmountError`).
- `satsToUsdString(sats: bigint, btcUsdPrice: number, opts?: { withSymbol?: boolean }): string`
- `chunkAddress(value: string, groupSize=4): string` — space-separated groups for the review screen.
