# TBC ↔ HyperEVM Bridge v2 — Phase 3 Solidity Verifier

Status: **Phase 3A consensus/Merkle primitives and Phase 3B authenticated
bootstrap commitment complete for `tbcdev-testnet`; header relay, FT verifier,
gateway and proof-backed token are not complete**

Implementation date: **2026-11-03 (Asia/Kuala_Lumpur)**

Nothing in this phase has been deployed. No transaction, mint, burn, release or
asset movement was submitted. The existing custodial Learning Bridge contracts
and settlement path are unchanged.

## 1. Implemented boundary

`wallet/contracts/phase3/TbcProofVerifier.sol` implements:

- exact 80-byte header parsing with explicit TBC wire/display byte order;
- double-SHA256 block hashes and Bitcoin/TBC compact-target decoding/encoding;
- proof-of-work range and hash checks using the TBC main-parameter pow limit;
- TBCNODE `GetBlockProof` work arithmetic; and
- index/count-bound Merkle reconstruction, including exact duplicated odd leaves.

`wallet/contracts/phase3/TbcDifficultyVerifier.sol` implements TBCNODE v3.3.1's
post-fork DAA, including the median-of-three suitable blocks, 144-block
chainwork window, 8,064-block dynamic spacing, median-time-past escape and the
per-block ±1/16 target bound. Its input points are intentionally not accepted as
trusted by themselves: a future relay must authenticate every point as an
ancestor of the candidate parent or against the bootstrap-history commitment.

`TbcVerifierHarness.sol` is stateless test scaffolding only. It has no storage,
admin, mint authority or settlement function and is not a bridge contract.

`wallet/contracts/phase3/TbcBootstrapVerifier.sol` fixes the testnet commitment
domain, checkpoint hash, range and root in Solidity. A caller cannot substitute
another root. It verifies height-directed 13-node proofs and exact duplicated
odd nodes using the same encoding as the TypeScript builder.

## 2. Executed cross-language vectors

The pinned Solidity 0.8.30 compiler targets Cancun, matching HyperEVM Testnet
chain 998. The compiled harness is 6,728 runtime bytes. A read-only `eth_call`
injects that runtime temporarily through the RPC state-override parameter; it
does not deploy code or submit a transaction.

The executed assertions cover:

- real MT block `839165`, hash
  `0000000000000157b648773dea20cc8addccb3708ec07c330ab711ca033123a9`;
- its version, previous hash, Merkle root, timestamp, bits, nonce, PoW target and
  block work;
- the real three-transaction MT Merkle branch;
- TBCScan block `837731`'s five-transaction odd-leaf branch;
- the real post-fork DAA transition from block `839164`, producing bits
  `0x1a0420a6`;
- rejection of an above-pow-limit header and a mutated duplicated odd leaf;
- the real height `839164` bootstrap point and its 13-node commitment proof; and
- rejection after changing the committed checkpoint timestamp.

Run the checks with:

```bash
cd wallet
npm run phase3:compile

cd ../backend
npm run phase3:test
npm run phase3:solidity-rpc-test
npm run typecheck
```

The RPC test is an integration vector, not the only future test layer. Before a
deployment, the same vectors must run in a pinned local EVM and the production
contracts need independent security and gas review.

## 3. Authenticated bootstrap history

The accepted checkpoint at height `839164` authenticates one header and its
cumulative chainwork. That alone is mathematically insufficient to verify the
next TBC difficulty transition. The DAA also reads historical points as far back
as `839164 - 8064 = 831100`.

A permissionless relay therefore needs an authenticated bootstrap context for
the inclusive range `831100..839164`, containing each block's height, hash,
timestamp, bits and cumulative chainwork. Phase 3B now freezes this context:

```text
schema              learningmaterials/tbc-header-bootstrap/v1
checkpoint          tbcdev-official-839164-v1
committed range     831100..839164 (8,065 points)
record              80-byte raw header || 32-byte big-endian chainwork
binary bytes        903,280
binary SHA-256      bbd1a9ecafd184a514d9cde87573360091a6d8a07a5e89e9ccaebb3ec8fb04eb
commitment root     94ac5bf81d725359d987255015423a13bb4ff99aa04456d6f952e0ddeaa1a273
```

The versioned binary and manifest live in
`backend/src/bridge/phase3/fixtures/`. The builder uses the official testnet
recent-block pages, recalculates chainwork backwards from the accepted
checkpoint, cross-checks selected heights with TBCScan, and is resumable through
an ignored local cache.

The two official testnet APIs do not expose pre-TBC headers at height `824189`
or earlier. TBCScan exposes the first TBC block `824190`; the REST block API
starts at `824191`. Consequently, Phase 3B verified 14,975 consecutive header
hashes, links and PoW checks from `824190` through `839164`, plus the 6,910 DAA
transitions whose full 8,064-block history is available (`832255..839164`). The
earlier context `831100..832254` remains part of the explicitly trusted official
bootstrap authority rather than being misreported as independently derived.

This limitation affects the initial trust anchor only. Starting with candidate
block `839165`, every required pre-checkpoint DAA point is committed by the root;
post-checkpoint points must come from relay-validated ancestors. Arbitrary
relayer-supplied DAA values remain forbidden.

Accepting arbitrary relayer-supplied DAA points would let a relayer choose an
easier target and is explicitly forbidden. Calling the API from a backend does
not close this gap because the Solidity contract cannot authenticate that reply.

## 4. Remaining Phase 3 work

Phase 3 is not yet a proof-backed bridge. The next implementation slices are:

1. implement a permissionless header relay with parent linkage, DAA, PoW,
   cumulative chainwork, competing-branch handling and unresolved-equal-work
   fail-closed behavior;
2. implement canonical ancestry and six-confirmation eligibility;
3. port the version-10 TXID and bounded Phase 2 Covenant/legacy-FT verifier to
   Solidity, with calldata and gas limits measured on chain 998;
4. add exact source-outpoint/logical-deposit replay protection; and
5. add a new proof-only `WrappedFTV2`/gateway pair with no owner, backend or
   minter proof bypass.

The existing `BridgeWrappedFT`, `LearningWrappedFT` and
`LearningRedemptionEscrow` must remain separate learning/custodial artifacts.
They must not be relabelled or upgraded in place as v2 contracts.

## 5. Current security statement

Phase 3A/B shows that the frozen TypeScript header, PoW, DAA, Merkle and
bootstrap-commitment vectors can be reproduced by Solidity on HyperEVM Testnet.
It does **not** yet establish a canonical TBC chain in a deployed contract and
cannot authorize minting. Until all remaining gates pass, the forward path
remains the existing custodial learning flow and must not be described as
trustless.

## 6. Evidence used

- [Official TBC Block API](https://docs.turingbitchain.io/en/Block) documents
  height lookup and recent-block pages, including their 100-block maximum.
- [Official API introduction](https://docs.turingbitchain.io/en/Introduction)
  identifies `api.tbcdev.org` as the Testnet API.
