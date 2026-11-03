# TBC ↔ HyperEVM Bridge v2 — Phase 1 API Proof Builder

Status: **Phase 1 complete and live-validated for the API-only
`tbcdev-testnet` route; Mainnet is out of scope**

Start date: **2026-11-03 (Asia/Kuala_Lumpur)**

This phase is read-only. It MUST NOT mint, burn, release, migrate, broadcast a
transaction, or move user assets. It is deliberately isolated from the current
Learning Bridge settlement path.

## 1. Chosen acquisition route

The project does not install TBCNODE.

| Role | Testnet endpoint | Treatment |
| --- | --- | --- |
| Primary locator and checkpoint authority | `https://scanapi.tbcdev.org/api` | Official authority only for the frozen `tbcdev` bootstrap checkpoint; otherwise proof-material provider |
| Whole-proof fallback and corroboration | `https://api.tbcdev.org/api/tbc` | Proof-material provider; independently parsed but not assumed to be a different operator |
| Consensus reference | official TBCNODE `v3.3.1`, commit `6ddea88c57e9bc9390c1730657ac766b56c4a670` | Source-code reference, not a running dependency |

The executable code is hard-locked to `testnet` and contains no Mainnet provider
selection. A later Mainnet project must introduce a separate route, checkpoint,
domain and review rather than changing this route in place.

`auto` mode tries to build the complete proof from TBCScan first. If that fails,
it discards the partial result and retries the complete proof using the official
API. It does not mix fields from two providers into one proof.

Provider `confirmed` and `confirmations` fields are observations only. They are
not canonical-chain, chainwork, difficulty, or UTXO-set proofs.

### Checkpoint authority decision

On 2026-11-03, the project owner confirmed that TBCScan is an official trusted
source. For the `tbcdev` learning/test route, Phase 1 therefore uses an official
checkpoint trust anchor instead of requiring a second independently operated
provider. This decision does not make post-checkpoint API responses trusted:
every subsequent header must still pass local consensus verification.

Checkpoint `tbcdev-official-839164-v1` is frozen as the parent of the captured
real MT deposit:

- height: `839164`
- block hash: `000000000000023f252086d278485a61b6c225ad07213fff329ef5e31e1c256b`
- previous hash: `000000000000039ec70bf61aed89b6cd6ada52e63f1bc11cf6629541a7740ab2`
- compact target: `0x1a041f18`
- cumulative chainwork: `0000000000000000000000000000000000000000014f15b416fbbd30a34db4b3`

Both official API routes returned matching header fields. TBCScan additionally
returned the cumulative chainwork. The frozen checkpoint is for `tbcdev-testnet`
only.

## 2. TXID-direct algorithm

1. Normalize and validate the requested 32-byte TXID and `vout`.
2. Resolve TXID to confirmed block height/hash.
3. Fetch raw transaction bytes and reproduce the TXID with `tbc-lib-js`.
4. Fetch the block header fields and the complete ordered TXID list.
5. Serialize the 80-byte header, reproduce its SHA256d hash, decode `bits`, and
   require the hash to satisfy the claimed target and shared PoW limit.
6. Require the target TXID to occur exactly once.
7. Rebuild the complete Bitcoin/TBC Merkle tree, including odd-leaf duplication.
8. Require the computed root to equal the header Merkle root.
9. Generate the branch and verify it again locally before returning it.

Datetime search is not used. TBCScan's transaction-status lookup already maps a
TXID directly to its block, while datetime would require a height search and can
only approximate a block interval.

## 3. Implemented files

- `backend/src/bridge/phase1/tbc-proof.types.ts` — versioned proof/data-source types.
- `backend/src/bridge/phase1/tbc-proof.crypto.ts` — header and Merkle primitives.
- `backend/src/bridge/phase1/tbc-consensus.ts` — compact target, PoW, block-work and exact post-fork DAA primitives.
- `backend/src/bridge/phase1/tbc-checkpoints.ts` — versioned official `tbcdev` trust anchor.
- `backend/src/bridge/phase1/tbc-header-chain.ts` — post-checkpoint linkage, difficulty, PoW, chainwork and greatest-work selection.
- `backend/src/bridge/phase1/tbc-proof.sources.ts` — strict TBCScan and official API adapters.
- `backend/src/bridge/phase1/tbc-proof.builder.ts` — fail-closed proof construction.
- `backend/scripts/build-tbc-proof.ts` — read-only CLI.
- `backend/src/bridge/phase1/*.test.ts` — offline positive and mutation vectors.

Run an offline check:

```bash
cd backend
npm run phase1:test
npm run typecheck
```

Run a live testnet proof lookup:

```bash
cd backend
npm run phase1:proof -- \
  --txid d87d9f42f427a7ac1ade5d2896a88a3e99deeec7257ae5df3ae2c013a3823519 \
  --vout 0 \
  --network testnet \
  --provider auto
```

The CLI writes JSON only to stdout and performs GET requests only.

## 4. Captured Merkle test vector

The TBCScan testnet example supplied by the project owner resolves to block
`837731`:

- block hash: `00000000000001f6c2f7c8aa1e7914b0f68a21b20733508d44b775b61da49675`
- target TXID: `11df2827c98dd5370277b9c2df7e50023ee0f408552770d3217e3fecaf15f6ed`
- target index: `4` of `5`
- Merkle root: `0089244e1171ecca4c8e780e994cfc06b7a78e33237ab17eb45ee5be20d18118`
- branch level 0: target TXID itself on the right (odd-leaf duplication)
- branch level 1: `c596026e784f908e442b3883ed41e23937921deace27f75ebab9b4e6f7d1f5b4` on the right
- branch level 2: `1a3f798f541c6dca88f46d1ee59041cf2a1336c4bde89b598248ca12dc49c372` on the left

The offline test reproduces the root and proves that a mutated branch no longer
matches. A standard genesis-header vector separately checks 80-byte header byte
order and SHA256d behavior.

### Real supported MT fixture

On 2026-11-03, the CLI independently completed the whole-proof flow through
both configured API adapters for the project's completed `MT` deposit
`d87d9f42f427a7ac1ade5d2896a88a3e99deeec7257ae5df3ae2c013a3823519:0`:

- block height: `839165`
- block hash: `0000000000000157b648773dea20cc8addccb3708ec07c330ab711ca033123a9`
- transaction index: `1` of `3`
- Merkle root: `cf2ac74ae087c96d00f28d2d6b214f2a7d3085c2dd56058721bc1187bef468ff`
- compact target: `0x1a0420a6`
- per-block work: `17457787679461317`

TBCScan and the official TBC API produced the same raw transaction, header,
block hash, transaction position and Merkle branch. The raw transaction was
parsed with `tbc-lib-js` and reproduced the requested TXID. These are two API
routes, but they are not counted as two independently operated consensus
providers without operator confirmation.

The real header and branch are frozen as an offline regression vector. A second
vector reproduces the exact `0x1a0420a6` next-target result from the pinned
TBCNODE post-fork DAA using the parent block at height `839164`, the median
work-window endpoints, both median-time-past windows and the 8,064-block
dynamic-spacing ancestor.

## 5. Phase 1 acceptance gates

- [x] No TBCNODE installation or runtime dependency.
- [x] TXID-direct primary adapter and whole-proof fallback adapter exist.
- [x] Raw transaction is parsed and its TXID is independently reproduced.
- [x] Header serialization, reported block hash, compact target, PoW and per-block work are independently checked.
- [x] Complete ordered TXID list, Merkle root and generated branch are checked.
- [x] Odd-leaf duplication and mutation rejection have offline tests.
- [x] Compact target, PoW range and cumulative block-work arithmetic match pinned-source vectors.
- [x] Existing bridge settlement code is unchanged.
- [x] Live CLI succeeds against both current testnet API schemas.
- [x] The project owner accepted official TBCScan as `tbcdev` checkpoint authority.
- [x] Exact post-fork TBC difficulty arithmetic and a real transition vector are frozen.
- [x] Checkpoint-to-real-deposit linkage and competing-tip chainwork vectors are frozen.
- [x] A versioned `tbcdev` bootstrap checkpoint is selected and corroborated through both official API schemas.
- [x] CLI and provider construction are hard-locked to Testnet endpoints.
- [x] A real completed Mega Token deposit fixture is captured and reviewed.

Phase 1 is complete for the API-only `tbcdev-testnet` proof-builder scope. A
successful Merkle proof alone proves inclusion under one header; canonical
acceptance additionally requires the post-checkpoint header-chain checks.

### Network-identity finding

The official TBCScan interface calls this route Testnet, while the official
`api.tbcdev.org/api/tbc/nodeinfo` response reports `chain = "main"`. The project
therefore gives the route its own unambiguous identifier, `tbcdev-testnet`, and
does not infer public-mainnet identity from that internal node field. Its observed
heights, first-TBC-block checkpoint and live DAA vectors align with the pinned
source's `CMainParams`; the verifier uses those observed official rules for this
route.

The exact post-fork DAA arithmetic can be tested independently of that naming
decision because the live route matches the pinned main-parameter transition at
height `839165`. A reset or incompatible official rule change requires a new route
and checkpoint version; it must not silently replace this trust anchor.

## 6. Deferred to later phases

- Phase 2: exact TBC Bridge Covenant and bounded legacy-FT proof shape.
- Phase 3: HyperEVM header linkage, proof-of-work, difficulty, chainwork, Merkle,
  version-10 TXID and FT verification contracts; proof-backed minting.
- Phase 4: reverse threshold/MPC release path.

No Phase 2 or Phase 3 security claim is implied by this Phase 1 implementation.

## 7. Pinned research evidence

- [TBCNODE v3.3.1 `pow.cpp`](https://github.com/TuringBitChain/TBCNODE/blob/6ddea88c57e9bc9390c1730657ac766b56c4a670/src/pow.cpp)
  defines compact-target range checks, PoW comparison and the post-fork DAA.
- [TBCNODE v3.3.1 `chain.cpp`](https://github.com/TuringBitChain/TBCNODE/blob/6ddea88c57e9bc9390c1730657ac766b56c4a670/src/chain.cpp)
  defines per-block work as `(~target / (target + 1)) + 1` and cumulative-work selection.
- [TBCNODE v3.3.1 `chainparams.cpp`](https://github.com/TuringBitChain/TBCNODE/blob/6ddea88c57e9bc9390c1730657ac766b56c4a670/src/chainparams.cpp)
  separates `CMainParams` and `CTestNetParams` and fixes the first TBC main-parameter
  block at height `824190`.
- [Official TBC Block API](https://docs.turingbitchain.io/en/Block) documents the
  fallback block fields, ordered `tx` list and hexadecimal `bits` encoding.
