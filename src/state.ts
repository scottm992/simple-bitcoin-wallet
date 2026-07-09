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

/** A fee tier the user can choose on Send. */
export type FeeTier = 'standard' | 'faster' | 'economy';

/** A composed-but-not-yet-sent payment carried from Send → Review → Sent. */
export interface PendingSend {
  readonly recipient: string;
  readonly amountSats: bigint;
  readonly feeRateSatVb: number;
  readonly feeTier: FeeTier;
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
  | { type: 'accountLoaded'; account: AccountSnapshot }
  | { type: 'accountError' }
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
      // Switching networks throws away the other network's chain state.
      return {
        ...state,
        network: action.network,
        account: null,
        accountStatus: 'loading',
        feeEstimates: null,
        pendingSend: null,
        sentTxid: null,
      };

    case 'accountLoading':
      return { ...state, accountStatus: 'loading' };

    case 'accountLoaded':
      return { ...state, account: action.account, accountStatus: 'ready' };

    case 'accountError':
      return { ...state, accountStatus: 'error' };

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
