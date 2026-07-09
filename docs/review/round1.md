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
