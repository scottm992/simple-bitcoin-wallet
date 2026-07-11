# PM Handoff — Simple Bitcoin Wallet

Written 2026-07-10 at the end of a thirteen-ship day (v1.1.1 → v1.3.0), by the
outgoing PM for the next one. This is the operational playbook + current state.
Read it with the project memory (auto-loaded), then `ROADMAP.md`, then skim
`docs/ENGINE.md` and the tail of `docs/review/round1.md`. Everything here was
true at commit `91cb418` (v1.3.0).

---

## 1. What this is

A live, shipped, 100% client-side Bitcoin wallet handling real money — treat
every change accordingly. Owner: Scott (the only known user; his wallet is
usually $0 while testing). Live at
https://scottm992.github.io/simple-bitcoin-wallet/ (GitHub Pages,
auto-deploys from `main` via Actions; CI gates on tsc + vitest + build).
Repo: scottm992/simple-bitcoin-wallet; local clone is this folder.

Current state: **v1.3.0, 347 tests, 19 security-review rounds, F1–F24 closed,
F25/F26/F27 open Info items (on ROADMAP). Next finding number: F28. Next
round number: 20.**

## 2. The process (non-negotiable, all owner-established)

- **Every change ships through:** feature branch → build → PM verification
  (gates + line-by-line diff review + hands-on where the browser can exercise
  it) → Fable security round appended to `docs/review/round1.md` (continuing
  the F-numbering and the house verdict format: "SHIP-BLOCKING ISSUES: N /
  new findings: M", per-area evidence, findings with SEV/Where/Scenario/Fix,
  throwaway `.review.test.*` files executed then DELETED) → findings fixed
  pre-merge + closure stanza → merge `--no-ff` to main → version bump chore
  (`APP_VERSION` in Settings.tsx) → push (this deploys) → watch the Actions
  run (`gh run watch`) → verify the live bundle hash changed → ROADMAP +
  memory updates → memory backup sweep
  (`powershell -File C:\Users\scott\claude-memory\backup-memory.ps1`) →
  Telegram ping to Scott.
- **Round weight:** full round for anything touching signing, fees, vault,
  API ingestion, or discovery-layer semantics; light round for display-only
  changes (still real: rounds 10/16/17/18 each caught or proved something).
  PM-authored one-liners are allowed (owner policy) but the reviewer must
  independently re-check them — the fix author is never the only checker.
- **Nothing unreviewed on main.** Pushing main deploys. Docs-only pushes are
  fine (deploy is a no-op rebuild).
- **No new npm dependencies without Scott's explicit sign-off.** The bar is
  tiny/audited/zero-dep or nothing. The app has six deps total; keep it so.
- **Commit trailer:** every commit ends with
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **If `public/sw.js` behavior changes, bump `CACHE_NAME`** (round 7 rule).

## 3. The team model

- Delegate coding to **Opus subagents**, security review to **Fable
  subagents**; the PM verifies everything hands-on before ship.
- **Rotation:** ~500k cumulative subagent tokens is a guideline; ~600k is
  Scott's comfort ceiling; ~1000k hard. `subagent_tokens` in completion
  notifications is PER-RUN — sum them yourself. Route fixes to the agent with
  the best file coverage; resume beats respawn until the ceiling nears.
- Reviewers: fresh per round; resume the same reviewer for its closure
  re-check (it re-runs its own probes — cheap and exacting).
- Agents building in parallel with the main checkout must use worktrees
  (`isolation: "worktree"`); `.claude/worktrees/` is gitignored. Merged-branch
  cleanup: worktree dirs can be file-locked by OneDrive — `git worktree
  prune` later; never `git add -A` blindly (a worktree gitlink once snuck
  into the index).

## 4. Verification toolkit (hard-won today)

- **Browser pane:** `preview_start {name:"dev"}` (launch.json exists, port
  5173) returns a `tabId`; drive with `javascript_tool`/`get_page_text`/
  `read_page`. The screenshot rasterizer can wedge pane-wide (timeouts) while
  the DOM/JS tools keep working — verify via DOM + computed styles when that
  happens.
- **Network stub recipe:** override `window.fetch` in the page BEFORE
  unlocking (a reload locks the wallet and wipes the stub — memory-only keys
  by design). Serve canned Esplora shapes; see the shapes in
  `src/lib/api.ts`'s validators. The preview browser's vault was WIPED during
  v1.3.0 testing — restore one with the public test seed
  (`abandon ×11 + about`) when needed.
- **Hidden-tab timer clamping:** background tabs clamp `setTimeout` to ~1s —
  it stretches the app's pacing AND any stub delays. It once faked a
  scan-stall (burned an hour); it also makes a perfect slow-network
  simulator when used deliberately.
- **Live engine runs:** `npx vite-node <script.ts>` imports `src/lib/*`
  directly — used to run real discovery against live blockstream with a
  throwaway seed (40 requests, delete the script after).
- **PowerShell traps:** NEVER put double-quote characters inside a `git -m`
  here-string (silently mangles args — verify every commit with `git log`);
  `>` redirection writes UTF-16 (use `cmd /c "... > file"` for byte-faithful
  output); `Set-Content` after `-Raw` reads can mojibake Unicode (the Edit
  tool is safer for source files).
- **Wipe/storage verification:** enumerate localStorage keys explicitly —
  an "it's gone" observation is vacuous if the key never existed (round-19
  lesson, recorded at my expense).

## 5. Architecture invariants (the F-lessons digest — details in round1.md)

- **F1/F10:** fee hard caps (500 sat/vB, 1M sats) non-overridable; 25% rule
  is informed-consent only. Custom-rate floor `MIN_CUSTOM_FEE_RATE = 0.1`
  (Send.tsx) is the single sub-1 relaxation point; tiers clamp ≥1.
- **F11:** ONE fee path — everything flows through `estimateSendFee`; tier
  and custom rates converge on one `feeRate` value (Send.tsx ~L159).
- **F12:** discovery runs settle deterministically (12s inactivity cutoff +
  120s hard cap); `complete=true` only from a full gap-20 evaluation; phase 2
  always evaluates from index 0; the "checking" cue is honest.
- **F15/F19:** never trust the API for a derivable fact — bump recipients
  verify against the local send log; `built.txid` keys everything, never the
  relay's echo.
- **F16:** cache invalidation is generation-fenced, never merely
  abort-paired. **F17:** pace only waves that hit the network. **F18:**
  quick-retry privilege is budgeted (5 between complete snapshots).
- **§7/§8 of `docs/HANDOFF-discovery-throttle.md` still bind** all
  discovery work (in-memory-only cache, poll stays uncached, no persisted
  emptiness proofs...). Read it before touching discovery.
- **F21:** rate-derived previews go DARK with no usable rate — never a
  fabricated number. **F22/F27 family:** copy must never overclaim (recency,
  status, causes).
- **F23/F24:** wallet removal takes the send log; boot and wipe both survive
  a corrupt vault (the app must always reach Unlock, whose forgot sheet is
  the rescue).
- Providers: chain data = blockstream.info (`chainApiBaseUrl`); fees + USD
  price = mempool.space (`apiBaseUrl`) — mempool.space never sees addresses.
  429s on discovery GETs pause-in-run (12s, max 3). mempool.space's 2026-07-09
  TCP-stall behavior decayed into plain 429s by 07-10 (probed) — keep the
  stall defenses anyway.

## 6. Open work, in the owner's likely priority order

1. **QR scanning on Send** — blocked on a dependency decision. First step is
   a supply-chain survey of QR-decode candidates (size, deps, maintenance,
   license, vendorability) for Scott to approve BEFORE any code. He's aware.
2. **F26 + F27 bundle** (vault-surface copy/gating): warn before
   create-over-vault from Welcome; discriminate `VaultCorruptError` on unlock
   and steer to the forgot sheet. Small; one round covers both.
3. **Chain-data failover** (blockstream ↔ mempool.space) — the resilience
   completion of v1.2.0. Full round.
4. **Hide-balance mode** — tiny. **Password estimator** — needs dep sign-off.
5. F25 (OS passkey credential outlives the wallet) — accepted Info; revisit
   if passkey UX gets touched.
6. v2 shelf (only if real users): watch-only export, tx notes, translations,
   faucet helper.

## 7. Working with Scott

- **Telegram** (`mcp__telegram__send_message`, default chat) for milestone
  pings and blocking decisions — not routine progress. One-way: he cannot
  reply there; he answers in-session.
- He field-tests on his phone promptly and his reports are precise gold —
  three of today's ships came straight from them. When a report contradicts
  your model, believe the report and instrument until the model fits
  (today's probe-before-rebuild pivot came from exactly that).
- He delegates design decisions but overrides crisply (the 0.1 sat/vB floor;
  "hold off on blockstream" then reversing on evidence). Present decisions
  with reasoning + a recommendation; accept the override without relitigating.
- Budget-aware: he raised limits mid-day once; park cleanly and resume if an
  agent dies on a spend limit (SendMessage to the same agent id resumes with
  context).
- Memory backups: run the sweep script after meaningful memory changes at
  natural wrap points (he pre-approves batching it to end-of-work).

## 8. State of the tree at handoff

- `main` = `91cb418`, pushed, deployed, live bundle verified. Working tree
  clean. All feature branches merged (safe to delete locally).
- Test count 347 across 39 files; every suite green; `tsc --noEmit` and
  `npm run build` clean.
- `docs/review/round1.md` carries all 19 rounds + closures. ROADMAP.md is
  current. Memory (auto-loaded) is the compact source of truth; this doc is
  the playbook.
