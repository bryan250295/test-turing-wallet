# Oracle / TuringUSD 项目资料审查与待确认事项

> 文档状态：初次资料审查（Draft for review）  
> 审查日期：2026-11-27（Asia/Kuala_Lumpur）  
> 范围：`oracle` 文件夹内两份指南、Turing Wallet 浏览器插件压缩包，以及公开 live 版本  
> 目标：把已确认事实、合理推断、冲突、缺口和需要项目方回答的问题分开记录，作为需求确认、架构评审、开发和验收依据。

## 1. 执行摘要

目前资料描述的是一个由三部分组成的系统：

1. **TBC Oracle**：收集多个市场的行情，产出带签名、带有效期、可回查的参考价。
2. **TuringUSD 借贷协议**：用户抵押 TBC，借出 TUSD；支持还款、抵押物管理、清算拍卖。
3. **Turing Wallet 3.2.2 浏览器插件**：向网页注入 TBC 与 EVM 钱包 provider，并新增 domain-message 签名能力，供 DApp 签署协议操作。

资料已经足以确认产品方向和若干核心经济参数，但**还不足以直接开始生产级集成**。当前最重要的缺口是：

- 指南引用的 `USAGE.md` / Quote API 使用手册不在资料包中。
- 没有提供 API schema、合约 ABI/交易构造规范、网络与合约地址、错误码和签名测试向量。
- 指南与 live 页面在“签名/交易次数”和“手续费”文案上存在冲突。
- Oracle 指南明确说明当前仍属于独立演练环境，不可用于真实抵押、借款或清算。
- 钱包插件会向所有网页注入 provider，并拥有较广的 host permissions；正式使用前必须确认来源、发布签名、origin 授权及升级策略。

因此建议先完成本文的 **P0 问题**，锁定接口和安全边界，再进入实现。

## 2. 审查来源与完整性

| 来源 | 本次确认内容 | SHA-256 / 访问日期 |
| --- | --- | --- |
| [TuringUSD-Guide.html](./TuringUSD-Guide.html) | 抵押、借款、还款、利息、清算和拍卖规则 | `44f3412b62a2fe337af82c0cf42872903eee4e7fd3d62a94f7b0ff9ccf8ce971` |
| [Turingoracle-Guide.html](./Turingoracle-Guide.html) | Oracle 报价来源、聚合、签名、时效和审计规则 | `a3a374676b6cd52d24601fe8160815c60738f0e5b9e276a0b6ec7e3d4cf0acbd` |
| [turing-wallet-sign-domain-message-8c48546.zip](./turing-wallet-sign-domain-message-8c48546.zip) | Turing Wallet 3.2.2 的 manifest、注入接口、签名请求和 EVM provider | `bd0426c7ad716b1f779cd9ce4a806c455f52fab75f7cd8ca5d600c952b1de158` |
| [TuringUSD live 版本](https://dai.tbcdev.org/) | 当前公开 UI、运行参数展示、钱包连接方式与实时更新机制 | 2026-11-27 |

### 2.1 资料完整性结论

已收到：

- 中英文 TuringUSD 产品指南。
- 中英文 TBC Oracle 产品指南。
- 未打包成商店格式的浏览器扩展静态文件，manifest 显示版本 `3.2.2`。
- 可公开访问的 live 参考页面。

仍缺少：

- Oracle 指南引用的 `USAGE.md` / Quote API User Guide。
- OpenAPI、JSON Schema、WebSocket/SSE event schema 或正式接口文档。
- Oracle 验签公钥、算法、canonical serialization 规范和测试向量。
- 借贷协议合约 ID、部署网络、版本、ABI/调用规范及审计报告。
- DApp 与钱包的 domain tag 注册表、消息格式版本和签名测试向量。
- 测试账户、测试币领取方式、只读与交易环境的 URL/CA 证书。
- 生产发布、回滚、密钥轮换和事故响应说明。

## 3. 已确认的产品规则

以下内容来自本地指南；它们是资料中的产品声明，不代表相关生产系统已经完成或通过安全审计。

### 3.1 TBC Oracle

- 支持四类参考报价：`BTC/USD`、`TBC/USDT`、`USDT/USD` 和派生的 `TBC/USD`。
- `TBC/USD = TBC/USDT × USDT/USD`。
- BTC/USD 示例来源为 Coinbase、Kraken、Bitstamp；合格后取各市场中间价的中位数。
- TBC/USDT 可采用固定权重：Hyperliquid 50%、LBank 40%、MEXC 10%。Hyperliquid 的 USDC 报价先使用 Kraken 的 USDC/USDT 换算。
- 必要来源有一个失效时，`TBC/USDT` 及依赖它的 `TBC/USD` 应暂停。
- 报告包含 `observedAt`、`issuedAt`、`expiresAt` 三类时间；新鲜度应以市场观察时间为主。
- 当前版本由单节点签发；客户端必须从独立可信渠道取得验签公钥。
- 即使报告未过期，使用前仍需检查 live availability。
- 市场源恢复后，需要连续通过约五分钟质量检查，再获取新快照。
- 历史估值应能通过 pair + round 取回原始签名报告、证据摘要和派生报价所引用的基础轮次。
- 当前版本仅适合独立演练环境；真实市场准入、七天校准及随后十四天报价观察仍待完成。

### 3.2 TuringUSD 借贷协议

- TuringUSD/TUSD 是 TBC 链上、目标价格为 1 美元的稳定币；市场价格可能偏离目标价，但债务仍以 TUSD 数量计量。
- 新版原生 TBC 参数示例：开仓抵押率 200%，清算线 120%。
- 抵押价值 2,000 美元时，最多借 1,000 TUSD，但仍受单仓位和系统总上限约束。
- 首版网页以原生 TBC 为抵押；协议层可支持经准入的 TBC20 Standard 资产，单个仓位只使用一种抵押品。
- 利息累计到 TUSD 债务中；协议参数可调整。
- 普通钱包转账不能偿还仓位，必须使用指定还款流程。
- 指南声称网页支持部分或全额还款；债务清零后提取剩余 TBC，目前可能仍需开发工具。
- 抵押率低于而非等于 120% 时，任何人可发起整仓清算。
- 拍卖起始价为协议报价的 1.1 倍，并随时间线性下降；达到本轮起始价的 30% 后可用新报价重启。
- 拍卖收入先还债，再支付 13% 清算罚金；不足部分记为 bad debt，未收取的罚金取消。
- 新参数只对新部署的合约实例生效，既有公开测试实例继续按旧合约规则运行。

## 4. Live 版本实测观察

观察地址：[https://dai.tbcdev.org/](https://dai.tbcdev.org/)，观察日期为 2026-11-27。动态数值只代表当时页面，不应硬编码为需求。

### 4.1 页面结构

- 顶部：TuringUSD 标识、语言切换、Connect wallet。
- Borrow 主视图：TBC price、Price confirmed 状态、Lock TBC、可选 Borrow TUSD 输入和借款上限。
- Market 面板：Borrow rate、Opening / liquidation ratio、Minimum debt、TBC locked、TUSD in circulation、Vaults。
- How it works：抵押借款、钱包签署、跌破清算线自动拍卖。
- 底部主导航：Balances、Borrow、Auctions。

实测时页面展示的动态数据包括：

- TBC price：`3.1237 USD`。
- Borrow rate (APY)：`5.00%`。
- Opening / liquidation ratio：`200% / 120%`。
- Minimum debt：`1 TUSD`。

这些数值与指南中的 200% / 120% 规则相符，但仍需由后端/合约配置返回，不应在前端固定。

### 4.2 Live 前端可见的集成方式

对公开前端 bundle 的静态检查显示：

- 页面通过 `POST /api/v1/session` 获取 session token，并以 `turingusd:session` 为 key 保存到 `localStorage`。
- 页面连接同源 `EventSource('/api/v1/events')`，监听 `view` event；收到事件后约 250 ms 合并刷新。
- 当 EventSource 不可用时，页面约每 8 秒刷新；另有约每 60 秒的兜底刷新。
- 页面等待 `window.Turing` 最长约 3 秒，并调用 Turing Wallet 的连接、网络、账户、公钥和 domain-message 签名接口。
- 页面监听钱包的 signed-out / network-changed 事件，也兼容页面级账户或网络变化事件。
- 钱包返回 pending 类错误时，签名调用存在短暂、有限次数的重试。

### 4.3 需要解决的 live 文案冲突

1. Live 页面写着 “Sign once in your wallet and it's done”，但本地指南描述先签 preparation transaction，再签 borrowing transaction。
2. Live 页面底部写着 “No fees”，但指南明确说明 preparation 和 borrow 交易分别需要 TBC 网络费，且已上链的 preparation fee 不退。
3. 指南说清偿后提取抵押物可能需要开发工具；live 导航和操作流是否已经提供完整 withdrawal/exit UI，需要连接测试钱包后确认。

这些冲突必须在上线前统一，否则用户无法准确判断签名次数、交易风险与成本。

## 5. 浏览器钱包插件静态审查

本节只对压缩包做静态检查，没有执行、安装或修改插件。

### 5.1 Manifest 与权限

- 名称：Turing Wallet。
- 版本：`3.2.2`。
- Manifest：V3。
- 后台：module service worker `background.js`。
- UI：popup + side panel。
- 权限：`storage`、`unlimitedStorage`、`tabs`、`sidePanel`。
- Content script 在 `<all_urls>` 的 `document_start` 注入；另一段 MAIN-world provider 在所有 HTTP/HTTPS 页面注入。
- `inject.js` 对 `<all_urls>` 开放为 web-accessible resource。
- Host permissions 包含 TBC API、Turing Wallet API，以及 Ethereum、Sepolia、BNB、Arbitrum、Hyperliquid、LBank、Binance、Blockstream 等多个域名。
- Extension CSP 允许自身脚本和 `wasm-unsafe-eval`，用于加载随包提供的 TBC SDK WASM。

### 5.2 注入给 DApp 的 TBC API

插件注入 `window.Turing`，可见接口包括：

- 连接与状态：`connect`、`disconnect`、`isConnected`、`getAddress`、`getPubKey`、`getBalance`、`getNetwork`、`getInfo`。
- TBC 操作：`sendTransaction`、`sendBatchRequest`、`signTransaction`、`signAssociatedTransaction`。
- 消息与数据：`signMessage`、`signDomainMessage`、`encrypt`、`decrypt`。
- BTC：`btc.sendTransaction`、`btc.signTransaction`、`btc.sendBatchRequest`。
- EVM：`evm.provider`、`evm.request`、`evm.sendTransaction`。

UTXO merge 接口只对特定 hostname 开放，不是普通 DApp 的通用能力。

### 5.3 Domain-message 签名

DApp 调用形态为：

```ts
const result = await window.Turing.signDomainMessage({
  domain: domainTag,
  messageHex,
});
```

插件的成功结果数据包含：

```ts
{
  address: string;
  digest: string;
  pubkey: string;
  sig: string;
}
```

静态代码显示：

- content script 会把 DApp 传入的 `domain` 映射为 `domainTag`。
- 插件另行记录网页 hostname/origin，不完全依赖 DApp 自报来源。
- 签名页面会展示 requesting origin、domain tag、digest 和 message byte length。
- 此类签名隐藏自动执行选项，要求用户主动批准。
- 钱包会验证 domain/messageHex 参数，并用当前 TBC 账户私钥签名。
- 返回前会确认签名所用公钥与当前账户公钥一致。

仍需正式文档说明 digest 的生成算法、domain 编码、message canonicalization 和验签方法。

### 5.4 EVM provider

- 插件实现 EIP-1193 风格 provider，并通过 EIP-6963 宣告 `Turing Wallet`。
- provider 同时标记 `isTuringWallet: true` 和 `isMetaMask: true`。
- 只有 `window.ethereum` 尚不存在时才把自己设为默认 provider。
- 支持 `connect`、`disconnect`、`accountsChanged`、`chainChanged` 事件。
- 单个 EVM 请求超时时间约 305 秒，同时最多允许 100 个 pending requests。

`isMetaMask: true` 可能使只检测 MetaMask 标记的 DApp 误认 provider。集成时应优先使用 EIP-6963 或 `isTuringWallet` 明确选择。

## 6. 建议的系统边界

```text
用户
  │
  ├─ TuringUSD Web DApp
  │    ├─ 同源 Backend API / Session
  │    ├─ SSE（状态变化通知）+ 有限轮询兜底
  │    └─ Turing Wallet provider
  │           ├─ TBC 交易/签名
  │           └─ EVM provider（若未来需要）
  │
  ├─ TuringUSD 协议合约
  │    ├─ Vault / debt / interest
  │    ├─ Repay / withdraw / exit
  │    └─ Liquidation / auction
  │
  └─ TBC Oracle
       ├─ Market adapters
       ├─ Quality gate / aggregation
       ├─ Signed reports / history
       └─ On-chain publication / status
```

安全责任应明确分开：

- DApp 只编排流程、显示预览和请求钱包签名，不接触用户私钥。
- Wallet 独立校验、预览并签署精确消息或交易。
- Backend 不应代替用户签署资产操作；它负责 session、读模型、索引和事件推送。
- Oracle signer 只签报价报告，不签用户借贷交易。
- 合约必须独立校验报价签名、有效期、round、资产、网络和重放保护，不能只信前端或 backend。

## 7. P0：开发前必须回答的问题

### 7.1 交付范围

- **P0-01**：本 task 要做的是复制 live TuringUSD 前端、把它整合进现有 LearningMaterials wallet，还是同时开发 Oracle/backend/合约？
- **P0-02**：第一阶段的可验收交付物是什么：只读行情、完整 testnet 借贷、还是可生产部署？
- **P0-03**：目标用户与平台是什么：桌面浏览器插件、移动钱包内置浏览器，还是两者都支持？
- **P0-04**：是否必须保持 live 版本的视觉设计，还是只参考流程与信息架构？
- **P0-05**：中文、英文是否都是首发必需；默认语言和语言持久化规则是什么？

建议默认：先做隔离 testnet 的端到端 MVP，包含 read-only Oracle、连接钱包、开仓、借款、还款和状态回查；生产能力另设安全门槛。

### 7.2 网络、合约与版本

- **P0-06**：目标 TBC network、chain/network identifier、API base URL 和 explorer URL 是什么？
- **P0-07**：新版借贷合约是否已部署？请提供 contract ID/address、版本、部署交易和验证方式。
- **P0-08**：旧实例与新实例如何区分？前端是否允许切换，还是只支持一个固定 deployment？
- **P0-09**：资产精度、价格精度、TUSD 精度及所有 rounding mode 是什么？
- **P0-10**：合约参数是否完全由链上读取？如果 backend 返回配置，如何验证它与链上值一致？
- **P0-11**：是否已有合约安全审计、经济模型审计和部署 reproducibility 记录？

建议默认：所有影响资金的参数从已验证的 deployment manifest 和链上状态读取，前端不硬编码。

### 7.3 Oracle 接口与信任根

- **P0-12**：请补充 `USAGE.md`、API schema、示例响应和错误码。
- **P0-13**：签名算法、hash、编码、canonical field order 和公钥格式是什么？
- **P0-14**：请提供至少一组合法、一组篡改、一组过期和一组错误网络的验签测试向量。
- **P0-15**：验签公钥通过什么独立可信渠道分发？公钥轮换和撤销如何通知客户端？
- **P0-16**：单节点 signer 是临时设计还是正式信任模型？是否规划多签、阈值签名或多节点共识？
- **P0-17**：每个 pair 的 `roundId` 是否全局单调？重启、回滚或灾备切换时如何避免 round 重用？
- **P0-18**：`observedAt`、`issuedAt`、`expiresAt` 的允许时钟偏差与最大间隔是多少？
- **P0-19**：live availability endpoint 的返回 schema 和状态机是什么？`healthy`、`degraded`、`suspended`、`recovering` 如何定义？
- **P0-20**：五分钟恢复窗口由 Oracle 服务端判断，还是要求每个客户端自行计时？
- **P0-21**：必要市场源、权重、偏差上限、spread、深度、成交新鲜度的具体阈值是什么？谁可以修改？
- **P0-22**：USDT/USD 或 USDC/USDT 脱锚时是否有独立 circuit breaker？
- **P0-23**：合约使用 recorded price、latest report 还是两者中的保守值？live bundle 中存在取两者较小值的逻辑，需要协议确认。

建议默认：服务端负责 source-health 与恢复窗口；客户端和合约仍各自执行签名、时效、pair、round 和 deployment 绑定检查，并 fail closed。

### 7.4 钱包签名与交易

- **P0-24**：TuringUSD 各操作的 domain tag 分别是什么？是否带协议名、版本、network、deployment ID 和 action？
- **P0-25**：`messageHex` 的字段 schema、序列化顺序、整数编码和文本编码是什么？
- **P0-26**：消息中如何绑定用户、vault、金额、quote round、expiry、nonce 和 chain/network，防止跨域、跨链、跨合约重放？
- **P0-27**：后端如何证明收到的 `address`、`pubkey`、`digest`、`sig` 属于同一请求？
- **P0-28**：连接授权是否按 origin 保存？用户如何查看和撤销已授权站点？
- **P0-29**：live 的“一次签名”与指南的“两笔交易”哪一个是当前真实流程？
- **P0-30**：preparation transaction 的目的、输出、有效期、幂等键与失败恢复方式是什么？
- **P0-31**：交易广播由钱包、DApp 还是 backend 完成？广播成功但前端超时时如何恢复？
- **P0-32**：用户拒绝、钱包锁定、错误网络、账户切换和插件升级中的请求如何处理？
- **P0-33**：最低兼容钱包版本是否为 3.2.2？旧版本应显示升级提示还是降级到其他签名方式？

建议默认：签名消息必须采用明确版本的 typed/canonical schema，所有动作使用独立 domain/action，包含一次性 nonce 与短 expiry，并由合约或 backend 保证消费幂等。

### 7.5 借贷与资金规则

- **P0-34**：页面的 “No fees” 是指无协议费，还是连网络费也没有？必须改成不含歧义的费用说明。
- **P0-35**：APY 是固定还是可变？按区块、按秒还是按其他周期计息？前端如何显示 accrued debt？
- **P0-36**：开仓能否只抵押、不借款？live 页面允许 Borrow TUSD optional，需要合约确认。
- **P0-37**：最低债务 1 TUSD 是否适用于所有仓位、所有版本和部分还款后的剩余债务？
- **P0-38**：单仓上限、系统 debt ceiling、最小抵押量和拍卖容量的来源是什么？
- **P0-39**：全额还款后，withdraw/exit 是否已在网页支持？若未支持，MVP 是否允许上线？
- **P0-40**：清算在 `< 120%` 触发；临界值计算的 rounding 和同区块价格变化如何处理？
- **P0-41**：拍卖价格下降曲线、持续时间、重启资格和 30% cusp 的准确公式是什么？
- **P0-42**：13% penalty 是基于债务、回收额还是抵押价值？bad debt 由谁承担和治理？
- **P0-43**：Oracle 暂停或价格未确认时，允许哪些动作？live 文案表示借款/提款暂停、还款不受影响，需要合约确认。

建议默认：价格不可用时禁止增加风险的动作，允许还款和增加抵押；提款、借款和新清算 fail closed。

### 7.6 Backend、session 与实时更新

- **P0-44**：`POST /api/v1/session` 是匿名 session、wallet challenge session，还是只用于 CSRF/速率限制？
- **P0-45**：session token 的 TTL、续期、撤销、绑定 origin/IP/device 的规则是什么？
- **P0-46**：token 存在 localStorage 是否为正式决定？如果发生 XSS，如何限制 token 的权限和损失范围？
- **P0-47**：`/api/v1/events` 的 event schema、鉴权、断线续传和 `Last-Event-ID` 支持是什么？
- **P0-48**：事件只表示“请刷新”，还是携带已版本化的状态？如何避免旧请求覆盖新状态？
- **P0-49**：SSE、8 秒 fallback polling 和 60 秒兜底刷新是否为正式 SLA？移动端/后台 tab 如何降频？
- **P0-50**：Backend/indexer 与链上状态出现延迟或分叉时，UI 显示 pending、confirmed、finalized 的规则是什么？

建议默认：SSE 只推送带 revision/event ID 的无敏感通知，前端收到后重新读取权威状态；断线采用指数退避、抖动和有限重试，恢复后按 revision 对账。

## 8. P1：实现设计阶段应确认的问题

### 8.1 UX 与状态

- **P1-01**：价格状态是否至少分为 Confirmed、Confirming、Unavailable、Expired？每种状态允许哪些按钮？
- **P1-02**：连接钱包后默认进入 Balances、Borrow 还是最近使用页？
- **P1-03**：交易预览必须显示哪些字段：金额、抵押率变化、清算价、利息、两笔网络费、quote round、expiry、contract？
- **P1-04**：签名或交易 pending 时能否关闭页面？恢复入口和 transaction history 在哪里？
- **P1-05**：账户/网络在确认页切换时，应取消请求还是重新报价？
- **P1-06**：用户输入导致抵押率接近 200% 或 120% 时，风险颜色和警告阈值是什么？
- **P1-07**：Oracle unavailable 时是否保留最后价格？若保留，必须明确标示“不可用于交易”。
- **P1-08**：移动端没有浏览器插件时，是显示安装说明、WalletConnect 类流程，还是不支持？
- **P1-09**：错误信息是否提供 request ID、可复制技术详情和安全的重试按钮？
- **P1-10**：无障碍要求是什么：键盘操作、focus、色彩对比、screen reader 和 reduced motion？

### 8.2 账户与数据一致性

- **P1-11**：账户 identity 以 address、pubkey 还是二者组合为准？
- **P1-12**：同一账户在不同 network/deployment 的 vault 如何隔离？
- **P1-13**：前端缓存哪些数据，账户/网络切换时清除哪些 cache？
- **P1-14**：用户拥有多笔 TUSD UTXO 时，何时需要 merge，费用和失败恢复如何显示？
- **P1-15**：同一操作重复点击、重复签名或重复广播的幂等策略是什么？
- **P1-16**：多标签页同时操作时如何同步 session、wallet 状态和 pending transaction？
- **P1-17**：历史记录保存多久，是否可按 vault、txid、round、action 搜索？

### 8.3 运维与治理

- **P1-18**：Oracle source、权重和阈值变更是否需要治理延迟和公开审计记录？
- **P1-19**：紧急暂停由谁执行，暂停范围能否区分 borrow、withdraw、liquidation 和 auction？
- **P1-20**：哪些指标触发告警：source stale、价差、signer down、SSE disconnect、indexer lag、bad debt？
- **P1-21**：日志中如何关联 session、wallet request、quote round、vault 和 transaction，同时避免记录签名敏感内容？
- **P1-22**：前端、backend、contract、oracle 和 wallet 版本如何显示并写入诊断信息？
- **P1-23**：发布失败如何回滚，旧前端与新 wallet/API 的兼容窗口多久？

## 9. 建议的 API / 数据契约清单

这里列的是所需能力，不代表 live 服务已经采用这些 endpoint 名称。

### 9.1 Oracle quote

至少需要以下字段：

```ts
type SignedQuote = {
  schemaVersion: string;
  pair: "BTC/USD" | "TBC/USDT" | "USDT/USD" | "TBC/USD";
  roundId: string;
  price: string;          // decimal string or integer + explicit decimals
  decimals: number;
  observedAt: string;
  issuedAt: string;
  expiresAt: string;
  status: "healthy" | "degraded" | "suspended" | "recovering";
  sourceRounds?: Array<{ pair: string; roundId: string }>;
  signerKeyId: string;
  signatureAlgorithm: string;
  signature: string;
};
```

还需：

- snapshot：一次返回 TBC/USD、TBC/USDT 和 USDT/USD 的一致快照。
- history：按 pair + roundId 回查原报告。
- evidence：返回各市场的时间、mid、spread、depth、recent trades 和排除原因。
- availability：当前可用性、恢复窗口开始时间和失败来源。
- publication：链上 TXID、confirmations、block height 和 finality。

### 9.2 Protocol view

至少需要：

- Deployment：network、contract、version、oracle key/config hash。
- Market：价格、价格状态、APY、ratio、minimum debt、debt ceiling、totals。
- Account：TBC/TUSD 余额、可用 UTXO、vaults。
- Vault：owner、collateral、principal、interest、current debt、ratio、liquidation price、status。
- Auction：vault、collateral remaining、debt target、price curve、current price、cusp、status。
- Transaction intent：action、inputs、outputs、fee、quote round、expiry、nonce、signing messages。

所有金额字段应使用 decimal string 或带 decimals 的整数，禁止使用 JavaScript floating point 作为资金权威值。

### 9.3 Event

建议统一 event envelope：

```ts
type ProtocolEvent = {
  eventId: string;
  revision: string;
  type: "market.changed" | "account.changed" | "vault.changed" | "auction.changed";
  deploymentId: string;
  account?: string;
  resourceId?: string;
  occurredAt: string;
};
```

事件只触发重新读取权威状态，不直接把 event payload 当成最终资金状态。

## 10. 安全审查清单

### 10.1 Oracle

- [ ] 验证签名、公钥 key ID、pair、network、deployment、round、decimals 和全部时间字段。
- [ ] 防止 round replay、跨 pair replay、跨环境 replay 和旧公钥 replay。
- [ ] 所有派生价格记录基础报价 round，并使用一致 snapshot。
- [ ] 价格过期、source 不健康、签名失败、clock skew 超限时 fail closed。
- [ ] 对 USDT/USDC 脱锚、薄流动性、异常 spread 和市场停牌有 circuit breaker。
- [ ] 公钥轮换有 overlap、撤销和审计记录。
- [ ] 客户端不能只依赖 TLS 或 backend 的 `healthy` 布尔值。

### 10.2 Wallet / DApp

- [ ] 使用 EIP-6963 / `isTuringWallet` 选 provider，避免 `isMetaMask` 误识别。
- [ ] origin allowlist 与用户授权可见、可撤销。
- [ ] 每个签名展示 action、金额、对象、network、contract、nonce、expiry 和风险。
- [ ] domain tag 与 message schema 版本化，提供独立验签测试。
- [ ] 拒绝超长 message、奇数 hex、非 hex、未知 schema 和过期请求。
- [ ] 私钥、解锁密码或助记词绝不进入网页、backend、日志或 analytics。
- [ ] 插件安装包来源、checksum、发布签名和自动更新渠道可验证。
- [ ] 评估 `<all_urls>` 注入、广泛 host permissions 和 `unlimitedStorage` 的最小权限替代方案。
- [ ] CSP、XSS、dependency/SBOM、WASM 完整性和 supply-chain 风险经过审查。

### 10.3 Protocol

- [ ] 合约独立验证 Oracle，不信任前端计算的 ratio 或价格。
- [ ] 精度和 rounding 对 borrow limit、interest、liquidation threshold、auction price 有一致测试。
- [ ] 交易幂等、nonce 消费与 UTXO race 有明确错误和恢复流程。
- [ ] 借款、还款、withdraw/exit、清算和 auction 均有 invariant/property tests。
- [ ] Oracle 暂停时允许降低风险的动作，禁止增加风险的动作。
- [ ] bad debt、emergency pause、upgrade 和治理权限经过审计并公开。

## 11. 验收测试建议

### 11.1 Wallet 连接

- 未安装插件、插件锁定、用户拒绝、错误 network、错误账户、连接超时。
- Turing Wallet 与 MetaMask 同时安装时能明确选择正确 provider。
- 账户/网络切换后旧 quote 和旧 intent 立即失效。
- 钱包 3.2.2 正确展示 origin、domain、digest 和 message 长度。

### 11.2 Oracle

- 正常 snapshot 可验签并复算 TBC/USD。
- 修改 price、round、decimals、expiry 或 source round 后验签失败。
- 任一必要 source 失败时，相关派生报价立即不可用于风险动作。
- 恢复不足五分钟仍不可用，满足恢复窗口后只接受新 snapshot。
- SSE 断开、重连、重复 event、乱序 event、漏 event 后状态最终一致。

### 11.3 Borrow / repay

- 抵押但不借、最低债务、最大可借、单仓上限和系统上限。
- APY 计息后 debt、ratio、liquidation price 一致。
- 部分还款后不得留下 dust；全额还款准确包含 accrued interest。
- 广播成功但前端超时后可通过 txid/account 恢复，不重复付款。
- 清偿后能够 withdraw 或明确引导到已支持的安全流程。

### 11.4 Liquidation / auction

- 120% 恰好不可清算，低于阈值可清算；覆盖边界 rounding。
- 起始价、线性下降、30% cusp 和重启使用新 quote。
- 达到 debt + penalty 后停止出售并退回剩余抵押品。
- 抵押品不足时产生准确 bad debt，不多收 penalty。

### 11.5 UI

- 桌面、窄屏、移动钱包浏览器、200% zoom。
- 中文/英文数值、时间、金额格式一致，不改变协议精度。
- Confirming/Unavailable/Pending/Rejected/Failed/Recovered 状态不只靠颜色表达。
- 页面刷新、关闭重开、多 tab 操作均可恢复进行中的交易。

## 12. 建议实施阶段

### Phase 0：补齐规格

- 回答所有 P0 问题。
- 收齐 USAGE、schema、contract deployment、signing vectors 和 test credentials。
- 解决 live 文案冲突，冻结产品词汇与状态机。

### Phase 1：只读集成

- Oracle snapshot、签名验证、availability 和 history。
- Market 页面、价格状态、protocol configuration。
- SSE + 有限 polling fallback、revision 对账和诊断 UI。

### Phase 2：钱包与预览

- Turing Wallet 3.2.2 discovery、connect、network/account guard。
- domain-message 验签联调。
- 借款/还款/auction intent 的完整可读预览，但先不广播。

### Phase 3：隔离 testnet 写操作

- 开仓、借款、还款、withdraw/exit、liquidation 和 auction。
- 断线、超时、拒绝、重放、重复广播和页面恢复测试。
- 对账与 transaction history。

### Phase 4：安全门槛

- 合约、Oracle、钱包插件和前端安全评审。
- 市场准入、七天校准、十四天观察。
- 监控、告警、应急暂停、密钥轮换和回滚演练。

## 13. Go / No-Go 清单

在以下项目完成前，不应把本系统描述为可用于真实资金：

- [ ] 正式 API 文档和签名测试向量齐全。
- [ ] Oracle 公钥分发、轮换和撤销流程通过评审。
- [ ] 新合约 deployment 与参数可独立验证。
- [ ] 指南、live UI 与真实交易次数/费用完全一致。
- [ ] 用户可在网页安全完成 repay 和 collateral withdrawal/exit。
- [ ] 钱包插件来源、checksum、权限和更新渠道通过审查。
- [ ] Oracle、协议合约和关键前端流程完成安全测试。
- [ ] 市场校准/观察完成，异常源与脱锚演练通过。
- [ ] SSE 断线、indexer lag、链重组和恢复机制通过测试。
- [ ] 紧急暂停、回滚、bad debt 和事故响应责任人明确。

## 14. 项目方最小回复模板

为了快速把本文转成正式需求，可由项目负责人先填写：

```text
交付范围：
目标环境 / network：
前端是否沿用 live UI：
支持桌面 / 移动：
Backend base URL：
Oracle base URL：
Oracle USAGE.md 位置：
Oracle public key / key ID：
Quote schema / 测试向量：
Protocol contract ID / version：
Deployment transaction：
Wallet 最低版本：
Domain tag 与 message schema：
真实签名/交易次数：
费用规则：
Withdraw/exit 是否已支持：
SSE event schema：
Test account / faucet：
安全审计状态：
负责人及验收日期：
```

## 15. 当前结论

这批资料适合作为产品与安全需求的起点。最可复用的 live 设计是：**由后端提供版本化读模型，以 SSE 通知状态变化，以有限轮询做容错；所有资金动作仍由浏览器钱包明确展示并由用户签署；Oracle 报告在客户端和合约端独立验证。**

当前不应把 HTML 指南、公开 live 页面或插件静态文件单独视为完整规范。完成 P0 质询并取得缺失的 API、合约和签名资料后，才能形成可编码、可测试、可审计的正式实施规格。
