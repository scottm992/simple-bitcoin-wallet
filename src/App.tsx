import type { JSX } from 'react';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import './theme.css';
import { reducer, initialState } from './state';
import type { PendingSend } from './state';
import {
  createVault,
  deleteVault as deleteVaultStorage,
  disablePasskeyUnlock,
  enablePasskeyUnlock,
  generateMnemonic,
  isPasskeyEnabled,
  isPasskeySupported,
  setVaultNetwork,
  unlockVault,
  unlockWithPasskey,
  vaultExists,
  getVaultNetwork,
  buildAndSignTx,
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
import { loadAccount, loadFees, loadPrice, signAndBroadcast } from './actions';
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
import { Review } from './screens/Review';
import { Sent } from './screens/Sent';
import { Activity } from './screens/Activity';
import { Settings } from './screens/Settings';
import { Sheet } from './components/ui';
import { strings } from './strings';

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

  // Which activity txid to auto-open when navigating from Home (optional).
  const [explainerOpen, setExplainerOpen] = useState(false);

  // ---- Boot: detect existing vault, install session guards ----------------
  useEffect(() => {
    const network = getVaultNetwork() ?? 'mainnet';
    applyNetworkTheme(network);
    dispatch({
      type: 'boot',
      hasVault: vaultExists(),
      network,
      passkeySupported: isPasskeySupported(),
      passkeyEnabled: isPasskeyEnabled(),
    });
    const teardown = installSessionGuards();
    const unsub = onLock(() => {
      // Wipe any in-flight draft secrets and route to Unlock.
      draftWordsRef.current = null;
      restorePhraseRef.current = null;
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
  const refreshAll = useCallback(async () => {
    if (!isUnlocked()) return;
    const network = state.network;
    dispatch({ type: 'accountLoading' });
    // Price + fees are independent and non-blocking.
    void loadPrice().then((btcUsd) => dispatch({ type: 'priceLoaded', btcUsd }));
    void loadFees(network)
      .then((feeEstimates) => dispatch({ type: 'feesLoaded', feeEstimates }))
      .catch(() => {
        /* fees unavailable; Send disables Review until present */
      });
    try {
      const account = await loadAccount(network);
      dispatch({ type: 'accountLoaded', account });
    } catch {
      dispatch({ type: 'accountError' });
    }
  }, [state.network]);

  // Load whenever we're on a wallet screen and unlocked.
  const onWalletScreen =
    state.screen === 'home' ||
    state.screen === 'receive' ||
    state.screen === 'send' ||
    state.screen === 'activity' ||
    state.screen === 'settings';

  useEffect(() => {
    if (onWalletScreen && isUnlocked() && state.accountStatus === 'loading' && state.account === null) {
      void refreshAll();
    }
  }, [onWalletScreen, state.accountStatus, state.account, refreshAll]);

  // Poll every 30s while unlocked + visible.
  useEffect(() => {
    if (!onWalletScreen) return;
    const id = setInterval(() => {
      if (isUnlocked() && document.visibilityState === 'visible') {
        void refreshAll();
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [onWalletScreen, refreshAll]);

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
    try {
      const mnemonic = await unlockVault(password);
      setUnlocked(mnemonic);
      dispatch({ type: 'unlocked' });
      setFirstHomeVisit(true);
      return true;
    } catch {
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
    setVaultNetwork(to);
    applyNetworkTheme(to);
    dispatch({ type: 'setNetwork', network: to });
    dispatch({ type: 'navigate', screen: 'home' });
  }

  function deleteWallet(): void {
    disablePasskeyUnlock();
    deleteVaultStorage();
    lockNow();
    dispatch({ type: 'vaultDeleted' });
  }

  // ---- Send / Review ------------------------------------------------------
  function composeSend(pending: PendingSend): void {
    dispatch({ type: 'composeSend', pending });
  }

  // Dry-run the build to show accurate fee/total on Review, reusing the same
  // params the confirm step will use (idempotent).
  function reviewNumbers(pending: PendingSend): { amountSats: bigint; feeSats: bigint; totalSats: bigint } {
    if (!state.account) return { amountSats: pending.amountSats, feeSats: 0n, totalSats: pending.amountSats };
    try {
      const built = getMnemonicBuild(pending);
      const amountSats = pending.sendMax
        ? built.totalInputSats - built.feeSats
        : pending.amountSats;
      return {
        amountSats,
        feeSats: built.feeSats,
        totalSats: amountSats + built.feeSats,
      };
    } catch {
      // If the build can't complete (shouldn't happen after compose validation),
      // fall back to the composed numbers.
      return {
        amountSats: pending.amountSats,
        feeSats: 0n,
        totalSats: pending.amountSats,
      };
    }
  }

  /** Builds (but does not broadcast) the tx to read accurate accounting. */
  function getMnemonicBuild(pending: PendingSend): ReturnType<typeof buildAndSignTx> {
    const mnemonic = getMnemonic();
    return buildAndSignTx({
      mnemonic,
      network: state.network,
      utxos: state.account?.utxos ?? [],
      recipient: pending.recipient,
      amountSats: pending.amountSats,
      feeRateSatVb: pending.feeRateSatVb,
      changeAddress: state.account?.changeAddress ?? pending.recipient,
      sendMax: pending.sendMax,
    });
  }

  async function confirmSend(): Promise<void> {
    const pending = state.pendingSend;
    if (!pending || !state.account) throw new Error('nothing to send');
    const txid = await signAndBroadcast({
      network: state.network,
      utxos: state.account.utxos,
      recipient: pending.recipient,
      amountSats: pending.amountSats,
      feeRateSatVb: pending.feeRateSatVb,
      changeAddress: state.account.changeAddress,
      sendMax: pending.sendMax,
    });
    dispatch({ type: 'sendBroadcast', txid });
    // Refresh so the pending tx shows up in activity.
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
            onUnlockPassword={unlockPassword}
            onUnlockPasskey={unlockPasskey}
            onRestore={startRestore}
          />
        );

      case 'home':
        return (
          <Home
            network={network}
            account={state.account}
            accountStatus={state.accountStatus}
            btcUsd={state.btcUsd}
            unit={unit}
            onCycleUnit={setUnit}
            firstVisit={firstHomeVisit}
            onReceive={() => dispatch({ type: 'navigate', screen: 'receive' })}
            onSend={() => dispatch({ type: 'navigate', screen: 'send' })}
            onSeeAll={() => dispatch({ type: 'navigate', screen: 'activity' })}
            onOpenActivity={() => dispatch({ type: 'navigate', screen: 'activity' })}
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
            address={state.account?.receiveAddress ?? ''}
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
              btcUsd={state.btcUsd}
              unit={unit}
              onCycleUnit={setUnit}
              firstVisit={false}
              onReceive={() => dispatch({ type: 'navigate', screen: 'receive' })}
              onSend={() => dispatch({ type: 'navigate', screen: 'send' })}
              onSeeAll={() => dispatch({ type: 'navigate', screen: 'activity' })}
              onOpenActivity={() => dispatch({ type: 'navigate', screen: 'activity' })}
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
            amountSats={nums.amountSats}
            feeSats={nums.feeSats}
            totalSats={nums.totalSats}
            btcUsd={state.btcUsd}
            onConfirm={confirmSend}
            onBack={() => dispatch({ type: 'navigate', screen: 'send' })}
          />
        );
      }

      case 'sent': {
        const amt = state.pendingSend
          ? reviewNumbers(state.pendingSend).amountSats
          : 0n;
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
            onBack={goHome}
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
