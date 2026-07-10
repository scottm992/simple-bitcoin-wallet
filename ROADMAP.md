# Roadmap

Where Simple Bitcoin Wallet could go from v1.0 (July 2026). Items are ordered
by value-for-effort within each phase; nothing here is committed work.

## v1.1.1 — OPEN BUG, next work: discovery retry loop self-throttles the API

**The one thing that should be fixed before anything else on this list.** For a
wallet with no used addresses, one full scan costs ~40 mempool.space requests;
the API stall-throttles bursts by hanging connections; the run dies on its 20s
deadline; nothing is cached across runs; and the app retries the identical burst
every 30 seconds forever with no backoff. It manufactures its own outage
("Checking for updates…" that never clears, then "couldn't reach the bitcoin
network"). Found in the field 2026-07-09; **no funds at risk** (display path only).

Full brief, measured numbers, staged plan, correctness landmines and a "do not"
list: **`docs/HANDOFF-discovery-throttle.md`**. Needs a Fable review round
(next finding number: F16).

- **Stage 1 (hotfix):** exponential backoff + cap on self-heal rescans; a scan
  cache that survives across runs (in-memory, per-network, short TTL, invalidated
  on any change signal) so an interrupted scan *converges* instead of restarting;
  drop the api-layer retry on discovery GETs; de-duplicate price/fee fetches;
  back off the error state; fix the `isEmpty` gating that makes Home flicker.
- **Stage 2:** pace a single run (concurrency 4 → 2, jittered waves).
- **Stage 3 (v1.1.2, needs owner sign-off):** pull the v1.2 second-source item
  forward — `blockstream.info` failover. Verified identical Esplora shape. **Must
  not ship before Stage 1**, or both providers get throttled.

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
