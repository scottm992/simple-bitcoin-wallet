# Handoff — discovery retry loop self-throttles mempool.space (v1.1.1 hotfix)

**Status: OPEN BUG, not yet fixed. Nothing in this document has been implemented.**
Written 2026-07-09 after a live field report + two independent diagnoses (the
second by a fresh Fable reviewer who verified every number below with
instrumented throwaway tests against the real scan code).

This file is the complete brief. It is written so a fresh engineer with no prior
context can pick the work up cold. Read it, then `docs/ENGINE.md` (especially the
`src/actions.ts` section), then rounds 5–6 of `docs/review/round1.md` (F12/F13
constrain the design).

---

## 1. Symptoms (owner's iPhone, PWA installed)

1. "Checking for updates…" cue appears on Home and never clears.
2. Eventually: "We couldn't reach the bitcoin network."
3. On cellular (fresh IP) phase 1 works again; the cue still never clears.
4. The bottom of Home visibly alternates every ~30 s between the "Your wallet is
   empty" nudge and the "Recent activity" block.

The wallet's balance is genuinely `$0` (owner confirmed). **No funds are at
risk and none were ever at risk** — this is a request-budget defect. The balance
path can only understate, never inflate, and no signing is involved.

## 2. Root cause, plainly

Proving a wallet is empty costs ~40 mempool.space requests inside one 20 s
deadline. mempool.space **stall-throttles bursts by hanging the TCP connection**
(no 429, no error — the documented, field-learned constraint). The run gets cut
off, **nothing is saved** (the scan cache is scoped to one run), and 30 s later
the app fires the identical 40-request burst again, forever, with no backoff and
no cap. Each failed attempt deepens the throttle until even phase 1's handful of
requests can't get through — which is the network error. A fresh IP resets the
throttle; the loop immediately re-poisons it.

For an empty wallet, **the app can never complete phase 2 against mempool.space,
and it manufactures its own outage.** Latent since two-phase discovery shipped;
the PWA made it easier to leave the app open, so it surfaced.

## 3. Measured facts (verify, don't trust)

| Case | Phase 1 | Full run | Retry cost |
|---|---|---|---|
| Empty wallet | 10 (all stats) | **40** | **40 again** |
| 1 used receive address | 13 | **43** | 43 again |
| With a cached high-water mark | 13 | 43 | mark changes nothing |

Idle phone offers **~44 requests / 30 s ≈ 5,300 / hour**.

Live measurements (owner's home IP, 2026-07-09):
- `mempool.space` — `dns:0.004s`, **TCP never connects**, `code:000` after ~22 s.
  Still black-holed 30+ min later. Not refused — silently hung.
- `blockstream.info/api/blocks/tip/height` — `200` in 0.26–0.39 s, same connection.
- `api.github.com` — `200` in 0.35 s. So: not the owner's connectivity.

**No cheaper API exists.** Esplora (both providers) has no batch endpoint and no
xpub endpoint. The gap-20 proof genuinely costs ~40 requests. The only lever is
*when* and *how often* we pay it.

## 4. The five defects (with file references, all verified)

1. **No backoff, no cap.** `pollTick` sees `accountComplete === false` and calls
   `onChanged` → `refreshAll()` → a brand-new full two-phase run, every 30 s
   forever (`src/actions.ts` `pollTick`; `src/App.tsx:194-215` interval).
2. **Cache is run-scoped.** `createScanCache()` is created *inside* each run
   (`src/actions.ts:133`), so a retry re-fetches all 40 addresses. A run cut at
   25/40 throws away 25 good responses.
3. **API layer retries discovery GETs once on transport failure**
   (`src/lib/api.ts:318`, `for (attempt = 0; attempt < 2; attempt++)`). Against a
   stall-throttler this **doubles offered load exactly when we're being punished**.
4. **The error state doesn't stop the loop.** `accountError` keeps the old
   snapshot and its `accountComplete=false` (`src/state.ts:221-222`), so full
   rescans keep firing *behind* the "couldn't reach the network" banner.
5. **Price/fees fetched twice per cycle** — once by the 30 s tick
   (`src/App.tsx:199-202`), once by the self-heal's `refreshAll`
   (`src/App.tsx:161-164`).

Plus the cosmetic tell: **`src/screens/Home.tsx:43`** gates `isEmpty` on
`accountStatus === 'ready'`; every rescan flips status to `'loading'`, swapping
the empty nudge for the activity block. Symptom 4 is the retry loop made visible.

Also worth knowing: the two address chains scan **concurrently**
(`src/lib/account.ts:304`, `Promise.all([receive, change])`), so peak in-flight is
~8, not the `concurrency: 4` you'd infer from `account.ts` alone.

## 5. The plan (recommended order)

### Stage 1 — v1.1.1 hotfix: stop the self-DoS. Ship together.

- **(a) Exponential backoff + jitter** on self-heal rescans: 30 s → 1 m → 2 m → …
  cap ~8 m. A manual "Try again" is always instant. Any success resets the ladder.
- **(b) Scan cache survives across runs**: in-memory (NOT persisted to disk —
  see §7), per network, short TTL (~90–120 s), **invalidated on any change signal**
  (poll detects movement, a broadcast happens, network switch, lock). Effect: a run
  cut at 25/40 resumes and pays only the remaining 15. **The scan converges across
  attempts instead of restarting forever.** This is the heart of the fix.
- **(c) Remove the api-layer retry for discovery GETs** (`api.ts:318`). The
  run-level self-heal *is* the retry. Keep broadcast's no-retry behavior as-is.
- **(d) De-duplicate the price/fees fetch** per cycle.
- **(e) Fix `Home.tsx:43`**: derive `isEmpty` from `account !== null` (+ the sat
  totals), not from `accountStatus === 'ready'`, so a background refresh stops
  swapping the layout. One-liner.
- **(f) Back off the error state too**: `accountError` must not leave a 30 s
  hammer running behind the banner.

### Stage 2 — pace a single run (cheap once 1b exists)

Concurrency 4 → 2, plus ~200 ms jittered delay between waves, spreading the 40
requests over ~10 s so the pattern stops looking like a burst. Only safe **with**
1(b): a slower run cut by the deadline must resume, not restart.

### Stage 3 — v1.1.2 fast-follow: second chain source (needs owner sign-off)

Add `blockstream.info` as an Esplora-compatible **failover** (already a planned
v1.2 roadmap item; today's evidence justifies pulling it forward). Verified:
identical response shape (`chain_stats` / `mempool_stats`, same field names), so
the F2 ingest validators transfer unchanged. Requires a CSP `connect-src` addition
in `vite.config.ts`.

**Trust-model cost (owner decides):** a second party sees your addresses, and
becomes a second party that could lie. Failover-only (not cross-check, not
round-robin) keeps that minimal. F15 already treats the chain API as hostile for
the one non-derivable field (the bump recipient).

> ⚠️ **Do not ship Stage 3 before Stage 1.** Without the loop fix, the fallback
> just gets *both* providers throttled.

## 6. Acceptance criteria

- Empty-wallet full run = **exactly 40 requests**; a *resumed* run costs only the
  remainder; the cheap poll stays at **2 requests**. Pin these counts in tests
  (`src/__tests__/discovery.test.ts` already pins request counts — follow that
  pattern).
- A stalled run does not cause a second run within the backoff window.
- With the network wedged, offered load decays instead of growing.
- The F12 cue still shows while (and only while) a snapshot is incomplete.
- Home no longer swaps layout during a background refresh.
- `tsc --noEmit` clean, full suite green (233 tests today), `npm run build` clean.

## 7. Correctness landmines — must be tested

- **Cross-run cache staleness (the big one).** A cached "unused" response could
  hide a payment that arrived within the TTL — and worse, a poll-detected change
  followed by a *cached* rescan would **un-detect** it. The invalidation rule is
  load-bearing: any change signal nukes the cache. Test explicitly: poll flags a
  tip as used → the next run must fetch that address fresh and see the funds.
  `pollAccount` calls `getAddressStats` directly (uncached) — **keep it that way.**
- **Never persist the cache** (or "never-used"/"confirmed empty" proofs) to disk
  or across sessions. See the rejected option in §8.
- **F12 stays intact:** phase 2 still *evaluates* every index from 0 — only
  response reuse changes. `complete = true` may only ever come from a full gap-20
  evaluation. Keep the round-5 regression test (a stale/ahead high-water mark must
  never hide funds).
- **F13:** key the cache per network. An aborted run's landed responses must never
  leak across a network switch.
- **Backoff honesty:** while backed off with an incomplete snapshot, the cue must
  stay visible — never present an incomplete balance as settled.

## 8. Do NOT

- **Do not** memoize "this wallet is confirmed empty" or persist per-address
  never-used facts. **Rejected on correctness:** the cheap poll only watches used
  addresses + the two tips, so a memoized empty-proof would hide a payment to any
  deeper gap-band address (hand out an address → close the app → get paid later).
  It's also unnecessary: after *one* successful full scan, steady state is already
  2 requests / 30 s. Fixing 1(b) is how you reach that state.
- **Do not** lower `FULL_GAP_LIMIT` below 20 (F8 — breaks restore parity with
  other wallets).
- **Do not** start phase 2 at the high-water mark (F12 exists because of exactly
  this).
- **Do not** add retries, longer timeouts, or a bigger deadline as *the* fix —
  every one increases offered load against a stall-throttler.
- **Do not** migrate to mempool.space's WebSocket API in a hotfix.
- **Do not** ship the blockstream fallback before the loop fix.
- **Do not** test against mempool.space from the owner's home IP while it is
  black-holed. Use mocked APIs in tests; use `blockstream.info` for shape checks;
  single, spaced requests only if you must touch the live API at all.

## 9. Process rules for this repo (non-negotiable)

- **No new npm dependencies** without the owner's explicit sign-off. (A new *API
  endpoint* is not a dependency, but IS a trust-model change requiring review.)
- Any change touching **signing, fees, the vault, or API ingestion** gets a Fable
  security review round appended to `docs/review/round1.md`, continuing the
  F-numbering. **Next finding number: F16.** This work touches API ingestion and
  the burst-sensitive discovery layer → **a review round is required.**
- **Pushing `main` deploys** (GitHub Pages via Actions; CI gates on tsc + vitest +
  build). Don't push mid-review. Use a feature branch for anything unreviewed.
- If `public/sw.js` behavior changes, **bump `CACHE_NAME`** (round-7 requirement).
- Verify hands-on before shipping, not just by test suite.

## 10. Current state at handoff

- `main` is clean, deployed, and healthy: **233 tests green**, 8 audit rounds,
  findings **F1–F15 all closed**. Live at
  https://scottm992.github.io/simple-bitcoin-wallet/
- Shipped 2026-07-09: PWA packaging (round 7), RBF Speed-up (round 8), passkey
  copy change (display-only, no round).
- This bug is **not** a regression from those — it predates them.
- Owner's home IP is currently black-holed by mempool.space; the phone works on
  cellular. The penalty decays on mempool.space's schedule, not ours.
