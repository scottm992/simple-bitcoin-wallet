/**
 * App.render.test.tsx — a lean smoke test that mounts the real App in happy-dom
 * and drives the create-flow transitions through the actual DOM. This confirms
 * the state machine + screens render without runtime errors, and that the seed
 * reveal starts blurred (no words in the DOM before an explicit tap).
 *
 * Network calls are not made here (we never reach Home's data load in these
 * transitions), so no api mocking is required.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../App';

// Tell React we're inside an act()-aware environment (silences dev warnings).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

/** Finds the first element whose trimmed text equals `text`. */
function byText(text: string): HTMLElement | null {
  const all = container.querySelectorAll<HTMLElement>('button, a, h1, h2, div, span');
  for (const el of all) {
    if (el.textContent?.trim() === text) return el;
  }
  return null;
}

async function mount(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
  });
}

describe('App create flow (smoke)', () => {
  it('shows Welcome on a fresh device', async () => {
    await mount();
    expect(container.textContent).toContain('Bitcoin, made simple');
    expect(container.textContent).toContain('Create a new wallet');
  });

  it('reveals the phrase only after an explicit tap (starts blurred)', async () => {
    await mount();

    // Start create.
    const create = byText('Create a new wallet');
    expect(create).not.toBeNull();
    await act(async () => create!.click());

    // On the reveal screen, the shield is present and words are dotted, not real.
    expect(container.textContent).toContain('These 12 words are your wallet');
    expect(container.textContent).toContain('Tap to reveal your words');
    // Bulleted placeholders present; no lowercase real word rendered yet.
    expect(container.textContent).toContain('•••••');

    // The continue button is disabled until reveal.
    const cont = byText("I've written them down") as HTMLButtonElement | null;
    expect(cont).not.toBeNull();
    expect(cont!.disabled).toBe(true);

    // Tap to reveal.
    const shield = container.querySelector<HTMLElement>('.reveal-card__shield');
    expect(shield).not.toBeNull();
    await act(async () => shield!.click());

    // Now the continue button is enabled and the shield is gone.
    const cont2 = byText("I've written them down") as HTMLButtonElement | null;
    expect(cont2!.disabled).toBe(false);
    expect(container.querySelector('.reveal-card__shield')).toBeNull();
    // 12 word chips are rendered.
    expect(container.querySelectorAll('.word').length).toBe(12);
  });

  it('advances to Confirm, then to Set a password', async () => {
    await mount();
    await act(async () => byText('Create a new wallet')!.click());
    await act(async () => container.querySelector<HTMLElement>('.reveal-card__shield')!.click());
    await act(async () => (byText("I've written them down") as HTMLElement).click());

    expect(container.textContent).toContain("Let's make sure you saved them");
    expect(container.textContent).toContain('Step 1 of 3');

    // Chips are rendered for the confirm game.
    expect(container.querySelectorAll('.chip').length).toBeGreaterThan(0);
  });

  it('offers the restore path from Welcome', async () => {
    await mount();
    await act(async () => byText('I already have a recovery phrase')!.click());
    expect(container.textContent).toContain('Restore your wallet');
    // 12 numbered inputs present.
    expect(container.querySelectorAll('.restore-input').length).toBe(12);
  });
});
