/**
 * session.ts — the ONLY place the decrypted mnemonic lives while unlocked.
 *
 * Secrets hygiene contract (the reviewer checks this hard):
 * - The mnemonic is held in a module-level ref (`mnemonicRef.current`), never in
 *   React state (which can be serialized by devtools), never in localStorage /
 *   sessionStorage / URLs, never logged, never in an error message.
 * - React never receives the mnemonic as a prop or state value. Code that needs
 *   to sign or reveal calls {@link withMnemonic} / {@link getMnemonic}
 *   synchronously, uses it, and lets it fall out of scope.
 * - Auto-lock clears the ref after 5 minutes of no interaction, and on returning
 *   to a tab that was hidden for > 60s. `lockNow()` clears it immediately.
 *
 * This module owns only the secret + the idle timers. It exposes a tiny
 * subscribe API so the app can navigate to Unlock when a lock happens.
 */

/** Idle auto-lock: clear the mnemonic after this long with no interaction. */
const IDLE_LOCK_MS = 5 * 60 * 1000;

/** Hidden-tab auto-lock: if the tab was hidden this long, lock on return. */
const HIDDEN_LOCK_MS = 60 * 1000;

/** The single in-memory home of the decrypted mnemonic. */
const mnemonicRef: { current: string | null } = { current: null };

/** Wall-clock time of the last user interaction, for the idle check. */
let lastActivity = 0;

/** Wall-clock time the tab became hidden, or null while visible. */
let hiddenSince: number | null = null;

/** Idle timer handle. */
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Listeners notified when the wallet locks (mnemonic cleared). */
const lockListeners = new Set<() => void>();

/** True while the wallet is unlocked (mnemonic present). */
export function isUnlocked(): boolean {
  return mnemonicRef.current !== null;
}

/**
 * Runs `fn` with the decrypted mnemonic, if unlocked. The mnemonic is passed in
 * and must not be captured beyond the call. Returns `fn`'s result, or throws
 * {@link LockedError} if locked.
 */
export function withMnemonic<T>(fn: (mnemonic: string) => T): T {
  const m = mnemonicRef.current;
  if (m === null) throw new LockedError();
  return fn(m);
}

/** Thrown when a secret-requiring operation runs while locked. */
export class LockedError extends Error {
  constructor() {
    super('Wallet is locked');
    this.name = 'LockedError';
  }
}

/**
 * Returns the mnemonic for immediate synchronous use, or throws if locked. Use
 * {@link withMnemonic} where possible; this exists for call sites that must hand
 * the value straight to an engine function.
 */
export function getMnemonic(): string {
  const m = mnemonicRef.current;
  if (m === null) throw new LockedError();
  return m;
}

/**
 * Stores the freshly-decrypted mnemonic and starts the idle timer. Called right
 * after a successful unlock / create / restore.
 */
export function setUnlocked(mnemonic: string): void {
  mnemonicRef.current = mnemonic;
  hiddenSince = null;
  noteActivity();
  startIdleTimer();
}

/** Clears the mnemonic and notifies listeners (navigate to Unlock). */
export function lockNow(): void {
  if (mnemonicRef.current === null) return;
  mnemonicRef.current = null;
  stopIdleTimer();
  for (const l of lockListeners) l();
}

/** Subscribe to lock events. Returns an unsubscribe function. */
export function onLock(listener: () => void): () => void {
  lockListeners.add(listener);
  return () => lockListeners.delete(listener);
}

/** Records user interaction to defer the idle auto-lock. */
export function noteActivity(): void {
  lastActivity = Date.now();
}

function startIdleTimer(): void {
  stopIdleTimer();
  idleTimer = setInterval(() => {
    if (mnemonicRef.current === null) return;
    if (Date.now() - lastActivity >= IDLE_LOCK_MS) {
      lockNow();
    }
  }, 15_000);
}

function stopIdleTimer(): void {
  if (idleTimer !== null) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

/** Handles tab visibility for the hidden-tab auto-lock. */
function handleVisibility(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'hidden') {
    hiddenSince = Date.now();
  } else {
    // Became visible again: if it was hidden too long, lock.
    if (hiddenSince !== null && Date.now() - hiddenSince >= HIDDEN_LOCK_MS) {
      lockNow();
    }
    hiddenSince = null;
    noteActivity();
  }
}

/**
 * Installs global activity + visibility listeners. Call once at app start.
 * Returns a teardown function (used by StrictMode double-invoke cleanup).
 */
export function installSessionGuards(): () => void {
  if (typeof window === 'undefined') return () => {};
  const activity = (): void => noteActivity();
  const events: (keyof WindowEventMap)[] = [
    'pointerdown',
    'keydown',
    'touchstart',
    'scroll',
    'focus',
  ];
  for (const e of events) window.addEventListener(e, activity, { passive: true });
  document.addEventListener('visibilitychange', handleVisibility);
  return () => {
    for (const e of events) window.removeEventListener(e, activity);
    document.removeEventListener('visibilitychange', handleVisibility);
  };
}
