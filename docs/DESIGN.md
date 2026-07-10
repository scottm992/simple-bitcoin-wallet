# Simple Bitcoin Wallet — Design Spec

The single source of truth for the UI programmer. Everything a beginner sees —
every button, heading, warning, error, empty state, and success message — is
written out verbatim here. Copy is plain English, warm, and free of jargon.

Target user: someone who has never owned bitcoin. They are not stupid — they are
new. We never talk down to them, and we never assume they know a word like
"seed", "gas", "UTXO", or "confirmation". Where a plain-English phrase exists, we
use it.

> **Status (2026-07-09):** this is the original v1.0 spec, kept for rationale,
> copy voice, and design tokens. The shipped app has moved past it in places —
> the security audit (`docs/review/round1.md`, F1–F13) added UI this spec does
> not describe (the high-fee consent notice on Send, the "Checking for
> updates…" balance cue, the plain-English Face ID explainer sheet), and a few
> details below were corrected to match the shipped app. Where this document
> and the app disagree, **the code and `src/strings.ts` are the truth.**

---

## 1. Design principles

1. **One thing per screen.** Each screen asks for one decision or shows one
   result. A beginner is never asked to hold two ideas at once. If a screen has
   two jobs, it becomes two screens.

2. **Plain words, always.** No jargon a newcomer wouldn't know. "Recovery
   phrase", not "seed" (with "12 words" as the everyday shorthand). "Network
   fee", not "gas". "Confirmed", not "6 confirmations". When a technical term is
   unavoidable, we explain it inline in one short sentence.

3. **Safety you can feel, not fear you can't act on.** The scary truths —
   *these words are your money*, *sending can't be undone* — are stated plainly
   and calmly. We warn without frightening the user into quitting. Warnings are
   specific and always paired with what to do next.

4. **The review is sacred.** Before anything irreversible (sending money,
   deleting the wallet), there is a full-screen review the user must read and
   confirm. We would rather add a tap than let someone lose money to a typo.

5. **Big, obvious, thumb-friendly.** Mobile-first. Primary actions are large
   buttons at the bottom of the screen where a thumb rests. Nothing important
   hides behind a small tap target or a hover.

---

## 2. Naming conventions used in copy

To keep the whole app consistent, always use these exact terms in UI copy:

| Concept | Word we use | Never say |
| --- | --- | --- |
| BIP39 mnemonic | **Recovery Phrase** (or "your 12 words") | seed, mnemonic, keys |
| Private key material | (never surfaced) | private key |
| Receiving address | **your address** | public key, pubkey |
| Miner fee | **network fee** | gas, miner fee, sat/vByte |
| Confirmed on chain | **Confirmed** / **Waiting to confirm** | N confirmations, mempool |
| Testnet | **Practice mode** | testnet (except once, in a subtitle) |
| Mainnet | **Live mode** / (default, unlabeled) | mainnet |
| Password unlock | **password** | passphrase (that's a different thing) |
| WebAuthn credential | **passkey** ("unlock with a passkey"), with the gesture described generically: *your face, fingerprint, or PIN* | WebAuthn, PRF; **"Face ID"** or "Touch ID" as a universal label |

> **Naming change (2026-07-09, product owner):** this row previously said to use
> "Face ID" and never the word "passkey". Reversed: the app now names the passkey
> plainly and explains it as an alternative to typing your password. Two reasons —
> (a) "Face ID" was hardcoded for every device, so it was simply wrong on Android,
> Windows, or a fingerprint Mac; (b) naming the passkey tells the user what is
> actually being created. The original concern behind the old rule still stands and
> is still met: the word must be *explained before the operating system says it*
> (see the explainer sheet in `strings.passkey`), never dropped on the user cold.

---

## 3. Sats vs BTC — recommendation

**Recommendation: lead with USD as the hero number, show BTC as the secondary
"official" amount, and let the user tap the amount to cycle USD → BTC → sats.**
Default the secondary unit to **BTC**, not sats.

Rationale:

- **USD is the only number a true beginner already understands.** "$120.00" needs
  no explanation. It is the anchor that makes everything else make sense, so it is
  the big number on the home screen.
- **BTC is what the rest of the world quotes.** Exchanges, price tickers, friends,
  and news all speak in BTC. If we hid BTC, the user couldn't reconcile our app
  with anything else they see. So BTC is the honest "official" unit shown right
  under the USD.
- **Why not lead with sats?** Sats read as a friendly, countable whole number
  ("42,000 sats" beats "0.00042 BTC" for readability), and we *do* offer them.
  But sats are not what the outside world quotes, and a beginner who sees "42,000"
  in our app and "0.00042 BTC" on an exchange will think they hold different
  amounts. Leading with sats trades one confusion for another.
- **The compromise:** amounts are **tappable**. Tap the balance to cycle
  USD → BTC → sats. Curious users discover sats naturally; nobody is forced to
  learn them on day one. The chosen unit is remembered per session.
- **In the Send flow, amount entry defaults to USD** (type "$25"), because a
  beginner thinks in dollars when deciding how much to send. We convert to BTC
  live beneath the field so they learn the relationship without doing math.

Formatting rules:
- USD: `$1,234.56` — always 2 decimals, thousands separators, `$` prefix.
- BTC: `0.01234567 BTC` — always 8 decimals when it's the official amount;
  trailing zeros kept so the number never "changes length" and looks glitchy.
- Sats: `1,234,567 sats` — integer, thousands separators, lowercase "sats".
- A dust/zero balance shows `$0.00` and `0 sats`, never a blank.

---

## 4. Screen inventory

Minimal set. Thirteen screens; each justifies its existence.

| # | Screen | Exists because |
| --- | --- | --- |
| 0 | **Welcome** | First contact; choose create vs restore |
| 1 | **Your Recovery Phrase** (reveal) | The one moment we hand over the money |
| 2 | **Confirm your phrase** | Proof they actually wrote it down |
| 3 | **Set a password** | Lock the wallet on this device |
| 4 | **Home** | Balance + the two things you do (receive/send) |
| 5 | **Receive** | Show address + QR to get paid |
| 6 | **Send — amount & address** | Compose a payment |
| 7 | **Send — review** | The irreversible-action gate |
| 8 | **Send — sent** | Confirmation something happened |
| 9 | **Activity** (history) | "Did my money arrive / leave?" |
| 10 | **Settings** | Lock, show phrase, network, delete |
| 11 | **Unlock** | Return visit; password / Face ID |
| 12 | **Restore from phrase** | Bring an existing wallet to this device |

Modals/sheets (not full screens): copy toast, "show phrase" re-auth sheet, delete
confirmation sheet, network-switch confirmation sheet.

---

## 5. Global chrome

### Top bar
- Height 56px. Left: back chevron (`‹`) where a back action exists, else the app
  wordmark "Simple Bitcoin". Center: screen title (optional; many screens have
  their heading in the body instead). Right: contextual (Settings gear on Home).
- Back chevron touch target is the full 44×44 left corner.

### Practice-mode banner (testnet)
When Practice mode is on, a **persistent full-width banner** sits directly under
the top bar on *every* screen, and cannot be dismissed:

> **Practice mode — these coins are worthless.** You're testing safely. Nothing
> here is real money.

Banner uses the distinct `--testnet` orange background with dark text. In Live
mode the banner is absent entirely (no empty bar). The banner also changes the
app's accent from bitcoin-orange-adjacent to the testnet orange so the whole app
*feels* different — see tokens.

### Bottom action area
Primary buttons are pinned to the bottom of the screen with safe-area padding for
the iPhone home indicator.

---

## 6. Screen-by-screen spec

Notation: **H** = heading, **B** = body/subtext, **[Button]** = button label,
`field` = input placeholder, *(state)* = a state or note.

---

### Screen 0 — Welcome

Layout: centered logo/illustration top third; headline + one line of body in the
middle; two stacked buttons at the bottom.

- **H:** Bitcoin, made simple
- **B:** A wallet that lives on your phone. You're in control — no bank, no
  sign-up, no email.
- **[Create a new wallet]** (primary)
- **[I already have a recovery phrase]** (secondary / text button)
- Footer link: **How this keeps your money safe** → opens a short plain-English
  explainer sheet (optional, non-blocking).

Explainer sheet copy (if built):
> **You hold the keys**
> This wallet makes a set of 12 secret words that only you ever see. Those words
> control your bitcoin. We can't see them, reset them, or get them back for you —
> and neither can anyone else. That's what makes it truly yours. On the next
> screens we'll help you save those words somewhere safe.
> **[Got it]**

---

### Screen 1 — Your Recovery Phrase (the reveal)

This is the most important screen in the app. It must make a beginner *understand*
that the 12 words ARE the money, without scaring them away.

Layout, in order:
1. Heading + short body.
2. A **blurred** phrase card with a "Tap to reveal" overlay (prevents shoulder-
   surfing and forces a deliberate moment).
3. Once revealed: the 12 words as numbered chips in a 2-column grid.
4. A calm "why this matters" callout.
5. A **[Copy]** option (with a warning) and the primary continue button.

Copy:

- **H:** These 12 words are your wallet
- **B:** Write them down in order and keep them somewhere safe and private. Anyone
  who has these words can take your bitcoin — and if you lose them, no one can get
  your bitcoin back. Not even us.

*(blurred state overlay):*
- **[Tap to reveal your words]**
- small note: Make sure no one is watching your screen.

*(revealed state — the callout below the words):*
> **Why we can't help you if these are lost**
> This wallet has no company account behind it. These 12 words are the only key.
> That's the trade for being truly in control: no one can freeze your money, and
> no one can recover it for you. So the words matter.

Actions:
- **[Copy the words]** (secondary). On tap, show toast: *Copied. Paste them into
  your password manager or notes, then delete once you've written them on paper.*
- **[I've written them down]** (primary; disabled until the phrase has been
  revealed at least once).

*(If user taps back / tries to leave):* sheet —
- **H:** Leave without saving your words?
- **B:** If you haven't written these 12 words down, you could lose access to your
  wallet. We'll show you a fresh set next time.
- **[Keep setting up]** (primary) / **[Leave anyway]** (text)

---

### Screen 2 — Confirm your phrase

Confirm pattern (per the brief): **tap 3 requested words, in order, from a
shuffled set.** This proves they wrote the words down without the tedium of
re-entering all 12.

How it works:
- We ask for three specific positions, one at a time (e.g. word #3, then #7, then
  #11 — positions chosen at random per wallet).
- Below the prompt, a shuffled grid of word chips (the correct answer plus
  believable decoys drawn from the user's own phrase and the BIP39 list).
- Tapping the right word advances to the next prompt. A progress dots row (● ● ○)
  shows 1 of 3, 2 of 3, 3 of 3.

Copy:

- **H:** Let's make sure you saved them
- **B:** Tap the words in the right spots. This checks that your written copy is
  correct.
- Prompt line (updates each step): **What's word number 3?**
- Progress: `Step 1 of 3`

*(correct tap):* the chip animates into the slot; advance. No modal.

*(wrong tap):* inline, gentle —
- The tapped chip shakes and shows: **That's not word 3. Check your written list
  and try again.** (No lockout; unlimited tries.)

*(all 3 correct):*
- Auto-advance to Set a password. Brief inline confirmation: **Nice — your backup
  works.**

*(escape hatch — "I need to see the words again"):* a small text link:
**[Show my words again]** → returns to Screen 1 (revealed), then back. We never
punish someone for double-checking.

---

### Screen 3 — Set a password

Layout: heading + body; one password field; one confirm field; strength hint;
optional Face ID toggle (only shown on supported devices); primary button.

Copy:

- **H:** Create a password
- **B:** You'll use this to unlock the wallet on this phone. It protects your
  wallet if someone else gets your device. It's separate from your 12 words.
- `Password` (field, obscured, with a show/hide eye)
- `Confirm password` (field, obscured)
- Strength hint (live, under the first field): a 5-band strength meter
  (F3 — see `src/password.ts`). Empty state: **Use at least 10 characters. A few
  words strung together is easiest to remember.**
- *(passkey supported):* toggle row —
  **Unlock with a passkey** — Skip typing your password next time — use your
  face, fingerprint, or device PIN. *(subtext)*. Turning it on first shows the
  plain-English explainer sheet (`strings.passkey`), which names the passkey and
  says the password still works, *before* the operating system's own prompt.
  **A password is always required**: the passkey is additive (a second,
  independent ciphertext of the seed), never a replacement — so "next time" in
  the subtext is load-bearing copy, not filler.
- **[Set password]** (primary; disabled until both fields match and the
  password passes the meter: ≥ 10 characters and not a well-known common
  password — F3)

Important clarifying line (small, under the button):
> Your password only unlocks this app on this phone. It can't recover your wallet
> — only your 12 words can do that.

Errors:
- Fields don't match: **These don't match yet.** (inline under confirm field)
- Too short: **A little longer, please — at least 10 characters.**

---

### Screen 4 — Home

The screen users see most. Balance first, then the two verbs.

Layout:
1. Top bar: wordmark left, **Settings gear** right.
2. (Practice banner if applicable.)
3. **Balance block**, centered:
   - Big USD number (hero).
   - BTC amount under it, muted.
   - The whole balance is **tappable** to cycle USD → BTC → sats. A tiny hint
     `tap to switch` shows on first visit only.
4. Two big buttons side by side: **Receive** and **Send**.
5. **Recent activity** preview: up to 3 latest items, then **[See all]**.

Copy:

- Balance label (small, above number): **Your balance**
- Hero: `$120.00`  ·  under it: `0.00189 BTC`
- **[Receive]** (with down-left arrow icon) — get paid
- **[Send]** (with up-right arrow icon) — pay someone
- Recent activity header: **Recent activity**
- **[See all]** → Activity screen

*(empty balance state):*
- Hero shows `$0.00` / `0 sats`.
- A friendly nudge card under the buttons:
  - **H:** Your wallet is empty — let's fix that
  - **B:** Tap **Receive** to show your address, then have someone send you
    bitcoin. Even a tiny amount is a great first test.

*(empty activity state):*
- **Nothing here yet.** Your payments will show up here once you send or receive.

*(price unavailable — offline):* USD shows `$— · price unavailable`, BTC still
shows. No blocking error.

---

### Screen 5 — Receive

Layout: heading; big QR code; address shown in chunked, readable groups; copy +
share buttons; a plain-English note.

Copy:

- **H:** Receive bitcoin
- **B:** Show this QR code, or share your address. Whoever's paying you scans or
  pastes it.
- QR code: large, centered, with your address encoded.
- Address, displayed in **4-character groups** across lines, in a monospace font,
  e.g. `bc1q · x9k2 · 8fj3 · … · q7z0`. Tapping the address copies it.
- **[Copy address]** (primary) → toast: **Address copied.**
- **[Share]** (secondary; uses the OS share sheet on mobile).
- Note (muted):
  > It's safe to share this address. It can only be used to *send you* money — no
  one can take anything with it. You can reuse it, or tap refresh for a new one.
- **[Show a new address]** (small text link) — for the privacy-curious; optional.

*(Practice mode):* the address note gains a line: **This is a practice address.
Only worthless practice coins work here.**

---

### Screen 6 — Send (amount & address)

One screen to compose; the *review* is where safety lives.

Layout:
1. **To** — address field with a **Paste** button. *(The originally spec'd
   **Scan QR** button was not built for v1.0 — Send is paste-only today; camera
   scanning is a v1.1 roadmap item.)*
2. **Amount** — big amount field defaulting to USD entry; live BTC conversion
   under it; a **Max** button.
3. **Network fee** — a simple three-choice selector (not sat/vByte).
4. Running total preview.
5. **[Review]** primary button (never "Send" — sending only happens after review).

Copy:

- **H:** Send bitcoin
- **To** label: **Send to**
  - `Paste an address` (field placeholder)
  - **[Paste]** button inside/next to the field *(no **[Scan]** in v1.0 —
    see note above)*
  - On valid address: a green check + **Address looks valid.**
- **Amount** label: **Amount**
  - Field shows `$0.00` and accepts USD by default; a small **BTC/USD** switch
    toggles entry unit.
  - Under field, live: `≈ 0.00039 BTC` (or `≈ $25.00` if entering BTC)
  - **[Max]** (small) — sends the whole spendable balance minus the fee.
- **Network fee** label: **Network fee** — with one-line explainer:
  *A small amount goes to the bitcoin network to process your payment.*
  - Three chips:
    - **Standard** — arrives in ~30 min · `≈ $0.40`
    - **Faster** — arrives in ~10 min · `≈ $0.90`
    - **Economy** — may take a few hours · `≈ $0.15`
  - Default selected: **Standard**.
- Total preview row (muted): **You'll send $25.00 + $0.40 fee = $25.40 total**
- **[Review]** (primary)

Inline errors on this screen (before review):
- Empty address: **[Review]** stays disabled; helper: **Add an address to
  continue.**
- Malformed address: **That doesn't look like a bitcoin address. Check for a typo,
  or paste it again.**
- Wrong-network address (mainnet address while in Practice mode, or vice-versa):
  **This address is for {Live/Practice} bitcoin, but you're in {Practice/Live}
  mode. Switch modes or use a different address.**
- Amount is 0 / empty: helper **Enter an amount to continue.**
- Amount over balance: **That's more than you have. You can send up to $118.60.**
  (also offer **[Send max]**)
- Amount below dust minimum: **That's too small to send. Try at least $0.50.**

---

### Screen 7 — Send review (the gate)

Full-screen. The user cannot send without passing through this. Designed so a
mistyped address or wrong amount is nearly impossible to miss.

Layout, top to bottom:
1. **H:** Check this before you send
2. **Amount block** — big: `$25.00` and under it `0.00039 BTC`.
3. **To block** — the destination address in **chunked groups of 4**, large
   monospace, wrapping across lines so every character is legible. Label:
   **Going to this address**. A **[Copy]** to let them cross-check against their
   source.
4. **Fee row:** **Network fee** — `$0.40 · arrives in ~30 min`
5. **Total row (emphasized):** **Total leaving your wallet** — `$25.40`
   (`0.00040 BTC`)
6. **Irreversibility line** (cannot be turned off), in a bordered warning strip:
   > **Sending bitcoin cannot be undone.** If the address is wrong, your money is
   > gone for good. Take a moment to compare the address above with the one you
   > were given.
7. **Slide to send** control **or** a large **[Send now]** primary button that
   requires a deliberate press (see component notes — we recommend the button plus
   a required checkbox on mainnet).
   - Above the button, on Live mode only, a checkbox: **☐ I've checked the
     address.** ([Send now] enabled only when checked.)
8. **[Go back and edit]** (secondary/text) — always available.

*(Practice mode):* the irreversibility strip is softened to:
> This is practice mode, so nothing real is at stake — but on a real wallet,
> sending can't be undone. Get in the habit of checking the address.

Copy summary of the exact required safety line (verbatim, Live mode):
**"Sending bitcoin cannot be undone. If the address is wrong, your money is gone
for good. Take a moment to compare the address above with the one you were
given."**

---

### Screen 8 — Send sent (success)

Layout: centered success mark; headline; what happens next; done button.

Copy:

- **H:** On its way
- **B:** You sent **$25.00** (0.00039 BTC). It usually lands in about 30 minutes.
  You can watch its progress in Activity.
- **[Done]** (primary) → returns to Home
- **[View in Activity]** (text link)

*(note under body, muted):* Bitcoin is still processing your payment. It's normal
for it to say "Waiting to confirm" for a little while.

---

### Screen 9 — Activity (history)

A simple list. No dense tables, no hashes front-and-center.

Layout: heading; grouped list by date ("Today", "Yesterday", "March 3");
each row = direction icon + plain label + amount + status.

Row anatomy:
- **Received** — green down-left arrow — `+$25.00` — *Confirmed*
- **Sent** — arrow up-right — `-$25.40` — *Confirmed* / *Waiting to confirm*
- Secondary line per row: relative time, e.g. *2 hours ago*.

Copy:
- **H:** Activity
- Status words: **Confirmed** / **Waiting to confirm** / **Failed**
- Tapping a row opens a **detail sheet**:
  - Amount (USD + BTC), direction, status, date/time.
  - **Network fee** (for sends).
  - The other party's address (chunked).
  - **[View on the block explorer]** (text link — opens mempool.space in a new
    tab; labeled plainly, not "mempool").
  - A one-liner explaining status:
    - Waiting: *The bitcoin network is still processing this. No action needed —
      it'll confirm on its own.*
    - Confirmed: *This payment is complete and permanent.*

*(empty state):* **Nothing here yet.** Your payments will show up here once you
send or receive.

*(load error):* **Couldn't load your activity. Check your connection and pull to
refresh.**

#### Speed up a stuck payment (added v1.1)

> Post-v1.0 addition (per the status note at the top of this file): not in the
> original v1.0 spec. It lives entirely inside the Activity detail sheet; the
> code and `src/strings.ts` (`speedUp` group) are the truth.

When a payment you **sent** is still **Waiting to confirm**, its detail sheet
gains a **[Speed up this payment]** button — a plain-English wrapper over an
opt-in Replace-By-Fee fee bump (the word "RBF" never appears). It is shown only
for pending, outgoing items — never for received or already-confirmed ones.

- **Entry point → loading.** Tapping it does one network look-up of the pending
  payment (busy label: *Checking…*), then the sheet becomes an offer or an
  honest dead-end.
- **Offer.** First, the destination (F15): **Going to this address** — the
  recipient address, chunked exactly like the Send review — and **Amount being
  sent** (what the replacement will pay them). The wallet has already verified
  both against its own local record of the original send (see below), but the
  sheet still shows them: review is sacred, and a fee-only sheet would hide
  where the money goes. Then three rows — **Fee paid so far**, **New fee**,
  **Extra cost** (USD hero, sats beneath) — showing the *effective* numbers the
  build will use. The new fee comes from the current **Faster** fee estimate;
  the network may raise it to the minimum a replacement is allowed to pay, and
  we display that raised figure, never our own arithmetic. Primary: **[Speed
  up — pay {extra} more]**; text: **[Not now]**.
  - *Full-balance send (a sweep, so the fee must come out of the amount sent):* a
    warning strip — *"…whoever you're paying will receive {X} less."* — gated
    behind a required checkbox (**I understand they'll receive less.**), the same
    deliberate treatment as the Live-mode Send review.
  - *Fee is a big share of the payment (the 25% rule):* the same informed-consent
    treatment as Send (F10) — the real numbers plus a required acknowledgment
    before the bump is allowed (which sets `allowHighFee`).
- **Dead-ends** (no action, a single **[Close]**, always honest — the original
  payment still goes through, it may just be slow): already-confirmed; sent
  before speed-up existed; nothing left over to raise the fee from; a shape we
  can't bump; or a fee that would exceed the wallet's hard safety ceiling
  (no-recovery copy consistent with Review's hard-block state). Two more from
  the F15 verification: *"Something doesn't match on this payment's details…"*
  when the network's description of the payment disagrees with the wallet's own
  record of it (a possible attack — calm but firm, no override anywhere), and
  *"This payment was made before this wallet was set up on this device…"* when
  there is no local record to verify against (a wallet restored from its 12
  words — send records don't travel with the seed).
- **Network hiccup (while checking, or broadcasting).** A non-destructive sheet —
  *your bitcoin is safe, nothing was sent* — with **[Try again]**, mirroring
  Send's broadcast-failure pattern.
- **Success.** *On its way — we gave your payment a boost.* We keep this
  confirmation on screen (rather than snapping the sheet shut) and refresh the
  account underneath, so the moment the old payment is replaced by a new one (a
  fresh id) never flashes a scary "it vanished" state. Dismissing with **[Done]**
  returns to the refreshed Activity list.

Double-submission is prevented with the Review screen's synchronous busy-flag:
the confirm button is disabled and shows *Speeding up…* the instant it is
tapped, so a second tap can't fire a second bump.

---

### Screen 10 — Settings

A short list. Grouped.

Copy (rows top to bottom):

**Security**
- **Lock wallet now** → returns to Unlock screen immediately.
- **Show my recovery phrase** → requires password re-entry (see re-auth sheet).
- **Change password** (optional; nice-to-have).

**Network**
- **Practice mode** — toggle. Subtext: *Test with worthless coins. Turn this on to
  learn without risking real money.*
  - Flipping it opens the network-switch confirmation sheet (below).

**This device**
- **Remove wallet from this phone** (styled as a destructive/red row) → delete
  confirmation sheet.

**About**
- **How this wallet keeps your money safe** → the explainer sheet.
- Version number, small and muted.

Network-switch confirmation sheet:
- **H:** Switch to Practice mode? *(or "Switch to Live mode?")*
- **B (to practice):** In Practice mode you'll see a different, practice-only
  wallet. Your real balance is safe and untouched — it comes back the moment you
  switch off Practice mode.
- **B (to live):** You're switching to real bitcoin. Real money, real
  transactions. Double-check every address before you send.
- **[Switch]** (primary) / **[Cancel]** (text)

---

### Screen 11 — Unlock (returning user)

Layout: app mark; single password field (or Face ID prompt first, if enabled);
unlock button; small recovery link.

Copy:
- **H:** Welcome back
- *(passkey enabled):* auto-prompt the passkey on open; the password field stays
  visible, and a manual retry button reads **[Unlock with a passkey]**. A failed
  or cancelled attempt falls back silently — no error copy.
- `Password` (field)
- **[Unlock]** (primary)
- **[Forgot password?]** (text link) → sheet:
  - **H:** Passwords can't be reset
  - **B:** Your password only unlocks this phone, so there's nothing to reset. If
    you can't get in, you can set the wallet up again from scratch using your 12
    words. Removing and restoring won't lose any bitcoin — your money lives on the
    bitcoin network, not in this app.
  - **[Restore with my 12 words]** / **[Try password again]**

Errors:
- Wrong password: **That password isn't right. Try again.** (After several tries,
  keep it calm — no threatening lockout copy; add a growing delay silently if
  desired.)

---

### Screen 12 — Restore from phrase

Layout: heading; body; a 12-word entry area (numbered fields with autocomplete
from the BIP39 word list); paste-all support; continue button. Then it flows into
**Set a password** (Screen 3) for this device.

Copy:
- **H:** Restore your wallet
- **B:** Enter your 12 words in order. As you type each one, we'll suggest the
  full word — tap it to fill in.
- 12 numbered inputs (or one paste box that splits into 12).
- **[Paste all 12]** (secondary) — accepts a space-separated phrase.
- Live validation per word: unknown words are flagged **Not a valid word — check
  the spelling.**
- **[Restore wallet]** (primary; enabled only when all 12 are valid BIP39 words).

Errors:
- Checksum fails (12 valid words but not a real phrase): **These 12 words don't
  add up to a valid recovery phrase. Check the order and spelling — even one word
  in the wrong place will do this.**
- Empty: button disabled with helper **Enter all 12 words to continue.**

Success: proceeds to Set a password → Home, balance loads.

---

## 7. User flows (step lists)

### A. First-time create
1. Welcome → **[Create a new wallet]**.
2. Your Recovery Phrase → tap to reveal → read callout → **[I've written them
   down]**.
3. Confirm your phrase → tap word #a, #b, #c correctly → auto-advance.
4. Set a password → enter + confirm → (optional enable Face ID) → **[Set
   password]**.
5. Home appears with $0.00 balance and the "let's fix that" nudge.

### B. Restore from seed
1. Welcome → **[I already have a recovery phrase]**.
2. Restore your wallet → enter/paste 12 words (autocomplete) → **[Restore
   wallet]**.
3. Set a password (for this device) → **[Set password]**.
4. Home appears; balance and activity load from the network.
- *Error path — bad word:* flagged inline; button stays disabled.
- *Error path — bad checksum:* full message on submit; user fixes order/spelling.

### C. Unlock (returning)
1. Open app → Unlock screen.
2. Face ID auto-prompt (if on) → success → Home. *Or* type password →
   **[Unlock]** → Home.
- *Error path — wrong password:* inline "That password isn't right. Try again."
- *Error path — forgot:* **[Forgot password?]** → explains reset isn't possible →
  offer restore.

### D. Receive
1. Home → **[Receive]**.
2. Receive screen shows QR + chunked address.
3. **[Copy address]** (toast) or **[Share]** or let them scan the QR.
4. Money arrives → appears in Activity as **Received · Waiting to confirm** →
   later **Confirmed**; Home balance updates.

### E. Send (happy path)
1. Home → **[Send]**.
2. Send screen: **[Paste]** address (green "Address looks valid") → enter amount
   in USD (live BTC shown) → pick **Standard** fee → **[Review]**.
3. Send review: read amount, chunked address, fee, total, irreversibility line →
   (Live mode) tick **I've checked the address** → **[Send now]**.
4. Send sent → **[Done]** → Home. Activity shows **Sent · Waiting to confirm**.

### F. Send — error paths
- **Bad / mistyped address:** on the compose screen, "That doesn't look like a
  bitcoin address. Check for a typo, or paste it again." **[Review]** disabled.
- **Wrong network address:** "This address is for Live bitcoin, but you're in
  Practice mode. Switch modes or use a different address."
- **Insufficient funds:** "That's more than you have. You can send up to $118.60."
  with **[Send max]** offered.
- **Amount too small (dust):** "That's too small to send. Try at least $0.50."
- **Network error at send time** (broadcast fails): after tapping **[Send now]**,
  show a non-destructive error sheet:
  - **H:** We couldn't send that just now
  - **B:** Your bitcoin is safe and still in your wallet — nothing was sent. This
    is usually a connection problem. Check your internet and try again.
  - **[Try again]** (primary) / **[Go back]**
  - *(Guarantee: we never leave the user unsure whether money left. If broadcast
    is unconfirmed, we say money did NOT leave and prompt retry; the signing/send
    code must be idempotent so a retry can't double-spend.)*
- **Price feed down:** amount can still be entered in BTC; USD shows "price
  unavailable"; sending still works.

### G. View recovery phrase (from Settings)
1. Settings → **Show my recovery phrase**.
2. Re-auth sheet:
   - **H:** Confirm it's you
   - **B:** Enter your password to see your 12 words.
   - `Password` field → **[Show my words]**.
   - Wrong password: "That password isn't right. Try again."
3. Phrase screen (reused reveal UI, blurred → tap to reveal), with the note:
   **Never share these words. Anyone who sees them can take your bitcoin.**
4. **[Done]** → back to Settings.

### H. Switch network (Practice/Live)
1. Settings → toggle **Practice mode**.
2. Network-switch confirmation sheet (copy per Screen 10) → **[Switch]**.
3. App reloads into the other wallet; the persistent banner appears/disappears;
   accent color changes. Balance/activity reload for that network.

### I. Delete wallet from this device
1. Settings → **Remove wallet from this phone**.
2. Delete confirmation sheet:
   - **H:** Remove this wallet from this phone?
   - **B:** This erases the wallet from this device only. Your bitcoin stays safe
     on the bitcoin network. **The only way back in is your 12 words** — if you
     haven't saved them, you'll lose access for good.
   - A required checkbox: **☐ I have my 12 words written down.**
   - **[Remove wallet]** (destructive/red; enabled only when checked) /
     **[Cancel]** (text).
3. On confirm → local encrypted data wiped → back to Welcome.

---

## 8. Design tokens

Paste-ready CSS custom properties. Light mode only (per brief). Two accent
themes: default (Live) and Practice (testnet). Switching `data-network="practice"`
on the root swaps the accent so the whole app *feels* different.

```css
:root {
  /* ---- Brand / accent (Live mode default) ---- */
  --accent:            #F7931A;   /* bitcoin orange — primary actions */
  --accent-press:      #E07E0C;   /* pressed/active */
  --accent-weak:       #FDEBD3;   /* tinted backgrounds, chips */
  --on-accent:         #FFFFFF;   /* text on accent */

  /* ---- Testnet / Practice mode accent (UNMISTAKABLY different) ---- */
  --testnet:           #7C4DFF;   /* violet — clearly not "real money" orange */
  --testnet-press:     #6B3FE0;
  --testnet-weak:      #ECE6FF;
  --testnet-banner-bg: #7C4DFF;
  --testnet-banner-fg: #FFFFFF;

  /* ---- Neutrals / surfaces ---- */
  --bg:                #FFFFFF;   /* app background */
  --surface:           #FFFFFF;   /* cards */
  --surface-2:         #F6F7F9;   /* subtle raised / inset */
  --surface-inset:     #F0F2F5;   /* fields, chips */

  /* ---- Text ---- */
  --text:              #14161A;   /* primary */
  --text-secondary:    #5B616E;   /* muted */
  --text-muted:        #8A909C;   /* hints, placeholders */
  --on-dark:           #FFFFFF;

  /* ---- Semantic ---- */
  --success:           #12A150;   /* received, confirmed, valid */
  --success-weak:      #E4F6EC;
  --danger:            #D92D20;   /* destructive, errors */
  --danger-weak:       #FDECEA;
  --warning:           #B54708;   /* irreversibility strip text */
  --warning-bg:        #FEF6E7;   /* irreversibility strip bg */
  --warning-border:    #F5C86B;

  /* ---- Borders ---- */
  --border:            #E4E7EC;   /* hairline */
  --border-strong:     #CFD4DC;   /* emphasized / focus base */
  --focus-ring:        #F7931A;   /* focus outline (accent) */

  /* ---- Typography (system font stack; no downloads) ---- */
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
               Helvetica, Arial, sans-serif, "Apple Color Emoji",
               "Segoe UI Emoji";
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
               "Liberation Mono", monospace;

  --fs-hero:     40px;  /* balance / big amount */
  --fs-title:    28px;  /* screen headings (H) */
  --fs-heading:  22px;  /* section headings */
  --fs-body:     17px;  /* default body — iOS-comfortable */
  --fs-callout:  15px;  /* callouts, secondary */
  --fs-small:    13px;  /* hints, captions */
  --lh-tight:    1.2;
  --lh-body:     1.5;
  --fw-regular:  400;
  --fw-medium:   500;
  --fw-semibold: 600;
  --fw-bold:     700;

  /* ---- Spacing scale (4px base) ---- */
  --sp-1:  4px;
  --sp-2:  8px;
  --sp-3:  12px;
  --sp-4:  16px;
  --sp-5:  20px;
  --sp-6:  24px;
  --sp-8:  32px;
  --sp-10: 40px;
  --sp-12: 48px;

  /* ---- Radii ---- */
  --radius-sm:   8px;   /* chips, small controls */
  --radius-md:   12px;  /* inputs, list rows */
  --radius-lg:   16px;  /* cards */
  --radius-xl:   22px;  /* sheets, big buttons */
  --radius-pill: 999px; /* pills / word chips */

  /* ---- Elevation (used sparingly) ---- */
  --shadow-card:  0 1px 2px rgba(20, 22, 26, 0.06),
                  0 1px 3px rgba(20, 22, 26, 0.05);
  --shadow-sheet: 0 -8px 30px rgba(20, 22, 26, 0.12);

  /* ---- Layout ---- */
  --max-width:     440px;  /* phone-width column; centers on desktop */
  --touch-min:     44px;   /* minimum touch target */
  --safe-bottom:   env(safe-area-inset-bottom, 0px);
}

/* Practice mode: repoint the accent so the whole app looks different */
:root[data-network="practice"] {
  --accent:       var(--testnet);
  --accent-press: var(--testnet-press);
  --accent-weak:  var(--testnet-weak);
  --focus-ring:   var(--testnet);
}
```

### Button styles (tokens → rules)

```css
.btn {
  min-height: var(--touch-min);
  padding: 14px 20px;
  border-radius: var(--radius-xl);
  font: var(--fw-semibold) var(--fs-body)/1 var(--font-sans);
  border: none;
  cursor: pointer;
  transition: transform .06s ease, background .15s ease;
}
.btn:active { transform: scale(0.98); }

.btn--primary   { background: var(--accent); color: var(--on-accent); }
.btn--primary:active { background: var(--accent-press); }
.btn--secondary { background: var(--surface-inset); color: var(--text); }
.btn--text      { background: transparent; color: var(--accent);
                  font-weight: var(--fw-medium); }
.btn--danger    { background: var(--danger); color: #fff; }
.btn--block     { width: 100%; }
.btn:disabled   { opacity: .45; cursor: not-allowed; }

:focus-visible  { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
```

---

## 9. Component inventory

Reusable pieces the programmer should build once. States listed.

- **Button** — variants: primary, secondary, text, danger. States: default,
  hover (desktop), active/pressed (scale 0.98), disabled (0.45 opacity),
  focus-visible (3px accent ring). Sizes: block (full width) and inline.
- **Text input** — states: empty (placeholder), focused (accent ring), valid
  (green check affix), error (danger border + message below), disabled. Includes
  a **password input** variant with show/hide eye toggle.
- **Amount input** — specialized: large numeric entry, USD/BTC unit switch, live
  converted subtext, **Max** affix.
- **Segmented fee selector** — 3 chips (Standard / Faster / Economy); one
  selected; each shows time estimate + fee. States: selected, unselected, pressed.
- **Sheet (bottom sheet / modal)** — slides up, rounded top corners
  (`--radius-xl`), scrim behind, drag-to-dismiss where non-destructive.
  States: presented, dismissing. Destructive sheets require an explicit button.
- **Toast** — transient bottom message (e.g. "Address copied."). Auto-dismiss
  ~2.5s. States: showing, hiding. Never used for errors that need a decision.
- **QR display** — renders address as a QR; states: loading, ready, error
  ("Couldn't draw the code — copy the address instead").
- **Address chunk** — renders an address in 4-character monospace groups with
  separators; tappable to copy; used on Receive, Send review, Activity detail.
- **Word chip** — a numbered pill for a recovery-phrase word. States (display):
  hidden/blurred, revealed. States (confirm game): idle, correct (fills slot),
  wrong (shake), used/disabled.
- **Balance display** — hero USD + secondary BTC; tap to cycle unit
  (USD → BTC → sats). States: loaded, loading (skeleton), price-unavailable.
- **List row** — for Activity and Settings. Left icon, title, optional subtitle,
  right value/chevron. States: default, pressed, destructive (red).
- **Status pill** — Confirmed (green) / Waiting to confirm (muted) / Failed
  (danger).
- **Practice banner** — persistent, full-width, non-dismissible; only in Practice
  mode.
- **Screen scaffold / nav** — a stack navigator: one screen at a time, back
  chevron in the top bar, no bottom tab bar (the app is small enough that Home is
  the hub and everything is one push deep). Primary actions pinned to bottom with
  safe-area padding.

---

## 10. Accessibility notes

- **Touch targets:** every interactive element is at least **44×44px**
  (`--touch-min`). Word chips and fee chips include padding to reach this even
  when the visible label is short.
- **Contrast:** body text `--text` on white ≈ 15:1; `--text-secondary` ≈ 6.5:1
  (passes AA for normal text). Never place text on `--accent` orange without
  white (`--on-accent`) — orange + dark text fails; orange + white passes for
  large/bold button labels. The Practice violet + white passes AA comfortably.
  Green/red semantic colors are always paired with an **icon and a word**
  (Received/Sent, Confirmed/Failed) so meaning never relies on color alone.
- **Focus states:** visible 3px `--focus-ring` outline with 2px offset on
  keyboard focus (`:focus-visible`). Never remove outlines globally.
- **The reveal + confirm** must be operable without color: the confirm game
  states use motion (shake) *and* text ("That's not word 3…"), not color alone.
- **Dynamic type / zoom:** use `rem`/`px` from the type scale; the layout column
  is capped at `--max-width` and must reflow (no fixed heights on text
  containers) so iOS text-size and browser zoom don't clip content.
- **Labels:** every input has a visible `<label>` (not placeholder-only).
  Icon-only buttons (back chevron, share, gear) get `aria-label`.
- **Screen reader order:** on Send review, the reading order is amount → address
  → fee → total → irreversibility warning → the send button, so the warning is
  heard immediately before the action.
- **Reduced motion:** honor `prefers-reduced-motion` — replace the confirm-game
  shake and button scale with instant state changes.
- **The QR is decorative-plus:** the address text is always present as the
  accessible source of truth; the QR has `alt="QR code for your bitcoin address"`.

---

## 11. Notes for the implementer

- The **Send review** screen is the single most important safety surface. Do not
  let any code path reach broadcast without rendering it. The "I've checked the
  address" checkbox (Live mode) and the verbatim irreversibility line are
  requirements, not suggestions.
- The **seed reveal** must default to blurred and require an explicit tap; never
  render the words unblurred on first paint.
- **Practice mode** must be impossible to confuse with Live: persistent banner +
  accent swap + "practice address" labels. If in doubt, make it *more* obvious.
- Keep every user-facing string in one place (a strings module) so copy stays
  consistent with this spec and is reviewable in one file.
```
