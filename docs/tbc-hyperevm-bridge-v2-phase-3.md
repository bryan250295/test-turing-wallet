# TBC ↔ HyperEVM Bridge v2 — Phase 3 Solidity Verifier

Status: **Phase 3A consensus/Merkle primitives, Phase 3B authenticated
bootstrap commitment, Phase 3C permissionless header-relay core and the Phase
3D bounded TXID/Covenant/v3 output-envelope, parent/outpoint conservation and
one-level FT ancestor-authentication, input-signature and exact legacy-v3
unlock-stack semantic layers, plus the dual-key replay-protection storage
primitive and proof-only Gateway/WrappedFTV2 composition, are implemented and
cross-checked for the frozen `tbcdev-testnet` vector; Phase 3E also executes the
same production composition through persistent transactions on a disposable,
pinned local Cancun EVM; Phase 3F adds deterministic malformed-proof and
relay-witness property vectors around that rehearsal; nothing is deployed to a
public network or independently audited**

Implementation date: **2026-11-05 (Asia/Kuala_Lumpur)**

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
relay. The proof Gateway binds that relay address, its own address and reserve
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

The fifth bounded semantic slice consumes the canonical legacy-v3
`getPreTxdata(parent, vout)` witness immediately after each FT public key. It
checks the pushed version/locktime/input/output header, every parent
outpoint/sequence, the aggregate parent input-script hashes, surrounding output
value/script-hash commitments, the pinned Code suffix and partial hash, exact
Tape bytes and the final input-script boundary. An inserted stable-coin
`isCoin` flag, changed parent header, non-canonical push or trailing stack data
therefore fails closed even though input scripts are not covered by the
`ALL|FORKID` signature digest.

`TbcFtUnlockPrefixVerifier.sol` completes the bounded legacy-v3 unlock-stack
semantics preceding each FT signature. It requires the exact SDK
`getCurrentTxdata || buildFtPrePreTxData` byte sequence, including canonical
push opcodes, output values/scripts, reverse Tape-slot ancestor ordering,
pre-parent header/input/output commitments and the input-index opcode. It
implements the TBC `OP_PARTIAL_HASH` SHA-256 compression state over exact
64-byte blocks and cross-checks it against the pinned SDK instead of treating
the supplied intermediate state as trusted data. The optimized fixed v3
partial-state path additionally binds the actual 1,856-byte Code prefix to the
pinned template before accepting its frozen compression state.

Together, the structural, authorization/parent-tail and unlock-prefix gates
cover the complete SDK-generated legacy-v3 `FT.getFTunlock(..., false)` input
shape for this frozen route through bounded semantic checks. This is not a
general-purpose TBC Script interpreter and does not support other FT versions,
stable-coin flags, swap paths, Schnorr or other sighash modes. It also does not
provide an independent UTXO non-membership/unspent proof and is not yet a mint
authorization gate by itself.

`TbcDepositReplayProtection.sol` adds the stateful boundary used by the
proof-only gateway. After every proof gate succeeds, the gateway can
atomically consume both the complete logical deposit ID and a separately
domain-separated physical source-outpoint ID binding the TBC Testnet domain,
source FT contract, transaction ID and fixed FT output `vout=1`. Reusing either
identity reverts before mint. The write is intentionally internal so an
untrusted caller cannot pre-consume another user's proof through a standalone
registry; the gateway inherits it and performs proof, replay write and
mint in one EVM transaction. Any later revert rolls both mapping writes back.

`TbcAuthorizedTransitionVerifier.sol` and
`TbcFtUnlockPrefixVerifierModule.sol` expose the two large stateless verifier
paths as production modules. `TbcProofMintGateway.sol` pins their exact runtime
codehashes. Its constructor directly deploys `TbcHeaderRelayV2` from the pinned
creation code and checks the resulting runtime codehash, so a caller cannot
supply exact relay runtime with pre-seeded fraudulent storage. The relay,
module addresses, reserve controller and wrapped token are immutable. Its
permissionless `mintFromProof` requires finalized Merkle inclusion, complete
input authorization, exact unlock-prefix semantics, identical signature
offsets across both modules, an identical parsed deposit result, and both replay
keys before minting. It has no owner, operator, pause key or alternate mint
entry point.

The Gateway constructor deploys its own `WrappedFTV2`, removing any circular or
mutable gateway/token configuration. The token is fixed to MT contract ID
`ac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c`,
one decimal, name `Proof Wrapped Mega Token` and symbol `pwMT`. Only the immutable
Gateway can mint, and total supply cannot exceed the pinned MT genesis supply of
10,000,000 raw units. There is no owner, admin, alternate minter or burn function;
burn remains disabled until the Phase 4 release path is separately designed and
reviewed.

`TbcBridgeDepositVerifierHarness.sol` now exposes only the structural, Merkle
and finalized-inclusion test paths. `TbcAuthorizedTransitionHarness.sol`
exposes only the authorization/parent-witness path, while
`TbcFtUnlockPrefixHarness.sol` exposes the exact prefix-semantic path. This is
compiler and deployment isolation required by the EVM code-size limit. The
production Gateway requires both Phase 3D gates over the same immutable
route inputs; neither result is sufficient by itself.
`TbcDepositReplayHarness.sol` is a 2,306-byte stateful test harness with no mint
authority. It cross-checks the source-outpoint key, both independent duplicate
paths and EVM rollback behavior; it is not the production Gateway.
`TbcProofMintIntegrationHarness.sol` is test-only scaffolding that observes the
token balance and supply within the same read-only RPC simulation and retries
the proof to confirm fail-closed replay handling.

## 2. Executed cross-language vectors

The pinned Solidity 0.8.30 compiler targets Cancun, matching HyperEVM Testnet
chain 998. The compiled primitive harness is 6,728 runtime bytes and the relay
is 9,314 runtime bytes. Phase 3D is split into a 14,789-byte structural/Merkle
harness, a 20,594-byte authorization/parent-witness harness and a 12,517-byte
unlock-prefix harness, leaving 9,787, 3,982 and 12,059 bytes respectively below
the EVM runtime limit. The split lets the compiler remove unrelated external
paths. Parsed deposit and dynamically sized parent views are shared across
conservation, native change, ancestor and input authorization checks, so each
supplied parent is hashed and decoded only once. A read-only `eth_call`
injects that runtime temporarily through the RPC state-override parameter; it
does not deploy code or submit a transaction.

The production authorization and prefix modules are 20,594 and 12,356 runtime
bytes. The composed Gateway is 12,642 bytes and the OpenZeppelin-based
WrappedFTV2 is 2,390 bytes, leaving 11,934 and 22,186 bytes respectively below
the EVM runtime limit. The Gateway creation bytecode also contains the token
and relay creation code because both are deployed atomically by its constructor.
That initcode is 26,391 bytes, 22,761 bytes below the Cancun/EIP-3860
49,152-byte initcode limit.

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
npm run phase3:local-evm-test
npm run typecheck
```

The RPC state-override and persistent local-EVM suites cover different
boundaries. Neither is a substitute for independent security and gas review.

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
bridge user. It also excludes the combined Phase 3D FT/Covenant proof, replay
write and mint transaction measured separately below. Bootstrap calldata shrinks as the relay moves
forward, but production budgeting still requires longer-range profiles and a
real deployed-state benchmark.

### 2.2 Phase 3D bounded deposit-envelope gas

The same read-only RPC suite builds a 3,441-byte signed version-10 transaction,
2,154 bytes of bounded parent transactions and two 85-byte bound ancestors from
the real pinned MT v3 Code/Tape artifact. The vector carries SDK-generated
compressed-key ECDSA signatures and the complete SDK-generated legacy-v3
unlock stack for its FT and native inputs. Its transactions are synthetic test
provenance rather than a claim about a historical on-chain transfer.
Solidity and `tbc-lib-js` produced the same TXIDs, Covenant controller and
logical deposit ID and accepted the same two `ALL|FORKID` signatures. Mutated
amount, Code template, CompactSize, gateway,
Merkle-root, parent ordering, Tape allocation, native change, missing/mutated
ancestor, ancestor-group count, native ancestor, signature count/location/body
and public-key point cases all reverted. Mutations that inserted an `isCoin`
byte between the public key and parent witness, changed the committed parent
header or appended stack data also reverted while leaving the signed
outpoints/outputs unchanged. The earlier authorization gate alone accepted
same-length mutations to the unsigned current/pre-parent prefix, while the new
semantic gate rejected changed current-output amounts, changed partial-SHA256
state and changed pre-parent headers. Solidity and the SDK produced the same
partial state for the same 256-byte script prefix. The parent has two non-zero
Tape slots: proofs are supplied in ascending slot order while the exact SDK
unlock prefix encodes the authenticated pre-parent transactions in reverse slot
order; reversing the supplied proof group reverted in both gates.
The same RPC state-override run produced the identical source-outpoint ID in
TypeScript and Solidity, rejected reuse of either the logical deposit ID or the
physical source outpoint while the other key changed, and confirmed that a
later revert rolls both replay writes back.
The composed Gateway vector additionally checked all pinned runtime hashes,
rejected a constructor supplied with changed verifier code, rejected a direct
non-Gateway token mint and a mint above the pinned source supply, rejected
different signature offsets between the two modules, minted the exact raw
amount to both recipient balance and total supply, then rejected the same proof
on its second call. For this synthetic transaction,
the read-only state override replaces the first retained header's Merkle root
with the synthetic TXID while retaining the production relay runtime and a
six-confirmation ancestry. It tests Gateway composition, not a claim that this
synthetic transaction exists in that historical TBC block.

Observed direct transaction estimates on HyperEVM Testnet on 2026-11-04:

| Operation | Calldata bytes | Direct transaction gas estimate |
| --- | ---: | ---: |
| Parse TXID + Covenant/v3 output envelope | 3,588 | 156,783 |
| Same envelope + one-leaf Merkle reconstruction | 3,748 | 166,001 |
| Envelope + 2 bound parents + FT/native conservation | 5,956 | 323,479 |
| Same transition + exact one-level ancestor authentication | 6,468 | 430,270 |
| Same transition + FT/native input authorization + exact parent witness | 6,724 | 642,958 |
| Exact `getCurrentTxdata` + `buildFtPrePreTxData` prefix semantics | 6,532 | 1,232,956 |
| Atomic logical-deposit + source-outpoint replay write | 100 | 71,625 |
| Finalized proof + both semantic modules + replay + exact token mint | 6,980 | 2,021,801 |

The Gateway deployment, including creation of its checkpoint-initialized relay
and immutable WrappedFTV2, estimated at 5,625,359 gas. This excludes deployment
of the two stateless verifier modules, which are separately pinned by runtime
codehash.

On the earlier one-ancestor benchmark, before harness separation and
parsed-view reuse, the authorization path cost 864,413 gas and the combined
runtime was 23,224 bytes. On that same vector, the optimized authorization path is
271,222 gas (about 31.38%) lower, and its deployable runtime is 2,630 bytes
smaller, without changing calldata or accepted proof semantics. Relative to the
first split-harness result, sharing every parent view removes another 128,907
gas (about 17.85%) at a 207-byte authorization-runtime cost.

The one-leaf vector has no sibling hashes. The standalone Merkle estimate does
not call a deployed relay; the combined Gateway estimate calls the production
relay runtime against read-only injected state. The transition uses two small
synthetic parents, so real parent/ancestor sizes and nontrivial Merkle branches
can be materially larger. These measurements therefore cannot be used as a
final per-deposit fee quote.

### 2.3 Phase 3E persistent local-EVM rehearsal

The pinned `Hardhat 3.21.2` EDR engine runs a disposable Cancun chain with
chain ID `998`. The test deploys the authorization module, prefix module and
Gateway in the production order. The Gateway constructor creates its own relay
and WrappedFTV2. Six official headers `839165..839170` are then submitted as
six real local transactions, after which the test checks six-confirmation
finality and cumulative work.

The synthetic deposit is not part of historical TBC Testnet. The suite makes
that boundary explicit by changing only the retained block's Merkle-root slot
inside the disposable EVM before sending the proof-mint transaction. It then
checks the exact `DepositConsumed` and `ProofMinted` event fields, both replay
keys, recipient balance, total supply and state preservation after a reverted
same-proof replay. It also rejects wrong verifier offsets, an invalid Merkle
index, direct token mint, supply-cap overflow, three malformed authorization
witness layouts, three malformed unlock prefixes and a Gateway deployment with
the wrong module runtime.

The compiler/build hash, runtime codehashes, deterministic deployment order,
addresses and gas results are frozen in
`backend/src/bridge/phase3/fixtures/phase3e-local-evm-v1.json`. A change fails
the test until it is deliberately reviewed and the manifest is updated.

Observed persistent local transaction gas on 2026-11-04:

| Operation | Gas used |
| --- | ---: |
| Deploy authorization module | 4,507,405 |
| Deploy prefix module | 2,725,013 |
| Deploy Gateway + self-created relay/token | 5,580,339 |
| Submit headers 839165..839170 | 6,441,867 |
| Finalized proof + both modules + replay + mint | 2,004,400 |
| Rejected same-proof replay | 248,910 |

These numbers are a deterministic regression baseline, not a public-network
fee quote. No public RPC transaction, token mint or asset movement occurs.

### 2.4 Phase 3F deterministic proof and witness fuzzing

The persistent local-EVM rehearsal now runs a reproducible seeded fuzz corpus
before its canonical mint. Seed `0x5eed3f01` generates 64 ABI-valid proof
envelopes across eight mutation classes: unknown block hash, raw transaction
bit flip, invalid transaction index, inconsistent transaction count/Merkle
branch, parent transaction bit flip, FT ancestor transaction bit flip,
signature public-key bit flip and signature push-offset displacement. Every
mutated proof must revert.

Each of the six relay transitions also tests four malformed bootstrap-witness
sets: one required witness removed, one witness duplicated, one authenticated
point changed and one Merkle sibling changed. All 24 cases must revert. The
same six witness sets are additionally submitted in reverse order through
read-only calls and must succeed. This is intentional: the relay resolves
witnesses by authenticated height, so their container has set semantics rather
than an order-dependent consensus meaning.

After all fuzz calls, the suite proves that wrapped supply and recipient
balance remain zero and that neither the logical-deposit nor source-outpoint
replay key was consumed. The unmodified canonical proof must then still mint
successfully. Counts, seed and invariants are frozen in
`backend/src/bridge/phase3/fixtures/phase3f-seeded-fuzz-v1.json`; Phase 3E's
deployment and gas manifest remains unchanged.

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

Phase 3 now contains the proof-only `WrappedFTV2`/Gateway implementation, but it
is not yet an operational proof-backed bridge. The pinned local-EVM deployment,
header-sync, mint and replay rehearsal and its fixed-seed malformed-input corpus
are complete. Before any public-network deployment, remaining work includes
larger multi-seed fuzz campaigns, long competing-branch and reorganization
tests, real-size deposit/Merkle-branch benchmarks and independent Solidity, TBC
Script and consensus review. A real testnet deposit must then pass through
newly deployed contracts without moving existing custodial balances.

The main protocol blocker is unchanged: finalized transaction inclusion does
not prove that the minted source FT outpoint remains unspent. An API or TBCScan
status is operational evidence, not a cryptographic fact authenticated by the
EVM. Production therefore still needs either an EVM-verifiable TBC UTXO
commitment/proof or a separately reviewed TBC Bridge Covenant/redemption design
that constrains reserve movement and prevents an already represented deposit
from being spent outside the authorized release transition.

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
parent bytes. The separate prefix-semantic gate validates the complete
`getCurrentTxdata` and `buildFtPrePreTxData` portion before each signature,
including the SDK-compatible SHA-256 intermediate states. Together these gates
cover the exact pinned legacy-v3 `FT.getFTunlock(..., false)` stack through a
bounded semantic verifier rather than a general Script interpreter.
The replay module separately consumes the logical intent identity and physical
source outpoint, rejects either form of reuse and relies on EVM transaction
atomicity to roll its state back if minting later fails.
The proof-only Gateway composes finalized inclusion, both exact semantic gates,
dual replay consumption and WrappedFTV2 minting without an administrative mint
path, and its constructor pins every external verifier runtime by codehash.
It does **not** establish a live canonical TBC chain because the relay is not
deployed on a public network or independently audited. It also does not prove
current UTXO unspentness. The Gateway has now executed against persistent state
on a disposable local chain, but its Merkle-root substitution is test-only and
does not claim that the synthetic transaction exists in historical TBC
Testnet. Until the unspent/reserve-control gap, independent review and a real
testnet proof pass are complete, the forward path remains the existing
custodial learning flow and must not be described as production-trustless.

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
