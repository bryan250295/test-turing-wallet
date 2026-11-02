# TBC ↔ HyperEVM Bridge v2 — Phase 0 Protocol Baseline

Status: **Phase 0 draft; no runtime behavior has changed**  
Baseline date: **2026-11-02 (Asia/Kuala_Lumpur)**  
TBCNODE review baseline: [`6ddea88c57e9bc9390c1730657ac766b56c4a670`](https://github.com/TuringBitChain/TBCNODE/tree/6ddea88c57e9bc9390c1730657ac766b56c4a670)

This document freezes the intended v2 scope before implementation. It is not a
claim that the bridge is trustless today. The existing Learning Bridge remains a
separate custodial test system until every applicable phase gate is satisfied.
`STUDY2.md` remains read-only source material.

Normative words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** describe v2
requirements. Field names, formulas and normative statements are the protocol
baseline; later translations must not change their meaning.

## 中文执行摘要

- 现有Learning Bridge继续作为托管式测试系统，不会被静默升级或迁移。
- 项目只运行官方未修改的TBCNODE，并修改自己仓库里的合约、证明服务、Indexer
  和Relayer；不会fork官方节点代码。
- TBC → HyperEVM的v2目标是由HyperEVM合约验证TBC header、chainwork、TXID、
  Merkle和指定FT状态，任何Relayer都能提交，Backend不能无证明mint。
- HyperEVM → TBC在不升级TBCNODE的范围内采用threshold/MPC，因此必须标示为
  trust-minimized，而不是完全trustless。
- 首条路线固定为TBC Testnet的Mega Token到HyperEVM Testnet chain ID 998，raw
  amount严格1:1；初始政策是两侧各6 confirmations，但这不等于确定性finality。
- Phase 0只冻结协议边界和编码规则，不部署、不mint、不burn、不release，也不移动
  用户资产。

## 1. Frozen outcome and non-goals

### 1.1 Target outcome

| Direction | v2 target | Where verification happens |
| --- | --- | --- |
| TBC → HyperEVM | Trustless deposit and mint | HyperEVM contracts verify TBC headers, chainwork, transaction inclusion and the supported FT transition |
| HyperEVM → TBC | Threshold/MPC trust-minimized burn and release | TBC covenant verifies a domain-separated threshold authorization |

The forward path MUST NOT give a backend, relayer, owner, or minter authority to
mint without a valid proof. The reverse path MUST NOT be described as trustless
while it depends on a signer threshold.

### 1.2 No official-code modification

This project will:

- run unmodified official TBCNODE instances;
- build its own protected RPC adapter, FT indexer and proof service;
- independently implement the minimum TBC verifier required on HyperEVM;
- deploy project-owned HyperEVM contracts and TBC covenant transactions.

This project will not fork or publish modified TBCNODE or HyperEVM node software.
Changing TBC consensus or adding BVM opcodes is explicitly outside v2 scope.

### 1.3 Official TBCNODE version policy

At the Phase 0 baseline date, the latest official stable TBCNODE release is
`v3.3.1`, commit
`6ddea88c57e9bc9390c1730657ac766b56c4a670`. This is the exact source baseline
reviewed for this document; it is not an old or project-modified node version.

Before Phase 1 deployment, the project MUST check the official TBCNODE releases
again. Production nodes MUST pin an exact official release tag, full commit hash,
verified build artifact and configuration. They MUST NOT automatically follow a
floating `main`, `latest` container tag or newly published release. A newer
official release may replace the pinned version only after compatibility,
security, RPC/proof-vector and rollback testing. An unreviewed development-branch
commit is not equivalent to the latest stable release.

### 1.4 Initial supported route

| Field | Frozen Phase 0 value |
| --- | --- |
| Source route name | TBC Testnet learning route (`api.tbcdev.org` is the current observation service, not the future trust root) |
| Source asset family | One ordinary legacy FT only |
| First asset | Mega Token (`MT`) |
| Source Contract ID | `ac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c` |
| Source decimals | `1` |
| Source FT version | Legacy FT v3 |
| Destination | HyperEVM Testnet, chain ID `998` |
| Amount mapping | Exact raw-unit `1:1`; no floating point and no exchange-rate conversion |
| Source confirmation policy | Minimum 6 canonical confirmations including the deposit block (normally 5 descendants) |
| Destination confirmation policy | Minimum 6 canonical confirmations including the transaction block |

The confirmation counts are risk policies, not deterministic finality. A later
security review MAY increase them. A policy change MUST be versioned and MUST NOT
silently change an already-created request.

## 2. Existing system boundary

The existing contracts remain learning artifacts:

- `LearningWrappedFT` trusts a designated minter and verifies no TBC proof.
- `LearningRedemptionEscrow` permanently locks tokens and performs no TBC release.
- the backend trusts the fixed TBC API/indexer for canonical inclusion and UTXO
  availability, although it independently checks raw transactions and scripts.

V2 MUST use new contracts and a new route/version. It MUST NOT silently reinterpret
old orders, old deposits, permanently locked lwFT, or the deployed Learning contract
as v2 proof-backed assets. Migration, if later offered, MUST be an explicit user
operation with separately reviewed rules.

## 3. Canonical identifiers and encoding

### 3.1 General rules

- Hex identifiers MUST be lowercase and fixed-width, without a `0x` prefix on the
  TBC/API side.
- A displayed TBC TXID is the 64 hexadecimal characters returned by TBCNODE/RPC.
- Solidity `bytes32 sourceTxid` MUST parse that displayed hexadecimal value directly.
  It MUST NOT reverse it merely for storage or display.
- TBC wire serialization MUST still apply TBCNODE's internal byte order where the
  protocol requires it. Display encoding and wire encoding MUST never be mixed.
- A source outpoint is `(sourceTxid, sourceVout)`, with `sourceVout` an unsigned
  32-bit zero-based output index.
- Raw token amounts use unsigned decimal integer strings at API boundaries and
  `uint256`/`bigint` internally. Floating point is forbidden.
- HyperEVM addresses are canonical 20-byte values. Letter casing is presentation
  only and MUST NOT change identity.
- A v2 TBC redemption recipient MUST use decoded, network-bound Base58Check payload
  bytes in the signed request. A free-form address string alone is insufficient.

### 3.2 Hash algorithms

- Turing TXID calculation MUST exactly reproduce TBCNODE transaction version 10.
- TBC block hashes and Merkle internal nodes use double SHA-256 as defined by
  TBCNODE.
- TBC Script hashes and partial hashes MUST use the exact algorithm required by
  the relevant locking script; no Keccak substitution is allowed.
- EVM-only message identifiers use `keccak256(abi.encode(...))`, never
  `abi.encodePacked(...)` for mixed dynamic fields.
- Every cross-chain hash or signature MUST include an explicit protocol/version
  domain. A signature valid for a deposit MUST NOT be valid for redemption,
  governance, another chain, or another deployment.

### 3.3 V2 domains and logical IDs

The following strings are frozen for v2 design. Their `keccak256` values will be
captured as test vectors before contracts are deployed:

```text
SOURCE_DOMAIN     = "learningmaterials/tbc-hyperevm/v2/tbc-testnet"
DEPOSIT_DOMAIN    = "learningmaterials/tbc-hyperevm/v2/deposit"
REDEMPTION_DOMAIN = "learningmaterials/tbc-hyperevm/v2/redemption"
HEADER_DOMAIN     = "learningmaterials/tbc-hyperevm/v2/header-relay"
```

The logical deposit identifier is:

```text
keccak256(abi.encode(
  DEPOSIT_DOMAIN_HASH,
  SOURCE_DOMAIN_HASH,
  sourceContractId,
  sourceTxid,
  uint32(sourceVout),
  uint256(destinationChainId),
  destinationGateway,
  recipient,
  amountRaw,
  depositNonce
))
```

All fields MUST be proven from, or cryptographically bound by, the accepted TBC
deposit covenant. Request metadata supplied only by a browser or backend is not
proof.

The logical redemption request identifier is:

```text
keccak256(abi.encode(
  REDEMPTION_DOMAIN_HASH,
  uint256(sourceEvmChainId),
  redemptionGateway,
  wrappedAsset,
  requester,
  amountRaw,
  tbcRecipientPayload,
  redemptionNonce
))
```

A reverse-release authorization MUST additionally bind the canonical HyperEVM
block hash, transaction hash, log index, request ID and validator-set epoch. The
exact threshold signature envelope is a Phase 4 deliverable.

## 4. TBC proof boundary

A valid forward mint requires all of the following, not merely an API response:

1. A header chain anchored at the approved bootstrap checkpoint.
2. Valid header linkage, SHA256d proof of work and TBC difficulty transitions.
3. Selection of the valid branch with the greatest cumulative chainwork.
4. The configured canonical-confirmation threshold.
5. A version-10 Turing TXID recomputed from the exact raw transaction.
6. A non-malleable Merkle inclusion proof to the accepted header root.
7. A bounded proof that the selected legacy FT transition and Bridge Covenant
   output are valid for the pinned asset, amount, destination and recipient.
8. Replay protection for the exact proven source outpoint and logical deposit ID.

`gettxoutproof` is proof material, not a trustless decision by itself. An indexer
MAY locate data, but neither an indexer nor a relayer is a trust root.

The final light-client bootstrap checkpoint is intentionally **not frozen yet**.
The currently pinned asset-genesis block proves asset identity for the learning
route; it is not automatically a sufficient light-client consensus checkpoint.
Phase 1 MUST confirm network identity and the checkpoint against independently
operated official TBCNODE instances before Phase 3 deployment.

## 5. Trust and authority model

### 5.1 Forward path

The forward path may assume:

- the configured bootstrap checkpoint is correct;
- TBC proof-of-work and cryptographic primitives are secure;
- HyperEVM consensus and the deployed verifier bytecode are correct.

It MUST NOT assume that a relayer, public API, project backend, FT indexer, owner,
or minter reports TBC state honestly. Submission MUST be permissionless. Core
verification and replay state SHOULD be non-upgradeable; any mutable operational
parameter MUST be narrowly scoped and controlled by a delayed multisig.

### 5.2 Reverse path

The reverse path explicitly trusts that at least the configured threshold of the
validator/MPC set will not authorize a false or duplicate HyperEVM event. No single
backend process or key may release reserves. Validator membership, threshold,
epochs, rotation, emergency handling and equivocation evidence are Phase 4 work.

Burn MUST NOT be enabled until a tested release path and failure-recovery procedure
exist. A burn without a safe release mechanism is an unacceptable loss state.

### 5.3 Administrators

An administrator MAY pause new deposits, mints or redemption requests. An
administrator MUST NOT be able to mint, rewrite an accepted proof, mark an unproven
deposit as canonical, or unilaterally release TBC reserves. Pausing is an incident
control, not a substitute for proof verification.

## 6. Reorganizations and completion

- The light client MUST follow cumulative chainwork rather than provider-reported
  confirmation counts.
- A deposit MUST NOT be mintable before its block has the configured number of
  canonical confirmations, counting its own block as confirmation one.
- Proof jobs MUST be tied to a specific header hash and proof-policy version.
- A reorganization before mint eligibility invalidates the pending proof.
- A reorganization detected after mint is a security incident because already
  transferred wrapped tokens cannot be automatically recalled. V2 MUST pause new
  settlement and reconcile reserves; the chosen confirmation policy limits but
  does not eliminate this risk.
- Backend timeouts, missing index data, or conflicting nodes produce `unknown` or
  `needs_review`, never success and never an automatic replacement payment.

## 7. Supply invariant

After v2 activation, the intended public invariant is:

```text
proven and locked TBC FT reserve
  = WrappedFTV2 totalSupply
  + authorized-but-not-yet-released redemption liability
```

The exact treatment of in-flight burns is finalized with Phase 4 state transitions.
Existing permanently escrowed Learning lwFT is outside this invariant. A public
reconciliation service MUST derive each term from fixed contracts, accepted proofs
and registered reserve outpoints; it MUST label unavailable data rather than infer
zero.

## 8. Phase gates and decision register

### Completed Phase 0 decisions

- [x] Only project-owned code and infrastructure will change.
- [x] Official TBCNODE will be run unmodified.
- [x] The first route supports one pinned legacy FT and exact 1:1 raw units.
- [x] TBC → HyperEVM targets proof-verified, permissionless minting.
- [x] HyperEVM → TBC is honestly scoped as threshold/MPC trust-minimized.
- [x] Existing Learning contracts and orders are not silently upgraded or migrated.
- [x] Canonical identifier, byte-order, amount and domain-separation rules are recorded.
- [x] Six confirmations remain the initial test policy and are not described as finality.

### Open gate before Phase 0 can be marked complete

- [ ] User review accepts this baseline and any requested corrections are recorded.

### External and later-phase gates

- [ ] Before production-oriented Phase 1 deployment, the TBC project/licensor
  confirms the intended commercial operation of unmodified TBCNODE and an
  independently written interoperable light client.
- [ ] During Phase 1, independently operated nodes confirm the source network
  identity, chain parameters and a suitable light-client bootstrap checkpoint.
- [ ] During Phase 2, the exact TBC Bridge Covenant serialization and bounded
  legacy-FT proof shape are specified and attached as versioned test vectors.

These later-phase items are deliberate hand-offs, not permission to change the
logical fields or trust model silently. Any incompatible change requires a new
protocol version and an explicit update to this decision register.

## 9. Next authorized implementation step

After review of this document, Phase 1 may begin with read-only infrastructure:

1. deploy two isolated official TBCNODE instances with `txindex`;
2. record binary/source version, network parameters and startup configuration;
3. expose authenticated internal RPC only;
4. compare best block hash, height and chainwork;
5. capture raw header, transaction and Merkle-proof fixtures without changing the
   current bridge settlement path.

No Phase 1 activity should mint, burn, release, migrate, or move user assets.
