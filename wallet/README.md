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

## Daily action logs

While running `npm run dev`, `npm run dev:tunnel`, or `npm run preview`, each call to
`connect()`, `mint()`, or `transfer()` appends one entry to `wallet/logs/YYYY-MM-DD`
(for example, `wallet/logs/2026-10-19`, with no file extension). Dates use
`Asia/Kuala_Lumpur` time. The directory is created automatically and ignored by Git.

```text
2026-10-19 13:10:00 Connect: {"response":{},"addresses":{},"network":{},"info":{}}
2026-10-19 13:10:05 Mint: {"txid":"example"}
2026-10-19 13:10:10 Transfer: {"error":{"name":"Error","message":"Request rejected"}}
```

Wallet responses are stored as JSON; connection entries also include address,
network, and wallet information. Calls stopped by validation store a status message.
Logging failures appear in the browser console and do not change the wallet result.
The `/__wallet-log` endpoint runs in Vite's development and preview servers; a
statically hosted build needs a backend implementing that endpoint to save files.

## Verify before using

Build the site before serving it:

```bash
npm run build
```

Test tokens only: this page deliberately refuses to mint when the wallet reports a mainnet network.
