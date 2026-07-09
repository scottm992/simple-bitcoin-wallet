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
    faceIdToggle: 'Unlock with Face ID',
    faceIdSubtext: 'Skip typing your password on this phone.',
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
    qrError: "Couldn't draw the code — copy the address instead.",
    qrAlt: 'QR code for your bitcoin address',
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
    // Dry-run failure: the amounts couldn't be worked out. Block sending; send
    // them back to re-check. Two honest variants (F10): only a genuine build
    // failure blames the balance; a fee-guard trip explains the fee instead.
    recheckHeading: "Let's double-check this payment",
    recheckBody:
      "We couldn't work out the fee and total just now — your available balance may have changed. Go back and enter the payment again so the numbers are right before you send.",
    recheckFeeBody:
      "The network fee would take an unusually big bite out of this payment. Go back to adjust the amount or pick a different fee speed — you can still choose to send it anyway from there.",
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
    loadError: "Couldn't load your activity. Check your connection and pull to refresh.",
    // Detail sheet.
    detailFee: 'Network fee',
    viewExplorer: 'View on the block explorer',
    statusWaiting:
      "The bitcoin network is still processing this. No action needed — it'll confirm on its own.",
    statusConfirmed: 'This payment is complete and permanent.',
    otherPartyLabel: 'To / from this address',
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
    useFaceId: 'Unlock with Face ID',
    passwordLabel: 'Password',
    unlock: 'Unlock',
    forgot: 'Forgot password?',
    wrongPassword: "That password isn't right. Try again.",
    faceIdFailed: 'Face ID unlock did not work. Enter your password instead.',
    // Forgot sheet.
    forgotHeading: "Passwords can't be reset",
    forgotBody:
      "Your password only unlocks this phone, so there's nothing to reset. If you can't get in, you can set the wallet up again from scratch using your 12 words. Removing and restoring won't lose any bitcoin — your money lives on the bitcoin network, not in this app.",
    forgotRestore: 'Restore with my 12 words',
    forgotRetry: 'Try password again',
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

  banner: {
    practice:
      "Practice mode — these coins are worthless. You're testing safely. Nothing here is real money.",
  },

  errors: {
    network: "We couldn't reach the bitcoin network. Check your connection and try again.",
    generic: 'Something went wrong. Please try again.',
  },
} as const;
