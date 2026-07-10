# Roadmap

Where Simple Bitcoin Wallet could go from v1.0 (July 2026). Items are ordered
by value-for-effort within each phase; nothing here is committed work.

## v1.2.0 — 🚧 built 2026-07-10 for owner UX testing: blockstream.info is the chain-data source

> ⚠️ **ROUND 13 SECURITY AUDIT OWED — before any further money-path work.** This
> release was built with the formal Fable security round **explicitly deferred by
> the owner** so he could test on his phone quickly. It touches API ingestion and
> the trust model (a second endpoint), which the repo's own rules require a review
> round for. **Do not build further on the money path, and do not treat v1.2.0 as
> audited, until Round 13 runs and appends to `docs/review/round1.md` (continuing
> the F-numbering from F18).**

**Owner field evidence, 2026-07-10:** mempool.space now rate-limits the owner's
IP with bare HTTP **429s** (no `Retry-After`; a token bucket ≈25–40 refilling
≈1/s), while blockstream.info serves the same connection flawlessly (0.2–0.3s).
The app treated a 429 as a fatal run error, so scans died and the frontier
**regressed** ("stuck at 22 of 40"). Three changes, four commits:

- **Chain data → blockstream.info** (`chainApiBaseUrl`): address stats / utxos /
  txs / one-tx fetch / broadcast now hit blockstream (byte-identical Esplora
  shapes, so F2 validators transfer unchanged). **Fees + USD price stay
  mempool.space** — the F1-audited fee path is byte-identical, and blockstream has
  a different fee shape and no price. CSP `connect-src` gains blockstream (keeps
  mempool.space). `public/sw.js` untouched (cross-origin passthrough by design).
- **HTTP 429 = a polite in-run PAUSE, not a dead run:** a discovery chain-data GET
  that 429s pauses ~12s (`RATE_LIMIT_PAUSE_MS`, sized to the ≈1/s refill) and
  retries, up to `MAX_RATE_LIMIT_PAUSES = 3` per run; the inactivity cutoff is
  suspended for the deliberate wait, the 120s hard cap still binds. NOT the §1c
  transport retry — a 429 is a server-priced wait, and honoring a bounded number
  REDUCES offered load.
- **Convergence-scoped cache TTL:** while an account is still converging (no full
  scan completed since the cache was created/invalidated) entries no longer expire
  by the 100s TTL, so ladder-spaced resumes converge instead of regressing; a
  completed full scan restores the normal TTL. Every change-signal invalidation
  still nukes the cache instantly in both modes (generation-fenced, F16).

Built with `tsc` clean and the full suite green (279 → 290 tests). **Round 13
should attack:** the second-endpoint trust surface (a lying blockstream mis-stating
balances — display-only, still caught by F15 on the one non-derivable field, the
bump recipient); the 429-pause inactivity-suspension interplay with the hard cap
and the F16 generation guard; and the convergence-TTL honesty argument (a payment
arriving mid-convergence must still be caught by the uncached poll within one
cycle).

## v1.1.1 — ✅ shipped 2026-07-10: discovery retry loop self-throttles the API

**Fixed and shipped** (security review round 9; F16/F17 found and closed; 261
tests). The empty-wallet scan used to re-fire its full ~40-request burst every
30 seconds forever when mempool.space stall-throttled it — manufacturing its own
outage. The fix: an exponential backoff ladder on automatic rescans (manual
retry always instant); a cross-run in-memory scan cache (per-network, ~100s TTL,
generation-fenced invalidation on every change signal) so an interrupted scan
*converges* instead of restarting; no api-layer retry on discovery GETs;
de-duplicated price/fee fetches; paced scan waves (concurrency 2, ~200ms
jittered inter-wave delay, applied only to waves that actually hit the
network — F17); and the `isEmpty` Home flicker fix. History and design
constraints: **`docs/HANDOFF-discovery-throttle.md`** (status updated) and
review rounds 9 + closure in `docs/review/round1.md`.

- **Stage 3 — DEFERRED by owner 2026-07-10:** the `blockstream.info` failover
  stays on the v1.2 shelf for now (owner chose to hold off; scanning-progress
  communication prioritized instead). Verified identical Esplora shape; still
  failover-only if/when revisited; still requires explicit owner sign-off
  (trust-model change) and a review round.

## v1.1.2 — ✅ shipped 2026-07-10: continuous scans on slow networks

**Owner field report, same day as v1.1.1:** on a slow network the scan reached
"22 of ~40", sat on the wait state for ~a minute, then finished — correct but a
bad flow. Fixed (security review round 11 + F18 closure; 276 tests then, 279
with the fee display): the fixed 20s run deadline became a **12s inactivity
cutoff** (every landed response resets it — a slow-but-moving scan now runs
continuously to completion) plus a **120s hard cap** (a run always settles;
F12's never-open-ended property). Cut runs that made progress self-heal in
**~8s** instead of a minute (progress-gated quick retry, **budgeted to 5
windows** between complete snapshots — F18 — so offered load still always
decays); no-progress runs walk the unchanged v1.1.1 ladder, and a fully wedged
network behaves byte-identically to v1.1.1.

## v1.1 — Feels like a real app (near-term, small pieces)

- **PWA packaging** — ✅ **shipped 2026-07-09** (security review round 7,
  F14 closed). Web app manifest, hand-traced ₿ icon (`assets-src/icons/`),
  hand-rolled zero-dependency service worker (network-first HTML, cache-first
  hashed assets, cross-origin untouched), iOS standalone safe-areas, and
  browser pull-to-refresh suppression (an accidental reload locked the wallet).
- **Speed up a stuck payment (RBF)** — ✅ **shipped 2026-07-09** (security
  review round 8; F15 found and closed). All sends signal BIP125
  (`RBF_SEQUENCE`); pending outgoing payments get a "Speed up" sheet that
  rebuilds with a higher fee on the same inputs. The bump's recipient is
  verified against a local send record written at broadcast time
  (`src/lib/sendLog.ts`) — a hostile chain endpoint cannot redirect a
  sped-up payment. Payments made before v1.1, or on another device, honestly
  dead-end as un-bumpable.
- **Scan QR to send** — camera-based address scanning on the Send screen
  (today it's paste-only). Needs a QR-decode dependency, so the supply-chain
  bar applies: tiny, audited, zero-dep library or nothing.
- **Fresh address nudge** — after a receive address gets used, rotate the
  Receive screen to the next one automatically (with the old one still valid).
  Improves privacy for free.

- **Show fee rates in sat/vB** — ✅ **shipped 2026-07-10** (owner request;
  security review round 12, 0 findings). Each fee tier chip on Send now shows
  its sat/vB rate; the displayed number and the rate the engine signs provably
  terminate in the same F1-clamped `feeRateForTier` evaluation (round 12
  traced chip-to-broadcast equality, including clamped extremes).

- **Custom fee rate** *(owner request, 2026-07-10)* — let the sender type
  their own sat/vB rate as an advanced option next to the recommended tiers.
  **Money-path change — needs a security review round when built:** the input
  must clamp into the F1 window (`MIN_ACCEPTED_FEE_RATE`–`MAX_ACCEPTED_FEE_RATE`;
  the hard 500 sat/vB / 1M-sat caps stay non-overridable) and must flow through
  the same `estimateSendFee` single path as the tiers (F11 — no parallel fee
  computation). The 25%-of-amount consent rule applies unchanged. Interacts
  with the sub-1 sat/vB item below: a custom rate under 1 sat/vB raises the
  same relay-floor questions, so decide the floor once, for both.

- **Scan progress on the "Checking for updates…" cue** — ✅ **shipped
  2026-07-10** (owner request; security review round 10, 0 findings). While
  a scan runs, the cue reads "Checking address N of ~M…" (M is an estimate
  that grows as used addresses extend the window — deliberately not a
  percent, which could move backwards); while the v1.1.1 backoff ladder is
  deliberately waiting, it becomes a tappable "Balance may be behind — will
  check again soon. Tap to check now." wired to the always-instant manual
  refresh. Display-only: the engine is byte-identical when the progress
  callback is absent. Known cosmetic: the counter resets at the phase-1→
  phase-2 seam (sub-second, only on self-heal re-runs) — smooth with a
  phase-1 offset if it ever bothers anyone.

- **Sub-1 sat/vB "super economy" fee** — Bitcoin Core 30 (Oct 2025) lowered the
  default minimum relay feerate to 0.1 sat/vB, so in a quiet mempool a payment
  can confirm for less than the app's current 1 sat/vB floor. The engine's fee
  math is already fraction-safe (`ceil(vsize × rate)`); the floor lives in
  `MIN_ACCEPTED_FEE_RATE` (api.ts) and `feeRateForTier`, both part of the F1
  fee-sanity fix — so lowering it is a money-path change needing a review round.
  Savings are small (≈100 sats on a typical send) and a sub-1 payment is more
  likely to stall, so this only became sane once **Speed up** shipped. Requires
  checking what mempool.space actually serves for fractional rates (the
  `/v1/fees/recommended` endpoint returns integers) and accepts on broadcast.

## v1.2 — Trust hardening

- **Second chain-data source** — 🚧 **partially realized in v1.2.0 (see above):**
  blockstream.info is now the PRIMARY chain-data source (mempool.space kept for
  fees + price), which addresses the 429 throttling that bit for real on
  2026-07-10. **Still future:** true FAILOVER architecture (automatic switch when
  the primary is unreachable/throttling) and the optional cross-check of displayed
  balances between the two — today it is a straight primary swap, not a resilient
  multi-source layer. Revisiting either still needs the owned Round 13 audit first.
- **Smarter password strength** — a proper local estimator (zxcvbn-class,
  vendored/audited) instead of the current heuristic; still no server, still
  plain-English guidance.
- **Hide balance mode** — tap to blur the balance for shoulder-surfing
  situations (bus, café).

## v2 — Bigger swings (only if the app earns real users)

- **Watch-only export** — export the account xpub so a user can monitor the
  wallet from other software without exposing keys.
- **Local transaction notes** — attach a private "what was this for" label to
  each payment, stored only on-device.
- **More languages** — the strings layer is already centralized
  (`src/strings.ts`), so translation is mechanical.
- **Practice-mode faucet helper** — one-tap link/flow to fund the practice
  wallet from a public testnet faucet, so beginners can try a full
  receive→send loop in minutes.

## Standing engineering habits (always-on)

- Re-run a Fable security round on ANY change that touches signing, fees,
  the vault, or API ingestion — the six-round audit trail lives in
  `docs/review/round1.md`; keep appending to it.
- Keep the discovery layer's single-flight + budgeted-scan pattern
  (`src/actions.ts` DiscoveryController) — mempool.space throttles request
  bursts by stalling connections, not by returning errors.
- Dependency updates on a slow, deliberate cadence (this app prefers boring,
  pinned, audited deps over fresh ones).
- Known accepted trade-offs (documented in README): light-client display
  trust, client-side-only unlock throttle, no coin control.
