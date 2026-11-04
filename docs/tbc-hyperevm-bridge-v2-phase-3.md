# TBC ↔ HyperEVM Bridge v2 — Phase 3 Solidity Verifier

Status: **Phase 3A consensus/Merkle primitives, Phase 3B authenticated
bootstrap commitment, Phase 3C permissionless header-relay core and the Phase
3D bounded TXID/Covenant/v3 output-envelope, parent/outpoint conservation and
one-level FT ancestor-authentication and input-signature layers are complete
for `tbcdev-testnet`; full FT Script execution, gateway and proof-backed token
are not complete**

Implementation date: **2026-11-04 (Asia/Kuala_Lumpur)**

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

`wallet/contracts/phase3/TbcHeaderRelayV2.sol` is a chain-998-only,
permissionless header relay. It has no owner, operator, pause key, configurable
checkpoint or asset-moving method. Its constructor installs only the frozen
height-`839164` checkpoint. Any account may then submit a child of any retained
branch, but acceptance requires:

- valid 80-byte header parsing and proof of work under the fixed TBC pow limit;
- a known parent and an exact TBCNODE post-fork DAA result;
- every required pre-checkpoint DAA point to pass the immutable Phase 3B Merkle
  commitment, with no unproven or unused witness slots;
- TBCNODE's signed version rule, median-time-past rule and 20-minute future-time
  window;
- checked cumulative work and greatest-work branch selection; and
- fail-closed canonical queries while two distinct tips have equal best work.

The relay retains a TBCNODE-compatible skip pointer per header, allowing
checkpoint-bounded ancestor queries without walking all 8,064 DAA blocks.
`isCanonical` enforces at least six confirmations and `isFinalized` fixes the
same six-confirmation minimum. A confirmation count includes the queried block.

`TbcHeaderRelayIntegrationHarness.sol` is test-only scaffolding. It deploys a
temporary relay inside a read-only RPC call, submits six real headers and checks
finality, ancestry and equal-work fail-closed transitions. It is not part of the
bridge settlement path.

`TbcBoundedTransaction.sol` parses the frozen 2..7-input and 3..6-output bridge
shape, plus parent transactions bounded to 1..7 inputs and 1..16 outputs, with
canonical CompactSize encodings and a 131,072-byte per-transaction hard limit.
Its TXID implementation reproduces TBC version 10's 112-byte `newTxHeader`
commitment; version 10 does **not** use double-SHA256 of the complete raw
transaction.

`TbcBridgeDepositVerifier.sol` verifies the canonical raw transaction, its TXID,
the fixed Bridge Covenant payload and controller, the pinned MT legacy-v3 Code
template, the contract-controller field, and the pinned Tape metadata and
committed amount. Its finalized entry point reconstructs the transaction Merkle
root and requires the selected header to be finalized by a supplied Phase 3C
relay. A future gateway must bind that relay address, gateway address and reserve
controller as immutable route policy; allowing a proof submitter to choose them
would not be secure.

The second Phase 3D slice accepts exactly one parent raw transaction for every
deposit input. It recomputes each parent TXID, binds the referenced vout, rejects
duplicate outpoints, requires the final input to be native P2PKH, verifies all
preceding pinned-v3 address-controlled Code/Tape pairs, enforces a single input
controller, exact six-slot amount/change allocation, output shape and positive
native fee. The parent bytes are therefore cryptographically bound by the
deposit inputs rather than trusted backend metadata.

The third Phase 3D slice accepts one ancestor group per deposit input. For every
non-zero legacy-v3 Tape slot it requires exactly one bounded ancestor raw
transaction, in ascending slot order, recomputes its version-10 TXID, binds it
to the corresponding parent input and verifies that the referenced ancestor
vout exists. Missing, extra, reordered or changed ancestor bytes therefore fail
closed. The final native fee input must have an empty ancestor group. This is
the exact one-level raw-transaction set selected by Phase 2's
`buildFtPrePreTxData`; the parent input TXID is the authentication commitment.

`TbcInputAuthorization.sol` adds the fourth Phase 3D slice. For every FT and
native input it locates the exact signature/public-key pushes committed inside
the serialized input script, requires canonical low-S DER ECDSA with exact
`ALL|FORKID (0x41)`, binds the compressed public-key HASH160 to the parent FT
controller or native P2PKH owner, reconstructs the TBC/BIP143-style sighash and
checks the signature through EVM `ecrecover`. The supplied x/y witness must
match the compressed key in the raw transaction; it cannot substitute another
owner. The final native input must also use the exact two-push P2PKH unlock
shape. Schnorr and other sighash modes fail closed for this frozen route.

The next bounded semantic slice consumes the canonical legacy-v3
`getPreTxdata(parent, vout)` witness immediately after each FT public key. It
checks the pushed version/locktime/input/output header, every parent
outpoint/sequence, the aggregate parent input-script hashes, surrounding output
value/script-hash commitments, the pinned Code suffix and partial hash, exact
Tape bytes and the final input-script boundary. An inserted stable-coin
`isCoin` flag, changed parent header, non-canonical push or trailing stack data
therefore fails closed even though input scripts are not covered by the
`ALL|FORKID` signature digest.

These slices still do not validate the preceding `getCurrentTxdata` and
`buildFtPrePreTxData` stack encodings or execute the complete pinned legacy-v3
FT Script. They also do not provide an independent UTXO
non-membership/unspent proof.
Accordingly it is an owner-authorized structural legacy-FT transition verifier,
not yet the full Phase 2 Script verifier and not a mint authorization gate.

## 2. Executed cross-language vectors

The pinned Solidity 0.8.30 compiler targets Cancun, matching HyperEVM Testnet
chain 998. The compiled primitive harness is 6,728 runtime bytes, the relay is
9,314 runtime bytes and the Phase 3D deposit harness is 23,224 runtime bytes,
leaving 1,352 bytes below the EVM runtime limit. A read-only `eth_call`
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
- rejection after changing the committed checkpoint timestamp;
- six consecutive official testnet headers `839165..839170`, including each
  parent link, PoW, exact DAA transition, MTP, version, cumulative work and
  bootstrap proof set;
- canonical ancestry and six-confirmation finality for block `839165`; and
- fail-closed equal-best-work state followed by resolution by a higher-work tip.

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

### 2.1 Read-only gas profile

The RPC test also runs `eth_estimateGas` against the relay deployment bytecode
and against the deployed runtime plus an exact storage override for each prior
header. Unlike the in-harness `gasleft()` diagnostic, the direct transaction
estimate includes transaction intrinsic gas and the submitted calldata.

Observed on HyperEVM Testnet on 2026-11-03:

| Operation | Bootstrap witnesses | Calldata bytes | Direct transaction gas estimate |
| --- | ---: | ---: | ---: |
| Deploy `TbcHeaderRelayV2` | — | — | 2,211,582 |
| Submit header 839165 | 26 | 17,700 | 1,120,055 |
| Submit header 839166 | 25 | 17,028 | 1,123,234 |
| Submit header 839167 | 24 | 16,356 | 1,079,180 |
| Submit header 839168 | 23 | 15,684 | 1,064,072 |
| Submit header 839169 | 22 | 15,012 | 1,051,412 |
| Submit header 839170 | 21 | 14,340 | 1,062,044 |
| Six header transactions | — | — | 6,499,997 |

The RPC's suggested gas price during that run was `100,000,000 wei` (0.1 gwei).
At that temporary price, deployment was approximately `0.0002211582 HYPE` and
the six separate header submissions totalled approximately `0.0006499997 HYPE`.
Deployment plus those six submissions was `8,711,579 gas`, or approximately
`0.0008711579 HYPE` at the observed price.
These are testnet observations, not fixed fees: the payable amount is always
`gasUsed × effectiveGasPrice` at inclusion time.

The six-header total is relay maintenance cost, normally paid across six
relayer transactions; it is not automatically charged as one transaction to a
bridge user. It also excludes the future Phase 3D FT/Covenant proof, replay
protection and mint transaction. Bootstrap calldata shrinks as the relay moves
forward, but production budgeting still requires longer-range profiles and a
real deployed-state benchmark.

### 2.2 Phase 3D bounded deposit-envelope gas

The same read-only RPC suite builds a 3,275-byte signed version-10 transaction,
2,113 bytes of bounded parent transactions and an 85-byte bound ancestor from
the real pinned MT v3 Code/Tape artifact. The vector carries SDK-generated
compressed-key ECDSA signatures for its FT and native inputs, but its synthetic
provenance is not presented as a complete valid FT Script execution.
Solidity and `tbc-lib-js` produced the same TXIDs, Covenant controller and
logical deposit ID and accepted the same two `ALL|FORKID` signatures. Mutated
amount, Code template, CompactSize, gateway,
Merkle-root, parent ordering, Tape allocation, native change, missing/mutated
ancestor, ancestor-group count, native ancestor, signature count/location/body
and public-key point cases all reverted. Mutations that inserted an `isCoin`
byte between the public key and parent witness, changed the committed parent
header or appended stack data also reverted while leaving the signed
outpoints/outputs unchanged.

Observed direct transaction estimates on HyperEVM Testnet on 2026-11-04:

| Operation | Calldata bytes | Direct transaction gas estimate |
| --- | ---: | ---: |
| Parse TXID + Covenant/v3 output envelope | 3,428 | 154,321 |
| Same envelope + one-leaf Merkle reconstruction | 3,588 | 163,574 |
| Envelope + 2 bound parents + FT/native conservation | 5,764 | 331,174 |
| Same transition + exact one-level ancestor authentication | 6,116 | 496,870 |
| Same transition + FT/native input authorization + exact parent witness | 6,372 | 864,413 |

The one-leaf vector has no sibling hashes and the second estimate does not call
a deployed relay. The transition estimate parses two small synthetic parents;
real parent/ancestor sizes can be materially larger. A real block branch, relay
lookup, complete FT script proof, replay write and mint will cost more. These
measurements therefore cannot be used as a final per-deposit fee quote.

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

## 4. Phase 3C trust and time boundary

The relay copies the contextual header rules from the pinned official TBCNODE
v3.3.1 source. In particular, TBC uses a 20-minute future-time allowance, not
Bitcoin's commonly cited two-hour window, and requires the new timestamp to be
strictly greater than the parent branch's median of the previous 11 timestamps.

TBCNODE compares future time with its peer-adjusted node clock. An EVM contract
cannot read that clock, so the relay uses HyperEVM's consensus `block.timestamp`
instead. This can delay a header when the two networks' clocks differ; it does
not let a relayer provide its own time. This clock substitution and submission
gas must be assessed before deployment.

The relay proves header-chain membership, accumulated work and transaction
Merkle-root availability. It does not prove TBC UTXO state, transaction script
execution or FT Covenant semantics. Those remain separate gates.

## 5. Remaining Phase 3 work

Phase 3 is not yet a proof-backed bridge. The next implementation slices are:

1. complete the remaining Phase 2 legacy-FT input proof: verify the pinned-v3
   FT Script semantics over the now-authenticated and owner-authorized bytes;
   choose and review either a bounded semantic verifier or a proof-system
   circuit before calling it trustless;
2. add exact source-outpoint/logical-deposit replay protection;
3. add a new proof-only `WrappedFTV2`/gateway pair with no owner, backend or
   minter proof bypass.

Before any relay deployment, add a pinned local-EVM suite, fuzz malformed
bootstrap witnesses and long competing branches, measure per-header gas, and
obtain independent Solidity/consensus review. The current RPC vector executes
real state transitions but is not a substitute for those gates.

The existing `BridgeWrappedFT`, `LearningWrappedFT` and
`LearningRedemptionEscrow` must remain separate learning/custodial artifacts.
They must not be relabelled or upgraded in place as v2 contracts.

## 6. Current security statement

Phase 3A/B/C shows that the frozen TypeScript header, PoW, DAA, Merkle and
bootstrap-commitment vectors, plus six real sequential relay transitions, can
be reproduced by Solidity on HyperEVM Testnet. Phase 3D additionally reproduces
the version-10 TXID, validates the pinned Covenant/v3 output envelope and binds
the deposit inputs to parent outpoints with structural FT/native conservation,
then authenticates the exact one-level legacy-FT ancestor set committed by
those parents and verifies the committed compressed-key `ALL|FORKID` signatures
against each FT/native input owner. It also binds the complete canonical parent
witness tail consumed after each FT signature/public key to those authenticated
parent bytes.
It does **not** establish a live canonical TBC chain because the relay is not
deployed or independently audited, and it does not execute or validate the
complete legacy FT input Script program: current-transaction and pre-parent
stack encodings remain outside the bounded semantic verifier. It cannot
authorize minting. Until all
remaining gates pass, the forward path remains the existing custodial learning
flow and must not be described as trustless.

## 7. Evidence used

- [Official TBC Block API](https://docs.turingbitchain.io/en/Block) documents
  height lookup and recent-block pages, including their 100-block maximum.
- [Official API introduction](https://docs.turingbitchain.io/en/Introduction)
  identifies `api.tbcdev.org` as the Testnet API.
- [Pinned TBCNODE contextual header validation](https://github.com/TuringBitChain/TBCNODE/blob/6ddea88c57e9bc9390c1730657ac766b56c4a670/src/validation.cpp#L5728-L5765)
  defines exact difficulty, MTP, future-time and version checks.
- [Pinned TBCNODE chain constants and MTP](https://github.com/TuringBitChain/TBCNODE/blob/6ddea88c57e9bc9390c1730657ac766b56c4a670/src/chain.h#L21-L32)
  fixes the future allowance at 20 minutes; the same file defines the 11-block
  MTP calculation.
- [Pinned TBCNODE skip-list implementation](https://github.com/TuringBitChain/TBCNODE/blob/6ddea88c57e9bc9390c1730657ac766b56c4a670/src/chain.cpp#L73-L123)
  is mirrored for efficient canonical ancestry queries.
- [Official HyperEVM documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm)
  identifies Testnet as chain 998, Cancun as its EVM target and HYPE as the
  native gas token.
