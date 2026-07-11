/**
 * strings.ts — every user-facing string in one place (per DESIGN.md §11).
 *
 * Copy is taken verbatim from docs/DESIGN.md so it stays reviewable in a single
 * file. Functions are used where a value is interpolated. Nothing secret is ever
 * placed in a string here.
 */

export const strings = {
  app: {
    wordmark: 'Simple Bitcoin',
  },

  common: {
    back: 'Back',
    settings: 'Settings',
    done: 'Done',
    cancel: 'Cancel',
    tryAgain: 'Try again',
    goBack: 'Go back',
  },

  welcome: {
    heading: 'Bitcoin, made simple',
    body: "A wallet that lives on your phone. You're in control — no bank, no sign-up, no email.",
    create: 'Create a new wallet',
    restore: 'I already have a recovery phrase',
    safetyLink: 'How this keeps your money safe',
  },

  explainer: {
    heading: 'You hold the keys',
    body: "This wallet makes a set of 12 secret words that only you ever see. Those words control your bitcoin. We can't see them, reset them, or get them back for you — and neither can anyone else. That's what makes it truly yours. On the next screens we'll help you save those words somewhere safe.",
    dismiss: 'Got it',
    title: 'How this wallet keeps your money safe',
  },

  reveal: {
    heading: 'These 12 words are your wallet',
    body: 'Write them down in order and keep them somewhere safe and private. Anyone who has these words can take your bitcoin — and if you lose them, no one can get your bitcoin back. Not even us.',
    revealButton: 'Tap to reveal your words',
    revealNote: 'Make sure no one is watching your screen.',
    calloutTitle: "Why we can't help you if these are lost",
    calloutBody:
      "This wallet has no company account behind it. These 12 words are the only key. That's the trade for being truly in control: no one can freeze your money, and no one can recover it for you. So the words matter.",
    copyWords: 'Copy the words',
    copyToast:
      "Copied for a moment. Paste them into your password manager now, then delete them from your clipboard and its history — anything you copy next can be read by other apps.",
    continue: "I've written them down",
    leaveHeading: 'Leave without saving your words?',
    leaveBody:
      "If you haven't written these 12 words down, you could lose access to your wallet. We'll show you a fresh set next time.",
    keepSetupUp: 'Keep setting up',
    leaveAnyway: 'Leave anyway',
    // Used when the reveal is shown from Settings.
    settingsNote: 'Never share these words. Anyone who sees them can take your bitcoin.',
  },

  confirm: {
    heading: "Let's make sure you saved them",
    body: 'Tap the words in the right spots. This checks that your written copy is correct.',
    prompt: (position: number): string => `What's word number ${position}?`,
    step: (n: number): string => `Step ${n} of 3`,
    wrong: (position: number): string =>
      `That's not word ${position}. Check your written list and try again.`,
    success: 'Nice — your backup works.',
    showAgain: 'Show my words again',
  },

  password: {
    heading: 'Create a password',
    body: "You'll use this to unlock the wallet on this phone. It protects your wallet if someone else gets your device. It's separate from your 12 words.",
    passwordLabel: 'Password',
    confirmLabel: 'Confirm password',
    // Strength band labels shown next to the live meter (F3).
    strengthLabel: (band: string): string => `Password strength: ${band}`,
    strengthTooShort: 'too short',
    strengthWeak: 'weak',
    strengthFair: 'okay',
    strengthGood: 'good',
    strengthStrong: 'strong',
    passkeyToggle: 'Unlock with a passkey',
    // "next time" is load-bearing: the toggle sits under "Create a password", and
    // a passkey never replaces making one — it only saves typing it on later
    // unlocks (the password stays the fallback if the passkey is ever lost).
    passkeySubtext:
      'Skip typing your password next time — use your face, fingerprint, or device PIN.',
    submit: 'Set password',
    clarify:
      "Your password only unlocks this app on this phone. It can't recover your wallet — only your 12 words can do that.",
    mismatch: "These don't match yet.",
    tooShort: 'A little longer, please — at least 10 characters.',
  },

  home: {
    balanceLabel: 'Your balance',
    switchHint: 'tap to switch',
    receive: 'Receive',
    receiveSub: 'get paid',
    send: 'Send',
    sendSub: 'pay someone',
    recentActivity: 'Recent activity',
    seeAll: 'See all',
    emptyBalanceHeading: "Your wallet is empty — let's fix that",
    emptyBalanceBody:
      'Tap Receive to show your address, then have someone send you bitcoin. Even a tiny amount is a great first test.',
    emptyActivity: 'Nothing here yet.',
    emptyActivityBody: 'Your payments will show up here once you send or receive.',
    priceUnavailable: 'price unavailable',
    // Shown under the balance when a payment you sent is still confirming, so the
    // hero balance doesn't imply that money is still spendable (F9).
    pendingOut: (amount: string): string => `${amount} on its way out, waiting to confirm`,
    pendingIn: (amount: string): string => `${amount} on its way in, waiting to confirm`,
    // Shown while only the quick first look at your balance is on screen (F12):
    // calm, non-alarming, disappears once the deeper check finishes. Also the
    // scanning cue's fallback text before a precise address count is available.
    stillChecking: 'Checking for updates…',
    // Scan-progress cue, State A (a run is actively scanning): names the address
    // being checked so a slow deep scan never looks stuck. The "~" is
    // load-bearing — M is an ESTIMATE that GROWS as used addresses extend the
    // scan, so it is never shown as an exact total. Cache hits count toward N
    // (scan position, not network traffic).
    checkingAddress: (checked: number, estimatedTotal: number): string =>
      `Checking address ${checked} of ~${estimatedTotal}…`,
    // Scan-progress cue, State B (snapshot incomplete but NO run in flight — the
    // v1.1.1 backoff ladder is deliberately waiting between checks). Honest
    // ("may be behind"), never alarming, and TAPPABLE: the manual refresh path is
    // never throttled, so a tap checks right now. No live countdown — "soon" is
    // enough (deliberately no 1s timer).
    balanceBehind: 'Balance may be behind — will check again soon. Tap to check now.',
  },

  receive: {
    title: 'Receive',
    heading: 'Receive bitcoin',
    body: "Show this QR code, or share your address. Whoever's paying you scans or pastes it.",
    copy: 'Copy address',
    copyToast: 'Address copied.',
    share: 'Share',
    note: "It's safe to share this address. It can only be used to send you money — no one can take anything with it. You can reuse it, or tap refresh for a new one.",
    practiceNote: 'This is a practice address. Only worthless practice coins work here.',
    newAddress: 'Show a new address',
    // One-time notice when the shown address rotates LIVE on this screen (a
    // payment landed on it and discovery advanced to the next unused address).
    // Reassures on both counts a beginner worries about: the swap wasn't an
    // error, and the old address didn't stop being theirs. "Has been used",
    // not "was just used": at the stale-cache seam the payment may have landed
    // long ago and discovery only just noticed — the copy must not overclaim
    // recency (F22, round 15).
    rotatedNotice:
      "Nice — the address you were showing has been used, so here's a fresh one. Using a new address each time keeps your payment history more private. The old address still works if someone pays it again.",
    qrError: "Couldn't draw the code — copy the address instead.",
    qrAlt: 'QR code for your bitcoin address',
    // Shown if no address is available at all (should not normally happen —
    // Receive falls back to a locally derived address even offline).
    unavailable:
      "We can't show your address right now. Check your connection and try again in a moment.",
  },

  send: {
    title: 'Send',
    heading: 'Send bitcoin',
    toLabel: 'Send to',
    addressPlaceholder: 'Paste an address',
    paste: 'Paste',
    scan: 'Scan',
    addressValid: 'Address looks valid.',
    amountLabel: 'Amount',
    convBtc: (btc: string): string => `≈ ${btc} BTC`,
    convUsd: (usd: string): string => `≈ ${usd}`,
    max: 'Max',
    unitSwitch: 'USD ⇄ BTC',
    feeLabel: 'Network fee',
    feeExplainer: 'A small amount goes to the bitcoin network to process your payment.',
    feeStandard: 'Standard',
    feeStandardTime: '~30 min',
    feeFaster: 'Faster',
    feeFasterTime: '~10 min',
    feeEconomy: 'Economy',
    feeEconomyTime: 'few hrs',
    // The underlying network fee rate for a tier, in sat/vB (satoshis per
    // virtual byte — bitcoin's own fee unit). Surfaced on each fee chip so a
    // curious or advanced sender can see the actual rate behind the speed/cost
    // lines; those plain-English lines stay the primary read for everyone else.
    // `rate` is passed straight from feeRateForTier — the SAME clamped value the
    // engine signs — so the number shown can never disagree with the number
    // used. Shown only once real estimates have loaded (no estimates → the chip
    // degrades to no rate, exactly as before).
    feeRate: (rate: number): string => `${rate} sat/vB`,
    // --- Custom fee rate (the fourth chip; owner request 2026-07-10) ---
    // The one place the app ASKS for a sat/vB number, so the unit appears in
    // the copy here — everywhere else it stays a small technical footnote.
    feeCustom: 'Custom',
    feeCustomSub: 'you choose',
    customFeeLabel: 'Your fee rate',
    customFeeUnit: 'sat/vB',
    customFeePlaceholder: 'e.g. 2.5',
    // Helper under the input while it is empty or valid-and-ordinary. min/max
    // are passed in from the REAL validation constants (never re-typed here).
    customFeeExplainer: (min: string, max: string): string =>
      `Set your own rate for the bitcoin network — any number from ${min} to ${max}. Higher usually confirms faster.`,
    // Rejection messages (reject, never clamp: a typed money number is either
    // used exactly as entered or refused with a reason — never silently edited).
    customFeeMalformed: "That doesn't look like a number. Plain digits work best, like 5 or 2.5.",
    customFeeOutOfRange: (min: string, max: string): string =>
      `This wallet sends at rates between ${min} and ${max} sat/vB. Pick a number in that range.`,
    // Shown under the fee chips while fee estimates are unavailable: the tier
    // chips render disabled with no costs (never fabricated numbers), and this
    // line points at the one path that still works — a typed custom rate
    // (owner decision 2026-07-10: an explicit rate may send during an
    // estimates outage).
    feesUnavailable:
      "Fee suggestions aren't loading right now, so the speeds above are unavailable. You can still send by choosing Custom and typing your own rate.",
    // Sub-1 sat/vB "slow lane" hint — informational only, never a consent gate
    // (the 25% fee-vs-amount rule stays the only consent flow). Honest about
    // accepted ≠ confirmed: the node takes sub-1 payments (verified live
    // 2026-07-10), but a busy network can leave one waiting or drop it — and
    // Speed up is the rescue, so we point at it.
    customFeeSlowHint:
      "A rate below 1 is the network's slow lane. Your payment may wait a very long time, and if the network gets busy it could be refused or dropped. If it gets stuck, you can speed it up from Activity.",
    review: 'Review',
    totalLine: (amount: string, fee: string, total: string): string =>
      `You'll send ${amount} + ${fee} fee = ${total} total`,
    // Inline errors (compose screen).
    needAddress: 'Add an address to continue.',
    malformedAddress:
      "That doesn't look like a bitcoin address. Check for a typo, or paste it again.",
    wrongNetwork: (addressFor: string, youIn: string): string =>
      `This address is for ${addressFor} bitcoin, but you're in ${youIn} mode. Switch modes or use a different address.`,
    needAmount: 'Enter an amount to continue.',
    overBalance: (max: string): string => `That's more than you have. You can send up to ${max}.`,
    sendMax: 'Send max',
    dust: (min: string): string => `That's too small to send. Try at least ${min}.`,
    scanUnsupported: 'Scanning needs a camera. Paste the address instead.',
    // Informed-consent notice when the network fee is a big share of a small
    // amount (F10). Shown inline on compose, with the real numbers.
    highFeeNotice: (fee: string, pct: string): string =>
      `Heads up: the network fee for this amount is about ${fee} — that's ${pct}% of what you're sending. Small amounts cost proportionally more to send.`,
    highFeeOptions: 'You can pick a slower fee speed, change the amount, or send it anyway.',
    sendAnyway: 'Send anyway',
  },

  review: {
    title: 'Review',
    heading: 'Check this before you send',
    toLabel: 'Going to this address',
    copy: 'Copy',
    feeLabel: 'Network fee',
    feeValue: (fee: string, time: string): string => `${fee} · arrives in ${time}`,
    // The fee row when the rate was typed by the user (feeTier 'custom'):
    // a custom rate can't honestly promise an arrival time, so the row shows
    // the rate itself instead — the SAME number carried in
    // PendingSend.feeRateSatVb that the build will sign (displayed =
    // transmitted, the fee-display honesty property).
    feeValueCustom: (fee: string, rate: string): string =>
      `${fee} · at your rate of ${rate} sat/vB`,
    totalLabel: 'Total leaving your wallet',
    warningLive:
      'Sending bitcoin cannot be undone. If the address is wrong, your money is gone for good. Take a moment to compare the address above with the one you were given.',
    warningPractice:
      "This is practice mode, so nothing real is at stake — but on a real wallet, sending can't be undone. Get in the habit of checking the address.",
    checkbox: "I've checked the address.",
    sendNow: 'Send now',
    goBack: 'Go back and edit',
    // Broadcast failure sheet.
    failHeading: "We couldn't send that just now",
    failBody:
      'Your bitcoin is safe and still in your wallet — nothing was sent. This is usually a connection problem. Check your internet and try again.',
    // Broadcast REJECTED because the fee rate is under the node's relay floor
    // (possible with a sub-1 custom rate when the network is busy). Unlike the
    // generic failure there is no retry offered — re-sending the identical
    // payment gets the identical answer — so the copy points back to the fee.
    failFeeTooLowBody:
      'The bitcoin network turned this payment down because its fee rate is below what it accepts right now. Your bitcoin is safe and nothing was sent. Go back and pick a higher fee, then try again.',
    // Dry-run failure: the amounts couldn't be worked out. Block sending; send
    // them back to re-check. Honest variants (F10/F11): only a genuine build
    // failure blames the balance; a fee-guard trip explains the fee with the
    // real numbers and offers the send-anyway choice right here.
    recheckHeading: "Let's double-check this payment",
    recheckBody:
      "We couldn't work out the fee and total just now — your available balance may have changed. Go back and enter the payment again so the numbers are right before you send.",
    recheckFeeBody: (fee: string, pct: string): string =>
      `The network fee would take an unusually big bite out of this payment — about ${fee}, which is ${pct}% of what you're sending. You can go back to change the amount or fee speed, or choose to send it anyway.`,
    recheckFeeHardBody:
      'The network fee for this payment is more than this wallet will ever send — that usually means something is wrong with the fee estimate. Go back and try a different amount or fee speed.',
    recheckGoBack: 'Go back and re-check',
  },

  sent: {
    heading: 'On its way',
    body: (usd: string, btc: string): string =>
      `You sent ${usd} (${btc} BTC). It usually lands in about 30 minutes. You can watch its progress in Activity.`,
    done: 'Done',
    viewActivity: 'View in Activity',
    note: 'Bitcoin is still processing your payment. It\'s normal for it to say "Waiting to confirm" for a little while.',
  },

  activity: {
    title: 'Activity',
    heading: 'Activity',
    received: 'Received',
    sent: 'Sent',
    confirmed: 'Confirmed',
    waiting: 'Waiting to confirm',
    failed: 'Failed',
    empty: 'Nothing here yet.',
    emptyBody: 'Your payments will show up here once you send or receive.',
    loadError: "Couldn't load your activity. Check your connection and try again.",
    // Detail sheet.
    detailFee: 'Network fee',
    viewExplorer: 'View on the block explorer',
    statusWaiting:
      "The bitcoin network is still processing this. No action needed — it'll confirm on its own.",
    statusConfirmed: 'This payment is complete and permanent.',
    otherPartyLabel: 'To / from this address',
  },

  // Speed up a stuck payment (opt-in Replace-By-Fee fee bump), added v1.1. Lives
  // inside the Activity detail sheet. No jargon: "speed up", "network fee",
  // never "RBF" / "sat/vB" / "mempool". USD is the hero, sats the secondary.
  speedUp: {
    // Entry-point button (pending, outgoing payments only).
    cta: 'Speed up this payment',
    // The header used across every state of the flow.
    title: 'Speed up this payment',
    // Short body under the offer rows.
    offerBody:
      'Paying a little more to the bitcoin network can help a slow payment go through sooner.',
    // Busy label while we look up the payment (one network request).
    checking: 'Checking…',
    // The destination the payment is going to (F15): the sheet re-confirms
    // WHERE the money goes, chunked like the Review screen, above the fee rows.
    destinationLabel: 'Going to this address',
    destinationAmountLabel: 'Amount being sent',
    // Offer rows (each shows USD, with sats beneath).
    feePaidLabel: 'Fee paid so far',
    newFeeLabel: 'New fee',
    extraCostLabel: 'Extra cost',
    // Primary button; `extra` is the extra cost (USD, or sats when the price is
    // unavailable).
    confirm: (extra: string): string => `Speed up — pay ${extra} more`,
    // Busy label on the confirm button while the boosted payment is sent.
    confirming: 'Speeding up…',
    notNow: 'Not now',
    close: 'Close',
    // Full-balance (sweep) original: the extra fee has to come out of the amount
    // being sent, so the recipient receives less. `less` is USD (or sats).
    reducesWarning: (less: string): string =>
      `This payment sent your full balance, so the extra fee comes out of the amount being sent — whoever you're paying will receive ${less} less.`,
    reducesCheckbox: "I understand they'll receive less.",
    // Informed consent when the new fee is a big share of the payment (the same
    // 25% rule as Send, F10). `fee` is USD (or sats); `pct` is a whole number.
    highFeeNotice: (fee: string, pct: string): string =>
      `Heads up: the new fee is about ${fee} — that's ${pct}% of what you're paying. Speeding up a small payment costs proportionally more.`,
    highFeeCheckbox: 'I understand the fee is a large part of this payment.',
    // Dead-ends: no action, a single Close, always honest (the original payment
    // still goes through — it may just be slow).
    deadConfirmed: 'Good news — this payment just went through. Nothing to speed up.',
    deadNotSignaling:
      "This payment was sent before speed-up existed, so it can't be sped up from here. It will still go through — it just may take a while.",
    deadInsufficientChange:
      "There isn't enough left over in this payment to raise its fee. It will still go through — it just may take a while.",
    deadCannot:
      "This payment can't be sped up from here. It will still go through — it just may take a while.",
    deadFeeCap:
      'Speeding this up would cost more than this wallet will ever send — that usually means the network fee estimate is off right now. This payment will still go through on its own — it just may take a while.',
    // F15 verification dead-ends. Mismatch is a possible attack: calm but firm,
    // no override anywhere. Unverified is the honest restored-wallet case
    // (send records don't travel with the 12 words).
    deadMismatch:
      "Something doesn't match on this payment's details, so we won't speed it up. Your money is safe and the original payment is unchanged.",
    deadUnverified:
      "This payment was made before this wallet was set up on this device, so it can't be sped up from here. It will still go through — it just may take a while.",
    // Network failure while looking up the payment (nothing was sent).
    errorHeading: "We couldn't check this just now",
    errorBody:
      'Your bitcoin is safe and nothing has changed. This is usually a connection problem. Check your internet and try again.',
    // Success.
    successHeading: 'On its way',
    successBody: 'We gave your payment a boost. It should confirm sooner now.',
    // Broadcast failure at confirm time (mirrors Send's broadcast-failure sheet).
    failHeading: "We couldn't speed it up just now",
    failBody:
      'Your bitcoin is safe and still on its way — nothing changed. This is usually a connection problem. Check your internet and try again.',
  },

  settings: {
    title: 'Settings',
    heading: 'Settings',
    securityGroup: 'Security',
    lockNow: 'Lock wallet now',
    showPhrase: 'Show my recovery phrase',
    changePassword: 'Change password',
    networkGroup: 'Network',
    practiceMode: 'Practice mode',
    practiceModeSub: 'Test with worthless coins. Turn this on to learn without risking real money.',
    deviceGroup: 'This device',
    removeWallet: 'Remove wallet from this phone',
    aboutGroup: 'About',
    aboutSafety: 'How this wallet keeps your money safe',
    version: (v: string): string => `Version ${v}`,
    // Network-switch sheet.
    switchToPracticeHeading: 'Switch to Practice mode?',
    switchToLiveHeading: 'Switch to Live mode?',
    switchToPracticeBody:
      "In Practice mode you'll see a different, practice-only wallet. Your real balance is safe and untouched — it comes back the moment you switch off Practice mode.",
    switchToLiveBody:
      "You're switching to real bitcoin. Real money, real transactions. Double-check every address before you send.",
    switchConfirm: 'Switch',
    // Delete sheet.
    deleteHeading: 'Remove this wallet from this phone?',
    deleteBody:
      'This erases the wallet from this device only. Your bitcoin stays safe on the bitcoin network. The only way back in is your 12 words — if you haven\'t saved them, you\'ll lose access for good.',
    deleteCheckbox: 'I have my 12 words written down.',
    deleteConfirm: 'Remove wallet',
    // Re-auth sheet (show phrase).
    reauthHeading: "Confirm it's you",
    reauthBody: 'Enter your password to see your 12 words.',
    reauthShow: 'Show my words',
  },

  unlock: {
    heading: 'Welcome back',
    usePassword: 'Use password instead',
    usePasskey: 'Unlock with a passkey',
    passwordLabel: 'Password',
    unlock: 'Unlock',
    forgot: 'Forgot password?',
    wrongPassword: "That password isn't right. Try again.",
    passkeyFailed: "That didn't work. Enter your password instead.",
    // Forgot sheet.
    forgotHeading: "Passwords can't be reset",
    forgotBody:
      "Your password only unlocks this phone, so there's nothing to reset. If you can't get in, you can set the wallet up again from scratch using your 12 words. Removing and restoring won't lose any bitcoin — your money lives on the bitcoin network, not in this app.",
    forgotRestore: 'Restore with my 12 words',
    forgotRetry: 'Try password again',
    forgotWipe: 'Remove this wallet and start fresh',
    // The last-resort wipe sheet (owner request 2026-07-10): the heaviest
    // consent flow in the app. Safe for someone holding their 12 words;
    // permanent loss for someone who isn't — say so bluntly, no softening.
    wipeHeading: 'Remove this wallet from this phone?',
    wipeBody:
      "This deletes the wallet from this phone only — your bitcoin lives on the bitcoin network. The ONLY way to see this wallet's money again is its 12-word recovery phrase. If you don't have those 12 words written down, any money in this wallet will be lost forever. No one — not even this app — can bring it back without them.",
    wipeCheckbox: 'I understand: without my 12 words, the money in this wallet is lost forever.',
    wipeConfirm: 'Remove wallet',
  },

  restore: {
    heading: 'Restore your wallet',
    body: "Enter your 12 words in order. As you type each one, we'll suggest the full word — tap it to fill in.",
    pasteAll: 'Paste all 12',
    invalidWord: 'Not a valid word — check the spelling.',
    restore: 'Restore wallet',
    checksumFail:
      "These 12 words don't add up to a valid recovery phrase. Check the order and spelling — even one word in the wrong place will do this.",
    emptyHelper: 'Enter all 12 words to continue.',
  },

  // Shown before we trigger the system passkey sheet (SetPassword toggle and
  // Settings enable), so the word "passkey" is explained before the OS says it
  // (Bug B). We name the passkey plainly and describe the biometric generically
  // — this is a web app, so the unlock gesture may be Face ID, a fingerprint,
  // or a device PIN depending on the device.
  passkey: {
    explainHeading: 'Create a passkey',
    explainBody:
      "A passkey lets you unlock this wallet without typing your password. Your device saves it and checks it's you — with your face, fingerprint, or PIN. It only unlocks the app on this device: your password still works, and your 12 words are never shared.",
    explainContinue: 'Create passkey',
    explainNotNow: 'Not now',
  },

  banner: {
    practice:
      "Practice mode — these coins are worthless. You're testing safely. Nothing here is real money.",
  },

  errors: {
    network: "We couldn't reach the bitcoin network. Check your connection and try again.",
    generic: 'Something went wrong. Please try again.',
  },
} as const;
