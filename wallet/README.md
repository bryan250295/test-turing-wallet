# TBC Devnet Token Minter

A local, mobile-friendly DApp for creating a test fungible token (FT) through Turing Wallet.

## Safety model

- The app requires the wallet to report `network: "tbc"` and `type: "testnet"` before enabling minting.
- It sends the mint request to `api.tbcdev.org`.
- It never requests, stores, or transmits a seed phrase, private key, or wallet password.
- Minting needs a small TBC Devnet balance to pay the transaction fee.

## Run locally

```bash
cd wallet
npm run dev
```

Vite prints a LAN URL such as `http://192.168.1.10:5173`. With the phone and computer on the same Wi-Fi network, open that URL from Turing Wallet's built-in DApp browser. The wallet must inject `window.Turing`; opening the page in Safari or Chrome will show the “wallet not detected” message.

## Amounts

`amount` is submitted as raw smallest-unit amount. For example, `100000` with `decimal: 2` displays as `1000.00` tokens.

## Verify before using

Build the site before serving it:

```bash
npm run build
```

Test tokens only: this page deliberately refuses to mint when the wallet reports a mainnet network.
