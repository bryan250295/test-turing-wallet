# TBC 核心技术说明与本项目的差异报告

日期：2026-11-17（Asia/Kuala_Lumpur）  
审查范围：`TelegramSharing.md`「核心技术说明」列出的五个主题，以及当前工作区中的 Wallet、HTLC、托管学习桥和 Testnet-v3 证明桥实现。

## 1. 结论

**项目已经使用 TBC 的 UTXO、FT、HTLC 和分层 TXID 能力；主要差距集中在桥的储备控制、反向协议和应用并行调度。**

最需要注意的六点：

1. 名为 Bridge Covenant 的源链脚本，实际是带数据承诺的签名控制脚本，尚未实现“只有满足指定跨链释放条件，资产才可继续花费”的完整可遗传约束。
2. V3 能证明入金交易并据此 mint，但“该储备之后一直受约束、不会被另行花费”仍是另一项未闭合的问题。
3. V3 没有完成 burn → TBC release 的反向协议；旧学习桥的往返成功不能算作 V3 反向完成。
4. TBC 的独立 UTXO 允许并行，不代表当前后台已经并行；目前 V3 自动推进每轮只处理一个任务。
5. 六次确认是合理的跨链结算选择，并不因官网介绍零确认就构成实现错误。
6. 部分阶段文档仍描述旧状态，与当前 V3 代码、README 不一致，容易误判项目进度与信任边界。

**这些网页介绍的是底层能力和设计方向，并非要求每个 DApp 实现全部能力的验收清单。** 下文分别标明真正未完成的目标、设计取舍与范围限制。

### 审查依据与限制

- 这是网页资料和当前源码的静态对照，包含工作区尚未提交的修改。
- 未运行测试、未发起签名或交易、未核验当前部署字节码和实时链上资金状态。
- 官方五个原链接都已访问；直接抓取有的只返回站点简介，中文页面存在重定向，Markdown 入口受到访问限制。因此本文结合可读取的官方搜索索引正文、官方学堂目录、官方术语表和操作码教程核对。**不能声称已完整读取五篇原文。**
- 官网文章中的性能数字和“零确认安全”宣传不是本次独立验证的结果，也不能直接作为本应用的性能或安全承诺。
- `TelegramSharing.md` 是原始参考材料，本次没有修改。

## 2. 必须分开的三个实现

| 实现 | 实际职责 | 当前信任边界 |
| --- | --- | --- |
| TBC 同链 HTLC | 创建锁、凭 secret claim、到期 refund | 钱包签名、TBC 脚本执行；后台构造交易与提供查询 |
| 旧托管 Learning Bridge／普通 wrapped FT 路径 | 保管源链 FT，授权 minter 铸币；旧 lwFT 可通过永久 escrow 锁定后申请返回 MT | 保管密钥、管理员／minter、验证后台 |
| Testnet-v3 Proof Bridge | 在 HyperEVM 验证 TBC 区块头、交易及受支持 FT transition 后 mint | 固定 checkpoint、受限验证器、源链储备控制，以及链的确认／重组假设 |

证据：

- [`LearningWrappedFT.sol`](../wallet/contracts/LearningWrappedFT.sol)，第 9–11、72–94 行明确说明托管与 minter 校验，未在合约中验证 TBC proof。
- [`TbcProofMintGatewayTestnetV3.sol`](../wallet/contracts/phase3/generated/TbcProofMintGatewayTestnetV3.sol)，`mintFromProof()` 第 141 行起组合 finalized deposit、transition、signature、FT unlock prefix 校验及 replay protection。
- [`WrappedFTV2.sol`](../wallet/contracts/phase3/WrappedFTV2.sol)，`mintFromProof()` 仅允许 immutable gateway 调用，没有备用 owner mint。

因此，不能把所有版本统一称为“后台可以任意 mint”，也不能把 V3 证明铸币等同于整个桥已经无需信任。

## 3. 五个核心主题对照

| 主题 | 官方资料的核心方向 | 项目对应情况 | 判断 |
| --- | --- | --- | --- |
| BVM | 用 UTXO 脚本表达可编程规则 | FT／HTLC 使用 SDK；目标链用 Solidity 验证 TBC 证据 | 已使用底层能力；不是自行实现通用 BVM |
| TuringContract | 交易自省、分段哈希与后续输出约束 | HTLC 有合约约束；桥的自有数据承诺脚本仍主要由控制方签名花费 | 桥储备约束存在实质差距 |
| 分层 TXID | 以分层哈希组织交易与继承信息 | V3 重算 version-10 TXID，但还要传递交易、父交易及祖先证据 | 算法已有实现，整份跨链 proof 并非常数大小 |
| ParaUTXO | 独立 UTXO 为并行处理创造条件 | 请求可独立保存，但后台推进和共享 EVM nonce 存在串行点 | 应用层尚未充分利用 |
| 零确认 | 广播／内存池阶段提供低延迟反馈 | 钱包显示 broadcast 状态；跨链 mint 等待 source 确认 | 合理分层；体验仍可加快 |

官方参考：[学堂技术概览](https://www.turingbitchain.io/tbc-academy/)、[TuringContract 术语与 Covenant 说明](https://www.turingbitchain.io/zh/tbc-academy/tbc-glossary/)、[分层 TXID](https://www.turingbitchain.io/tbc-academy/hierarchical-txid/)、[ParaUTXO](https://www.turingbitchain.io/zh/tbc-academy/parautxo-architecture/)、[零确认安全模型](https://www.turingbitchain.io/tbc-academy/zero-confirmation-security/)。

## 4. 具体发现

### F1. Bridge Covenant 的命名强于当前脚本所强制执行的规则

**分类：设计差异；在宣称源链资产受完整 Covenant 约束前必须补齐。**

官方 Covenant 的重点，是脚本能检查并约束后续交易／输出，使规则随状态延续。参考：[官方操作码教程](https://www.turingbitchain.io/zh/tbc-academy/use-bvm-opcodes/)。

项目的 [`buildBridgeCovenantScript()`](../backend/src/bridge/phase2/bridge-covenant.ts) 第 111–121 行生成的是：

```text
<payload> OP_DROP OP_DUP OP_HASH160 <controllerPubKeyHash> OP_EQUALVERIFY OP_CHECKSIG
```

这里 payload 承诺了跨链目的和金额等信息，EVM verifier 可以校验该承诺；但这个脚本自身没有验证 HyperEVM burn、指定 MT 释放对象或下一代输出模板。`OP_DROP` 也不负责检查未来交易必须遵守 payload 的业务规则。

需要区分：这只是桥的自有 intent/control 脚本，不表示 SDK 的 FT 资产脚本和 HTLC 都没有 Covenant 能力。

**影响：** 控制方签名仍决定对应控制输出的花费授权；跨链条件没有全部转化为 TBC 链上强制规则。实际 FT 储备释放还须分别分析 FT code/Tape、其控制密钥及配套花费约束。

**建议：** 当前名称和说明明确为“数据承诺 + 控制方签名”；生产设计再明确由哪段脚本或阈值签名协议强制绑定 release recipient、amount、request ID、epoch 与后续输出。仅有一个公钥哈希不代表已经运行 MPC。

### F2. 入金证明与持续储备安全尚未闭环

**分类：未完成的安全目标；生产前优先级最高。**

V3 Gateway 已验证交易包含、FT transition、输入签名和解锁前缀，且消费 deposit ID 防止同一证据重复 mint。这是实质实现，不是单纯相信后台报数。

但“历史上创建过正确储备输出”与“mint 时／mint 后，该储备始终存在且只能按赎回规则花费”是两件事。分层 TXID 本身也不是当前 UTXO 集的未花费证明。[官方分层 TXID 说明](https://www.turingbitchain.io/tbc-academy/hierarchical-txid/)介绍的是继承信息的组织，不能据此推导出持续储备证明。

项目自己在 [`Phase 2 文档`](tbc-hyperevm-bridge-v2-phase-2.md) 第 145–155 行及 [`README`](../README.md) 第 50–51 行承认该边界。Gateway 的 `mintFromProof()` 没有另行接收一个经共识认证的“当前未花费证明”。

**建议：** 明确储备控制者和可花费规则；设计释放登记、负债／储备对账和异常停止业务策略。如果仍靠 threshold/MPC 管理释放，就将持续偿付和反向安全写成对应信任假设。API `unspent=true` 可用于监控，不能冒充链上独立验证的证明。

### F3. 新版证明桥的反向流程尚未实现

**分类：项目路线图未完成；并非这五篇文章直接规定的功能。**

[`WrappedFTV2.sol`](../wallet/contracts/phase3/WrappedFTV2.sol) 第 7–8 行明确将赎回设计留给 Phase 4；当前没有公开 burn／redeem 路径。

旧版 [`LearningRedemptionEscrow.sol`](../wallet/contracts/LearningRedemptionEscrow.sol) 第 17–19 行明确是永久锁定，不是 burn；其往返 MT 交易属于旧托管路径。

[`Phase 0`](tbc-hyperevm-bridge-v2-phase-0.md) 第 35–44、235–238 行计划的 threshold/MPC reverse release，仍需 signer set、threshold、epoch、轮换和异常处理协议。

**影响：** 目前不能说 V3 已完成双向去信任桥，也不能因为旧 lwFT 可以退回 MT，就假定 pwMT 具备相同出口。

**建议：** 在开放新版反向入口前完成独立协议和验收；不应先补一个 burn 按钮再等待释放服务。

### F4. 应用调度仍串行，尚未体现 ParaUTXO 的并行优势

**分类：能力尚未利用；性能上限不能从底层宣传推算。**

官方 ParaUTXO 强调互不竞争的 UTXO 可以并行处理；这不保证应用后台和目标 EVM 自动并行。[官方 ParaUTXO 说明](https://www.turingbitchain.io/zh/tbc-academy/parautxo-architecture/)。

[`ProofBridgeV3AutomationService.tick()`](../backend/src/bridge/proof-bridge-v3-automation.service.ts) 第 79–92 行使用进程级 `running`，查询 pending 后只推进 `rows[0]`。其 EVM 提交还共用一个 relayer 的 pending nonce。

[`ProofBridgeV3Repository.pending()`](../backend/src/bridge/proof-bridge-v3.repository.ts) 第 121–125 行虽然读取最多八项，当前 worker 不会同时推进这八项。

**影响：** 不同用户的独立源链输入，仍可能在应用层排队；源链并行能力不等于跨链端到端吞吐量。未做压测，不能由此量化排队时间或断言必然饥饿。

**建议：** 将 API 观察、proof 构建与 EVM 提交拆成有界任务；独立任务可并行，竞争同一 UTXO 的任务互斥；共享 EVM nonce 由专门队列管理。多实例运行前还需跨进程任务租约，不能只依赖内存 `running`。

### F5. 零确认理念与当前确认策略是取舍，不是错误

**分类：合理策略差异；不要为追求体验直接降低跨链安全门槛。**

官方资料将零确认放在内存池验证和低延迟处理语境中；官方白皮书也建议重要资产转移等待区块确认。[零确认安全模型](https://www.turingbitchain.io/tbc-academy/zero-confirmation-security/)、[官方白皮书](https://www.turingbitchain.io/WhitePaper.pdf)。

项目 [`TbcHeaderRelayTestnetV3.sol`](../wallet/contracts/phase3/generated/TbcHeaderRelayTestnetV3.sol) 第 22 行固定 `MIN_CONFIRMATIONS = 6`。钱包转账也把 broadcast 与完成区分。这与 `TelegramSharing.md` 第五节本身的表述相容。

**真正需要改进的是：** 广播接收、可见于 mempool、等待区块、源链达到策略深度、目标链 mint 完成，这些状态应分别显示；后台轮询间隔带来的延迟也应与链本身的确认耗时区分。

**建议：** 保持跨链最终结算门槛；为广播阶段提供更快反馈。六次确认应有业务风险依据，且 PoW 重组不会因为 UI 写了 Finalized 就不可能发生。源链深重组也无法自动撤销另一条链上已经铸出的资产。

### F6. 分层 TXID 已实现，但不是通用、恒定成本的跨链验证器

**分类：已经实现核心算法；存在明确支持范围。**

[`TbcBoundedTransaction._version10Txid()`](../wallet/contracts/phase3/TbcBoundedTransaction.sol) 第 213–228 行组合交易头、输入 outpoints／sequence、输入脚本哈希及输出哈希后计算 TXID；不能报告为“完全未使用分层 TXID”。

同一文件第 12–17 行限制单笔 raw transaction 为 131,072 bytes、最多七个输入和六个目标输出。Gateway 仍接收 `parentTransactions`、`ancestorTransactions`、签名 witnesses 等数据。

**影响：** 分层指纹紧凑，不代表跨链 inclusion、DAA、FT ancestry、签名验证的全部 proof 都只有 32 bytes，也不代表当前验证器支持任意 FT、任意 Script 或无限大的交易。

**建议：** 发布支持矩阵，并在创建入金前检查输入数量、交易形状和证明预算，避免用户付款后才发现不受支持。扩展能力必须按模板／资产版本审查，不能把这个 Solidity 子集标成完整 BVM。

### F7. 文档混合了阶段历史与当前状态

**分类：应立即修正的说明问题。**

[`docs/tbc-hyperevm-bridge-v2-phase-3.md`](tbc-hyperevm-bridge-v2-phase-3.md) 的部分“Remaining work／Current security statement”仍写尚未公开部署或并非 operational proof bridge；当前 [`README`](../README.md) 和 `generated/*TestnetV3.sol` 已描述新的 checkpoint、permissionless relay 与自动 proof mint 路径。

这说明至少存在文档版本边界不清；仅凭源码和部署描述文件，仍不能独立确认所有线上运行状态。

**建议：** 各文档顶部标明适用版本和更新时间；将阶段性结论明确标成当时状态，并链接到当前版本状态页。分别写清“源码已有”“部署记录已有”“真实链上验收通过”，防止把不同证据等级混用。

## 5. 哪些不应被列为未履行

- **没有自建 BVM／修改 TBCNODE：** 这是应用项目，无需重造节点；Phase 0 也明确选择 API-only、参考节点共识源码的路线。
- **HyperEVM 部分使用账户模型／Solidity：** 目标链环境决定了实现形式，不违背源链使用 UTXO。
- **使用 PostgreSQL 保存历史：** 索引和订单持久化本身不违背链上可验证原则；关键是最终资金授权是否只依赖数据库字段。
- **SDK 内部实现操作码：** 业务文件没有直接出现 `OP_PUSH_META`，不等于生成的 FT／HTLC Script 没有相关规则。
- **没有 GPU、百万 TPS 或所有生态模块：** 这些是节点／生态能力或目标，不是本钱包和实验桥必须完成的功能。
- **没有把 Testnet 当成 Mainnet：** 当前证明路径明确限制 Testnet，是范围控制，不是技术理念冲突。

## 6. 建议处理顺序

| 优先级 | 工作 | 完成的判断依据 |
| --- | --- | --- |
| 立即 | 统一旧托管桥、V3 和历史阶段文档的名称与信任说明 | 每个入口都能明确资产、验证方式、储备控制者和是否可赎回 |
| 生产前必须 | 明确源链储备花费约束与持续偿付模型 | 可逐项说明谁能花费、凭什么证据、如何限制收款人／金额、防重复和轮换 |
| 开放 V3 反向前 | 完成 Phase 4 release 协议 | burn／锁定证据、阈值策略、重组和恢复流程形成完整闭环 |
| 扩大使用前 | 并行 worker、nonce 队列和跨进程租约 | 独立请求可并发，冲突请求不重复消费或重复提交 |
| 体验改进 | 广播反馈与最终结算分层；预检 proof 支持范围 | 用户能看懂当前等待原因，且不把 broadcast 误认为完成 |

## 7. 原始参考入口

以下五项对应 `TelegramSharing.md` 的原始链接，保留供人工浏览核对：

1. [BVM 技术介绍](https://www.turingbitchain.io/tbc-academy/bvm-explained/)
2. [TuringContract 合约设计](https://www.turingbitchain.io/tbc-academy/turingcontract-design/)
3. [分层 TXID 技术说明](https://www.turingbitchain.io/tbc-academy/hierarchical-txid/)
4. [ParaUTXO 并行架构](https://www.turingbitchain.io/tbc-academy/parautxo-architecture/)
5. [零确认交易安全模型](https://www.turingbitchain.io/tbc-academy/zero-confirmation-security/)

补充官方交叉参考：[技术学堂目录](https://www.turingbitchain.io/tbc-academy/)、[中文术语表](https://www.turingbitchain.io/zh/tbc-academy/tbc-glossary/)、[BVM 操作码教程](https://www.turingbitchain.io/zh/tbc-academy/use-bvm-opcodes/)、[白皮书](https://www.turingbitchain.io/WhitePaper.pdf)。
