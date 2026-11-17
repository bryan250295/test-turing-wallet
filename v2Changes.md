
<!-- 
原本没有的：
Get Block/Merkle Proof: 
To prove that the transaction generating the UTXO was safely included in a block, use the gettxoutproof RPC command passing the transaction ID (txid). This returns a hex-encoded Merkle proof confirming the transaction is anchored to a block header. 

escrow = smart contract?
6次 canonical confirmations = 6 Confirmation 在 UI
-->

## Original TBC Testnet ↔ HyperEVM Testnet bridge
- Not running entirely on TBC, this 1st version bridge rules is runned by NestJS/PostgreSQL service plus Solidity contracts on HyperEVM.
- The EVM contract cannot verify TBC by itself. It trusts the designated minter and your off-chain deposit verifier.
- “Lock” is custodial in the bridge. It means transferring the FT to an address controlled by the bridge. Unlike your HTLC exercise, the user has no hashlock-based refund path.
- Replay protection does not prove reserves. processedOrders and processedDeposits prevent repeated minting of the same recorded payment, but a dishonest minter could still mint against false information.
- BVM is not EVM. Your project deliberately connects the two: UTXO FT assets on TBC and an ERC-20 representation on HyperEVM.
- Native TBC is not Mega Token or lwFT. Native TBC pays source-chain fees; MT is the bridged FT; HYPE pays HyperEVM gas.
- Hierarchical TXID and ParaUTXO are underlying TBC/node concepts. Your application benefits from UTXO independence and validates transaction ancestry, but it does not implement these consensus-level features itself.
- Zero confirmation is unsuitable for bridge settlement. Your six-confirmation policy is appropriately more conservative than accepting mempool visibility.
```
// custodial Lock-and-Mint design
User’s TBC FT
     ↓
Unique TBC custody address
     ↓ verified after 6 confirmations
Trusted minter
     ↓
Wrapped ERC-20 on HyperEVM

// test
1,000,000 MT
  → 1,000,000 lwFT
  → permanent lwFT escrow
  → 1,000,000 MT returned
```
Backend 担任 owner 和 minter 角色

## intentional differences - not misalignment
```
TBC UTXO transactions
        ↓
NestJS verification and custody
        ↓
HyperEVM Solidity contract
```
That is acceptable because TelegramSharing.md presents TuringBridge as a general cross-chain direction; it does not require every bridge to be implemented solely inside BVM.

## Features I haven't implement
Your project does not directly implement:
- BVM itself
- OP_PUSH_META or OP_PARTIAL_HASH
- Hierarchical TXID consensus rules
- ParaUTXO node processing
- Mining or SHA-256 consensus
- ZeroeDEX, NFT or liquidity-pool functionality
- A trustless cross-chain proof verifier
That does not put the project out of line. Those are platform-level capabilities, while your project is an application built using TBC’s UTXO, FT, wallet and API infrastructure.
Main point to preserve
Continue describing it as:
An experimental custodial TBC Testnet ↔ HyperEVM Testnet learning bridge, inspired by TuringBridge and built using TBC UTXO, FT, wallet and API technologies.

Do not describe it as:
- The official TuringBridge protocol
- A trustless bridge
- A bridge secured entirely by TuringContract
- A full implementation of BVM or ParaUTXO
- A two-chain HTLC atomic swap
So the conclusion is: yes, the project is still in line with TelegramSharing.md. It applies a focused subset of the document—UTXO assets, contracts, SDKs, wallet integration, HTLC concepts and cross-chain interoperability—while clearly documenting its additional custody and EVM trust assumptions.

## Trustless
For a trustless TBC → HyperEVM direction, HyperEVM would need:
1. An on-chain TBC header light client.
2. SHA256d proof-of-work validation.
3. Exact nBits/difficulty validation.
4. Cumulative-chainwork comparison and reorg handling.
5. Turing TXID calculation.
6. Merkle inclusion verification.
7. On-chain or cryptographically proven FT covenant/ancestry validation.

## Now V2
```
TBCScan / Official API / 独立来源
              ↓
交叉确认 checkpoint
              ↓
API 获取连续 headers
              ↓
项目自己的代码验证 PoW、difficulty、previous-hash linkage、cumulative chainwork
              ↓
选择 greatest-work canonical chain
```
完整流程可以这样理解：
1. Phase 1：收集 proof data
   从 TBC API/TBCScan取得 transaction、header、Merkle branch 等资料，并在链下检查格式及关联性。
2. Phase 2：链下验证规则
   验证 TXID、Merkle proof、FT、Covenant 等规则，确认所采用的算法和数据正确。
3. Phase 3A：把验证逻辑移植到 Solidity
   让 HyperEVM 合约自行验证 Header、PoW、DAA 和 Merkle proof，而不是相信 backend 告诉它“验证通过”。
4. Phase 3B：建立可信启动资料
   把 checkpoint 之前 DAA 需要的历史数据建立成固定 Merkle commitment。Relayer 必须提交对应 Merkle proof，不能随意伪造历史 difficulty data。
5. Phase 3C：维护 TBC header chain
   Relayer 向 HyperEVM 提交 TBC headers；合约验证并记录：
   - Parent linkage
   - PoW 与 difficulty
   - Cumulative chainwork
   - Canonical branch
   - Competing branches
   - 6 confirmations
Gas 的理解则是：
每笔 HyperEVM 操作费用 = 该交易 gasUsed × 当时 gasPrice

会产生链上 gas 的主要操作是：
- 部署 verifier/relay 合约
- Relayer 每次提交 TBC header
- 提交 bootstrap Merkle witnesses
- 未来提交 transaction/FT/Covenant proof
- Replay protection storage
- 最终 mint wrapped token
Phase 1–2 是后端／离线工作，通常没有 blockchain gas fee，但会有服务器、API和计算成本。
所以更准确的总结是：
Phase 1–2 确认资料和验证算法；Phase 3A–3C 把部分验证与 canonical-chain tracking 搬到 HyperEVM。只有实际提交到 HyperEVM 的部署和交易才产生 gasUsed，再乘以当时的 gasPrice 得出 gas fee。

目前 Phase 3C 已确认可以执行，但还没有完成每个操作的正式 gas profiling，也没有真正广播或支付 gas。