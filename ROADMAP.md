# Roadmap

Where Simple Bitcoin Wallet could go from v1.0 (July 2026). Items are ordered
by value-for-effort within each phase; nothing here is committed work.

## v1.1 — Feels like a real app (near-term, small pieces)

- **PWA packaging** — ✅ **shipped 2026-07-09** (security review round 7,
  F14 closed). Web app manifest, hand-traced ₿ icon (`assets-src/icons/`),
  hand-rolled zero-dependency service worker (network-first HTML, cache-first
  hashed assets, cross-origin untouched), iOS standalone safe-areas, and
  browser pull-to-refresh suppression (an accidental reload locked the wallet).
- **Speed up a stuck payment (RBF)** — pending outgoing transactions get a
  "Speed up" button that rebuilds with a higher fee (BIP125). Closes the
  biggest known functional gap: today a low-fee send can sit unconfirmed
  with no recourse. Money-path change → needs a security review round.
- **Scan QR to send** — camera-based address scanning on the Send screen
  (today it's paste-only). Needs a QR-decode dependency, so the supply-chain
  bar applies: tiny, audited, zero-dep library or nothing.
- **Fresh address nudge** — after a receive address gets used, rotate the
  Receive screen to the next one automatically (with the old one still valid).
  Improves privacy for free.

## v1.2 — Trust hardening

- **Second chain-data source** — add an Esplora-compatible fallback (e.g.
  blockstream.info) used when mempool.space is unreachable or throttling,
  and optionally cross-check displayed balances between the two. Directly
  shrinks the "trusts one endpoint for display" caveat and the throttling
  failure mode found in field testing.
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
