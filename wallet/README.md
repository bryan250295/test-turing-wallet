# TBC Devnet Wallet App

A React and TypeScript DApp for minting and transferring test fungible tokens
through Turing Wallet, viewing UTXOs and transaction history, and querying BitBus.

## Safety model

- The app requires the wallet to report `network: "tbc"` and `type: "testnet"` before enabling minting.
- It sends the mint request to `api.tbcdev.org`.
- It never requests, stores, or transmits a seed phrase, private key, or wallet password.
- Minting needs a small TBC Devnet balance to pay the transaction fee.

## Run locally

```bash
cd wallet
npm install
npm run typecheck
npm run dev
```

These commands assume your terminal starts in `LearningMaterials`. If it is
already inside `wallet`, omit `cd wallet`. From `LearningMaterials`, you can also
use `npm --prefix wallet run dev` or `npm --prefix wallet run typecheck`.

Vite prints a LAN URL such as `http://192.168.1.10:5173`. With the phone and computer on the same Wi-Fi network, open that URL from Turing Wallet's built-in DApp browser. The wallet must inject `window.Turing`; opening the page in Safari or Chrome will show the “wallet not detected” message.

## TypeScript and project structure

The app and local logging server use TypeScript with strict checking. Use `.tsx`
for JSX components and `.ts` for hooks, services, helpers, and configuration.

```text
wallet/
├── server/
│   └── walletLogger.ts       # Daily log endpoint for Vite dev/preview
├── src/
│   ├── components/
│   │   └── WalletConnection.tsx
│   ├── config/
│   │   └── constants.ts
│   ├── hooks/
│   │   ├── useInquiry.ts
│   │   ├── useTransactionHistory.ts
│   │   ├── useUtxos.ts
│   │   └── useWalletSession.ts
│   ├── pages/
│   │   ├── BridgeLabPage.tsx
│   │   ├── TransactionPage.tsx
│   │   ├── UtxoPage.tsx
│   │   └── WalletPage.tsx
│   ├── services/
│   │   ├── actionLog.ts
│   │   ├── apiClient.ts
│   │   ├── apiValidation.ts
│   │   ├── bitbusApi.ts
│   │   ├── tbcApi.ts
│   │   ├── transactionHistory.ts
│   │   └── utxos.ts
│   ├── styles/
│   │   └── global.css
│   ├── types/               # api.ts, wallet.ts, transaction.ts, utxo.ts
│   ├── utils/               # errors.ts, tokenAmounts.ts, transactions.ts
│   ├── App.tsx              # Routes and shared wallet session
│   └── main.tsx             # Browser entry point
├── tsconfig.json
└── vite.config.ts
```

Page UI uses custom React hooks for loading, errors, refresh, and cancellation.
Services own HTTP calls, response validation, and history aggregation. Pure
formatting and calculation functions belong in `utils`; shared contracts belong
in `types`. The current fetching flow remains based on React hooks.

```bash
npm run typecheck        # Compile-time checking without generating files
npm run typecheck:watch  # Continuous checking while developing
npm run build           # Type checking, then production compilation into dist/
```

Vite's development server transpiles TypeScript without checking types; use the
editor or the watch command for feedback. The build fails on type errors.
API responses enter as unknown data and essential fields are checked at runtime;
TypeScript types alone cannot validate external responses. Amounts may be strings
to preserve integer precision. New API fields can still be inspected in raw data.
Tabs use a display width of four.

## Page routes

- `/` redirects to `/wallet`.
- `/wallet` opens the wallet page.
- `/utxo` opens the UTXO list.
- `/transaction` opens transaction history.
- `/bridge-lab` opens Bridge Lab: Overview shows the existing BitBus data, and HTLC Testnet is a blank tab reserved for future work.
- `/inquiry` redirects to `/bridge-lab` for existing links.

Navigation supports browser Back/Forward and direct page links. When deploying,
configure the web server to serve `index.html` for these frontend routes so direct
links and page reloads work. The wallet session is shared across routes; page-local
forms and filters reset when leaving a page.

## Amounts

- Mint: the initial `amount` uses raw smallest units. For example, `100000` with
  `decimal: 2` represents `1000` tokens.
- Transfer: enter the token amount you want to send, such as `10.5`. The app checks
  its precision and balance; the wallet receives this amount in token units.
- UTXO amounts retain the API's raw units. Transaction fees display in TBC.

## Daily action logs

While running `npm run dev` or `npm run preview`, each call to
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
