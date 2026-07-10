/**
 * state.ts — the single top-level app state, screen state machine, and reducer.
 *
 * IMPORTANT (secrets hygiene): this state object is held in React state and may
 * be inspected by devtools. It MUST NOT contain the mnemonic, any private key,
 * or the user's password. Those live only in session.ts (mnemonic) or as local,
 * short-lived component state that is cleared on navigation (password fields,
 * the transient seed words during create/confirm).
 */
import type { Network } from './lib';
import type { AccountSnapshot } from './lib/account';
import type { FeeEstimates } from './lib';

/** The screens, as a simple stack-free state machine. */
export type Screen =
  | 'welcome'
  | 'reveal' // create: show the phrase
  | 'confirm' // create: confirm 3 words
  | 'setPassword' // create/restore: set device password
  | 'restore' // restore: enter 12 words
  | 'home'
  | 'receive'
  | 'send'
  | 'review'
  | 'sent'
  | 'activity'
  | 'settings'
  | 'unlock';

/** Which flow we're in, so setPassword knows where it came from. */
export type Flow = 'create' | 'restore' | null;

/**
 * A RECOMMENDED fee tier on Send. Deliberately does NOT include 'custom':
 * `feeRateForTier` (actions.ts) is total over exactly these three values, and
 * the Speed-up sheet offers only tiers — keeping this type narrow means a
 * custom choice can never reach the tier→rate mapping by accident.
 */
export type FeeTier = 'standard' | 'faster' | 'economy';

/**
 * What the user picked in the Send fee selector: a recommended tier, or
 * 'custom' — their own typed sat/vB rate (validated at entry by Send's
 * `classifyCustomFeeRate` before it can reach state). The rate itself always
 * travels in `PendingSend.feeRateSatVb` regardless of the choice; this value
 * only records WHICH picker produced it, so Review can label the fee honestly
 * (a tier promises an arrival time, a custom rate cannot).
 */
export type FeeChoice = FeeTier | 'custom';

/** A composed-but-not-yet-sent payment carried from Send → Review → Sent. */
export interface PendingSend {
  readonly recipient: string;
  readonly amountSats: bigint;
  readonly feeRateSatVb: number;
  /**
   * Which fee choice produced `feeRateSatVb`: a tier (feeRateForTier's clamped
   * output) or 'custom' (a user-typed rate Send validated into
   * [MIN_CUSTOM_FEE_RATE, MAX_ACCEPTED_FEE_RATE] — reject-never-clamp).
   * Labeling only: everything downstream (the Review dry-run and the broadcast
   * build) consumes `feeRateSatVb` through the same single path either way
   * (F11) and the engine's hard fee guards apply unchanged.
   */
  readonly feeTier: FeeChoice;
  readonly sendMax: boolean;
  /**
   * True only when the user explicitly confirmed an unusually large
   * fee-vs-amount ratio on the compose screen ("Send anyway", F10). Threaded
   * through the Review dry-run and the broadcast build so both use identical
   * params. Never bypasses the engine's hard fee-rate / absolute-fee limits.
   */
  readonly allowHighFee: boolean;
}

/** Loading status for network-backed data. */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Live scan position for the Home "Checking address N of ~M…" cue
 * (scan-progress feature; DISPLAY-ONLY). `checked` = addresses evaluated so far
 * across both chains (cache hits count — scan position, not network traffic);
 * `estimatedTotal` = the current combined window estimate, which GROWS as used
 * addresses extend a chain's gap window (so the honest form is "N of ~M", never
 * a percent that could move backwards). `null` whenever no discovery run is
 * actively scanning — the cue then shows its deliberate-wait text (the v1.1.1
 * backoff ladder is between checks), so a cut run can't freeze a stale count.
 */
export interface ScanProgress {
  readonly checked: number;
  readonly estimatedTotal: number;
}

/** The full application state. Contains NO secrets. */
export interface AppState {
  readonly screen: Screen;
  readonly flow: Flow;
  readonly network: Network;
  /** True once the app has determined whether a vault exists (initial boot). */
  readonly booted: boolean;
  /** Whether a vault exists on this device. */
  readonly hasVault: boolean;

  /** Account snapshot for the active network, or null before first load. */
  readonly account: AccountSnapshot | null;
  readonly accountStatus: LoadStatus;
  /**
   * Whether the current snapshot came from a FULL (gap-20) scan. False while
   * only the fast phase-1 result is on screen (F12): Home shows a subtle
   * "checking for updates" cue and the poll tick self-heals by completing the
   * scan. True whenever there is no snapshot at all (nothing to qualify).
   */
  readonly accountComplete: boolean;
  /**
   * Live scan-progress for the Home checking cue, or `null` when no run is
   * actively scanning (see {@link ScanProgress}). Display-only; carries no
   * secrets and never gates funds display.
   */
  readonly scanProgress: ScanProgress | null;

  /** BTC/USD price, or null when unavailable (offline). */
  readonly btcUsd: number | null;

  /** Fee estimates for the active network, or null before first load. */
  readonly feeEstimates: FeeEstimates | null;

  /** The payment being composed/reviewed. */
  readonly pendingSend: PendingSend | null;
  /** The txid of the most recent successful broadcast, for the Sent screen. */
  readonly sentTxid: string | null;

  /** Whether the device supports passkey/Face ID unlock. */
  readonly passkeySupported: boolean;
  /** Whether passkey unlock is enabled for the current vault. */
  readonly passkeyEnabled: boolean;
}

/** Actions the reducer understands. */
export type Action =
  | { type: 'boot'; hasVault: boolean; network: Network; passkeySupported: boolean; passkeyEnabled: boolean }
  | { type: 'navigate'; screen: Screen }
  | { type: 'startCreate' }
  | { type: 'startRestore' }
  | { type: 'unlocked' } // mnemonic now in session; go to home
  | { type: 'locked' } // session cleared; go to unlock
  | { type: 'vaultCreated'; network: Network; passkeyEnabled: boolean }
  | { type: 'vaultDeleted' }
  | { type: 'setNetwork'; network: Network }
  | { type: 'accountLoading' }
  | { type: 'accountLoaded'; account: AccountSnapshot; complete: boolean }
  | { type: 'accountError' }
  | { type: 'scanProgress'; progress: ScanProgress | null }
  | { type: 'priceLoaded'; btcUsd: number | null }
  | { type: 'feesLoaded'; feeEstimates: FeeEstimates }
  | { type: 'composeSend'; pending: PendingSend }
  | { type: 'sendBroadcast'; txid: string }
  | { type: 'clearSend' }
  | { type: 'setPasskeyEnabled'; enabled: boolean };

/** The initial state before boot resolves. */
export const initialState: AppState = {
  screen: 'welcome',
  flow: null,
  network: 'mainnet',
  booted: false,
  hasVault: false,
  account: null,
  accountStatus: 'idle',
  accountComplete: true,
  scanProgress: null,
  btcUsd: null,
  feeEstimates: null,
  pendingSend: null,
  sentTxid: null,
  passkeySupported: false,
  passkeyEnabled: false,
};

/** Pure reducer. No side effects, no secrets. */
export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'boot':
      return {
        ...state,
        booted: true,
        hasVault: action.hasVault,
        network: action.network,
        passkeySupported: action.passkeySupported,
        passkeyEnabled: action.passkeyEnabled,
        screen: action.hasVault ? 'unlock' : 'welcome',
      };

    case 'navigate':
      return { ...state, screen: action.screen };

    case 'startCreate':
      return { ...state, flow: 'create', screen: 'reveal' };

    case 'startRestore':
      return { ...state, flow: 'restore', screen: 'restore' };

    case 'unlocked':
      // Entering the wallet: reset any stale send/account so home reloads fresh.
      return {
        ...state,
        screen: 'home',
        flow: null,
        account: null,
        accountStatus: 'loading',
        accountComplete: true,
        scanProgress: null,
        pendingSend: null,
        sentTxid: null,
      };

    case 'locked':
      return {
        ...state,
        screen: 'unlock',
        flow: null,
        account: null,
        accountStatus: 'idle',
        accountComplete: true,
        scanProgress: null,
        pendingSend: null,
        sentTxid: null,
      };

    case 'vaultCreated':
      return {
        ...state,
        hasVault: true,
        network: action.network,
        passkeyEnabled: action.passkeyEnabled,
      };

    case 'vaultDeleted':
      return {
        ...initialState,
        booted: true,
        passkeySupported: state.passkeySupported,
        screen: 'welcome',
      };

    case 'setNetwork':
      // Switching networks throws away the other network's chain state
      // synchronously — no stale-network balance may survive the switch (F13).
      return {
        ...state,
        network: action.network,
        account: null,
        accountStatus: 'loading',
        accountComplete: true,
        scanProgress: null,
        feeEstimates: null,
        pendingSend: null,
        sentTxid: null,
      };

    case 'accountLoading':
      // A run is starting: drop any prior scan-progress so a stale count from a
      // previous (possibly deadline-cut) run can't flash before the new run's
      // first progress tick arrives.
      return { ...state, accountStatus: 'loading', scanProgress: null };

    case 'accountLoaded':
      return {
        ...state,
        account: action.account,
        accountStatus: 'ready',
        accountComplete: action.complete,
      };

    case 'accountError':
      return { ...state, accountStatus: 'error' };

    case 'scanProgress':
      // Display-only cue data. `null` = no run actively scanning (dispatched
      // when a run settles, so a cut run's count can't linger on the cue).
      return { ...state, scanProgress: action.progress };

    case 'priceLoaded':
      return { ...state, btcUsd: action.btcUsd };

    case 'feesLoaded':
      return { ...state, feeEstimates: action.feeEstimates };

    case 'composeSend':
      return { ...state, pendingSend: action.pending, screen: 'review' };

    case 'sendBroadcast':
      return { ...state, sentTxid: action.txid, screen: 'sent' };

    case 'clearSend':
      return { ...state, pendingSend: null, sentTxid: null };

    case 'setPasskeyEnabled':
      return { ...state, passkeyEnabled: action.enabled };

    default:
      return state;
  }
}
