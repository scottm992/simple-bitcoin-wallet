# Simple Bitcoin Wallet

A dead-simple, beginner-friendly Bitcoin wallet that runs entirely in your browser.

**Live app:** https://scottm992.github.io/simple-bitcoin-wallet/

- **Create a wallet** — generates a standard 12-word seed phrase (BIP39)
- **Receive bitcoin** — shows your address as text + QR code
- **Send bitcoin** — paste an address, enter an amount, review, send
- **Speed up a stuck payment** — if a payment is taking too long because its
  fee was low, tap "Speed up" to re-send it with a higher fee (BIP125 RBF)
- **Your keys never leave your device** — all key generation and transaction
  signing happens locally in the browser; the app only talks to the public
  [mempool.space](https://mempool.space) API for balances and broadcasting
- **Mainnet by default, testnet toggle** for practicing with worthless coins
- **Password-encrypted storage**, with optional Face ID / passkey unlock on
  supported devices (WebAuthn PRF)
- **Add it to your Home Screen** — installs like a real app (PWA): its own
  icon, full-screen launch, and the app shell opens even offline (checking
  your balance still needs a connection)

> ⚠️ **Status: new software.** The code has been through a nine-round adversarial
> security audit (see `docs/review/`) with all findings resolved, but it is young
> and lightly road-tested. Start in **Practice mode**, then use small amounts you
> can afford to lose. Known limitations: the app trusts mempool.space for chain
> data (it validates everything, but a compromised endpoint could still mislead
> the display); reusing a receive address reduces privacy; the unlock throttle is
> client-side only.

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
