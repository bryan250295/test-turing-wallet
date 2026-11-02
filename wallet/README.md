# TBC Devnet Wallet App

A React and TypeScript DApp for minting and transferring test fungible tokens
through Turing Wallet, viewing UTXOs and transaction history, and querying BitBus.

## Safety model

- The app requires the wallet to report `network: "tbc"` and `type: "testnet"` before enabling minting.
- It sends the mint request to `api.tbcdev.org`.
- It never requests or stores your Turing/MetaMask seed phrase, private key or wallet password. Separately generated bridge custody keys are encrypted on the backend.
- Minting needs a small TBC Devnet balance to pay the transaction fee.

## Run locally

The application now uses React + NestJS + PostgreSQL in Docker Compose.
From the repository root:

```bash
node scripts/setup-local.mjs
docker compose up --build -d
```

For subsequent starts, use `docker compose up`. Open `http://localhost:5173`.
Connect Turing Wallet on Testnet. Refreshing the page restores an existing login
session without requesting a new signature. Only an explicit **Connect wallet**
or **Reconnect** action can request a login signature when needed, then load HTLC
requests. Account/network changes do not request signatures by themselves. If
you cancel the signature or the session expires, click **Reconnect** to retry.
This is an ownership message signature, not a funds transaction.

HTLC forms reset when you leave their tab, including when switching between
Create lock and Claim / Refund. Inputs, secrets, reviews and submission messages
are discarded; saved request history stays in the database. Selecting Claim or
Refund from My HTLC Requests opens a fresh form with that request selected.

See [backend architecture and migration / 后端与迁移说明](../docs/backend-architecture.md)
for DBeaver connection details, volumes, secrets, backups and production builds.
`npm run dev` in `wallet/` starts only the frontend; the backend must also be running.

## Bridge order preparation

After **Deployment verified**, load Mega Token (MT) again and use **Verify selected
FT** for a fresh source check. In **Testnet Bridge → Bridge orders**:

1. Refresh saved orders and choose your verified lwFT contract.
2. Enter an MT amount (up to 1 decimal) and review the HyperEVM receiving address.
   It defaults to the connected MetaMask account; a different receiving address
   may be entered explicitly.
3. Click **Review order**, check the frozen terms, then **Save prepared order**.
4. View its prepared status and encrypted custody allocation in Saved orders.
   A preparation can be closed before its payment details have been opened.
5. Acknowledge custody and click **Open payment details**. In Turing Wallet send
   the exact MT amount to this order's custody address, paying its native TBC fee.
6. Paste the transfer TXID and click **Verify source deposit**. Use **Recheck source
   deposit** until at least 6 confirmations are verified. Do not pay again if a read fails.
7. Select the saved admin in MetaMask, estimate and confirm unpause if needed.
   Check its transaction status until verified. Then select the minter, estimate
   mint, review the amount/recipient/fee, and confirm mint in MetaMask.
8. Check the mint transaction status until **Completed**, then **Add lwFT to
   MetaMask** and view the receiving account on HyperEVM Testnet (998).

Preparation alone sends no transaction and has no gas fee. Opening payment details
is explicit and retains the address permanently; there is no automatic refund or
payment expiry. Only one ordinary legacy MT transfer group with the exact amount
is accepted. Source verification trusts the fixed tbcdev node/indexer and also
checks raw scripts, amounts and custody; it is not an independent SPV verifier.

After a timeout, refresh saved progress and check wallet Activity before retrying.
Public hashes returned by MetaMask are retained for recovery if an API save fails.
Discard an awaiting-wallet request only after checking that it was never sent;
discarding cannot cancel a pending transaction. The backend never signs with your
MetaMask key. Leaving the tab clears inputs; orders and receipts remain in PostgreSQL.
The first funded transfer and 1,000,000 lwFT MetaMask balance were accepted on
2026-10-29. Comprehensive error scenarios and reverse redemption remain unverified.

### Reverse bridge preparation

The chosen design keeps existing lwFT and permanently escrows redeemed tokens;
its totalSupply does not decrease. In a completed order, use **Reverse bridge ·
permanent lwFT escrow → Preview escrow deployment** with the original MetaMask admin.
The read-only preview checks this order's MT reserves and estimates a new, initially
paused escrow's deployment fee. Use **Prepare escrow deployment**, review the saved
quote, then **Deploy escrow with MetaMask**. Keep the wallet panel open for its request.
**Check escrow deployment status** verifies at least 6 confirmations and the saved
constructor/runtime and initially paused, zero-locked state. Refresh restores saved
records without sending again; Activity hashes support uncertain-send recovery.
Token approval, token locking and MT release remain disabled until the release path
is connected. See bridge guide section 11 for the full deployment/recovery flow.

Compile the independent escrow artifact from `wallet/`:

```bash
node scripts/compileBridgeContract.mjs --redemption
```

Token import acknowledges the existing wallet display only. Its button disables
after approval in the current page/account context; cancellation preserves the
completed mint. Reloading may offer import again; the app cannot reliably detect
whether an externally managed wallet still displays the token.

## TypeScript and project structure

```text
wallet/src/             React pages, components, hooks and browser wallet services
backend/src/            NestJS controllers, services, repositories and TBC SDK engine
backend/prisma/         Database model and committed SQL migrations
shared/src/             Shared types, validation, read-only chain clients and pure helpers
wallet/contracts/       Experimental HyperEVM Solidity contract
```

The old Vite middleware in `wallet/server/` has moved to NestJS. Vite now proxies
API requests to the backend; it no longer owns persistence or transaction construction.

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
- `/bridge-lab` opens Bridge Lab: Overview shows BitBus data, Testnet Bridge connects both learning-bridge wallets, HTLC Testnet manages token locks, and My HTLC Requests lists locally saved token locks for the connected Testnet wallet.
- `/inquiry` redirects to `/bridge-lab` for existing links.

Navigation supports browser Back/Forward and direct page links. When deploying,
configure the web server to serve `index.html` for these frontend routes so direct
links and page reloads work. The wallet session is shared across routes; page-local
forms and filters reset when leaving a page.

## Testnet Bridge wallet setup

Open **Bridge → Testnet Bridge**. The source card reuses the shared Turing
Wallet session on TBC Testnet. The destination card connects the MetaMask browser
extension and displays its selected account, chain ID and native test HYPE balance.
The experiment is TBC FT → Learning Wrapped Test FT (`lwFT`), custodial Lock and
Mint, 1:1 with matching decimals. The page also provides saved orders, explicit
payment details, source verification and wallet-confirmed settlement, as described
in the order workflow above.

Use **Load / refresh FT tokens** after connecting Turing Wallet, then select a
token by Contract ID. The app reads metadata for that exact ID and displays its
name, symbol and decimals. It does not infer asset identity from a token name or
default to native TBC's six decimals. Selection is cleared on wallet/network/tab
changes and before a new metadata read; cancelled or stale reads cannot restore it.
These are metadata previews. Click **Verify selected FT** after completing wallet
login to have NestJS verify the approved MT genesis and save its configuration in
`bridge_assets`. The approved asset is Contract ID
`ac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c`,
Mega Token (MT), 1 decimal, legacy FT v3. Verification sends no transaction and
charges no network fee. It does not prove a deposit or deploy / mint lwFT.
TBC20 and stablecoin adapters are not implemented. Native TBC and HYPE still pay
network fees for future transfers and deployment.

After verifying MT, use **Deployment preview → Estimate deployment fee**.
The connected MetaMask account is the deployer and, by default, Admin and Minter;
uncheck the option to enter separate public role addresses. NestJS encodes the
server's compiled contract for chain 998 and estimates gas, the current gas price,
a budget with 20% extra gas units, and the balance shortfall. Quotes expire after
60 seconds; source verification must be less than 10 minutes old. Changing roles,
wallets, networks or tabs clears the preview. This step requests no signature,
does not deploy or mint, and does not grant the backend wallet signing access.

For deployment, click **Prepare deployment**, review the saved roles and fee
budget, check the acknowledgement, then **Deploy with MetaMask**. This is an
explicit creation transaction spending test HYPE; it does not unpause minting.
The backend verifies the exact transaction, six confirmations, runtime code and
the creation-block initial state before marking its address verified. Saved
deployments survive reloads and tab changes without resending. If the sending
outcome is unknown, inspect MetaMask Activity and recover its hash before trying
again. **Discard unused preparation** cannot cancel a blockchain transaction.
The user confirmed the first deployment and receipt verification on 2026-10-28.
Funded settlement and deployment error cases still need browser acceptance;
compilation alone does not establish their success.

- **Connect MetaMask** requests account access only when clicked. Authorized
  accounts are read silently when opening the tab; no signature is requested.
- MetaMask discovery uses [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963)
  (`io.metamask`) with a legacy injected-provider fallback. Other wallets are not
  selected just because they occupy `window.ethereum`. Provider identifiers are
  supplied by extensions and are not cryptographic identity verification.
- **Switch to HyperEVM Testnet** requests chain `998` (`0x3e6`). If the wallet
  reports an unknown chain, it offers to add the network, then requests switching
  again. Wallet approval or rejection remains under the user's control.
- Network configuration is isolated in `src/config/hyperevm.ts`: official RPC
  `https://rpc.hyperliquid-testnet.xyz/evm`, HYPE, 18 decimals. See the
  [HyperEVM network documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm).
- HYPE is read through the selected wallet provider only on chain `998`. Values
  retain integer precision and display up to 18 fractional digits (at least six).
  A wrong-network balance is never presented as test HYPE.
- Account/network/connect events refresh the view. Disconnects clear it.
  Overlapping reads are coalesced; outdated responses are discarded. Each read
  has a 20-second deadline. There is no balance polling or automatic retry loop.
  **Refresh wallet** updates the balance after a faucet claim or other transfer.
- Leaving the tab removes listeners and invalidates pending reads. An unanswered
  approval remains pending across tab changes to prevent duplicate prompts.

The integration uses typed EIP-1193 calls in `services/evmWallet.ts`, lifecycle
state in `hooks/useHyperEvmWallet.ts`, and presentation in
`components/bridge/TestnetBridge.tsx`. Connection reads are quiet. Deployment,
unpause and mint each require an explicit reviewed action and MetaMask confirmation;
the backend has no EVM signing key. Separate source custody keys are encrypted.
The user confirmed normal connection, chain 998 and matching HYPE balance in a
real browser screenshot on 2026-10-27. Error/account/network-change acceptance
remains pending. A positive HYPE balance does not establish an affordable deployment.

### Experimental wrapped token contract

See [the bilingual bridge design (中文 / English)](docs/learning-bridge.md) for custody responsibilities,
asset units, proposed order states, payment verification and settlement recovery.
Route constants live in `src/config/learningBridge.ts`.

`contracts/LearningWrappedFT.sol` reuses OpenZeppelin ERC20, Ownable2Step and
Pausable. Each instance pins one nonzero source FT Contract ID and its decimals
as immutable constructor arguments. It restricts minting to a designated minter,
rejects mismatched source IDs, consumes both order IDs
and source payment outputs to prevent replays, starts paused with zero supply,
and restricts deployment to chain 998. It does not validate TBC proofs or provide
burn/redemption. Pausing affects new mints; token transfers remain available.

```sh
npm run contracts:compile
```

The build pins `solc` 0.8.30 and OpenZeppelin Contracts 5.4.0, targets Cancun with
optimizer runs 200, and writes an ignored `artifacts/LearningWrappedFT.json`
containing ABI, bytecode, compiler metadata and full build input. The compiler's
`tmp` dependency is overridden to 0.2.7 to address its reported path vulnerabilities.
Contract tooling is development-only and is not imported into the browser bundle.
Compilation does not execute behavior tests, deploy a contract or submit a mint.
Deployment still needs a backend-verified FT identity and decimals, explicit
admin/minter addresses and a live gas estimate. The old native TBC wrapper has
been replaced; a new source FT requires its own wrapper instance and route binding.

## HTLC Testnet

Open **Bridge → HTLC Testnet** and connect Turing Wallet on TBC Testnet.
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

The list, details dialog and Claim / Refund view share the same inspected status:

| Status | Meaning at the last successful check |
| --- | --- |
| Locked | Confirmed, unspent lock; the refund is not yet eligible by chain time. |
| Refundable | Confirmed, unspent lock; the backend reports that chain time permits A to request a refund. |
| Lock pending | The lock transaction has no block confirmation yet. |
| Claim pending / Refund pending | A matching recovery transaction has been found but has no block confirmation yet. |
| Claimed / Refunded | A matching recovery transaction has at least one confirmation. |
| Spent / unavailable | Lock outputs are unavailable, with no verified recovery to identify the outcome. |
| Status unavailable | The status check failed; any retained result is explicitly marked as a previous result. |

Saved records without an inspected result retain their submission/unverified
labels; a local receipt alone does not prove a pending or completed chain transaction.
Refundable remains in **Active**. Refunds require A's explicit action and are not
automatic; B may still claim while the lock is unspent. The label uses the backend's
`refundEligible` result, never the browser clock, and adds no API requests.

The sender sees **Refund**, disabled until chain time makes it eligible; the
recipient sees **Claim**. Completed rows offer **View details**. Every row has
that details action, opening a dialog with token identity, amount, participants,
deadline, confirmations, hashlock, related transactions and available fees.
Dates use MYT, with 12-hour times to the minute (for example, `26 Oct 2026, 3:40 p.m.`).
The refund picker continues to use its displayed local timezone with the same time format.
Fees reuse existing backend decode results without extra requests;
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
| `POST /__htlc/locks` | Use receipt IDs as hints, verify on-chain terms, then save; does not broadcast funds |
| `POST /__htlc/locks/status` | Inspect the wallet's saved locks on Testnet; body contains address and optional cursor |

These resources cover records stored by this app, not network-wide HTLC discovery.
All these resources require a TBC Testnet backend session. Address filters must
match the authenticated wallet, and individual records require sender/receiver
ownership. Secret retrieval additionally requires a separate wallet signature
and is excluded from all lock responses.


The local HTLC API admits two operations at a time and queues up to eight more
in FIFO order. Ordinary overlap waits for a slot; only a full waiting queue
returns 429. Each HTTP request has a 90-second deadline covering body reading,
queueing, module loading and execution. Timeout returns 504; cancellation and
completion release the slot exactly once. This deadline does not reverse a
transaction already submitted to Testnet. Broadcasts are never automatically
retried. Restart the backend service to load server changes.
Requests can also be added once using a prior receipt or their public IDs.

- Public metadata is saved in PostgreSQL `htlc_requests` and `htlc_recoveries`.
  The backend saves a pending record before contacting the node, then updates the
  receipt even if the browser disconnects. Display observations are stored separately.
- Legacy JSON is imported transactionally by the Compose migration job. Original
  files remain for rollback; new writes use the database. See the migration guide.
- Browser localStorage history imports only records involving the authenticated
  wallet, retaining records for other accounts. Browser metadata is rechecked on chain.
- Claimed/Refunded still require matching transaction evidence and confirmations.
  Database persistence alone does not prove a chain outcome.
- Restarting the backend expires temporary signing sessions, not saved receipts.
  The UI's display cache is separate from fresh signing and broadcast validation.

### Saved claim secrets

New locks save their secret when signing completes. Before signing, the secret
exists only in browser memory. Public request history still excludes secrets.

To retrieve one later, connect the original sender wallet and open **My HTLC
Requests → View details → Retrieve claim secret** (also available after loading a request in
**Claim / Refund**). Approve the ownership message in the wallet, then reveal or
copy the secret. This signature sends no transaction and costs no network fee.
Retrieval requires a short-lived, single-use challenge. The recipient still
needs the sender to share the secret deliberately; connecting B does not reveal it.

Encrypted records use AES-256-GCM and are stored in PostgreSQL `claim_secrets`.
The matching key stays in `.secrets/htlc.key`, mounted only into backend/migration
containers. Back up both the database and the key separately. This trusts the app
server and operator; encryption does not protect against full backend compromise.

Older locks whose secrets were never saved still require their original secrets.
The migration cannot recreate missing secret material. New login, retrieval and
funded flows require user wallet acceptance in the migrated application.

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
previous single-chain acceptance does not establish acceptance of the new backend integration.

## Amounts

- Mint: the initial `amount` uses raw smallest units. For example, `100000` with
  `decimal: 2` represents `1000` tokens.
- Transfer: enter the token amount you want to send, such as `10.5`. The app checks
  its precision and balance; the wallet receives this amount in token units.
- UTXO amounts retain the API's raw units. Transaction fees display in TBC.

## Action audit summaries

Authenticated browser actions send only allowlisted action/outcome summaries to
`/__wallet-log`; NestJS stores them in PostgreSQL `audit_events`. Arbitrary wallet
responses, signatures, request bodies and secrets are excluded. Client summaries
are not proof of on-chain success. Historical `wallet/logs` files are retained as
old debugging logs, not imported as authoritative audit records.

## Verify before using

Build the site before serving it:

```bash
npm run build
```

Test tokens only: this page deliberately refuses to mint when the wallet reports a mainnet network.

### Prepare a reverse redemption

With the completed forward order and verified escrow loaded, open **Prepare redemption · lwFT → MT**, select the original MetaMask receiving account on Testnet 998, enter an amount and TBC P2PKH recipient, then **Review redemption → Save redemption preparation**. Saving does not move tokens or charge gas. Refresh saved redemptions after an interrupted save; repeat saves for identical terms use the same request key. An unused preparation can be closed. MT release and escrow locking remain pending; do not transfer lwFT directly to escrow. See learning-bridge.md section 12.

### Fund the MT return fee

Under the saved full-amount redemption, open **MT return · fee funding → Open TBC fee funding details**. Send the displayed native test TBC amount once from Turing Wallet to the displayed custody address, retain its TXID, wait for 6 confirmations, then **Verify fee funding and save MT release plan**. Do not pay MT again. Native change stays in custody without automatic refund. After funded, continue with the MetaMask activation, exact approval and permanent-locking controls (section 14). See learning-bridge.md section 13.

### Activate, approve and permanently lock

On a funded redemption, use **MetaMask · activate, approve and lock → Check next wallet step**. Estimate and review the suggested action, acknowledge it, then confirm in MetaMask. Verify each transaction to 6 confirmations before the next step. Existing different allowances are reset before exact approval. Permanent locking has no undo. A verified lock unlocks the explicit custody-signing and saved-MT-broadcast controls. Refresh never resends; recover uncertain transaction hashes through Activity. See learning-bridge.md section 14.

### Bridge reconciliation

Open **Bridge → Reconciliation** with your original TBC Testnet wallet signed in. **Refresh saved history** shows both directions, confirmed amounts and recorded actual fees per lwFT contract. **Check current balances** reads indexed MT reserves and registered permanent locks against lwFT totalSupply; it shows its time and coverage separately from saved records. Neither action sends a transaction. See [learning-bridge.md, section 17](docs/learning-bridge.md#17-桥对账页面--17-bridge-reconciliation-2026-10-30) for scope and limitations.

### Guided bridge flow

In **Testnet Bridge**, choose **Send MT → Receive lwFT** or **Return lwFT → Receive MT**. Follow the highlighted step and use **Prepare next wallet step** for the required action and fee review. Existing pending transactions are checked about every 30 seconds while the page is visible; you can pause checks or use **Check now**. Wallet approvals, permanent locking, custody signing and broadcasting remain explicit actions. Setup and old attempts are available under expandable history. See learning-bridge.md section 18.
