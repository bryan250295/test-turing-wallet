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
- `/transaction?txid=<transaction-id>` filters and expands a linked transaction.
  HTLC lock, claim and refund links use this view. Transactions absent from the
  loaded wallet history are queried directly by TXID on Testnet.
- `/bridge-lab` opens Bridge Lab: Overview shows BitBus data, HTLC Testnet manages token locks, and My HTLC Requests lists locally saved token locks for the connected Testnet wallet.
- `/inquiry` redirects to `/bridge-lab` for existing links.

Navigation supports browser Back/Forward and direct page links. When deploying,
configure the web server to serve `index.html` for these frontend routes so direct
links and page reloads work. The wallet session is shared across routes; page-local
forms and filters reset when leaving a page.

## HTLC Testnet

Open **Bridge Lab → HTLC Testnet** and connect Turing Wallet on TBC Testnet.
The page provides **Create lock** and **Claim / Refund**. Native TBC is used for
transaction fees and protocol outputs; the locked asset is an FT token.

### Create a lock

The recipient field is a free-entry autocomplete. Typing filters previous
recipient addresses; its inline arrow opens the full list. Mouse/touch, arrow
keys and Enter select an address; Escape dismisses the list. New addresses can
also be typed or pasted directly.

Recipients are added to browser `localStorage` only after a lock submission
returns `submitted` (including a successful submission-status check). Review,
signing alone, rejected submissions and unknown outcomes do not add recipients.
This acknowledgement is not a claim of block confirmation. The cache keeps up to
100 distinct addresses in recent-use order, excluding the current sender from
suggestions. It is scoped to this browser/site and TBC Testnet. Clearing browser
site data clears the suggestions; if browser storage is blocked, the list works
in memory for that session and reports the storage failure.

The reusable input, hook and cache live in `RecipientAddressInput.tsx`,
`useRecipientSuggestions.ts` and `services/recipientCache.ts`. Filtering and
selection make no API calls. No contact-management screen, server address-book
API or address-book file writes are used. HTLC request records still use the
separate server storage described below.

1. Choose a token, enter the recipient address and token amount, then choose a
   future refund date/time.
2. Click **Review lock**. The browser generates a claim secret and hash; the
   server validates token funding, builds the transaction and calculates fees.
   No wallet signature or broadcast happens during review.
3. Review the amount, recipient, refund deadline and native costs, then click
   **Sign with wallet**. The server saves the claim secret encrypted, linked to
   the signed lock TXID, before allowing submission. If saving fails, signing
   reports an error and nothing is broadcast. You can also copy a private backup.
4. Click **Submit lock** to broadcast the verified transaction. **Submitted**
   is an acknowledgement, not block confirmation. Use **My requests** to check it.

If the review expires or the server restarts, use **Edit details** and review
again. Signing sessions remain temporary; saved request metadata does not restore
signatures. Creating another transaction does not cancel an existing signed one.

### Claim or refund

1. Select **Claim / Refund**. The backend loads saved requests and checks their
   chain status automatically. **Refresh requests** reloads the list. Completed, spent, unconfirmed
   or unchecked entries cannot be selected. Choose an available request. Selecting one checks
   its latest on-chain conditions. A request opened from My HTLC Requests is
   prefilled; click **Load request**. Public IDs can also be entered under
   **Find a request by transaction ID**.
2. The recipient can choose **Review claim**, enter the original claim secret,
   acknowledge its on-chain disclosure, then sign and submit. The recipient needs
   native test TBC for fees. The secret is sent to the local server to assemble
   the signed claim and becomes public when the claim is broadcast.
3. The sender can choose **Review refund** after Testnet median chain time is
   strictly past the refund deadline, then sign and submit. Refunds need no secret.
4. Check confirmation and balances through **My HTLC Requests**. Claim and refund
   spend the entire locked token output; only one can succeed. Claim remains
   possible after the refund deadline while the lock is unspent.

The server rechecks account/network, UTXOs, signatures, transaction structure,
fees and input scripts. Refund maturity uses `/api/tbc/nodeinfo`, with fresh checks
before signing, finalizing and submission. Missing chain-time data blocks refunds.
Unknown or rejected submissions have a read-only status check; there is no
automatic rebroadcast. A missing indexer result is not proof of rejection.

### My HTLC Requests and storage

**My HTLC Requests** automatically loads the connected wallet's saved history.
The filters appear as **All**, **Active**, **Completed**, with **All** selected by default.
**Active** includes pending or unverified requests.
**Completed** includes only successfully checked, confirmed claims/refunds;
**All** shows every saved record. Spent/unavailable outputs and status errors
are not treated as completed. Filter counts use the loaded wallet records and
switching filters makes no network request.

The sender sees **Refund**, disabled until chain time makes it eligible; the
recipient sees **Claim**. Completed rows offer **View details**. Every row has
that details action, opening a dialog with token identity, amount, participants,
deadline, confirmations, hashlock, related transactions and available fees.
Dates use MYT. Fees reuse existing backend decode results without extra requests;
missing fees are shown as Unavailable. The dialog header and Close button stay
visible while its content scrolls. Close or Escape dismisses the dialog.

Opening the tab or switching wallets requests saved records and chain status
from the backend in one workflow. **Refresh requests** repeats this workflow;
there is no per-row Check button or background polling. Both screens share up
to 200 public snapshots in browser memory and show the check time. Leaving the
view stops its UI updates; bounded shared backend checks may finish and be
reused by the next visitor.

The backend merges concurrent checks for the same wallet/page. Successful
responses are reused for up to 15 seconds (errors for 5 seconds), with at most
100 cached pages. A changed lock list or recovery TXID invalidates that page.
Shared wallet jobs run one at a time with a bounded waiting queue. Signing and
broadcasting always validate fresh chain conditions, bypassing this display cache.

List refresh uses `POST /__htlc/locks/status` with `{ "address": "..." }`.
The server reads that wallet's saved locks and associated recovery TXIDs; the
browser does not submit a lock list. Up to 25 locks are checked per response.
If `nextCursor` is returned, the browser requests the next page using the same
address and that cursor. The response has one success or error per
lock, so one unavailable transaction does not discard the successful results.
The server checks locks sequentially and reuses verified raw transactions, token
metadata and median chain time within that batch only. Each lock has a maximum
20-second check budget; a batch has at most 70 seconds, reduced by time already
spent waiting in the HTTP queue. Remaining entries receive an error if its time
budget expires or Testnet returns 429. Use **Refresh requests** to retry later.
No partial results are presented as newly verified locks. The existing single
inspection endpoint remains available for loading a specific lock.

Public lock resources:

| Method and path | Purpose |
| --- | --- |
| `GET /__htlc/locks?address=...` | List saved public records for that wallet; no chain refresh |
| `GET /__htlc/locks/:lockTxid` | Read one saved public record; 404 if absent |
| `POST /__htlc/locks` | Save validated public request metadata; does not lock or broadcast funds |
| `POST /__htlc/locks/status` | Inspect the wallet's saved locks on Testnet; body contains address and optional cursor |

These resources cover records stored by this app, not network-wide HTLC discovery.
Wallet addresses are public query filters, not authentication. Secret retrieval
remains a separate wallet-signature flow and is excluded from all lock responses.


The local HTLC API admits two operations at a time and queues up to eight more
in FIFO order. Ordinary overlap waits for a slot; only a full waiting queue
returns 429. Each HTTP request has a 90-second deadline covering body reading,
queueing, module loading and execution. Timeout returns 504; cancellation and
completion release the slot exactly once. This deadline does not reverse a
transaction already submitted to Testnet. Broadcasts are never automatically
retried. Restart the dev server to replace an older middleware instance.
Requests can also be added once using a prior receipt or their public IDs.

- Public metadata is saved as `wallet/storage/htlc/testnet/<lock-txid>.json`.
  Signing and broadcast attempts are recorded automatically. The server saves a
  pending record before contacting the node and updates it after the response,
  including when the browser disconnects.
- Files contain public metadata and up to ten recovery attempts per lock. Secret,
  signed/raw transaction data and signing-session IDs are excluded. Back up this
  folder and keep claim secrets privately, separately from request history.
- Old localStorage records migrate on first use. Switching browsers or clearing
  browser storage does not delete the server's files. Older JSON files that were
  never saved here need one import. The list covers this app's saved history;
  wallet-wide HTLC discovery would require an indexer.
- Claimed/Refunded require a matching recovery transaction and confirmations.
  Missing outputs show **Spent / unavailable**; errors preserve the last result
  with its check time. No background polling is enabled.
- Files are ignored by Git and blocked from static serving. Dev/preview servers
  provide the history API; static hosting alone does not provide persistence.

### Saved claim secrets

New locks save their secret when signing completes. Before signing, the secret
exists only in browser memory. Public request history still excludes secrets.

To retrieve one later, connect the original sender wallet and open **My HTLC
Requests → View details → Retrieve claim secret** (also available after loading a request in
**Claim / Refund**). Approve the ownership message in the wallet, then reveal or
copy the secret. This signature sends no transaction and costs no network fee.
Retrieval requires a short-lived, single-use challenge. The recipient still
needs the sender to share the secret deliberately; connecting B does not reveal it.

Encrypted records use AES-256-GCM and are saved under
`wallet/storage/htlc/secrets/<lock-txid>.json`. Back up the entire private folder,
including its hidden `.encryption-key` file. Losing that key prevents retrieval.
The key and encrypted records are on the same server: this trusts the app server
and its operator, and does not protect against server compromise. Neither secret
records nor the encryption key are served as static files or included in Git.

Older locks whose secrets were never saved cannot be recovered by this feature.
Keep their original secrets. Restart `npm run dev` after installing this change
to enable the retrieval endpoints. Wallet message signing and funded flows still
require hands-on verification with the wallet.

### Implementation

Components in `src/components/bridge` handle creation, review, submission,
recovery and history. Hooks manage wallet interactions and cancellation. Services
and server modules perform API reads, construction and verification. Tutorial
hash-matching exercises and the separate wallet-preparation screen were removed.

The server pins `tbc-contract@1.7.3` and `tbc-lib-js@1.0.31`; these SDKs stay out of
the browser bundle. Only ordinary legacy FT tokens are supported; TBC20 and
stablecoin proof adapters are not implemented. Local APIs accept reviewed terms
or server-issued build IDs, never arbitrary raw transactions for broadcasting.

This is a single-chain TBC Testnet HTLC. Cross-chain swaps are not implemented.
The UI cleanup does not establish successful on-chain claim/refund acceptance;
B's claim remains unverified because that account lacks native test TBC for fees.

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
