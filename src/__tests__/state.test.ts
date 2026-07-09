import { describe, it, expect } from 'vitest';
import { reducer, initialState, type AppState } from '../state';

describe('reducer — screen state machine', () => {
  it('boots to unlock when a vault exists', () => {
    const s = reducer(initialState, {
      type: 'boot',
      hasVault: true,
      network: 'mainnet',
      passkeySupported: false,
      passkeyEnabled: false,
    });
    expect(s.booted).toBe(true);
    expect(s.screen).toBe('unlock');
    expect(s.hasVault).toBe(true);
  });

  it('boots to welcome when no vault exists', () => {
    const s = reducer(initialState, {
      type: 'boot',
      hasVault: false,
      network: 'testnet',
      passkeySupported: true,
      passkeyEnabled: false,
    });
    expect(s.screen).toBe('welcome');
    expect(s.network).toBe('testnet');
    expect(s.passkeySupported).toBe(true);
  });

  it('walks the create flow: welcome → reveal → confirm → setPassword → home', () => {
    let s: AppState = reducer(initialState, {
      type: 'boot',
      hasVault: false,
      network: 'mainnet',
      passkeySupported: false,
      passkeyEnabled: false,
    });
    s = reducer(s, { type: 'startCreate' });
    expect(s.screen).toBe('reveal');
    expect(s.flow).toBe('create');
    s = reducer(s, { type: 'navigate', screen: 'confirm' });
    expect(s.screen).toBe('confirm');
    s = reducer(s, { type: 'navigate', screen: 'setPassword' });
    expect(s.screen).toBe('setPassword');
    s = reducer(s, { type: 'vaultCreated', network: 'mainnet', passkeyEnabled: false });
    s = reducer(s, { type: 'unlocked' });
    expect(s.screen).toBe('home');
    expect(s.flow).toBe(null);
    expect(s.accountStatus).toBe('loading');
  });

  it('restore flow sets flow=restore and lands on restore screen', () => {
    const s = reducer(initialState, { type: 'startRestore' });
    expect(s.screen).toBe('restore');
    expect(s.flow).toBe('restore');
  });

  it('locking clears account + send state and returns to unlock', () => {
    let s: AppState = reducer(initialState, { type: 'unlocked' });
    s = reducer(s, { type: 'accountLoaded', account: { confirmedSats: 5n } as never, complete: true });
    s = reducer(s, { type: 'locked' });
    expect(s.screen).toBe('unlock');
    expect(s.account).toBe(null);
    expect(s.accountStatus).toBe('idle');
  });

  it('switching network throws away chain state and reloads', () => {
    let s: AppState = reducer(initialState, { type: 'unlocked' });
    s = reducer(s, { type: 'accountLoaded', account: { confirmedSats: 9n } as never, complete: true });
    s = reducer(s, { type: 'feesLoaded', feeEstimates: { fast: 5, medium: 3, slow: 1 } });
    // An incomplete snapshot was on screen; the switch must blank everything
    // SYNCHRONOUSLY in the reducer (F13) and reset the completeness flag (F12).
    s = { ...s, accountComplete: false };
    s = reducer(s, { type: 'setNetwork', network: 'testnet' });
    expect(s.network).toBe('testnet');
    expect(s.account).toBe(null);
    expect(s.feeEstimates).toBe(null);
    expect(s.accountStatus).toBe('loading');
    expect(s.accountComplete).toBe(true);
  });

  it('compose → broadcast → clear moves through review and sent', () => {
    const pending = {
      recipient: 'tb1qxyz',
      amountSats: 1000n,
      feeRateSatVb: 3,
      feeTier: 'standard' as const,
      sendMax: false,
      allowHighFee: false,
    };
    let s: AppState = reducer(initialState, { type: 'unlocked' });
    s = reducer(s, { type: 'composeSend', pending });
    expect(s.screen).toBe('review');
    expect(s.pendingSend).toEqual(pending);
    s = reducer(s, { type: 'sendBroadcast', txid: 'deadbeef' });
    expect(s.screen).toBe('sent');
    expect(s.sentTxid).toBe('deadbeef');
    s = reducer(s, { type: 'clearSend' });
    expect(s.pendingSend).toBe(null);
    expect(s.sentTxid).toBe(null);
  });

  it('deleting the vault returns to welcome and clears vault flag', () => {
    let s: AppState = reducer(initialState, {
      type: 'boot',
      hasVault: true,
      network: 'mainnet',
      passkeySupported: false,
      passkeyEnabled: false,
    });
    s = reducer(s, { type: 'vaultDeleted' });
    expect(s.screen).toBe('welcome');
    expect(s.hasVault).toBe(false);
  });
});
