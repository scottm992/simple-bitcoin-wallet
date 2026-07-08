/**
 * Chrome.tsx — the per-screen frame: top bar, optional Practice banner, body.
 *
 * Every screen renders `<Chrome …>` so the banner reliably appears directly
 * under the top bar on every screen in Practice mode, and the back/gear controls
 * live in a consistent place.
 */
import type { JSX, ReactNode } from 'react';
import { TopBar, PracticeBanner } from './ui';

export function Chrome(props: {
  network: 'mainnet' | 'testnet';
  onBack?: (() => void) | undefined;
  title?: string | undefined;
  brand?: boolean | undefined;
  right?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <>
      <TopBar onBack={props.onBack} title={props.title} brand={props.brand} right={props.right} />
      {props.network === 'testnet' ? <PracticeBanner /> : null}
      {props.children}
    </>
  );
}
