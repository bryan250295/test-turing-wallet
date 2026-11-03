# TBC ↔ HyperEVM Bridge v2 — Phase 2 Covenant and Legacy-FT Proof

Status: **Phase 2 serialization and offline verification complete for the
`tbcdev-testnet` route; not deployed or connected to settlement**

Implementation date: **2026-11-03 (Asia/Kuala_Lumpur)**

Phase 2 freezes how a new v2 deposit binds its destination and how a bounded
legacy-FT transition is verified. It does not broadcast a TBC transaction,
deploy an EVM verifier, mint, burn, release, or reinterpret an existing custody
payment. Existing vout-0 custody deposits are not v2 deposits.

## 1. Covenant model

The official `tbc-contract` 1.7.3 HTLC implementation demonstrates the legacy-FT
contract-controller convention used here:

```text
controller = RIPEMD160(SHA256(SHA256(covenant locking script)))
FT controller byte = 0x01 (contract)
```

The Bridge Covenant locking script is canonical and data-bound:

```text
PUSHDATA2 <262-byte BridgeDepositPayloadV1>
OP_DROP
OP_DUP OP_HASH160 <reserveControllerPubKeyHash> OP_EQUALVERIFY OP_CHECKSIG
```

The first push commits the cross-chain intent. The P2PKH tail is controlled by
the future threshold/MPC aggregate key. A release spends the Covenant output and
its adjacent FT Code output in the same transaction; the legacy FT script checks
that its contract-controller hash matches this Covenant script.

This is intentionally consistent with the Phase 0 trust model: proof-backed
forward minting does not give the backend a mint override, while reverse release
remains threshold/MPC trust-minimized. The Covenant does not itself understand a
HyperEVM burn. Phase 4 must freeze the signer set, threshold, epoch, release
message and incident rules before this controller can hold real production funds.

## 2. Fixed payload serialization

All integers are unsigned big-endian. Hex values are raw bytes without text or
`0x` inside the payload.

| Offset | Bytes | Field |
| ---: | ---: | --- |
| 0 | 8 | ASCII `LMBV2DEP` |
| 8 | 2 | schema version `1` |
| 10 | 32 | `keccak256("learningmaterials/tbc-hyperevm/v2/tbc-testnet")` |
| 42 | 32 | `keccak256("learningmaterials/tbc-hyperevm/v2/deposit")` |
| 74 | 32 | source legacy-FT Contract ID |
| 106 | 32 | destination chain ID (`998`) |
| 138 | 20 | destination gateway address |
| 158 | 20 | recipient address |
| 178 | 32 | raw token amount |
| 210 | 32 | deposit nonce |
| 242 | 20 | reserve threshold/MPC controller public-key hash |

Frozen domain hashes:

```text
SOURCE_DOMAIN_HASH  = 170fd6ecf53e485cfe0df6a4e3977ae78d3e1fca9ceb05a79c2bca1c79e45c8b
DEPOSIT_DOMAIN_HASH = 17a434e20a40ff4ee406974b50f279ce6f08bc91db025396d92f2871bdaaee46
```

`sourceTxid` is not placed inside its own transaction because that would be a
self-reference. It is reproduced from the final raw transaction. `sourceVout`
is fixed by the output layout below. Both are then included in the Phase 0
Solidity-compatible logical deposit ID.

## 3. Deposit transaction layout

| Output | Required content |
| ---: | --- |
| 0 | 100 sat Bridge Covenant locking script |
| 1 | 500 sat pinned legacy-FT v3 Code, controller = Covenant script hash |
| 2 | zero-sat matching FT Tape, amount = Covenant `amountRaw` |
| 3–4 | optional exact FT change Code/Tape back to the input owner |
| final | optional native P2PKH fee change back to the native input owner |

The v2 source outpoint is therefore `(depositTxid, 1)`. The verifier accepts one
to six address-controlled FT inputs followed by exactly one native fee input.
All FT inputs must share one owner and token identity. It checks every parent,
the six Tape allocation slots, required ancestors, conservation, output order,
network fee and every unlocking script locally.

The current completed Learning Bridge payment
`3bae1fe926e1ac620ad5c0697c6352af7f0b7d26a459122cbb1a8376e1032b1d:0`
is deliberately rejected: it sends FT directly to a custody address and has no
v2 Covenant output.

## 4. Bounded proof envelope

Schema: `learningmaterials/tbc-legacy-ft-deposit-proof/v1`

The envelope carries the raw deposit transaction, raw genesis transaction and,
for every input, its parent plus only the ancestors selected by the six uint64
FT Tape slots. Bounds are fail-closed:

- Testnet route only;
- 2–7 inputs and 3–6 outputs;
- at most 48 unique transactions;
- at most 1,000,000 bytes per raw transaction;
- at most 8,000,000 submitted raw-transaction bytes in total;
- route policy must separately match Contract ID, legacy version, chain ID,
  gateway address and reserve threshold/MPC controller.

API metadata, decoded token JSON and a browser order are not accepted as proof.
The verifier parses raw TBC transactions, pins the published legacy script
artifact and reproduces all relationships itself.

## 5. Offline vectors and tests

The tests freeze:

- the real MT genesis
  `ac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c`;
- its real mint source
  `0756eb73f180ce6abfeaf5f343ffcc63909f6fb4028f7a1e209a045890affdb2`;
- the exact SDK artifact `ft-v3-npm-1.6.1-1.6.5`, 1,884-byte Code and
  73-byte Tape;
- contract-controller byte `0x01` for that v3 Code;
- fixed domain, Covenant-controller and logical-deposit hash vectors;
- a fully signed local FT-to-Covenant transition generated with the current SDK;
- rejection after recipient, amount, controller, destination, route, layout or
  proof mutation.

The fully signed synthetic harness uses the current SDK-generated legacy v4
fixture so its private key is known and every input script can be executed. The
pinned real route is independently frozen as v3 and the production policy must
require v3. No real MT output was signed or moved.

Run all Phase 2 checks offline:

```bash
cd backend
npm run phase2:test
npm run typecheck
```

## 6. What Phase 2 does not prove

This proof establishes creation of the correctly bound FT reserve output. TBC
headers do not commit to a UTXO-set root, so a short Merkle inclusion proof alone
cannot cryptographically prove that the output remains unspent at an arbitrary
later tip. An API `unspent` response is useful observation data but is not an
on-chain trustless proof.

The v2 design handles this limitation by making the reserve spendable only with
the threshold/MPC controller and by publicly tracking registered reserve and
release outpoints. Consequently, reserve release and continuing solvency retain
the Phase 0 threshold trust assumption. They must not be described as fully
trustless.

Phase 3 still needs to implement and audit the HyperEVM verifier for headers,
difficulty, chainwork, TXID, Merkle inclusion, this exact Covenant/FT proof and
replay protection. Until then, the current minter-controlled contract remains a
separate custodial learning system.

## 7. Evidence used

- [UTXO Compiler deployment model](https://docs.utxocompiler.com/how-to-deploy-and-call-a-contract)
  describes a deployed contract instance as a transaction output whose locking
  script must be satisfied when spent.
- [Official TBC API introduction](https://docs.turingbitchain.io/en/Introduction)
  distinguishes address UTXOs from contract/script history and defines bounded
  API response behavior.
- [Official TBC20 API](https://docs.turingbitchain.io/en/TBC20) documents the
  42-hex combine script (`20-byte controller + type byte`) and FT UTXO routes.
- `tbc-contract` 1.7.3 `tbc-htlc.js` is the pinned executable reference for
  `HASH160(SHA256(contractScript))` ownership of a legacy FT Code output.
