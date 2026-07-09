import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Service-worker registration (offline-openable app shell + installability).
// PROD ONLY: in dev, a service worker would cache Vite's HMR modules and fight
// hot reload, so dev + HMR stay completely SW-free. BASE_URL carries the GitHub
// Pages subpath (base: './' → './sw.js', resolved against the document url), so
// the worker registers at the app's own scope. Registration is best-effort: any
// failure is swallowed — the wallet works identically with or without the SW.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* no-op: the app functions fully without the service worker */
    });
  });
}
