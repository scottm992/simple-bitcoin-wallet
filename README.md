# Simple Bitcoin Wallet

A dead-simple, beginner-friendly Bitcoin wallet that runs entirely in your browser.

- **Create a wallet** — generates a standard 12-word seed phrase (BIP39)
- **Receive bitcoin** — shows your address as text + QR code
- **Send bitcoin** — paste an address, enter an amount, review, send
- **Your keys never leave your device** — all key generation and transaction
  signing happens locally in the browser; the app only talks to the public
  [mempool.space](https://mempool.space) API for balances and broadcasting
- **Mainnet by default, testnet toggle** for practicing with worthless coins
- **Password-encrypted storage**, with optional Face ID / passkey unlock on
  supported devices (WebAuthn PRF)

> ⚠️ **Status: under construction.** Do not use with real funds yet.

## Security model

- 100% client-side static app — there is no server and nothing custodial
- Seed phrases are generated with [@scure/bip39](https://github.com/paulmillr/scure-bip39)
  and never transmitted anywhere
- The seed is stored only in your browser, encrypted (AES-GCM) with a key
  derived from your password (scrypt)
- Transactions are built and signed locally with
  [@scure/btc-signer](https://github.com/paulmillr/scure-btc-signer)

## Development

```bash
npm install
npm run dev     # local dev server
npm test        # unit tests
npm run build   # production build
```

## License

MIT
