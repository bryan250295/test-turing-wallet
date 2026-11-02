# Learning Bridge backend

NestJS + TypeScript + Prisma + PostgreSQL. The React application remains in
`../wallet`. Shared DTO domain types and pure validation helpers live in `../shared`.

See [local setup and migration / 本地启动与迁移](../docs/backend-architecture.md).

## Modules

| Path | Responsibility |
| --- | --- |
| `src/auth` | TBC / EVM ownership challenges, expiring database sessions and CSRF guard |
| `src/htlc` | Controllers, DTO validation, ownership rules and database repositories |
| `src/htlc/engine` | Reviewed TBC SDK construction, signature/script verification, bounded queues |
| `src/bridge` | Approved FT registry, deployments, prepared orders and encrypted per-order custody |
| `src/database` | Prisma connection lifecycle |
| `src/common` | Health resources, sanitized audit events and HTTP errors |
| `prisma` | Database models, versioned SQL migrations and constraints |
| `scripts/import-storage.ts` | Atomic, repeatable legacy JSON import |
| `scripts/verify-bridge-asset.ts` | Operator entry point to verify and register the pinned source FT |

Controllers delegate business work to services. Repositories own database writes.
The HTLC engine receives repositories and its authenticated owner through an
`AsyncLocalStorage` scope; it does not read browser files or instantiate a second
database connection. Signing contexts are transient, owner-bound and expire after
15 minutes. Backend restarts require rebuilding unsigned transactions. Existing
on-chain transactions and database receipts are retained.

## Host development

Run `node scripts/setup-local.mjs` from the repository root first. Then start the
PostgreSQL and one-shot migration services using Compose (`docker compose up --build -d postgres migrate`). In this directory:

```bash
npm ci
npm run db:generate
npm run dev
```

`npm run build` emits `dist/backend/src/main.js` and `dist/shared`.
`npm start` runs the compiled application. The runtime `.env` uses the restricted app role; schema changes and legacy import
run with the separate migration role through Compose. The committed migrations are applied
with `prisma migrate deploy`; schema changes use a new migration, never a reset
or an unrecorded `db push` against existing data. Prisma is pinned to **7.10.1**;
follow that major version's commands when reading newer documentation.

## Authentication

- `POST /api/auth/challenge`: `{ chain: "tbc", network: "testnet", address }`.
  EVM EOA login also accepts `{ chain: "evm", network: "998", address }`.
- Sign the exact returned text with the corresponding wallet.
- `POST /api/auth/verify`: `{ challengeId, signature }`. The browser must retain
  the challenge cookie. Successful verification sets an HttpOnly session cookie
  and returns a CSRF token.
- `GET /api/auth/session` reads the current session and CSRF token.
- `POST /api/auth/logout` revokes the current session.
- Protected writes require `X-CSRF-Token`. Unsafe requests require the exact
  configured `Origin`; use the frontend proxy for same-origin cookies.

All HTLC routes require the authenticated TBC Testnet identity. Address query
parameters are checked against that identity. Secret retrieval additionally
requires a separate single-use ownership signature bound to the current session.
EVM login proves an EOA signature over chain-bound text; it does not verify wallet
network selection and does not link an EVM identity to a TBC identity. Smart
contract wallets / ERC-1271 and wallet linking are not implemented.

Local development API documentation: `http://localhost:5173/api/docs`.
Health endpoints: `/api/health/live`, `/api/health/ready`.

## Current limits

- Run one backend replica: build contexts, display caches and bounded queues are
  in memory. Database advisory locks protect persistent merges across processes,
  but this is not a distributed transaction worker.
- `wallet_identities.role` is reserved for later management features. No admin
  dashboard or privilege-elevation API is supplied.
- Bridge orders retain frozen terms and owner-scoped history. Each has unique
  encrypted custody; payment details require explicit acknowledgement. The backend
  verifies ordinary MT transfers and prepares unpause/mint calls for MetaMask.
  No backend EVM private key, automatic mint worker or reverse redemption exists.
- Authentication and funded flows need user wallet acceptance after the migration.

## Reverse bridge preparation

The user selected permanent escrow of the existing lwFT; supply does not decrease.
`POST /api/bridge/orders/:id/redemption/preview` accepts `{ from }` and requires the
original TBC session, CSRF, a completed forward settlement and its saved admin.
`BridgeRedemptionService` checks custody recovery and unspent MT deposit evidence,
then the existing token binding, canonical target block, nonce, balance and a new
paused escrow's constructor simulation. It returns a 60-second read-only fee quote.
No database records or transactions are created by preview. Temporary source read
failures follow the same bounded retry rules as forward verification.

The compiled escrow artifact is independent of the existing wrapped-token artifact.
Escrow creation is now persisted and wallet-confirmed. These additional authenticated,
CSRF-protected write routes live under `/api/bridge/orders/:id/redemption`:

| Endpoint | Purpose |
| --- | --- |
| `GET deployments` | Restore the original order's saved escrows |
| `POST deployments` | Fresh reserve/fee check and immutable deployment preparation (`{ from }`) |
| `POST deployments/:deployment/begin` | Fresh preflight and single-use wallet send slot |
| `POST deployments/:deployment/submit` | Attach the public creation hash (`{ txHash }`) |
| `POST deployments/:deployment/check` | Verify canonical creation, runtime/initial state and 6 confirmations |
| `POST deployments/:deployment/cancel` | Discard unused preparation; awaiting-wallet also requires `{ notSent: true }` |

`RedemptionEscrowRepository` freezes intent fields and uses sender locks shared with
other deployment/mint calls. PostgreSQL limits runtime updates to observations and
forbids record deletion. No EVM signing key or automatic deployment exists. Status
unavailability retains prior evidence; hash recovery does not open another wallet send.
The additive migration is `202610290001_redemption_escrow_deployments`.

Token approval/locking and source release routes remain disabled. Redemption orders,
TBC fee funding, unique UTXO reservation, custody signing and release recovery are next.

## Prepared bridge orders

All routes use the authenticated TBC Testnet identity; writes also require CSRF.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/bridge/orders/setup` | Custody readiness and this identity's verified deployments |
| `GET /api/bridge/orders` | Prepared orders first, then recent closed preparations, at most 20 |
| `POST /api/bridge/orders` | Freeze reviewed terms and allocate encrypted custody atomically |
| `POST /api/bridge/orders/:id/cancel` | Close an unused preparation, retaining its custody record |

The preparation DTO accepts only `idempotencyKey`, `deploymentId`, `amount` and
`recipient`. The service gets the sender from the signed-in identity and the FT,
decimals, target contract and confirmation policy from server configuration and
verified records. A repeated request ID with identical terms returns the same
record; different terms return a conflict. At most 3 open preparations per identity.
Custody private keys and WIFs are never returned. Payment details and unsigned
wallet calls are exposed separately after their validation gates. See the
architecture guide for the independent custody encryption key and backups.

## Wallet-confirmed settlement

All routes are under `/api/bridge/orders/:id/settlement`, scoped to the original
TBC identity. POSTs require Origin/CSRF; quote/begin/check use bounded source/RPC
queries. GET reads saved progress without opening a wallet prompt.

| Suffix | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Saved source proof, custody payment address after activation, wallet attempts |
| `/open` | POST | Acknowledge custody, authenticate the saved encrypted key, check source checkpoint and target, reveal payment details |
| `/deposit` | POST | Attach a TXID or recheck the existing exact MT output |
| `/calls` | POST | Fresh source/target verification and a 60-second unpause/mint fee quote |
| `/calls/:attemptId/begin` | POST | Recheck proof, role, fees and nonce; reserve one wallet send slot |
| `/calls/:attemptId/submit` | POST | Save the MetaMask transaction hash without assuming success |
| `/calls/:attemptId/check` | POST | Verify exact transaction, receipt, canonical block, event and 6 confirmations |
| `/calls/:attemptId/cancel` | POST | Discard an unused quote or a user-confirmed rejected/unsent wallet request |

Unknown sends require Activity-hash recovery. Discarding local state cannot cancel
an on-chain transaction. Source outpoints have a database-wide unique reservation,
including across target deployments. Mint calldata is derived from frozen terms;
the browser independently compares every ABI word before opening MetaMask.
The contract also rejects replayed order/deposit keys. Invalid or reorganized
evidence after a send requires reconciliation. Failed node reads retain history;
neither payment nor mint is automatically retried.

### Redemption preparation

After a verified escrow deployment, `GET/POST /api/bridge/orders/:id/redemption/orders` lists or saves preparation terms; `POST /api/bridge/orders/:id/redemption/orders/:redemption/cancel` closes an unused preparation. Original TBC session and mutation CSRF apply. POST accepts `{escrowId,idempotencyKey,holder,tbcRecipient,amount}`. Only the original lwFT holder is supported. A fresh unspent reserve and target check precedes a serialized aggregate reservation (maximum 3 preparations). `redemption_orders` terms/evidence are immutable to the runtime role; only status/cancelledAt may change. This is preparation only: no token approvals/locking, fee funding, custody signing or broadcasts. See learning-bridge.md section 12.

### Native fee funding and MT release

The full-original-deposit return now has persisted fee details, an immutable unsigned plan, unique source/fee input reservations, permanent-lock receipt verification, gated custody signing and fixed-TXID broadcast/reconciliation. Routes are under `/api/bridge/orders/:id/redemption/orders/:redemption/release`: GET progress; POST `open`, `funding {txid}`, `lock {txHash}`, `sign {planHash,authorize:true}`, `broadcast {planHash,authorize:true}`, `check`. Native funding needs 6 confirmations, a sufficient single P2PKH output and unspent status. Plans and signed bytes are insert-only to the runtime role; no signed raw or keys enter public DTOs. Signing and sending are explicit actions after a freshly verified exact permanent lock. After funding, the browser now provides wallet unpause, exact allowance and permanent locking (section 14). Partial releases are rejected. See learning-bridge.md section 13.

### Wallet-confirmed redemption locking

`GET .../redemption/orders/:redemption/wallet` loads saved requests; POST `wallet/state` checks the next live step; `wallet/quote {kind,from}` persists a 60-second reviewed call; `wallet/:call/begin`, `submit {txHash}`, `cancel {notSent?}`, `check` reserve/send/recover/verify it. Kinds are unpause, reset, approve, lock. All require the original TBC session and mutation CSRF. Full source/fee/plan preflight gates quote/begin; exact allowance and calldata are independently validated. Original sender locks now include these requests. After a lock receipt/event reaches 6 canonical confirmations, the saved release becomes locked and the existing explicit custody signing/broadcast flow applies. See learning-bridge.md section 14.
