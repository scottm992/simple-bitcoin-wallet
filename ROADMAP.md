# Roadmap

Where Simple Bitcoin Wallet could go from v1.0 (July 2026). Items are ordered
by value-for-effort within each phase; nothing here is committed work.

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

- **Show fee rates in sat/vB** *(owner request, 2026-07-10)* — display the
  actual sat/vB rate alongside each recommended fee choice on Send (today the
  tiers show cost but not the underlying rate). Display-only: the rates already
  arrive via `getFeeEstimates`/`feeRateForTier`; this just surfaces them.

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

- **Second chain-data source** — *(being pulled forward to v1.1.2 — see the
  v1.1.1 section above)* add an Esplora-compatible fallback (e.g.
  blockstream.info) used when mempool.space is unreachable or throttling,
  and optionally cross-check displayed balances between the two. Directly
  shrinks the "trusts one endpoint for display" caveat and the throttling
  failure mode found in field testing — which bit for real on 2026-07-09.
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
