/**
 * App.wipe.test.tsx — round-19 findings F23/F24, pinned at the App level
 * (deleteWallet is App-internal, so the honest test drives the real flow):
 *  - F24: a CORRUPT vault must not block the lock-screen wipe — the wipe is
 *    exactly the corrupted-state user's rescue, and disablePasskeyUnlock's
 *    vault read throws on garbage;
 *  - F23: the wipe removes the send log too — the log maps this device to the
 *    wallet's on-chain txids, so it must not outlive "remove this wallet".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../App';
import { strings } from '../strings';
import { SEND_LOG_STORAGE_KEY } from '../lib';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VAULT_KEY = 'sbw.vault.v1';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function btn(text: string): HTMLButtonElement | null {
  for (const b of container.querySelectorAll('button')) {
    if (b.textContent?.trim() === text) return b as HTMLButtonElement;
  }
  return null;
}

async function click(text: string): Promise<void> {
  const b = btn(text);
  expect(b, `button "${text}"`).not.toBeNull();
  await act(async () => b!.click());
}

describe('App — the lock-screen wipe survives a corrupt vault (F24) and takes the send log (F23)', () => {
  it('corrupt vault + leftover send log: the full wipe flow still lands on Welcome with both gone', async () => {
    // A vault too corrupt to parse — the state that used to make the wipe
    // throw before deleting anything — plus a send log from past broadcasts.
    localStorage.setItem(VAULT_KEY, '{corrupt%%%not-json');
    localStorage.setItem(
      SEND_LOG_STORAGE_KEY,
      JSON.stringify({ version: 1, mainnet: [], testnet: [] }),
    );

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    // The vault key exists, so App boots to Unlock.
    expect(container.textContent).toContain(strings.unlock.forgot);

    await click(strings.unlock.forgot);
    await click(strings.unlock.forgotWipe);
    const check = container.querySelector<HTMLButtonElement>('.check-row');
    expect(check).not.toBeNull();
    await act(async () => check!.click());
    await click(strings.unlock.wipeConfirm);

    // F24: the wipe completed despite the corrupt vault…
    expect(localStorage.getItem(VAULT_KEY)).toBeNull();
    // …F23: and took the send log with it…
    expect(localStorage.getItem(SEND_LOG_STORAGE_KEY)).toBeNull();
    // …landing on Welcome, ready to start fresh.
    expect(container.textContent).toContain(strings.welcome.create);
  });
});
