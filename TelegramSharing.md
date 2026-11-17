
# 项目名 - TuringBitChain

## 项目简介 
TBC（TuringBitChain）是一条基于比特币 UTXO 模型的 Layer 1 公链，采用与比特币同源的 SHA256 PoW 共识。它首创 BVM（比特币虚拟机），在 UTXO 模型上实现图灵完备智能合约，并通过 OP_PUSH_META、OP_PARTIAL_HASH 与分层 TXID 支持「可遗传契约」。TBC 面向资产代币化、AI Agent 与机器人经济，目标以可编程货币承载高频微支付与条件结算；区块可向 GB 级扩展，用户越多、单位手续费越低。TBC 为网络原生资产，用于网络内价值转移与手续费支付，而非链上 AMM 资金池代币

项目详细介绍（尽量多，白皮书、项目详细资料等）

TBC 图灵比特链：让 UTXO 承载更丰富的智能合约与链上应用

TuringBitChain，简称 TBC，中文名称为“图灵比特链”，是一条基于 UTXO 模型、采用 SHA-256 工作量证明机制的独立区块链网络。TBC 主网于 2024 年 2 月 14 日上线，致力于在比特币技术体系的基础上，拓展智能合约、数字资产和去中心化应用的实现空间。

TBC 以 BVM、TuringContract、分层 TXID 和 UTXO 并行处理为主要技术方向，将交易、资产和合约状态组织在可验证的 UTXO 结构中，面向资产发行、链上交易、NFT、支付和数据服务等场景提供开发基础。

TBC 的发展目标，是让 UTXO 不仅能够承载价值转移，也能够支持更丰富的应用逻辑，为开发者构建可编程、可验证、面向扩展的链上应用提供工具。

## 一、延续 UTXO 技术路线，拓展链上可编程能力

UTXO，即“未花费交易输出”，是比特币技术体系中的核心数据模型。在这一模型下，交易通过消耗已有输出、创建新的输出来完成资产转移。

TBC 在这一基础上扩展合约能力，使交易输出不仅能够承载资产，也能够承载合约状态与执行约束。应用通过交易推动状态变化，由网络验证新的输出是否符合规则。

这种设计为资产流转提供了清晰的输入、输出和状态继承关系，也为独立交易的并行验证创造了条件。开发者可以围绕 UTXO 构建支付、资产管理、交易服务和链上数据应用。

## 二、BVM：面向 UTXO 的智能合约执行体系

BVM，即 Bitcoin Virtual Machine，是 TBC 的原生智能合约执行体系。

不同于以账户和全局状态为中心的合约架构，BVM 围绕 UTXO、交易上下文与脚本验证组织应用逻辑，使开发者能够在 UTXO 模型上表达更加复杂的业务规则。

在这一体系中，资产转移与合约状态变更通过交易相互关联，节点根据脚本和共识规则验证执行条件。BVM 为 TBC 的资产发行、合约交互和应用开发提供了底层支持。

BVM 是 TBC 自身的技术体系，并不意味着合约直接在比特币主网上执行，也不等同于 EVM。

## 三、TuringContract：让合约状态沿交易持续传递

TuringContract 是 TBC 的智能合约方案，其核心思路是将 UTXO 作为可编程的状态载体，让合约规则在连续交易中得到验证与延续。

一次合约交互可以消耗旧状态，并创建满足约束的新状态，使资产和业务逻辑随着交易持续演进。

围绕这一机制，TBC 引入了交易元数据读取、分段哈希验证等能力：

- **交易元数据读取**：让合约检查输入、输出等交易条件，为资产流转设置约束。
- **分段哈希验证**：在脚本执行限制下，对较长的数据进行分段处理与验证。
- **状态继承验证**：结合交易结构和哈希信息，验证合约状态之间的关联。

这些能力为 FT、NFT、流动性池、多签和其他可编程资产应用提供了技术基础。

## 四、分层 TXID 与并行处理：面向扩展的架构设计

随着合约不断交互，交易之间的状态继承和验证数据也会变得更加复杂。TBC 的分层 TXID 设计通过分层哈希与紧凑指纹组织交易信息，旨在降低合约验证过程中反复携带完整历史数据的负担。

与此同时，TBC 的 ParaUTXO 架构方向强调利用不同 UTXO 之间的独立性，为交易并行处理提供空间。

这两项设计分别关注验证信息的组织效率与交易处理的并行能力，共同服务于 TBC 的扩容方向。需要注意的是，并行处理适用于具备独立性的交易；竞争同一个 UTXO 或合约状态的交易，仍然需要处理执行顺序与冲突。

## 五、兼顾交互体验与链上确认

TBC 关注支付和应用交互中的响应速度，并围绕零确认交易提供低延迟交互思路。

交易广播后，应用可以根据节点接收、验证和传播情况，向用户提供较快反馈，减少等待区块打包才能看到交互结果的情况。

零确认反馈与区块确认属于不同阶段。对于大额资金转移、交易所入账和重要结算，仍应结合确认深度、交易依赖和业务风控进行处理。应用可以根据不同场景，在响应速度与结算安全要求之间制定适合自身的策略。

## 六、原生资产与多类型链上资产

TBC 是网络的原生资产，具有 6 位小数精度，参与链上价值转移、交易手续费支付和网络激励。

在原生资产之外，TBC 还提供面向 FT 和 NFT 的开发与查询能力。不同资产通过各自的合约标识进行区分，可以具有独立的名称、精度和业务用途。

围绕这些基础能力，开发者可以探索：

- 同质化代币发行、转账与资产管理。
- NFT、数字内容与链上权益应用。
- 流动性池、资产兑换与交易服务。
- 多签钱包和协作式资产控制。
- 地址分析、交易解析与资金流向追踪。

原生 TBC 与链上项目发行的代币是不同资产，具体代币的规则和风险应根据对应合约与项目资料分别判断。

## 七、开发工具与数据服务

TBC 已公开节点代码，并提供 JavaScript 工具库、合约 SDK、钱包连接工具和 REST API 文档，覆盖从底层交易构造到应用集成的多个环节。

其中：

- **TBCNODE 提供节点软件及共识、交易验证相关代码。
- tbc-lib-js 提供地址、密钥、脚本、交易构造与签名等基础工具。
- tbc-contract 提供 FT、NFT、Pool、多签等合约相关开发能力。
- 钱包连接工具 支持 DApp 与 Turing Wallet 进行交互。
- 官方 API 提供区块、交易、地址、UTXO、Mempool 和代币等数据接口。

这些工具为钱包、交易平台、资产管理系统、区块浏览器和链上分析服务的开发提供了入口。开发者可以先在测试网验证业务流程，再根据实际需求开展主网集成；具体使用条件以各仓库许可证和文档为准。

## 八、生态方向与发展愿景

TBC 官方资料介绍的生态方向覆盖内容、交易与跨链互操作：

- **ZeroeDEX**：探索订单簿式去中心化交易与链上结算。
- **TuringBridge**：面向不同链与应用生态之间的互操作。
- **BitBus**：探索 BTC 与 TBC 之间基于 HTLC 思路的原子交换。

上述方向展示了 TBC 对 UTXO 应用空间的探索。各项目的具体功能、上线状态和安全条件，应以对应产品及最新公告为准。

从价值转移到可编程资产，从单笔交易到持续运行的合约状态，TBC 正围绕 UTXO 架构建立自己的应用开发体系。其长期方向，是通过合约能力、验证机制和开发工具的持续完善，为更多链上应用提供实现空间。

> 说明：TBC 是独立运行的区块链网络，不等同于比特币主网，也不自动继承比特币主网的全部安全保障。本文用于项目与技术介绍，不构成收益承诺或投资建议；性能、功能及生态进展以实际网络、公开代码和最新资料为准。

---
官方资料与相关链接

# 项目资料

- [TBC 官方网站](https://www.turingbitchain.io/)
- [TBC 官方白皮书（PDF）](https://www.turingbitchain.io/WhitePaper.pdf)
- [TBC 官方 GitHub](https://github.com/TuringBitChain)
- [TBC 中文技术学堂](https://www.turingbitchain.io/zh/tbc-academy/)
- [TBC 官方技术问答](https://www.turingbitchain.io/zh/tbc-academy/tbc-technical-qa-bank/)

# 技术与开发

- [TBCNODE 节点代码](https://github.com/TuringBitChain/TBCNODE)
- [tbc-lib-js JavaScript 基础工具库](https://github.com/TuringBitChain/tbc-lib-js)
- [tbc-contract 合约 SDK](https://github.com/TuringBitChain/tbc-contract)
- [Turing Wallet 钱包连接工具](https://github.com/TuringBitChain/turing-wallet-provider)
- [官方 API 与开发文档](https://docs.turingbitchain.io/)
- [钱包开发文档](https://docs.turingwallet.xyz/)
- [技术学习资料](https://github.com/TuringBitChain/LearningMaterials)

# 核心技术说明

- [BVM 技术介绍](https://www.turingbitchain.io/tbc-academy/bvm-explained/)
- [TuringContract 合约设计](https://www.turingbitchain.io/tbc-academy/turingcontract-design/)
- [分层 TXID 技术说明](https://www.turingbitchain.io/tbc-academy/hierarchical-txid/)
- [ParaUTXO 并行架构](https://www.turingbitchain.io/tbc-academy/parautxo-architecture/)
- [零确认交易安全模型](https://www.turingbitchain.io/tbc-academy/zero-confirmation-security/)

# 网络工具与安全资料

- [TBCScan 区块浏览器](https://tbcscan.xyz/)
- [Turing Wallet 钱包官网](https://turingwallet.xyz/)
- [CertiK 项目与审计资料](https://skynet.certik.com/projects/turingbitchain)

# 官网链接
https://www.turingbitchain.io/
# 推特链接
https://x.com/TBCnetwork_