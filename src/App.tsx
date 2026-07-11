import type { JSX } from 'react';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import './theme.css';
import { reducer, initialState } from './state';
import type { PendingSend } from './state';
import {
  clearSendLog,
  createVault,
  deleteVault as deleteVaultStorage,
  deriveReceiveAddress,
  disablePasskeyUnlock,
  enablePasskeyUnlock,
  generateMnemonic,
  getCachedReceiveIndex,
  isPasskeyEnabled,
  isPasskeySupported,
  setVaultNetwork,
  unlockVault,
  unlockWithPasskey,
  vaultExists,
  getVaultNetwork,
  buildAndSignTx,
  FeeTooHighError,
  type Network,
} from './lib';
import {
  installSessionGuards,
  lockNow,
  onLock,
  setUnlocked,
  getMnemonic,
  isUnlocked,
} from './session';
import {
  DiscoveryController,
  bumpAndBroadcast,
  invalidateScanCache,
  loadFees,
  loadPrice,
  prepareBump,
  signAndBroadcast,
  type PreparedBump,
} from './actions';
import type { AccountSnapshot } from './lib/account';
import type { DisplayUnit } from './display';

import { Welcome } from './screens/Welcome';
import { Reveal } from './screens/Reveal';
import { Confirm } from './screens/Confirm';
import { SetPassword } from './screens/SetPassword';
import { Restore } from './screens/Restore';
import { Unlock } from './screens/Unlock';
import { Home } from './screens/Home';
import { Receive } from './screens/Receive';
import { Send } from './screens/Send';
import { Review, type ReviewNumbers } from './screens/Review';
import { Sent } from './screens/Sent';
import { Activity } from './screens/Activity';
import { Settings } from './screens/Settings';
import { Sheet } from './components/ui';
import { strings } from './strings';

/**
 * Fast follow-up delay for the v1.1.2 progress-gated quick retry. When a run is
 * cut mid-scan but made progress, the controller becomes eligible to self-heal
 * within its ~8s quick window — far sooner than the 30s baseline clock's next
 * edge. This one-shot nudge, armed only while the snapshot sits in the
 * deliberate-wait (State B) state, lets that quick resume be FELT promptly
 * instead of waiting up to a full tick (the owner's "sat there ~a minute"
 * complaint). Kept at ~8s to line up with the controller's QUICK_RETRY_MS; the
 * controller's eligibility gate + single-flight are the real throttle, so this
 * can only ever advance the timing of an already-eligible check, never burst.
 */
const QUICK_SELF_HEAL_FOLLOWUP_MS = 8_000;

/** Applies the data-network attribute so the accent swaps in Practice mode. */
function applyNetworkTheme(network: Network): void {
  const root = document.documentElement;
  if (network === 'testnet') root.setAttribute('data-network', 'practice');
  else root.removeAttribute('data-network');
}

export default function App(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Transient, screen-local secret-ish material that must NOT enter app state:
  // the freshly-generated words during create/confirm, and the restore phrase in
  // flight. Held in a ref (never serialized) + a render trigger.
  const draftWordsRef = useRef<string[] | null>(null);
  const restorePhraseRef = useRef<string | null>(null);
  const [, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender((n) => n + 1), []);

  // For the "show phrase from settings" flow: the decrypted words are held in a
  // ref (never serialized into React state), with a boolean flag driving render.
  const settingsRevealWordsRef = useRef<string[] | null>(null);
  const [settingsRevealActive, setSettingsRevealActive] = useState(false);
  const clearSettingsReveal = useCallback(() => {
    settingsRevealWordsRef.current = null;
    setSettingsRevealActive(false);
  }, []);

  // Display unit for the balance (remembered per session).
  const [unit, setUnit] = useState<DisplayUnit>('usd');
  const [firstHomeVisit, setFirstHomeVisit] = useState(true);
  // The payment a Home row tap asked to see: Activity opens its detail sheet
  // for this txid on arrival, then consumes it (one-shot). Null for every
  // other route into Activity (See all, the Sent screen) — those land on the
  // plain list. Fixes the tap-a-row-get-the-list bug (owner report).
  const [activityFocusTxid, setActivityFocusTxid] = useState<string | null>(null);

  // F6: client-side throttle on wrong-password unlock attempts. This is NOT a
  // real security boundary — a determined attacker copies the vault and brute-
  // forces it offline (scrypt is the actual defence). It only slows a casual
  // device-local guesser and is documented as such. The count lives in a ref so
  // it survives re-renders but resets on a full reload / successful unlock.
  const failedUnlocksRef = useRef(0);

  // Which activity txid to auto-open when navigating from Home (optional).
  const [explainerOpen, setExplainerOpen] = useState(false);

  // Bug A: single-flight discovery coordinator (at most one run in flight;
  // cheap poll ticks are skipped while anything runs). Lives in a ref so the
  // same instance survives re-renders.
  const discoveryRef = useRef<DiscoveryController | null>(null);
  function discovery(): DiscoveryController {
    discoveryRef.current ??= new DiscoveryController();
    return discoveryRef.current;
  }
  // Latest account snapshot + its completeness, mirrored into refs so the poll
  // interval closure always sees current values without resetting its cadence.
  const accountRef = useRef<AccountSnapshot | null>(null);
  const accountCompleteRef = useRef(true);
  useEffect(() => {
    accountRef.current = state.account;
    accountCompleteRef.current = state.accountComplete;
  }, [state.account, state.accountComplete]);

  // ---- Boot: detect existing vault, install session guards ----------------
  useEffect(() => {
    // F24 (round 19, boot half): a CORRUPT vault must never crash the boot —
    // getVaultNetwork/isPasskeyEnabled PARSE the vault document and throw
    // VaultCorruptError on garbage. The app must still reach the Unlock
    // screen (vaultExists keys on the raw key's presence, corrupt or not), so
    // the forgot-password → wipe-and-start-fresh rescue stays reachable for
    // exactly the user whose storage is broken. Password attempts against a
    // corrupt vault fail like a wrong password; the wipe is the way out.
    let network: Network = 'mainnet';
    let passkeyEnabled = false;
    try {
      network = getVaultNetwork() ?? 'mainnet';
      passkeyEnabled = isPasskeyEnabled();
    } catch {
      /* corrupt vault document — boot locked on mainnet defaults */
    }
    applyNetworkTheme(network);
    dispatch({
      type: 'boot',
      hasVault: vaultExists(),
      network,
      passkeySupported: isPasskeySupported(),
      passkeyEnabled,
    });
    const teardown = installSessionGuards();
    const unsub = onLock(() => {
      // Wipe any in-flight draft secrets, stop any in-flight discovery, drop the
      // cross-run scan cache (§1b — lock clears every network's cached
      // responses so the next unlock starts fresh), and route to Unlock.
      draftWordsRef.current = null;
      restorePhraseRef.current = null;
      discoveryRef.current?.abort();
      invalidateScanCache();
      clearSettingsReveal();
      dispatch({ type: 'locked' });
    });
    return () => {
      teardown();
      unsub();
    };
  }, [clearSettingsReveal]);

  // Keep the theme in sync with the network.
  useEffect(() => {
    applyNetworkTheme(state.network);
  }, [state.network]);

  // ---- Data loading: account, price, fees --------------------------------
  // Full (two-phase) discovery, account only. Single-flight: a new call aborts
  // any in-flight run and starts fresh (Bug A). The run is deadline-bounded, so
  // accountStatus can never sit on 'loading' forever. Kept SEPARATE from the
  // price/fees fetch so the automatic poll path can refresh the account without
  // re-fetching price/fees the tick already got (§1d — one of each per cycle).
  const refreshAccount = useCallback(() => {
    if (!isUnlocked()) return;
    const network = state.network;
    dispatch({ type: 'accountLoading' });
    discovery().refresh({
      network,
      onSnapshot: (account, complete) => dispatch({ type: 'accountLoaded', account, complete }),
      onError: () => dispatch({ type: 'accountError' }),
      // Scan-progress cue (display-only): each tick updates "Checking address N
      // of ~M". onSettled clears it when the run ends so a deadline-cut run can't
      // leave a frozen count on the cue — with no run in flight the cue falls
      // back to its deliberate-wait (State B) text. A superseded run never fires
      // onSettled (the controller guards this.current === handle), and
      // startDiscovery drops any progress after abort (externallyAborted), so no
      // stale or cross-run count can linger.
      onProgress: (checked, estimatedTotal) =>
        dispatch({ type: 'scanProgress', progress: { checked, estimatedTotal } }),
      onSettled: () => dispatch({ type: 'scanProgress', progress: null }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.network]);

  // Price + fees are independent, cheap single requests. Fetched in exactly one
  // place per cycle (§1d): here for the manual/unlock/switch/broadcast paths,
  // and once by the 30s tick for the periodic refresh — never both in a cycle.
  const refreshPriceFees = useCallback((network: Network) => {
    void loadPrice().then((btcUsd) => dispatch({ type: 'priceLoaded', btcUsd }));
    void loadFees(network)
      .then((feeEstimates) => dispatch({ type: 'feesLoaded', feeEstimates }))
      .catch(() => {
        /* fees unavailable: Send disables the tier chips (no fabricated
           costs), but a typed CUSTOM rate may still send (owner decision —
           see Send.tsx canReview) */
      });
  }, []);

  // The full manual refresh: price + fees + account. Used ONLY on unlock,
  // network switch, manual Try again / refresh, and after a broadcast.
  const refreshAll = useCallback(() => {
    if (!isUnlocked()) return;
    refreshPriceFees(state.network);
    refreshAccount();
  }, [state.network, refreshPriceFees, refreshAccount]);

  // Load whenever we're on a wallet screen and unlocked.
  const onWalletScreen =
    state.screen === 'home' ||
    state.screen === 'receive' ||
    state.screen === 'send' ||
    state.screen === 'activity' ||
    state.screen === 'settings';

  useEffect(() => {
    if (onWalletScreen && isUnlocked() && state.accountStatus === 'loading' && state.account === null) {
      refreshAll();
    }
  }, [onWalletScreen, state.accountStatus, state.account, refreshAll]);

  // Cheap poll every 30s while unlocked + visible (Bug A): NEVER a full rescan.
  // Re-checks only the known-used addresses plus the receive/change tips (a
  // fresh wallet costs 2 requests) and refreshes fees/price. Skipped entirely
  // while a discovery run is in flight. A detected on-chain change (or an
  // incomplete snapshot needing self-heal) triggers an ACCOUNT-ONLY refresh —
  // this tick already fetched price/fees, so refreshAccount (not refreshAll)
  // avoids a duplicate price/fees fetch in the same cycle (§1d). The controller
  // gates the automatic path with its backoff ladder (§1a); this interval stays
  // a dumb 30s clock.
  useEffect(() => {
    if (!onWalletScreen) return;
    const id = setInterval(() => {
      if (!isUnlocked() || document.visibilityState !== 'visible') return;
      if (discovery().busy) return; // a full run is already crawling: skip
      refreshPriceFees(state.network);
      const account = accountRef.current;
      if (!account) return; // nothing known: wait for a manual Try again
      discovery().pollTick({
        network: state.network,
        account,
        accountComplete: accountCompleteRef.current,
        onChanged: () => refreshAccount(),
      });
    }, 30_000);
    return () => clearInterval(id);
  }, [onWalletScreen, state.network, refreshPriceFees, refreshAccount]);

  // Fast follow-up for the v1.1.2 progress-gated quick retry. While the snapshot
  // is INCOMPLETE and no run is in flight — the deliberate-wait "State B" the
  // Home cue shows after a run was cut mid-scan — the controller may already be
  // eligible to self-heal within its ~8s quick window, much sooner than the 30s
  // clock's next edge. This arms a SINGLE, visibility-gated one-shot to nudge the
  // self-heal so a progress-cut resume is felt promptly. SAFE by construction:
  //  - it is a no-op unless the controller says it's eligible AND no run is busy
  //    (the eligibility gate + single-flight are the throttle — this can never
  //    burst or amplify load, only advance the timing of an already-due check);
  //  - it targets exactly State B (incomplete snapshot, not scanning), which is
  //    reachable only when a run kept a phase-1 partial — i.e. a run that made
  //    progress. A no-progress run errors with NO snapshot (not State B), so this
  //    never fires for one, and a resumed run that lands nothing is on the FULL
  //    ladder, so the nudge simply no-ops (gated) and the 30s clock takes over;
  //  - it is bounded: one timer per State-B episode, re-armed only when the
  //    incomplete/scanning state actually changes.
  const selfHealPending =
    onWalletScreen &&
    state.account !== null &&
    !state.accountComplete &&
    state.accountStatus !== 'loading' &&
    state.scanProgress === null;
  useEffect(() => {
    if (!selfHealPending) return;
    const id = setTimeout(() => {
      if (!isUnlocked() || document.visibilityState !== 'visible') return;
      if (discovery().busy) return;
      const account = accountRef.current;
      if (!account) return;
      discovery().pollTick({
        network: state.network,
        account,
        accountComplete: accountCompleteRef.current,
        onChanged: () => refreshAccount(),
      });
    }, QUICK_SELF_HEAL_FOLLOWUP_MS);
    return () => clearTimeout(id);
  }, [selfHealPending, state.network, refreshAccount]);

  // ---- Navigation helpers -------------------------------------------------
  const goHome = useCallback(() => dispatch({ type: 'navigate', screen: 'home' }), []);

  // ---- Create flow --------------------------------------------------------
  function startCreate(): void {
    draftWordsRef.current = generateMnemonic().split(' ');
    dispatch({ type: 'startCreate' });
  }

  function revealContinue(): void {
    dispatch({ type: 'navigate', screen: 'confirm' });
  }

  function confirmDone(): void {
    dispatch({ type: 'navigate', screen: 'setPassword' });
  }

  // ---- Set password (create or restore) -----------------------------------
  async function submitPassword(password: string, enableFaceId: boolean): Promise<void> {
    const network = state.network;
    const mnemonic =
      state.flow === 'restore' ? restorePhraseRef.current : draftWordsRef.current?.join(' ') ?? null;
    if (mnemonic === null) throw new Error('missing phrase');

    await createVault(mnemonic, password, network);
    let passkeyEnabled = false;
    if (enableFaceId) {
      try {
        await enablePasskeyUnlock(mnemonic);
        passkeyEnabled = true;
      } catch {
        // Face ID setup failed; the password vault still works. Proceed.
      }
    }
    // Move the secret into the in-memory session, then clear the drafts.
    setUnlocked(mnemonic);
    draftWordsRef.current = null;
    restorePhraseRef.current = null;

    dispatch({ type: 'vaultCreated', network, passkeyEnabled });
    dispatch({ type: 'unlocked' });
    setFirstHomeVisit(true);
  }

  // ---- Restore flow -------------------------------------------------------
  function startRestore(): void {
    dispatch({ type: 'startRestore' });
  }

  function restoreValid(phrase: string): void {
    restorePhraseRef.current = phrase;
    dispatch({ type: 'navigate', screen: 'setPassword' });
  }

  // ---- Unlock -------------------------------------------------------------
  async function unlockPassword(password: string): Promise<boolean> {
    // F6: after a few wrong tries, add a short, growing delay before the next
    // attempt is even evaluated. Capped so a legitimate user isn't locked out.
    const fails = failedUnlocksRef.current;
    if (fails >= 3) {
      const delayMs = Math.min(2 ** (fails - 3) * 500, 5_000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const mnemonic = await unlockVault(password);
      setUnlocked(mnemonic);
      failedUnlocksRef.current = 0;
      dispatch({ type: 'unlocked' });
      setFirstHomeVisit(true);
      return true;
    } catch {
      failedUnlocksRef.current += 1;
      return false;
    }
  }

  async function unlockPasskey(): Promise<boolean> {
    try {
      const mnemonic = await unlockWithPasskey();
      setUnlocked(mnemonic);
      dispatch({ type: 'unlocked' });
      setFirstHomeVisit(true);
      return true;
    } catch {
      return false;
    }
  }

  // ---- Settings actions ---------------------------------------------------
  async function showPhrase(password: string): Promise<boolean> {
    try {
      // Verify by decrypting; the words are held in a ref (not React state) and
      // cleared on navigation away from the reveal.
      const mnemonic = await unlockVault(password);
      settingsRevealWordsRef.current = mnemonic.split(' ');
      setSettingsRevealActive(true);
      dispatch({ type: 'navigate', screen: 'reveal' });
      return true;
    } catch {
      return false;
    }
  }

  async function toggleFaceId(enable: boolean): Promise<void> {
    if (enable) {
      const mnemonic = getMnemonic();
      await enablePasskeyUnlock(mnemonic);
      dispatch({ type: 'setPasskeyEnabled', enabled: true });
    } else {
      disablePasskeyUnlock();
      dispatch({ type: 'setPasskeyEnabled', enabled: false });
    }
  }

  function switchNetwork(to: Network): void {
    // F13: kill the old network's in-flight discovery FIRST, so no
    // stale-network snapshot can dispatch after the switch; the setNetwork
    // reducer then blanks the account synchronously (a skeleton on switch is
    // correct at the practice/live trust boundary).
    discoveryRef.current?.abort();
    // §1b: invalidate the cache for the network we're switching TO, so the
    // balance we're about to show is fetched fresh — never a stale response for
    // the network the user just selected. The from-network's cache is keyed
    // separately (F13) and harmless; it too is invalidated on any switch back.
    invalidateScanCache(to);
    setVaultNetwork(to);
    applyNetworkTheme(to);
    dispatch({ type: 'setNetwork', network: to });
    dispatch({ type: 'navigate', screen: 'home' });
  }

  function deleteWallet(): void {
    // F24 (round 19): a CORRUPT vault must never block the wipe.
    // disablePasskeyUnlock READS the vault (it rewrites it sans passkey) and
    // throws VaultCorruptError on garbage — and the lock-screen wipe is
    // exactly the corrupted-state user's rescue path. Passkey cleanup is
    // best-effort; the deletion below removes the whole vault document —
    // passkey ciphertext included — regardless.
    try {
      disablePasskeyUnlock();
    } catch {
      /* corrupt vault — the deletion below still removes it wholesale */
    }
    deleteVaultStorage();
    // F23 (round 19): the send log maps this device to the wallet's on-chain
    // txids; "remove this wallet from this phone" must take it too.
    clearSendLog();
    lockNow();
    dispatch({ type: 'vaultDeleted' });
  }

  // ---- Receive -------------------------------------------------------------
  /**
   * The address Receive shows. Discovery only determines which index is next-
   * UNUSED; the wallet's own addresses are always derivable locally. So when
   * discovery hasn't succeeded (flaky network, still loading), fall back to a
   * locally-derived receive address — at the last cached next-unused index if
   * one was ever recorded for this network, else index 0 — so Receive ALWAYS
   * shows a real, spendable-to address of this wallet. Worst case is address
   * reuse; showing nothing (or an empty QR) is never acceptable.
   */
  function receiveDisplayAddress(): string {
    if (state.account) return state.account.receiveAddress;
    if (!isUnlocked()) return '';
    try {
      const index = getCachedReceiveIndex(state.network) ?? 0;
      return deriveReceiveAddress(getMnemonic(), state.network, index).address;
    } catch {
      // Derivation should never fail with an unlocked session; if it somehow
      // does, Receive renders its "can't show your address" state — never an
      // empty QR.
      return '';
    }
  }

  // ---- Send / Review ------------------------------------------------------
  function composeSend(pending: PendingSend): void {
    dispatch({ type: 'composeSend', pending });
  }

  // Dry-run the build to show accurate fee/total on Review, reusing the same
  // params the confirm step will use (idempotent). On ANY failure we return an
  // `ok: false` result so Review blocks sending and shows a "recheck this
  // payment" state — never fabricated $0-fee numbers on the last-chance money
  // screen (F4). The failure reason is discriminated so the copy is honest
  // (F10): a fee-guard trip explains the fee, everything else explains that the
  // available balance may have changed.
  function reviewNumbers(pending: PendingSend): ReviewNumbers {
    if (!state.account) return { ok: false, reason: 'stale' };
    try {
      const built = getMnemonicBuild(pending);
      const amountSats = pending.sendMax
        ? built.totalInputSats - built.feeSats
        : pending.amountSats;
      return {
        ok: true,
        amountSats,
        feeSats: built.feeSats,
        totalSats: amountSats + built.feeSats,
      };
    } catch (err) {
      // The UTXO set may have changed under a 30s poll (InsufficientFunds), or
      // the fee tripped the sanity guard (FeeTooHighError — the compose
      // pre-check shares the engine's own selection code so this normally can't
      // happen, but if it ever does the blocked state must offer a real
      // recovery, F11). Name the real cause and carry the real numbers; never
      // render numbers we can't stand behind.
      if (err instanceof FeeTooHighError) {
        return {
          ok: false,
          reason: 'fee-too-high',
          feeSats: err.feeSats,
          comparedToSats: err.comparedToSats,
        };
      }
      return { ok: false, reason: 'stale' };
    }
  }

  /**
   * Builds (but does not broadcast) the tx to read accurate accounting. Requires
   * a wallet change address; if one is somehow missing we throw rather than
   * defaulting change to any external address (F7 — fail closed, never overpay
   * the recipient).
   */
  function getMnemonicBuild(pending: PendingSend): ReturnType<typeof buildAndSignTx> {
    const changeAddress = state.account?.changeAddress;
    if (!changeAddress) throw new Error('missing change address');
    const mnemonic = getMnemonic();
    return buildAndSignTx({
      mnemonic,
      network: state.network,
      utxos: state.account?.utxos ?? [],
      recipient: pending.recipient,
      amountSats: pending.amountSats,
      feeRateSatVb: pending.feeRateSatVb,
      changeAddress,
      sendMax: pending.sendMax,
      allowHighFee: pending.allowHighFee,
    });
  }

  async function confirmSend(): Promise<void> {
    const pending = state.pendingSend;
    if (!pending || !state.account) throw new Error('nothing to send');
    // sendRecorded=false (a best-effort storage failure) never blocks a send —
    // it only means this payment won't be speed-up-able later (F15).
    const { txid } = await signAndBroadcast({
      network: state.network,
      utxos: state.account.utxos,
      recipient: pending.recipient,
      amountSats: pending.amountSats,
      feeRateSatVb: pending.feeRateSatVb,
      changeAddress: state.account.changeAddress,
      sendMax: pending.sendMax,
      allowHighFee: pending.allowHighFee,
    });
    dispatch({ type: 'sendBroadcast', txid });
    // Refresh so the pending tx shows up in activity.
    void refreshAll();
  }

  // ---- Speed up (RBF fee bump) --------------------------------------------
  // The Activity detail sheet owns the sub-flow's UI state; App owns the two
  // impure calls that read the mnemonic + touch the network, mirroring how
  // confirmSend wraps signAndBroadcast.

  /** Gathers everything the Speed-up offer needs (one network fetch). */
  async function speedUpPrepare(txid: string, signal?: AbortSignal): Promise<PreparedBump> {
    if (!state.account) throw new Error('no account loaded');
    return prepareBump(state.network, txid, state.account, signal);
  }

  /**
   * Builds + broadcasts the boosted replacement, then triggers the same full
   * refresh the send path uses so the replaced payment (new id) settles into
   * Activity. The sheet keeps its success state on screen until dismissed, so
   * this refresh never flashes a scary "the old payment vanished" intermediate.
   */
  async function speedUpConfirm(
    prepared: PreparedBump,
    feeRateSatVb: number,
    allowHighFee: boolean,
  ): Promise<void> {
    await bumpAndBroadcast({ network: state.network, prepared, feeRateSatVb, allowHighFee });
    void refreshAll();
  }

  // ---- Render -------------------------------------------------------------
  if (!state.booted) {
    return <div className="app" />;
  }

  const network = state.network;

  return (
    <div className="app">
      {renderScreen()}
      {explainerOpen ? (
        <Sheet onScrim={() => setExplainerOpen(false)}>
          <h2 className="sheet__title">{strings.explainer.heading}</h2>
          <p className="sheet__body">{strings.explainer.body}</p>
          <div className="sheet__actions">
            <button className="btn btn--primary btn--block" onClick={() => setExplainerOpen(false)}>
              {strings.explainer.dismiss}
            </button>
          </div>
        </Sheet>
      ) : null}
    </div>
  );

  function renderScreen(): JSX.Element {
    switch (state.screen) {
      case 'welcome':
        return <Welcome onCreate={startCreate} onRestore={startRestore} />;

      case 'reveal': {
        // Two contexts: create flow (draft words) or settings re-view.
        const settingsMode = settingsRevealActive;
        const words = settingsMode
          ? settingsRevealWordsRef.current ?? []
          : draftWordsRef.current ?? [];
        return (
          <Reveal
            network={network}
            words={words}
            mode={settingsMode ? 'settings' : 'create'}
            onContinue={revealContinue}
            onExit={() => {
              if (settingsMode) {
                clearSettingsReveal();
                dispatch({ type: 'navigate', screen: 'settings' });
              } else {
                // Leaving create abandons the draft phrase.
                draftWordsRef.current = null;
                dispatch({ type: 'navigate', screen: 'welcome' });
              }
            }}
          />
        );
      }

      case 'confirm':
        return (
          <Confirm
            network={network}
            words={draftWordsRef.current ?? []}
            onDone={confirmDone}
            onShowWords={() => {
              rerender();
              dispatch({ type: 'navigate', screen: 'reveal' });
            }}
            onBack={() => dispatch({ type: 'navigate', screen: 'reveal' })}
          />
        );

      case 'setPassword':
        return (
          <SetPassword
            network={network}
            passkeySupported={state.passkeySupported}
            onSubmit={submitPassword}
            onBack={() =>
              dispatch({
                type: 'navigate',
                screen: state.flow === 'restore' ? 'restore' : 'confirm',
              })
            }
          />
        );

      case 'restore':
        return (
          <Restore
            network={network}
            onValidPhrase={restoreValid}
            onBack={() => dispatch({ type: 'navigate', screen: 'welcome' })}
          />
        );

      case 'unlock':
        return (
          <Unlock
            network={network}
            passkeyEnabled={state.passkeyEnabled}
            passkeySupported={state.passkeySupported}
            onUnlockPassword={unlockPassword}
            onUnlockPasskey={unlockPasskey}
            onRestore={startRestore}
            // The locked-out last resort: the SAME single deletion routine the
            // Settings remove flow uses — never a parallel wipe path. Lands on
            // Welcome (vaultDeleted), where create/restore both start fresh.
            onWipe={deleteWallet}
          />
        );

      case 'home':
        return (
          <Home
            network={network}
            account={state.account}
            accountStatus={state.accountStatus}
            accountComplete={state.accountComplete}
            scanProgress={state.scanProgress}
            btcUsd={state.btcUsd}
            unit={unit}
            onCycleUnit={setUnit}
            firstVisit={firstHomeVisit}
            onReceive={() => dispatch({ type: 'navigate', screen: 'receive' })}
            onSend={() => dispatch({ type: 'navigate', screen: 'send' })}
            onSeeAll={() => dispatch({ type: 'navigate', screen: 'activity' })}
            onOpenActivity={(txid) => {
              setActivityFocusTxid(txid);
              dispatch({ type: 'navigate', screen: 'activity' });
            }}
            onSettings={() => {
              setFirstHomeVisit(false);
              dispatch({ type: 'navigate', screen: 'settings' });
            }}
            onRefresh={() => void refreshAll()}
          />
        );

      case 'receive':
        return (
          <Receive
            network={network}
            address={receiveDisplayAddress()}
            onBack={goHome}
          />
        );

      case 'send':
        if (!state.account) {
          // Shouldn't happen (Send is reached from Home after load), but guard.
          return (
            <Home
              network={network}
              account={null}
              accountStatus={state.accountStatus}
              accountComplete={state.accountComplete}
              btcUsd={state.btcUsd}
              unit={unit}
              onCycleUnit={setUnit}
              firstVisit={false}
              onReceive={() => dispatch({ type: 'navigate', screen: 'receive' })}
              onSend={() => dispatch({ type: 'navigate', screen: 'send' })}
              onSeeAll={() => dispatch({ type: 'navigate', screen: 'activity' })}
              onOpenActivity={(txid) => {
                setActivityFocusTxid(txid);
                dispatch({ type: 'navigate', screen: 'activity' });
              }}
              onSettings={() => dispatch({ type: 'navigate', screen: 'settings' })}
              onRefresh={() => void refreshAll()}
            />
          );
        }
        return (
          <Send
            network={network}
            account={state.account}
            btcUsd={state.btcUsd}
            fees={state.feeEstimates}
            onReview={composeSend}
            onBack={goHome}
          />
        );

      case 'review': {
        if (!state.pendingSend) return <div className="app" />;
        const nums = reviewNumbers(state.pendingSend);
        return (
          <Review
            network={network}
            pending={state.pendingSend}
            numbers={nums}
            btcUsd={state.btcUsd}
            onConfirm={confirmSend}
            onBack={() => dispatch({ type: 'navigate', screen: 'send' })}
            onAcceptHighFee={() => {
              // F11 recovery: re-compose the same payment with informed consent.
              // The dry-run then succeeds and the full review gate (numbers,
              // checkbox, Send now) still applies before anything is sent.
              if (state.pendingSend) {
                dispatch({
                  type: 'composeSend',
                  pending: { ...state.pendingSend, allowHighFee: true },
                });
              }
            }}
          />
        );
      }

      case 'sent': {
        const nums = state.pendingSend
          ? reviewNumbers(state.pendingSend)
          : ({ ok: false, reason: 'stale' } as const);
        const amt = nums.ok ? nums.amountSats : 0n;
        return (
          <Sent
            network={network}
            amountSats={amt}
            btcUsd={state.btcUsd}
            onDone={() => {
              dispatch({ type: 'clearSend' });
              goHome();
            }}
            onViewActivity={() => {
              dispatch({ type: 'clearSend' });
              dispatch({ type: 'navigate', screen: 'activity' });
            }}
          />
        );
      }

      case 'activity':
        return (
          <Activity
            network={network}
            items={state.account?.activity ?? []}
            status={state.accountStatus}
            btcUsd={state.btcUsd}
            account={state.account}
            fees={state.feeEstimates}
            onPrepareBump={speedUpPrepare}
            onBumpConfirm={speedUpConfirm}
            onBack={goHome}
            onRefresh={() => void refreshAll()}
            initialTxid={activityFocusTxid}
            onInitialTxidShown={() => setActivityFocusTxid(null)}
          />
        );

      case 'settings':
        return (
          <Settings
            network={network}
            passkeySupported={state.passkeySupported}
            passkeyEnabled={state.passkeyEnabled}
            onBack={goHome}
            onLockNow={() => {
              lockNow();
            }}
            onShowPhrase={showPhrase}
            onToggleFaceId={toggleFaceId}
            onSwitchNetwork={switchNetwork}
            onDelete={deleteWallet}
            onExplainer={() => setExplainerOpen(true)}
          />
        );

      default:
        return <Welcome onCreate={startCreate} onRestore={startRestore} />;
    }
  }
}
