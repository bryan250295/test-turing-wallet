# TBC ↔ HyperEVM Bridge v2 — Phase 3 Solidity Verifier

Status: **Phase 3A consensus/Merkle primitives complete for `tbcdev-testnet`;
header relay, FT verifier, gateway and proof-backed token are not complete**

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

## 2. Executed cross-language vectors

The pinned Solidity 0.8.30 compiler targets Cancun, matching HyperEVM Testnet
chain 998. The compiled harness is 5,858 runtime bytes. A read-only `eth_call`
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
  `0x1a0420a6`; and
- rejection of an above-pow-limit header and a mutated duplicated odd leaf.

Run the checks with:

```bash
cd wallet
npm run phase3:compile

cd ../backend
npm run phase3:solidity-rpc-test
npm run typecheck
```

The RPC test is an integration vector, not the only future test layer. Before a
deployment, the same vectors must run in a pinned local EVM and the production
contracts need independent security and gas review.

## 3. Bootstrap-history gate discovered during implementation

The accepted checkpoint at height `839164` authenticates one header and its
cumulative chainwork. That alone is mathematically insufficient to verify the
next TBC difficulty transition. The DAA also reads historical points as far back
as `839164 - 8064 = 831100`.

A permissionless relay therefore needs an authenticated bootstrap context for
the inclusive range `831100..839164`, containing at least each block's height,
timestamp, bits and cumulative chainwork. The intended testnet construction is:

1. fetch consecutive raw headers and chainwork material from the frozen official
   testnet providers;
2. locally reproduce header hashes, linkage, PoW, DAA and cumulative chainwork;
3. create a versioned Merkle commitment over all 8,065 context points;
4. bind that commitment to checkpoint ID `tbcdev-official-839164-v1`; and
5. make the future relay verify Merkle witnesses only for pre-checkpoint DAA
   points, while post-checkpoint points must come from relay-validated ancestors.

Accepting arbitrary relayer-supplied DAA points would let a relayer choose an
easier target and is explicitly forbidden. Calling the API from a backend does
not close this gap because the Solidity contract cannot authenticate that reply.

## 4. Remaining Phase 3 work

Phase 3 is not yet a proof-backed bridge. The next implementation slices are:

1. build and independently reproduce the 8,065-point testnet bootstrap-history
   commitment and freeze its serialization/root;
2. implement a permissionless header relay with parent linkage, DAA, PoW,
   cumulative chainwork, competing-branch handling and unresolved-equal-work
   fail-closed behavior;
3. implement canonical ancestry and six-confirmation eligibility;
4. port the version-10 TXID and bounded Phase 2 Covenant/legacy-FT verifier to
   Solidity, with calldata and gas limits measured on chain 998;
5. add exact source-outpoint/logical-deposit replay protection; and
6. add a new proof-only `WrappedFTV2`/gateway pair with no owner, backend or
   minter proof bypass.

The existing `BridgeWrappedFT`, `LearningWrappedFT` and
`LearningRedemptionEscrow` must remain separate learning/custodial artifacts.
They must not be relabelled or upgraded in place as v2 contracts.

## 5. Current security statement

Phase 3A shows that the frozen TypeScript header, PoW, DAA and Merkle vectors can
be reproduced by Solidity on HyperEVM Testnet. It does **not** yet establish a
canonical TBC chain in a deployed contract and cannot authorize minting. Until
all remaining gates pass, the forward path remains the existing custodial
learning flow and must not be described as trustless.
