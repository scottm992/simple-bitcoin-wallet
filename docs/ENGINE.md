# Wallet Engine API Reference

Terse reference for every exported symbol under `src/lib/`, plus the discovery
orchestration layer in `src/actions.ts` (last section). Import from the
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

**RBF signaling (BIP125)**: `RBF_SEQUENCE = 0xfffffffd` — `buildAndSignTx` sets this `nSequence` on **every** input, so every payment signals opt-in Replace-By-Fee (`nSequence < 0xfffffffe`). `0xfffffffd` is `MAX_BIP125_RBF_SEQUENCE` (the largest RBF-signaling value; its BIP68 disable bit `0x80000000` stays set → no relative timelock). It is committed in the BIP143 sighash, so it is authenticated by every signature and lands in the final signed tx; it does not change vsize, so fee estimates are unaffected. Makes a stuck, under-priced payment rescuable by the Speed-up (fee-bump) flow.

**RBF fee bump (Speed-up)**: `INCREMENTAL_RELAY_SAT_VB = 1` (the BIP125 rule-4 relay floor).
- `estimateBumpFee({ utxos, recipientAmountSats, hasChangeOutput, oldFeeSats, oldVsize, feeRateSatVb }): BumpFeeEstimate` — pure dry-run of a replacement: SAME inputs (exactly the original outpoints; v1 adds none, keeping the BIP125 conflict set identical) and SAME recipient. The fee increase comes out of change; a no-change (sweep) original reduces the recipient amount instead (`reducesRecipientBy > 0` → the UI must collect explicit consent). Change squeezed sub-dust folds into the fee (same dust rule as sends). Enforces the BIP125 floors — new fee ≥ old fee + `INCREMENTAL_RELAY_SAT_VB` × new vsize AND effective rate strictly > old rate — by RAISING the fee to the floor and reporting it (`rateWasRaised`); never describes a replacement relays would reject. Verifies the caller's numbers reconcile (`inputs = amount + change + fee`, else `InvalidTxParamsError`) and bounds `oldVsize` to a plausible window. Throws `CannotBumpError('insufficient-change')` when nothing in the payment can absorb any increase. Computes `needsHighFeeConsent` and `exceedsRateCeiling` for the build to enforce.
- `buildRbfBumpTx({ mnemonic; network; utxos; recipient; recipientAmountSats; changeAddress: string | null; oldFeeSats; oldVsize; feeRateSatVb; allowHighFee? }): BuiltTx` — CONSUMES `estimateBumpFee` (never a parallel computation, F11) and signs the replacement; every input re-signals `RBF_SEQUENCE`, so a bump can itself be re-bumped. All send fee guards apply unchanged (F1/F10): requested rate > `MAX_FEE_RATE_SAT_VB` — **hard**; floors pushing the fee past that ceiling for the replacement's size (`exceedsRateCeiling`) — **hard**; fee > `MAX_FEE_ABSOLUTE_SATS` — **hard**; the 25% consent rule bypassable **only** via `allowHighFee` (compared to amount + fee, or total input for a sweep — same semantics as sends).
- `CannotBumpError` (`.reason`) — machine-readable dead-ends: `'confirmed' | 'not-signaling' | 'foreign-inputs' | 'insufficient-change' | 'unsupported-shape' | 'recipient-mismatch' | 'unverified'` (the last two are the F15 send-record verification: mismatch = possible attack, hard fail, no override; unverified = no local record on this device, e.g. a wallet restored from its 12 words).

**Errors**: `InsufficientFundsError` (`.available`, `.required`), `InvalidRecipientError`, `InvalidTxParamsError`, `FeeTooHighError` (`.feeSats`, `.feeRateSatVb`, `.comparedToSats`), `CannotBumpError` (`.reason`).

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

Every call takes `network: Network` first. GETs retry once on transport failure after a short jittered backoff (300–800 ms); broadcast never retries. Discovery GETs (stats/utxos/txs) use an 8s timeout and accept an optional `AbortSignal` so a whole discovery run can be cancelled; other calls use 15s.

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
- `getAddressStats(network, address, signal?): Promise<AddressStats>`
- `getUtxos(network, address, signal?): Promise<ApiUtxo[]>`
- `getFeeEstimates(network): Promise<FeeEstimates>`
- `broadcastTx(network, txHex): Promise<string>` — returns txid; surfaces API error text.
- `getAddressTxs(network, address, signal?): Promise<AddressTx[]>`
- `getTransaction(network, txid, signal?): Promise<ApiTransaction>` — one transaction by id (the Speed-up flow's data source; ONE request). The txid ARGUMENT is validated (64-hex) BEFORE the URL is built (status-400 `ApiResponseError`, no request made). F2 ingest validation on every consumed field: `status.confirmed` boolean; `fee` sat-range; `weight` positive integer ≤ 4M (vsize = `ceil(weight/4)`); vin/vout arrays 1–200 entries; per-vin 64-hex txid, non-negative vout, u32 `sequence`, no duplicate outpoints; sat-range values; length-capped address strings. `vin[].prevout` (absent on coinbase) and address fields (absent on nonstandard scripts) are OPTIONAL by type — the same esplora shape serves both networks (live-verified), so validation is never flaky across networks. Cross-field integrity: the response's txid must equal the request, and when every input carries a prevout, `fee` must equal inputs − outputs exactly.
  - `ApiTransaction { txid; confirmed; feeSats: bigint; weight; vsize; vin: ApiTxVin[]; vout: ApiTxVout[] }`; `ApiTxVin { txid; vout; sequence; prevout?: ApiTxPrevout }`; `ApiTxPrevout { value: bigint; address? }`; `ApiTxVout { value: bigint; address? }`
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
- `getCachedReceiveIndex(network): number | null`; `setCachedReceiveIndex(network, index): void` — non-secret last-known next-unused receive index per network, stored alongside the vault. Lets Receive derive a correct address locally when discovery is unavailable (fall back to index 0 if never recorded).
- `getCachedHighWater(network): { receive; change } | null`; `setCachedHighWater(network, marks): void` — non-secret per-chain highest-used-index marks; later discovery scans anchor their gap window here so a fast first-paint scan can't terminate below known funds.

**Passkey functions** (all fail gracefully with typed errors)
- `isPasskeySupported(): boolean` — cheap, side-effect-free capability check (use this by default).
- `probePasskeyPrf(opts: { userInitiated: boolean }): Promise<boolean>` — deeper PRF probe. **Creates a real platform credential** (WebAuthn has no side-effect-free PRF probe), so it refuses to run unless `userInitiated: true` and best-effort signals the throwaway credential for pruning (F7). Call only from an explicit user opt-in, immediately before `enablePasskeyUnlock`.
- `enablePasskeyUnlock(mnemonic): Promise<void>` — create platform passkey + store PRF-wrapped ciphertext.
- `unlockWithPasskey(): Promise<string>`
- `isPasskeyEnabled(): boolean`; `disablePasskeyUnlock(): void`

---

## `sendLog.ts` — the local send record (F15)

Non-secret, per-network localStorage log (own key `sbw.sends.v1`; vault.ts untouched) of this wallet's OWN broadcasts: txid → { recipient, amountSats }, written at broadcast time from the USER-confirmed values. It is the Speed-up flow's verification baseline: `prepareBump` hard-fails a bump whose API-reported recipient/amount don't match the record, so the wallet never signs a bump to a destination it didn't itself send to. Bounded (`MAX_SEND_RECORDS_PER_NETWORK = 200` most-recent per network, oldest-first eviction) and best-effort (a storage failure never breaks broadcasting). Corrupt/absent data degrades to "no record" (a fail-safe dead-end), never a crash.

- `recordSend(network, txid, { recipient, amountSats }): boolean` — persists one record (replaces same-txid; caps the list). `false` = write failed (surfaced via `BroadcastResult.sendRecorded`).
- `getSendRecord(network, txid): SendRecord | null` — `null` = never broadcast on this device / evicted.
- `normalizeRecipientAddress(address): string` — trims; lowercases bech32 (BIP173 case-insensitivity — the API reports lowercase); preserves base58 verbatim (case-sensitive).
- `SEND_LOG_STORAGE_KEY = 'sbw.sends.v1'`, `MAX_SEND_RECORDS_PER_NETWORK = 200`.

---

## `format.ts` — display helpers

**Constants**: `SATS_PER_BTC = 100_000_000n`, `MAX_SUPPLY_SATS`.
**Error**: `InvalidAmountError`.

**Functions**
- `satsToBtcString(sats: bigint): string` — trims trailing zeros, always ≥ 1 decimal.
- `btcStringToSats(btc: string): bigint` — strict parse; rejects > 8 decimals / malformed (`InvalidAmountError`).
- `satsToUsdString(sats: bigint, btcUsdPrice: number, opts?: { withSymbol?: boolean }): string`
- `chunkAddress(value: string, groupSize=4): string` — space-separated groups for the review screen.

---

## `src/actions.ts` — discovery orchestration (outside `lib/`)

The coordination layer between the engine and the UI. Its shape is dictated by
one field-discovered constraint: **mempool.space throttles request bursts by
stalling connections until client timeout — it returns no error.** So discovery
is single-flight, budget-limited, and deadline-bounded. Any change touching
discovery must preserve this pattern (see review rounds 5–6, F12/F13).

**Constants**: `FAST_GAP_LIMIT = 5` (phase 1), `FULL_GAP_LIMIT = 20` (phase 2,
BIP44/F8), `DISCOVERY_DEADLINE_MS = 20_000`, `POLL_CONCURRENCY = 4`.

- `startDiscovery({ network, onSnapshot, onError, deadlineMs? }): DiscoveryHandle`
  — one two-phase run. **Phase 1** (first paint): fast gap-5 scan anchored at the
  cached high-water marks. **Phase 2** (correctness): extends to the full gap-20
  scan from index 0, reusing every phase-1 response via a run-scoped `ScanCache`
  (only the window extension costs new requests). `onSnapshot(snapshot, complete)`
  fires per phase — `complete` is `false` for phase 1, `true` for phase 2 (F12;
  the UI keeps a "Checking for updates…" cue while only an incomplete snapshot is
  on screen). The run settles deterministically at the deadline: a landed phase-1
  result is kept; with no result at all, `onError` fires — the skeleton is never
  open-ended. `DiscoveryHandle { done: Promise<void>; abort(): void }` — `abort()`
  cancels every in-flight request and silences the run: a superseded run never
  dispatches a snapshot or an error, even if a phase had already resolved with its
  continuation still queued (F13).
- `pollAccount(network, account, signal?): Promise<boolean>` — the cheap 30-second
  poll. Re-checks ONLY known-used addresses plus the two tips (budget: a fresh
  wallet costs 2 requests), never a rescan; `true` ⇒ caller should full-refresh.
- `DiscoveryController` — the single-flight coordinator; one instance app-wide
  (`App.tsx` `discoveryRef`). `refresh(params)` aborts any in-flight run and starts
  fresh. `pollTick(params)` is skipped entirely (zero requests) while a run or a
  prior poll is in flight — 30s ticks can never pile bursts onto a slow crawl; when
  the on-screen snapshot is incomplete it self-heals by requesting a full refresh
  instead of polling (F12). `abort()` on lock/unmount/network switch — on a network
  switch, call it synchronously BEFORE dispatching `setNetwork` (F13). `busy: boolean`.
- `loadAccount(network)` — one full single-phase discovery (no deadline/phases).
- Also here: `loadPrice()` (null on failure — offline-tolerant), `loadFees(network)`,
  `feeRateForTier(fees, tier)` — second independent clamp into
  `[MIN_ACCEPTED_FEE_RATE, MAX_ACCEPTED_FEE_RATE]` (F1), and
  `signAndBroadcast(params): Promise<BroadcastResult>` — reads the mnemonic at
  call time, never returns it; idempotent on retry (same UTXO set + params ⇒
  same signed tx; mempool.space treats re-broadcast of an accepted tx as
  success). `allowHighFee` bypasses only the 25% consent rule, never the hard
  rate/absolute caps (F10). After a successful broadcast it writes the F15 send
  record (returned txid → user-confirmed recipient + exact recipient-output
  amount). `BroadcastResult { txid; sendRecorded }` — `sendRecorded: false`
  means the best-effort record write failed: the payment is unaffected but
  cannot later be sped up (`'unverified'`).
- `prepareBump(network, txid, account, signal?): Promise<PreparedBump>` — the
  Speed-up flow's gather step. Costs exactly ONE network request
  (`getTransaction`); the input/output ownership mapping is LOCAL derivation
  only (`deriveAddressRange` over both chains, index 0 → high-water mark +
  gap-20 — zero requests, so the burst budget is untouched). Typed
  `CannotBumpError` dead-ends, in order: `confirmed`; `not-signaling` (EVERY
  input must carry sequence < 0xfffffffe — pre-v1.1 sends don't);
  `foreign-inputs` (an input's prevout address isn't one we derive);
  `unsupported-shape` (not this wallet's send shape: >2 outputs, >1 foreign
  output, an address-less output, or an ambiguous self-send); and the **F15
  verification**: the classified recipient's address AND amount must exactly
  match the local send record for this txid — `recipient-mismatch` (hard fail,
  no override: inputs/change are provably ours by derivation, the recipient is
  the one field we can't derive, and without this check a hostile API could
  substitute an attacker's address) or `unverified` (no record on this device;
  legitimate only for a wallet restored from its 12 words — every bumpable tx
  is v1.1+, and v1.1 writes records). Output classification: the foreign
  output is the recipient and the owned one is change; a SELF-SEND resolves as
  receive-chain output = recipient, change-chain output = change; a single
  all-ours output = recipient (self-sweep). `PreparedBump { txid; utxos;
  recipient; recipientAmountSats; changeAddress: string | null; oldFeeSats;
  oldVsize; oldRateSatVb }` — the ORIGINAL recipient/change addresses are
  reused verbatim in the replacement.
- `bumpAndBroadcast({ network, prepared, feeRateSatVb, allowHighFee }):
  Promise<BroadcastResult>` — reads the mnemonic at call time, builds via
  `buildRbfBumpTx`, broadcasts. Same idempotency argument as `signAndBroadcast`
  (deterministic signatures ⇒ a retry re-broadcasts the identical replacement
  and rewrites an identical record). Writes the replacement's OWN F15 record
  (returned txid → the verified recipient + the replacement's actual
  recipient-output amount, reduced for a sweep), so a bump of a bump verifies
  against the replacement's record — the chain of trust runs unbroken back to
  the user's original confirmation. The new fee rate comes from the existing
  `loadFees`/`feeRateForTier` path (already clamped, F1).
