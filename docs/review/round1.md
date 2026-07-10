# Security Review — Round 1

**Simple Bitcoin Wallet** — adversarial audit of engine + app. Reviewer verified
by reading every source file and by executing targeted tests (deleted after use).

## Verdict

**SHIP-BLOCKING ISSUES: 1 / total findings: 9**

The crypto core (vault, key derivation, coin selection, cross-network guards,
auto-lock, secrets hygiene) is genuinely solid and well-tested. The one
ship-blocker is that the app extends *complete trust* to the mempool.space fee
estimate and applies no sanity cap, so a single bad/hostile fee number can drain
a wallet — most severely through **Send Max** — with nothing on screen a beginner
could recognize as wrong.

---

## Findings (by severity)

### F1 — [SEV-High] No fee sanity cap: a bad fee estimate drains funds via Send Max  *(SHIP-BLOCKING)*

- **Where:** `src/lib/tx.ts:170-173` (`feeForVsize`), `:266-276` (sendMax fee),
  `:181-223` (`selectCoins`); `src/actions.ts:66-70` (`feeRateForTier`, only guards
  `raw > 0`); `src/lib/api.ts:193-200` (`getFeeEstimates`, returns the API number
  verbatim). Nothing anywhere bounds the fee rate or the absolute fee.
- **Scenario (verified with a test):** The fee comes from the untrusted
  `/v1/fees/recommended` endpoint. If that endpoint is compromised, MITM'd, or
  merely buggy/spiking and returns e.g. `fastestFee: 5000` (sane is ~5–50 sat/vB),
  and the user taps **Max** on a 600,000-sat balance:
  `feeSats = ceil(vsize × 5000) ≈ 550,000`; `sendAmount = 600,000 − 550,000 = 50,000`.
  The UTXO values are *honest*, so the signatures are valid and the tx broadcasts
  and confirms. The user sent 50,000 sats and **burned ~550,000 to miners.** For a
  non-max send the same inflation produces a fee many times the amount (test: a
  20,000-sat send incurred a 112,800-sat fee — 5.6×). Review shows the fee only as
  a USD figure a beginner has no baseline to judge, under copy that says a fee is
  "a small amount [that] goes to the bitcoin network."
- **Why it matters here:** This is the exact "untrusted API" hole the brief calls
  out. BIP143 protects against *lying UTXO values* (see F2 / verified-good), but it
  does **not** protect against an honest-inputs + dishonest-fee-rate transaction —
  that tx is valid and the money is really gone.
- **Fix:** In `tx.ts`, cap the effective fee before signing: reject/clamp when
  `feeRateSatVb` exceeds a hard ceiling (e.g. 2,000 sat/vB) **and** when the
  computed `feeSats` exceeds a sane fraction of the amount being sent (e.g. > 25%
  for a normal send) or, for Send Max, a fraction of `totalInput`. Surface a
  blocking "this fee looks unusually high" confirmation on Review rather than a bare
  USD number. Also clamp in `feeRateForTier`.

### F2 — [SEV-High] Untrusted mempool.space data is never validated or bounded

- **Where:** `src/lib/api.ts:139-151` (`getAddressStats`), `:166-178` (`getUtxos`),
  `:237-255` (`getAddressTxs`) — every numeric field is fed straight into `BigInt(...)`
  with no range/format checks; consumed in `src/lib/account.ts:236-295` and rendered
  across Home/Activity/Send.
- **Scenario (verified):** (a) A hostile/buggy API can report an arbitrary balance
  (test showed `getAddressStats` happily returning 21,000,000 BTC) with no check
  against `MAX_SUPPLY_SATS`; a beginner may believe they were paid or that funds
  arrived. (b) A non-integer/non-numeric value (e.g. `value: 1.5`, `"1e9"`) makes
  `BigInt()` throw, which surfaces as `AccountDiscoveryError` and wedges the wallet
  into the network-error state (DoS). The app leans entirely on BIP143 to prevent a
  *lying UTXO value* from causing theft — which works, but is a protocol accident,
  not a defense the app makes.
- **Fix:** Validate each field on ingest: integers only, `0 ≤ value`, reject values
  above `MAX_SUPPLY_SATS`, and clamp/label an implausibly large aggregate balance.
  Treat malformed entries as a typed response error, not an uncaught throw.

### F3 — [SEV-Medium] Weak password policy against an offline-attackable vault

- **Where:** `src/screens/SetPassword.tsx:26` (`password.length >= 8` is the only
  gate); `src/lib/vault.ts:38` (scrypt N=2¹⁷) + localStorage storage.
- **Scenario:** The encrypted vault lives in `localStorage` (`sbw.vault.v1`) and is
  readable by anyone with device access or an exfiltration path. scrypt N=2¹⁷ is
  reasonable but an 8-character, low-entropy password (all this app enforces) is
  well within offline brute-force reach for a wallet holding real savings. There is
  no strength estimation, no warning, no passphrase encouragement.
- **Fix:** Raise the floor and add real strength feedback (length + zxcvbn-style
  estimate), warn on weak/common passwords, and encourage a longer passphrase.
  Consider bumping scrypt cost.

### F4 — [SEV-Medium] Review can display "$0 fee / total = amount" if the dry-run build fails

- **Where:** `src/App.tsx:284-305` (`reviewNumbers`): both the `!state.account`
  early return and the `catch` return `feeSats: 0n, totalSats: pending.amountSats`.
- **Scenario:** If `getMnemonicBuild` throws (e.g. a 30-s poll refreshes
  `state.account` to fewer UTXOs so coin-selection now throws `InsufficientFunds`
  between compose and review), the final confirmation screen shows a **$0 network
  fee** and a total equal to the amount. The Send button is still enabled (it gates
  only on the checkbox/busy). The subsequent real broadcast fails safely (no funds
  move), but showing a fabricated $0 fee on the last-chance money screen erodes the
  exact cross-check the Review screen exists to provide.
- **Fix:** On dry-run failure, don't render fake numbers — disable Send and show a
  "recheck this payment" state, or recompute before enabling confirmation.

### F5 — [SEV-Low] Seed phrase copied to clipboard is never cleared

- **Where:** `src/screens/Reveal.tsx:33-40` (`copyWords` → `navigator.clipboard.writeText(seed)`).
- **Scenario:** The 12-word seed lands on the OS clipboard (and clipboard history /
  sync managers persist it indefinitely). Other apps can read it. This is a spec'd
  convenience (DESIGN §Reveal), but it is a real seed-leak vector for beginners.
- **Fix:** Auto-clear the clipboard after a short delay, and strengthen the toast
  warning to "delete it from your clipboard/history now." Consider omitting copy on
  mobile.

### F6 — [SEV-Low] No rate-limiting / backoff on repeated wrong-password unlock attempts

- **Where:** `src/screens/Unlock.tsx:27-36`; `src/App.tsx:213-223`.
- **Scenario:** Unlimited password attempts with no lockout or increasing delay. A
  device-local attacker gets unbounded online guesses (scrypt's ~sub-second cost is
  the only throttle). Bounded impact (a determined attacker attacks the vault
  offline anyway), hence Low.
- **Fix:** Add exponential backoff / attempt counter after N failures.

### F7 — [SEV-Low] Dangerous change-address default + undeletable probe credential

- **Where:** `src/App.tsx:317` (`changeAddress: state.account?.changeAddress ?? pending.recipient`);
  `src/lib/vault.ts:324-336` (`probePasskeyPrf` creates a resident credential it can
  never delete).
- **Scenario:** The `?? pending.recipient` fallback is currently unreachable (guarded
  by `reviewNumbers`' `!state.account` return), but it is a latent footgun: if ever
  reached it would route change to the *recipient*, silently overpaying them.
  Separately, `probePasskeyPrf` leaves an orphaned platform credential on every probe.
- **Fix:** Make the change-address absence a hard error, never a default to any
  external address. Document/avoid the throwaway-credential probe or delete-and-retry.

### F8 — [SEV-Info] Gap-limit discovery can miss funds at higher indices

- **Where:** `src/lib/account.ts:54-59` (`gapLimit: 5`, `maxIndex: 50`), `:144-200`.
- **Scenario:** Standard BIP gap-limit behavior: funds received to an address beyond
  5 consecutive unused (or index > 50) won't be discovered/spendable in-app. Matches
  the DESIGN default; flagging so it's a conscious choice, not a surprise.
- **Fix:** None required; consider a "rescan deeper" affordance and documenting the
  limit for power users.

### F9 — [SEV-Info] Negative pending balance hidden from the Home hero

- **Where:** `src/screens/Home.tsx:32` (`totalSats = confirmed + (pending > 0 ? pending : 0)`).
- **Scenario:** Outgoing-unconfirmed (negative pending) is excluded, so just after a
  send the hero still shows the pre-send balance until confirmation. Spend paths
  correctly use confirmed UTXOs, so this is display-only, but can briefly imply money
  is still available.
- **Fix:** Reflect net pending (including outgoing) in the balance, or label a
  "pending out" line.

---

## Verified-good (checked and sound — do not re-litigate)

- **Mnemonic entropy:** `generateMnemonic` uses `@scure/bip39` 128-bit over the
  platform CSPRNG. 12 words, correct.
- **Vault crypto:** AES-256-GCM via WebCrypto; scrypt N=2¹⁷/r8/p1; **fresh random
  16-byte salt + 12-byte IV per encryption** (tested); wrong password / tamper both
  surface as `WrongPasswordError` without leaking which; versioned document;
  malformed JSON → `VaultCorruptError`. No secret is ever placed in an error/message.
- **Passkey (WebAuthn PRF) path:** PRF secret → HKDF-SHA256(random salt, info) → AES
  key wrapping a *second, independent* ciphertext of the same mnemonic. Does not
  weaken the password ciphertext (independent key/salt/IV) and can't be brute-forced
  offline without the authenticator. `userVerification: 'required'`. Sound.
- **Secrets hygiene:** decrypted mnemonic lives only in a module ref in `session.ts`,
  never in React state / storage / URLs / logs; draft + settings-reveal words held in
  refs and cleared on navigation and on lock (`App.tsx` onLock). No `console.*` in
  app/engine source.
- **Auto-lock:** idle (5 min) and hidden-tab (>60 s) locks both fire and null the
  mnemonic ref; `lockNow()` immediate; listeners route to Unlock.
- **Coin selection & change:** largest-first with fee re-iteration; sub-dust change
  correctly folded into fee (no unspendable output); accounting identity
  `inputs = amount + change + fee` holds (tested); change address is derived from
  *our* wallet's chain-1 next-unused index and re-validated for the active network.
- **Cross-network address safety:** explicit bech32/bech32m HRP guard **and** base58
  version-byte rejection both confirmed by test (testnet legacy rejected on mainnet
  and vice-versa). `bcrt1` regtest addresses rejected.
- **BIP143 protection:** a lying UTXO *value* cannot cause theft — the signer commits
  to the claimed amount, the network verifies against the real amount, mismatch →
  invalid signature → broadcast rejected (no funds move). (The app itself makes no
  such check — see F1/F2.)
- **QR / XSS:** `Qr.tsx` `dangerouslySetInnerHTML` receives only locally-generated
  SVG geometry from the `qr` package, fed our own derived address; no user/API string
  reaches an HTML sink. `bitcoin:` URI is address-only.
- **CSP / supply chain:** built `dist/index.html` carries a strict policy
  (`script-src 'self'`, no `unsafe-inline` for scripts; `unsafe-eval`/`ws:` only in
  the dev policy). No CDN/font/external references anywhere. `package-lock.json`: 172
  packages, all resolved from `registry.npmjs.org`, no install scripts except esbuild
  / fsevents (expected); dep names verified character-by-character; `qr` is
  paulmillr's package.
- **Double-broadcast:** Review gates on a synchronous `busy` flag; retry sheet is
  non-destructive; broadcast failure explicitly states funds did not move.
- **Amount parsing:** `format.ts` bigint-based, strict ≤8-decimal parsing; rejects
  `"."`, empty, multi-dot, and >8-dp input (tested suite passes).

_Tests referenced above were written with a `.review.test.ts` suffix, executed, and
deleted; no source files were modified._

---

# Round 2 — Re-audit of fixes

**SHIP-BLOCKING ISSUES: 1 / new findings: 1**

Re-ran every original exploit against the new code (deleted the throwaway tests
after). `npm test` = 92 passing, `tsc --noEmit` clean, `npm run build` clean, prod
CSP still `script-src 'self'`. Eight of nine fixes are genuinely closed. The F1 fee
guard is sound at the engine layer but its **25%-of-amount** rule is too aggressive
and now blocks legitimate small sends at honest fee rates, surfacing as the F4
"recheck" dead-end — a new ship-blocking regression (F10).

## Per-finding verdicts

- **F1 — CLOSED (with regression → F10).** `FeeTooHighError` in `tx.ts` rejects rate
  > 500 sat/vB, fee > 25% (of amount+fee / of total-input for sendMax), or > 1,000,000
  sats absolute; `allowHighFee` overrides. `getFeeEstimates` clamps to `[1,500]`;
  `feeRateForTier` clamps again. Verified: the original sendMax-drain at 5000 sat/vB
  now throws; a 600k-sat sweep at the max in-window rate (500) still builds. Escape
  hatch is *not* wired to any UI (good — can't be abused; but also no recovery path,
  see F10).
- **F2 — CLOSED.** Every mempool.space field validated on ingest → typed
  `ApiResponseError`: 21M-BTC cap, integers-only, 64-hex txids, array size caps, price
  bounds. Verified: fabricated 21M+ balance and non-integer UTXO value both rejected
  cleanly (no raw `BigInt()` crash); hostile fee clamped.
- **F3 — CLOSED.** `password.ts`: min 10 chars, common-password rejection, 5-band
  meter wired into `SetPassword.tsx` gating submit. Heuristic + small common-list, but
  a reasonable, testable improvement.
- **F4 — CLOSED.** `reviewNumbers` returns a discriminated union; `Review.tsx` renders
  a no-amounts, no-Send blocking state on `ok:false`. (Minor: the `sent` screen now
  shows `$0.00` if its post-broadcast dry-run fails — cosmetic, money already sent.)
- **F5 — CLOSED.** `Reveal.tsx` clears the copied seed after 30 s and on unmount, only
  if the clipboard still holds it (won't clobber later copies). Sound.
- **F6 — CLOSED (as scoped).** Growing delay after ≥3 fails, capped 5 s, in a ref;
  explicitly documented as a casual-guesser speed-bump only (resets on reload). Fine
  for the stated scope.
- **F7 — CLOSED.** `changeAddress ?? recipient` removed — `getMnemonicBuild` throws if
  no wallet change address (fail-closed); `probePasskeyPrf` now requires
  `{userInitiated:true}` and best-effort signals the credential for pruning.
- **F8 — CLOSED.** Gap limit 20 / max index 200.
- **F9 — CLOSED.** `Home.tsx` shows net balance plus explicit "on its way out/in"
  pending lines.

## New findings

### F10 — [SEV-High] Fee-fraction guard blocks legitimate small sends, with a misleading dead-end  *(SHIP-BLOCKING)*

- **Where:** `src/lib/tx.ts:357-367` (25% guard: `feeSats > (amount+fee)×0.25`);
  `src/screens/Send.tsx:89-107` (compose validates only dust + over-balance — no fee-
  fraction awareness); `src/App.tsx:303-322` (dry-run `catch` → `{ok:false}`);
  `src/screens/Review.tsx:54-72` + `strings.review.recheckBody`.
- **Scenario (verified):** The guard passes only when `fee ≤ amount/3`. At an honest,
  in-window **30 sat/vB**, a ~4,230-sat fee means any send below ~12,700 sats (~$8–13)
  is rejected; during congestion (120 sat/vB) a normal **20,000-sat (~$20) send** is
  rejected. Send.tsx has no idea, so the user composes fine, taps Review, and hits the
  F4 blocking screen — whose copy says *"your available balance may have changed… enter
  the payment again"*. Re-entering the same small amount loops forever; there is no fee
  explanation, no cheaper-tier hint, and `allowHighFee` is exposed nowhere. This breaks
  the exact "even a tiny amount is a great first test" flow the app's own empty state
  promotes.
- **Fix:** Move the fee-vs-amount check into Send compose with clear copy ("the network
  fee is large relative to this small amount") and an explicit, informed confirm that
  wires `allowHighFee: true` through `signAndBroadcast`/`getMnemonicBuild`; and/or
  compare small-send fees against an absolute sat threshold rather than a pure ratio.
  At minimum, fix `recheckBody` to name the real cause instead of blaming the balance.
- **Residual (same guard):** the `MAX_FEE_ABSOLUTE_SATS` (1M) + 25% rule could also
  block a legitimate many-UTXO consolidation at a high honest rate — rare for beginners,
  but the same escape-hatch gap applies.

_Round-2 tests used the `.review.test.ts` suffix, were executed, and were deleted; no
source files were modified._

---

# Round 3 — Re-audit of the F10 fix

**SHIP-BLOCKING ISSUES: 0 / new findings: 1 (Medium)**

`npm test` = 105 passing, `tsc --noEmit` clean, `npm run build` clean, prod CSP still
`script-src 'self'`. Verified every requested scenario against the new code (throwaway
tests deleted).

## F10 — PARTIALLY CLOSED

The main dead-end is fixed and the hard limits are genuinely hard:

- **Small-send consent path works (verified).** A $12 send (3,000 sats) at an honest
  30 sat/vB, and a $20 send at 120 sat/vB, both trip the compose-time notice
  (`highFee`), show real numbers + a "Send anyway", and `buildAndSignTx(... allowHighFee:true)`
  then builds and signs — no loop. `allowHighFee` rides `PendingSend` through the Review
  dry-run *and* the broadcast build (`App.tsx:348,363` → `actions.ts:110`), so all three
  use identical params.
- **Hard caps are not bypassable (verified).** The original 5000 sat/vB sendMax drain
  still throws `FeeTooHighError` *with `allowHighFee:true`* (rate cap moved above the
  `allowHighFee` gate, `tx.ts:325`); the 1,000,000-sat absolute ceiling likewise throws
  with the flag set (30-input sweep at 500 sat/vB, `tx.ts:380`). Only the 25% rule is
  consent-gated.
- **Consent can't be set silently.** `review(true)` is reachable only from the
  "Send anyway" button, which renders only when `highFee` is true (with the notice). A
  fresh `PendingSend` is built on every compose from live state, so `allowHighFee` never
  leaks across sends, tier/amount/recipient edits, or a back-navigation (Send remounts
  with empty local state).
- **Blocked-state copy is now honest** — `'fee-too-high'` vs `'stale'` reasons
  (`Review.tsx:58-79`).

### F11 — [SEV-Medium] Compose fee estimate vs. build fee diverge at the dust-fold boundary → the F10 loop returns

- **Where:** `Send.tsx:92-149` (compose `estInputs`/`highFee` uses a 2-output estimate)
  vs `tx.ts:273-288` (`selectCoins` folds a sub-dust change into the fee, 1 output);
  `App.tsx:319-326` (`FeeTooHighError` → `{ok:false}`); `Review.tsx:58-79`.
- **Scenario (verified):** Single 17,500-sat UTXO, send 13,000 at an honest 30 sat/vB.
  Compose estimates the 2-output fee (4,230) → `highFee` is **false** → the normal Review
  button shows, **no** "Send anyway", `allowHighFee` stays false. But the real build finds
  the change (270 sats) is dust, folds it, and the actual fee becomes 4,500 → crosses 25%
  → `buildAndSignTx` throws `FeeTooHighError`. Review shows the blocked `'fee-too-high'`
  screen, whose copy says *"you can still choose to send it anyway from there"* — yet going
  back to Send shows no Send-anyway (compose still says not-high-fee). The user loops on a
  narrow but realistic band of small amounts (~$8-13 at standard fees), with misleading
  copy and no path. Not fund-loss — it fails safe (blocks) — but it is the exact F10 dead-end,
  re-narrowed to the dust boundary.
- **Fix:** Make the compose pre-check use the same dust-fold logic as `selectCoins`
  (compute the real selected-input fee incl. the no-change/fold branch), OR when the Review
  dry-run throws `FeeTooHighError` on a build the user did NOT consent to, surface the
  consent "Send anyway" from the Review blocked-state itself rather than bouncing them to a
  Send screen that won't offer it. A minor related nit: the compose notice shows the 2-output
  estimate, which can differ from the Review's actual fee by up to ~dust.

_Round-3 tests used the `.review.test.ts` suffix, were executed, and were deleted; no source
files were modified._

---

# Round 4 — Re-audit of the F11 fix

**SHIP-BLOCKING ISSUES: 0 / new findings: 0**

`npm test` = 113 passing, `tsc --noEmit` clean, `npm run build` clean, prod CSP still
`script-src 'self'`. Throwaway tests deleted; no source modified.

## F11 — CLOSED

Drift is eliminated by construction, and the blocked state is no longer a dead end:

- **One selection code path (verified).** New `estimateSendFee()` (`tx.ts:329`) dry-runs
  the engine's own `selectCoins`/sendMax logic — dust-fold included — and computes
  `needsHighFeeConsent` with the shared `feeFractionCeiling`. `buildAndSignTx` now
  *consumes that same result* (`tx.ts:433`, using `sel.feeSats`/`sel.needsHighFeeConsent`),
  and `Send.tsx` reads `feeSelection.needsHighFeeConsent` from the identical call
  (`Send.tsx:92-138`). The parallel `estimateFeeSats` reimplementation is gone.
- **My Round-3 scenario is fixed (verified).** 17,500-sat UTXO / 13,000 send / 30 sat/vB:
  `estimateSendFee` now reports the exact dust-folded fee (4,500) *and*
  `needsHighFeeConsent: true`, so compose shows the "Send anyway" notice — no silent loop.
- **Property sweep (verified).** Across the dust-fold boundary (amounts 546→19,000 at
  1 & 30 sat/vB, exercising both the dust-fold and consent paths) and across sendMax
  balances (3k→1M at 1/30/200/500 sat/vB): `estimateSendFee.feeSats` equals the built
  fee exactly, and `needsHighFeeConsent` matches whether the no-consent build throws —
  in every case.
- **Review recovery works and hard blocks stay honest (verified).** If a `fee-too-high`
  block ever reaches Review (e.g. a UTXO set that shifts under the 30s poll between compose
  and review), the blocked state carries the real `FeeTooHighError` numbers and offers a
  working "Send anyway" → `onAcceptHighFee` re-composes with `allowHighFee` and the full
  Review gate (numbers + address checkbox + Send now) still applies (`Review.tsx:67-105`,
  `App.tsx:557-567`). It is marked recoverable only when the percentage rule tripped and
  the fee is within the hard limits; a hard-limit block (rate cap or > 1,000,000-sat
  absolute) shows honest no-recovery copy with no bait button.
- **Hard caps still hold with `allowHighFee` (verified).** 5000 sat/vB sendMax and the
  30-input/500 sat/vB absolute-ceiling case both still throw `FeeTooHighError` with the
  flag set.

_Round-4 tests used the `.review.test.ts` suffix, were executed, and were deleted; no
source files were modified._

---

# Round 5 — Re-audit of the network overhaul (Bug A single-flight/two-phase; Bug B Face ID jargon)

**SHIP-BLOCKING ISSUES: 0 / new findings: 2 (both Low)**

`npm test` = 128 passing, `tsc --noEmit` clean, `npm run build` clean, prod CSP still
`script-src 'self'`, no `console.*` in source. Verified each risk area with throwaway
tests (deleted). The restructure is well-built; two low-severity display/edge gaps.

## Per-area verdicts

- **1. Funds-display correctness — SOUND (one Low, F12).** The *final* (phase-2) scan
  always starts at index 0 with the BIP44 gap-20, so a stale, missing, or ahead-of-reality
  cached high-water mark can never hide funds — it only forces extra scanning and
  self-corrects the persisted mark (verified: gap-band funds found; a mark of 50/10,000
  with funds at index 3 still finds them and rewrites the mark to 3; index-0 funds found
  under a high mark). Marks are per-network keyed, so no practice/live cache mixup. The
  run-scoped `ScanCache` returns identical per-address data across phases (no double-fetch).
- **2. Races — SOUND.** Superseded runs are safe: a mid-flight abort rejects (no dispatch),
  and an already-resolved phase-1 dispatches *before* the abort (older data, immediately
  replaced by the new run); `onError` is gated by `externallyAborted`, so a superseded run
  never flips the UI to error (matches the team's own test). Lock aborts the run and, being
  external, suppresses both `onError` and any post-lock `onSnapshot`; the snapshot carries no
  secrets. Single-flight (`busy`/`current`/`pollBusy`) prevents a poll from ever starting a
  second full run.
- **3. Deadline interplay — SOUND.** Phase-1 dispatches `accountLoaded` (status `ready`)
  immediately, so there is no open-ended skeleton and no "updating" state that can stick:
  deadline during phase-1 → error; during phase-2 → keep phase-1. (Flip side is F12.)
- **4. Abort threading (api.ts) — SOUND.** No retry once the signal aborts; the retry
  backoff `sleep` resolves early on abort; aborted requests surface as swallowed
  `ApiNetworkError` inside the superseded run (never a user-facing error); the concurrency
  pool always settles (verified: pre-aborted signal rejects promptly; a hanging run rejects
  on abort).
- **5. sendMax / UTXO snapshot — SOUND.** The Review dry-run and the broadcast both build
  from the *same current* `state.account`, so they can't diverge. A sendMax fired during a
  phase-1 partial sweeps only the partial UTXO set (leaves any gap-band UTXOs behind — not a
  loss, recovered on the next scan); folded into F12.
- **6. Unlock auto-passkey / Bug B — SOUND.** `autoTriedRef` makes the auto-trigger
  single-shot (StrictMode-safe); cancel/fail falls back silently to the always-visible
  password field; the passkey path doesn't touch the F6 wrong-password throttle. Bug B: a
  plain-English explainer sheet precedes the system "passkey" prompt in both SetPassword and
  Settings, opt-in only.

## New findings

### F12 — [SEV-Low] An understated phase-1 balance can be presented as final ('ready') with no "updating" cue

- **Where:** `actions.ts:126-148` (phase-1 `onSnapshot` then phase-2; on any throw with
  `gotSnapshot` the phase-1 result is kept), `App.tsx:159` (`onSnapshot → accountLoaded`,
  status `ready`); `state.ts` has no partial/updating status.
- **Scenario (verified):** funds at a receive index in the gap-6..gap-20 band (uncommon but
  real — address gaps, or a seed used elsewhere) make phase-1 (gap-5) report a *lower*
  balance; if phase-2 is then cut off (the 20s deadline on a throttled network — exactly
  Bug A's condition, or a lock/network-switch in the ~1-2s window), the understated phase-1
  balance stays on screen as a settled `ready` value with no error and no "still checking"
  indicator. Direction is safe (understated, never inflated; the send dry-run uses the same
  partial set so no bad tx), and it self-heals on the next full refresh — but the user gets
  no cue to retry.
- **Fix:** carry a `complete`/phase flag on the snapshot (or a distinct status) so phase-1
  renders a subtle "still checking your balance…" until phase-2 confirms, and if a run ends
  without phase-2 completing, show a gentle "balance may be incomplete — tap to refresh"
  affordance instead of a bare `ready`.

### F13 — [SEV-Low/Info] Network switch doesn't eagerly abort the prior run — a stale-network balance can flash

- **Where:** `App.tsx switchNetwork` (dispatches `setNetwork` + navigate home but does not
  call `discoveryRef.current?.abort()`); the new run only starts later via the wallet-screen
  effect's `refreshAll`.
- **Scenario:** if an in-flight run for the *old* network resolves a phase-1 in the frame
  between `setNetwork` (which clears the account) and the effect's `refresh()` (which aborts
  it), it can paint the previous network's balance briefly before the new run supersedes —
  a transient Live-balance-under-Practice (or vice-versa) flash. Display-only, self-correcting,
  no persistent cross-network corruption (marks/data are per-network).
- **Fix:** call `discoveryRef.current?.abort()` synchronously inside `switchNetwork` (and
  ideally kick `refreshAll` there) so the old run can't dispatch after the switch.

_Round-5 tests used the `.review.test.ts` suffix, were executed, and were deleted; no source
files were modified._

---

# Round 6 — Re-audit of the F12 / F13 fixes (final confirm)

**SHIP-BLOCKING ISSUES: 0 / new findings: 0**

`npm test` = 134 passing, `tsc --noEmit` clean, `npm run build` clean, prod CSP still
`script-src 'self'`, no `console.*` in source. Both fixes verified; no regressions.

## F12 — CLOSED

- **Completeness is threaded end-to-end.** `onSnapshot(snapshot, complete)` marks phase-1
  `false` / phase-2 `true` (`actions.ts:108,142,150`); the reducer stores `accountComplete`
  and every reset path (`unlocked`/`locked`/`setNetwork`, initial) sets it `true`
  (`state.ts`); Home shows a muted "Checking for updates…" cue only while
  `account !== null && !accountComplete` (`Home.tsx`).
- **Self-heals and can't stick (verified).** A deadline that cuts phase-2 keeps the
  incomplete phase-1 result with no error; the next `pollTick` sees `accountComplete: false`
  and requests a full refresh *without issuing any poll request of its own*
  (`actions.ts:258-263`), which completes to a `complete:true` snapshot and clears the cue.
  Independently confirmed the self-heal branch fires `onChanged` with zero network calls, and
  that a `complete:true` snapshot does NOT take the self-heal branch (so the cue clears and
  the retry loop stops). The team's fake-timer test walks the whole incomplete→heal→complete
  chain; the cue persists only while the balance genuinely is incomplete (honest), and clears
  the moment a full scan lands.

## F13 — CLOSED

- **Eager abort + reducer blanking + post-resolution guard.** `switchNetwork` now calls
  `discoveryRef.current?.abort()` *before* dispatching `setNetwork`, which blanks the account
  synchronously in the reducer (`App.tsx:324-328`, `state.ts setNetwork`). Crucially,
  `startDiscovery` now re-checks `externallyAborted` *after each phase's await, before
  dispatching* (`actions.ts:139,148`), closing the exact queued-microtask window I flagged:
  a phase-1 that has already resolved (continuation queued) is dropped silently if the run
  was aborted on the same frame. The team's `manual`-resolver test reproduces precisely that
  race (resolve phase-1, then abort synchronously) and asserts no `onSnapshot`/`onError` — it
  passes. Verified `setNetwork` blanks the account and `abort()` leaves the controller
  not-busy so the fresh run starts clean.

## Round-5 properties — still hold

Single-flight (poll skipped while a run is busy), the deterministic deadline→error path when
no snapshot exists, and abort threading (no retry after abort, pool settles) are all still
green in the suite after the change.

_Round-6 tests used the `.review.test.tsx` suffix, were executed, and were deleted; no source
files were modified._

---

# Round 7 — PWA packaging (manifest + service worker + standalone shell)

**SHIP-BLOCKING ISSUES: 0 / new findings: 1 (Info)**

`npm test` = 146 passing (incl. the change's 12 new sw/manifest tests), `tsc --noEmit` clean,
`npm run build` clean. Built `dist/index.html` CSP is byte-for-byte the strict policy —
`script-src 'self'`, no weakening; `dist/` contains `sw.js` + `manifest.webmanifest` copied
verbatim from `public/` (diff-verified) plus all four icons, and every reference (assets,
manifest, apple-touch-icon) is relative. Beyond the unit gates I drove the SW's REAL event
wiring in a throwaway harness (stub `self`/`caches`/`fetch` injected as scope params — the
handlers run unmodified) and verified the built app live under `vite preview`: the SW
registers at the correct scope with `updateViaCache: 'imports'`, controls the page on first
visit, and `sbw-cache-v1` contains only same-origin entries.

## Per-area verdicts

- **a. Stale-HTML pinning — SOUND.** Navigations are network-first and the cache is
  consulted ONLY when `fetch()` *rejects* (offline/DNS): an online 5xx is returned to the
  user, never a stale cached shell (verified in the harness — 503-with-stale-copy returns
  the 503, caches nothing). A 304 (`ok:false`) is likewise returned uncached and can't
  clobber a cached 200 — and in practice the SW never sees raw 304s for navigations
  (conditional revalidation happens in the HTTP-cache layer below `fetch`, which surfaces
  the freshened 200). `ignoreSearch` applies only inside the offline-fallback `match`, and
  it ignores the query string, never the path — no wrong-document match. GitHub Pages'
  `max-age=600` allows up to 10 minutes of ordinary HTTP-cache staleness, but that window
  is identical with and without the SW (the SW's `fetch(request)` rides the same HTTP
  cache) — the SW adds zero pinning on top. SW-update path: `register()` uses the default
  `updateViaCache: 'imports'` (confirmed live), so the sw.js update check itself always
  bypasses the HTTP cache, and there are no `importScripts`; a client can never run a
  weeks-old SW because of Pages' max-age. Deploy-recoverability holds: push again → every
  online client gets the new HTML on next navigation (≤ the pre-existing 10-min HTTP-cache
  window).
- **b. API-traffic non-interference — SOUND.** `decideStrategy` returns `'passthrough'`
  for every non-GET and every cross-origin URL *before* any other logic, and passthrough
  means the handler returns without `respondWith` — the browser behaves exactly as with no
  SW. Verified in the harness: mempool.space GET, mempool.space POST (broadcast),
  same-origin POST, `data:` and extension URLs all produce no `respondWith` and **zero
  SW-issued fetches**; a request whose property getters throw is caught by the handler's
  try/catch and falls through (rule 5). Redirect edges: a same-origin navigation that
  redirects yields an `opaqueredirect`/`cors`-type response — returned, never cached;
  either way no retry, no duplicate. Live confirmation: after real app usage,
  `sbw-cache-v1` holds only same-origin shell/manifest/asset entries — no mempool.space
  URL can ever appear. Added request volume: the SW itself issues no requests beyond the
  1:1 pass-through; the only new traffic anywhere is the sw.js registration/update checks
  against GitHub Pages — nothing touches the mempool.space burst budget.
- **c. Cache poisoning / integrity — SOUND (one Info nit, F14).** The
  `ok && type === 'basic'` guard blocks redirected-cross-origin (`cors`), `opaque`, and
  error responses from ever being stored (harness-verified). A 206 Partial Content *passes*
  the guard (`ok` is true for 206 — the code comment is wrong about that) and reaches
  `cache.put`, where the Cache API spec itself rejects partial responses, so no partial is
  ever stored — but the rejection is unhandled (F14). Attacker-controlled same-origin path:
  the origin is `scottm992.github.io`, which other repos of the same account could share
  under different paths — but the SW's scope confines it to `/simple-bitcoin-wallet/`
  clients, the app never requests other paths, and content there is controlled by the same
  account (compromise of which is game-over regardless). `cache.put` failure (quota, 206,
  `Vary: *`) cannot break a page load: the put is fire-and-forget and the response has
  already been returned — verified by feeding put a never-settling thenable (an awaited put
  would have hung the harness; it didn't).
- **d. Cache growth — ACCEPTABLE as-is (info-level trade-off, no pruning now).**
  Reproduced live: two builds' hashed assets coexist in `sbw-cache-v1` (6 entries). One
  build is ~420 kB (400 kB JS + 19 kB CSS), growth is linear only in deploys a client
  actually loads, entries are same-origin content-hashed files that can never be served
  stale, and browser cache quota is orders of magnitude larger. Pruning logic would add
  complexity (and new failure modes) to money-adjacent plumbing for zero security gain.
  Requirement going forward: **bump `CACHE_NAME` whenever sw.js behavior changes**, which
  prunes everything via the activate handler (harness-verified: only `sbw-cache-*` names
  other than the current one are deleted; other apps' caches untouched). A bounded prune
  can ride the v1.2 trust-hardening pass if desired.
- **e. clients.claim() + no-skipWaiting — SOUND.** No `skipWaiting` anywhere (grep-verified),
  so a controlling SW is never swapped mid-session. The subtle case — a page that loads
  while a new SW sits waiting runs the *new* deploy's HTML/JS under the *old* controlling
  SW — is skew-free by construction: the SW is content-agnostic (network-first HTML,
  cache-first assets keyed by full content-hashed URL), so any SW version serves correct
  bytes for any page version, in both directions. `claim()` only affects
  previously-uncontrolled pages (very first install, or post-hard-reload), where the claimed
  page and the claiming SW are the same deploy or the cache is empty → network. No
  version-skew window found.
- **f. Registration — SOUND.** `import.meta.env.PROD` gates dev out entirely (HMR unaffected);
  `BASE_URL` is `'./'` under `base: './'`, so `'./sw.js'` resolves against the document URL →
  `/simple-bitcoin-wallet/sw.js`, and the default scope is the script's directory → exactly
  the app subpath (live-verified at preview root). `register()` is idempotent for the same
  URL+scope, so the load-listener can't double-register; failure is swallowed and the app
  is identical without the SW (registration is additive only). No wrong-scope path found.
- **g. Pull-to-refresh + safe-area CSS — SOUND.** `overscroll-behavior-y: none` suppresses
  only overscroll *chaining/refresh gestures*, never scrolling itself; the document doesn't
  scroll in this layout anyway (all scrolling lives in `.screen-body { overflow-y: auto }`,
  which keeps scrolling normally — its `contain` just stops chain-out at the edges, which is
  precisely the anti-reload intent: a reload wipes the memory-only session and locks the
  wallet). `padding-top: var(--safe-top)` is `env(safe-area-inset-top, 0px)` → exactly 0 in
  any normal browser (no-op), real inset only in notched standalone.
- **h. Activity "Try again" — SOUND.** It reuses the *same* `refreshAll` callback Home and
  Receive already pass (`App.tsx:575/606/677`) — no new semantics. Rapid-tap churn is
  structurally suppressed: the first tap dispatches `accountLoading`, which synchronously
  flips `accountStatus` to `'loading'` and unmounts the error callout (and its button) on
  the same render — there is no second tap to give. Even absent that, each `refresh()`
  aborts the prior run (cancelling its in-flight requests, keeping concurrency at
  POLL_CONCURRENCY) and the F13 `externallyAborted` silencing plus single-flight
  `busy`/`pollBusy` gates are untouched by this diff — F12/F13 invariants hold as shipped
  in Round 6.
- **i. Test harness (sw.test.ts) — SOUND.** The stub `self` has no `addEventListener`, so
  the event-wiring block never executes: no listeners, and the I/O helpers (`networkFirst`/
  `cacheFirst`) are defined but never invoked — `caches`/`fetch` are only referenced inside
  their bodies, so no I/O can occur in the test process. Confirmed the converse too: with
  `module` undefined (the real-SW condition) the export block is a no-op — evaluated the
  file that way in my own harness without error. `new Function` evaluates only the repo's
  own `public/sw.js` via Vite `?raw`; no external input.
- **j. make-placeholder-icons.mjs — SOUND (one provenance note).** Imports only
  `node:zlib`/`node:fs`/`node:path`/`node:url`; zero network; writes exactly the four
  documented files, with paths anchored to the script's own location (cwd-independent), all
  under `public/`. The hand-rolled PNG encoder is correct (verified by decoding the output:
  valid IHDR/IDAT/IEND, filter-0 scanlines, every pixel `#F7931A`, correct dimensions;
  `deflateSync` produces the zlib-wrapped stream PNG requires). Output is deterministic
  (identical hashes across runs). **Note/disclosure:** the placeholder PNGs sitting in the
  tree at review time did NOT byte-match the script's output (the two 512s even differed
  from each other); executing the script during this audit — required to audit it —
  overwrote them with its canonical deterministic output, which is what the tree now holds.
  Same filenames/dimensions, still valid solid-orange placeholders; functionally nothing
  changed, and the designer's real icons replace these before commit anyway. **Icon plan
  verdict:** committing hand-authored SVG masters to a repo-root non-served folder
  (`assets-src/`, not `public/`) is fine — verified the build output contains only
  `public/` copies + bundled assets, so nothing under `assets-src/` ships (Vite's dev
  server can serve root files, but that's dev-only and the SVGs are non-secret). Keep the
  final PNG filenames identical and note in the folder README which SVG each PNG was
  rendered from, so the shipped binaries keep auditable provenance.
- **k. index.html metas + manifest — SOUND.** The CSP meta is untouched and the built policy
  is unchanged (verified). No `worker-src` is declared, so the SW script falls back to
  `script-src 'self'` — only our own origin can ever be a service worker. New tags are all
  same-origin relative references (`./manifest.webmanifest`, `./apple-touch-icon.png`) —
  subpath-safe and no external fetches; `manifest-src` falls back to `default-src 'self'`.
  The manifest's `id`/`start_url`/`scope` are all `'./'`, resolved against the manifest URL
  → exactly the app root on the Pages subpath (and the shipped test locks a leading-`/`
  regression out). `display: standalone`, no `url_handlers`/`protocol_handlers`/share
  targets — nothing that widens the surface, nothing leaks. Duplicated brand color
  (theme-color meta vs manifest) is explicitly commented as one-source-in-manifest;
  `apple-mobile-web-app-capable` is the legacy-but-still-honored iOS meta — harmless.

## New findings

### F14 — [SEV-Info] `cache.put` is fire-and-forget with no `.catch` — unhandled rejections; and the "partial ... never stored" comment is wrong about *why*

- **Where:** `public/sw.js:109` (`networkFirst`) and `:134` (`cacheFirst`) —
  `cache.put(request, response.clone());` with the returned promise discarded; the comment
  at `:106-107` claims partial responses are excluded by the guard.
- **Scenario (verified in a throwaway harness):** a 206 Partial Content response has
  `ok === true` and `type === 'basic'`, so it passes the guard and reaches `cache.put`; only
  the Cache API's own spec behavior (reject on 206, reject on `Vary: *`, reject on quota
  exhaustion) prevents storage. Because the put promise is discarded (confirmed: nothing is
  ever chained on it), each such failure surfaces as an unhandled promise rejection inside
  the SW — console noise, and on some browsers an error-report event, but **no functional
  impact**: the response has already been returned to the page, and a hanging/rejecting put
  cannot delay or break any load (verified by feeding put a never-settling thenable).
  Availability and integrity are both preserved; this is hygiene plus an inaccurate
  comment in a file whose header promises every line is audit-grade.
- **Fix:** append `.catch(function () {})` to both `cache.put` calls (with a one-line
  comment: quota/206/Vary rejections are expected and safely ignored), and correct the
  `:106` comment — partials are excluded by the Cache API's put rules, not by `response.ok`.

_Round-7 throwaway tests used the `.review.test.ts` suffix, were executed, and were deleted;
no source files were modified. (Executing `scripts/make-placeholder-icons.mjs` to audit it
regenerated the four placeholder PNGs under `public/` — see area j's disclosure; those
binaries were declared out of scope and are replaced by the designer's icons before commit.)_

---

# Round 7 closure — F14 re-check

**SHIP-BLOCKING ISSUES: 0 / new findings: 0**

## F14 — CLOSED

- **Fix verified in place and complete.** Both `cache.put` calls now carry
  `.catch(function () {})` (`public/sw.js:116`, `:143`); harness re-run (same stub
  `self`/`caches`/`fetch` technique as Round 7, throwaway deleted): a put that genuinely
  rejects (quota / 206 / `Vary: *`) is swallowed with no unhandled rejection reported by
  vitest, and the response is still returned to the page in both `networkFirst` and
  `cacheFirst`. These were the only fire-and-forget cache operations in the file — the
  activate handler's `caches.delete` chain is consumed by `event.waitUntil`, and every
  `open`/`match` promise is chained.
- **Corrected comment is accurate** (`sw.js:106-111`): `response.ok` excludes non-2xx,
  `type === 'basic'` excludes cross-origin/opaque, and a 206 passes `ok` with storage
  refused by the Cache API itself — matching spec behavior as verified in Round 7.
- **No CACHE_NAME bump — correct call.** Nothing has shipped, so no deployed client holds
  a cache created by pre-fix worker code; and the fix changes only rejection *handling*,
  not what gets stored, so cache contents are identical either way. `sbw-cache-v1` as the
  first live version is right.
- Gates re-confirmed by me: `tsc --noEmit` clean, `npm test` = 146 passing,
  `npm run build` clean.

_The F14 closure test used the `.review.test.ts` suffix, was executed, and was deleted; no
source files were modified._

---

# Round 8 — RBF Speed-up (signaling + bump engine + sheet)

**SHIP-BLOCKING ISSUES: 1 / new findings: 1**

`npm test` = 212 passing, `tsc --noEmit` clean, `npm run build` clean, prod CSP still
`script-src 'self'` (verified in `dist/index.html`), and the PWA surface is untouched
(`git diff` on `public/`, `index.html`, `src/main.tsx`, `vite.config.ts` is empty). The
engine work is careful and largely excellent — the fee-guard reuse (F1/F10), the F11
single-code-path property, BIP125 floor math, the change-address ownership proof, and the
F2-style ingest validation all hold up under test. But the bump flow introduces the first
code path in this wallet where **the client signs a transaction whose destination address
comes from the untrusted API instead of from the user** — and there is no local cross-check
or on-screen re-confirmation of that address. A hostile/compromised mempool.space endpoint
can therefore redirect the full amount of a sped-up payment to an attacker (F15). Verified
by test: the built, signed replacement pays the API-supplied recipient with valid signatures
and no guard trips.

## Per-area verdicts

- **a. Hostile-API change theft — CHANGE is SOUND; RECIPIENT is NOT (F15, ship-blocking).**
  The *change* address is provably ours: `classifyBumpOutputs` only ever assigns change to
  an owned output, so swapping our change for an attacker address yields two foreign outputs
  → `unsupported-shape` honest failure (test-verified). But the *recipient* is the foreign
  output, reused verbatim from `getTransaction` with **no local verification and no
  re-confirmation in the offer sheet** (the sheet shows only fee rows). A hostile endpoint
  that keeps the real owned inputs + real owned change but substitutes the recipient address
  (value unchanged, so the `inputs − outputs = fee` cross-check still passes) makes the
  wallet build, sign, and broadcast a valid BIP125 replacement paying the attacker.
  **Verified by test:** `prepareBump` returned `recipient = <attacker>`, and the broadcast
  replacement's first output was the attacker's P2WPKH script funded with the full 80,000
  sats. See F15.
- **b. Hard caps under bump — SOUND.** `buildRbfBumpTx` enforces, *before* the `allowHighFee`
  gate: requested rate > `MAX_FEE_RATE_SAT_VB` → hard `FeeTooHighError`; `exceedsRateCeiling`
  (the BIP125 floors pushing the fee past what 500 sat/vB pays for this size) → hard;
  `newFeeSats > MAX_FEE_ABSOLUTE_SATS` → hard. `allowHighFee` bypasses only the 25% rule
  (F10 semantics preserved). The shipped suite proves each cap holds *with* `allowHighFee`
  set. The dust-fold effective-rate slop (≤ `DUST_LIMIT_SATS`) mirrors the accepted
  `selectCoins` behaviour and stays bounded by the absolute cap — not a new issue.
- **c. Accounting identity — SOUND (byte-parse-verified).** Change-absorbs: `sum(outputs) +
  fee == sum(inputs)` and the recipient output is never reduced. Sweep: single output,
  `recipient + fee == inputs`, and `reducesRecipientBy == newFee − oldFee` exactly, matching
  the built output to the satoshi. Dust-fold: change dropped, recipient untouched, residue
  folded to fee. All three reconcile.
- **d. BIP125 economics — SOUND.** `bumpFeeFloor` takes `max(requested, oldFee + 1×vsize,
  ⌈oldFee×newVsize/oldVsize⌉+1)`, so a boundary bump clears both the incremental-relay floor
  and the strictly-greater-effective-rate rule (test: a requested rate *below* the original's
  still produces `newFee ≥ oldFee + vsize` and `newFee/newVsize > oldFee/oldVsize`, with
  `rateWasRaised` reported). The −31 vB (`OUTPUT_VB`) change-fold adjustment is correct — one
  P2WPKH output is 31 vB — and the folded fee provably still clears every floor at the smaller
  vsize (all three floors shrink with vsize while the folded fee only grows).
- **e. Ownership / mapping — SOUND.** A foreign input can pass as ours only if its prevout
  address collides with one we derive over both chains [0 … high-water + gap-20] — a
  local-derivation-only map, no network — which is cryptographically impossible; otherwise
  `foreign-inputs`. The self-send classification claim holds: when every output is ours, any
  misclassification of recipient-vs-change only shifts value between our own outputs and the
  fee (both destinations are ours), never to a third party. The `chain-0 = recipient` /
  `chain-1 = change` / single-output-= recipient rules are exhaustive; anything else
  dead-ends `unsupported-shape`.
- **f. Ingest — SOUND.** The shipped `api.tx.test.ts` fuzzes response-txid≠request, duplicate
  outpoints, out-of-range/float/negative/undefined `sequence` (u32), float/negative/
  over-supply values, oversized/ wrong-type addresses, empty/oversized vin·vout vectors,
  zero/over-max weight, and the `fee = inputs − outputs` cross-field identity in both
  directions — comprehensive. Reasoned about the one intentional gap: the fee cross-check is
  skipped when any input lacks a prevout, but such a transaction always dead-ends
  `foreign-inputs` in `prepareBump` (no owned prevout address), so an unvalidated fee can
  never reach the bump math. The `txidArg` is 64-hex-validated before the URL is built.
- **g. Consent paths — SOUND.** `allowHighFee` is passed as `consents.highFee` and the confirm
  button is disabled until the matching checkbox is ticked (and `confirmBump` re-checks before
  awaiting), so consent can't be set silently; it bypasses only the 25% rule. The sweep
  (`reducesLess`) checkbox gates the button independently. The hard-cap dead-end (`fee-cap`)
  offers a single Close — no bait button — mirroring Review's hard-block. The checkbox-vs-Send's-
  button affordance difference preserves F10's "explicit, informed, per-attempt" property.
  (Minor, non-finding: the notice's displayed `pct` uses `newFee/newRecipient` while the rule
  compares against `recipient+fee`/`totalInput`; the copy reads "% of what you're paying," a
  defensible framing — magnitude only, no safety impact.)
- **h. Idempotency / double-submission — SOUND.** The synchronous `submitting` flag (set before
  the await, the Review-house standard) plus the `confirmBump` early-return prevent a second
  bump from one sheet; only one detail sheet exists at a time. Deterministic RFC6979 signatures
  + mempool.space's accept-on-rebroadcast make a retry (the fail-state "Try again," same
  captured `offer.feeRate`) re-emit the *identical* replacement — no two distinct replacements,
  no double-spend. `aliveRef` guards post-dismiss `setState`.
- **i. Burst discipline — SOUND.** `prepareBump` is exactly one `getTransaction` (plus
  local-only derivation for the owned-address map — zero requests); nothing loops, polls, or
  retries beyond api.ts's standard single transport retry. Sheet dismissal aborts the in-flight
  fetch via `abortRef` on unmount. The discovery single-flight/budget discipline is untouched.
- **j. UI honesty — SOUND (except the recipient omission → F15).** Every number shown is read
  straight off the one `BumpFeeEstimate` the build consumes (F11) — no UI arithmetic on
  money. Dead-end copy maps 1:1 to true machine reasons via `deadEndFromReason`/`isHardFeeCap`.
  The post-success transition keeps the confirmation on screen and refreshes underneath, so
  the old-txid→replacement swap never flashes a wrong intermediate. The one honesty gap is
  substantive, not cosmetic: the sheet never shows the *destination* of the payment being sped
  up (F15).
- **k. Regression — SOUND.** The only send-path change is `sequence = RBF_SEQUENCE` on every
  input (0xfffffffd — largest RBF-signaling value, BIP68 disable bit set, no vsize change),
  byte-verified in the shipped tx tests; normal sends are otherwise identical. PWA/SW/`public/`
  and the CSP are untouched (diff empty; `dist` CSP still `script-src 'self'`).

## New findings

### F15 — [SEV-High] A hostile API can redirect a sped-up payment's recipient — the client signs an API-supplied destination  *(SHIP-BLOCKING)*

- **Where:** `src/actions.ts` `classifyBumpOutputs` (the foreign output becomes `recipient`,
  reused verbatim) → `prepareBump` (`recipient: recipient.address`) → `bumpAndBroadcast` →
  `src/lib/tx.ts` `buildRbfBumpTx` (`scriptForAddress(recipient, network)` validates only
  form/network, not intent) → `src/screens/Activity.tsx` offer sheet (renders fee rows only —
  no destination address/amount). The recipient originates entirely from the untrusted
  `getTransaction` response and is never cross-checked against a locally-known value.
- **Scenario (verified with a throwaway test):** A compromised or MITM'd mempool.space
  endpoint (the app's single trusted third party — the exact threat model F1/F2 treat as in
  scope) serves a `getTransaction` response for the user's pending payment that keeps the real
  owned inputs and the real owned change output, but substitutes the **recipient address** for
  an attacker's (leaving the value the same, so the `fee = inputs − outputs` integrity check
  still passes). `prepareBump` returns `recipient = <attacker>`; the user sees an offer sheet
  showing only "Fee paid / New fee / Extra cost" and taps "Speed up — pay $X more";
  `buildRbfBumpTx` builds and signs a valid BIP125 replacement paying the attacker, which
  `bumpAndBroadcast` broadcasts. **Test result:** the broadcast replacement's first output was
  the attacker's P2WPKH script funded with the full 80,000-sat recipient amount, with valid
  signatures — no guard tripped. Because the replacement shares the original's inputs and pays
  a higher fee, it replaces the honest original and can confirm, sending the funds to the
  attacker.
- **Why it matters here:** This breaks the invariant the whole audit trail has defended — a
  hostile endpoint may *mislead the display* but must never *move funds* (F1 was ship-blocking
  for exactly this line, and it protected a fee-sized loss; F15 redirects the entire payment
  amount). Every prior signing path takes its destination from the user, who confirms the
  address on Review (the cross-check F4/F7 deliberately preserve). The bump flow is the first
  path that signs a destination chosen by the server, with no user confirmation of it.
- **Fix:** Restore the "user confirms the destination" property before signing. Minimum:
  render the recipient address (chunked, as Review does) **and** the amount to that recipient
  in the Speed-up offer sheet, so a substituted address is visible and the sheet isn't a
  fee-only cross-check. Stronger (defence in depth): persist each send's `(txid → recipient
  address, amount)` locally at broadcast time and, in `prepareBump`, hard-fail
  (`unsupported-shape`/new reason) when the API's recipient/amount don't match the persisted
  record — so the wallet never signs a bump to an address it didn't itself send to. Until one
  of these lands, the bump flow should be considered a fund-redirection surface.

_Round-8 throwaway tests used the `.review.test.ts` suffix, were executed, and were deleted; no
source files were modified. Empirically verified: the recipient-substitution redirect (built +
signed replacement pays the attacker), the change-swap fail-safe, the change-absorbs and sweep
accounting identities (byte-parsed, `reducesRecipientBy` exact), and the BIP125 boundary-bump
floors; ingest validation was confirmed against the shipped `api.tx.test.ts` fuzz suite._
