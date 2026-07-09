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
