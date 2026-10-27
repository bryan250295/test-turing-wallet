# Bridge and Swap
- 只要可以证明从哪个source chain到哪个destination chain和rules就能成立bridging ( 跨链需要实际支持 source chain、destination chain 和目标资产的协议，以及可验证的交易和执行规则。)
- source chain 就是从哪里来
- destination chain 就是要换到哪里去
- rules 包含 （lock and mint，burn and mint， liquidity）
- what you get will not always be token, it can be anything that they provided

> 以下兑换比例和跨链路线都是学习假设，不表示 TBC 当前存在可用的 USDC 或 Ethereum 桥。兑换需要交易对手／流动性；桥接需要实际支持该资产的协议。

## Bridging 的 flow example (lock and mint)：
```
10 TBC  
  ↓ 交易成 100 USDC
100 USDC (TBC Network)
  ↓ lock 100 USDC 在 TBC network 和 bridge 到 Ethereum network
100 wrapped USDC 在 Ethereum Network
  ↓ 交易成 ETH
Estimate 100 USDC = 1 ETH
```
### or using native coin to bridge
```
10 原生(Native) TBC
  ↓ 在 TBC 网络锁住 10 TBC
  ↓ 桥验证锁定交易
Ethereum 上收到 10 wrapped TBC Token
  ↓ 如果有交易市场，再兑换成 ETH
按当时价格获得相应数量的 ETH
```

## Bridging 的 flow example (burn and mint)：
```
10 TBC
  ↓ 交易成 100 USDC
100 USDC (TBC Network)
  ↓ burn 100 USDC 在 TBC network 和 verify销毁 transaction
  ↓ Attestation （Proof / Signed Cert）
  ↓ authorize Ethereum network mint 100 USDC
  ↓ destination chain 上的 Smart Contract execute mint
100 USDC 在 Ethereum Network
  ↓ 交易成 ETH
Estimate 100 USDC = 1 ETH
```

## Bridging 的 flow example (liquidity)：
```
10 TBC
  ↓ 交易成 100 USDC
100 USDC (TBC Network)
  ↓ Deposit（存入桥的资金池）
  ↓ Verify the Deposit（验证存款交易）
  ↓ Release / Payout（目标链资金池支付）
100 USDC on Ethereum Network
  ↓ 交易成 ETH
Estimate 100 USDC = 1 ETH
```

- Attestation（证明／签名凭证）- 负责验证的系统确认交易后，出具一份带数字签名的证明（Digital Sign）
- Smart Contract（智能合约）- kind of contract to avoid 一直被拿来重复领取 (按代码验证条件和执行状态变化；防止重复领取还需要正确的状态／消息唯一性设计。)
- Liquidity Pool（资金池）- 把全部资金集中存放的地方 (流动性提供者存入资产、按协议规则用于兑换或支付的资金储备。)
- HTLC（Hash Time-Locked Contract｜哈希时间锁合约）- is a smart contract

Vifi
DeFi
SocialFi
GameFi
编译器，UTXO compiler
Contract
Hyperliquid

# Sepolia wallet and obtain test ETH.

> 历史备选计划，尚未实现。2026-10-26 已选择 TBC Testnet ↔ HyperEVM Testnet 作为下一条主线，见下方第 6 节；Sepolia 保留作参考。Lock and Mint 与双链 HTLC Atomic Swap 是不同方案，当前单链 HTLC 已有成功交易。
## Suggested learning sequence
1. [ ] Prepare a Sepolia wallet and obtain test ETH.
2. [ ] Deploy dwTBC with restricted minting.
3. [ ] Practice authorized minting and transfers. This tests the token; it is not bridging yet.
4. [ ] Design the TBC escrow/locking mechanism.
5. [ ] Add a local relayer that verifies confirmed deposits, amounts, and the intended Sepolia recipient.
6. [ ] Prevent duplicate minting: each source deposit must be processed only once.
7. [ ] Implement the return path: burn dwTBC, verify the burn, then release the corresponding TBC.

---

# Bridge Lab 学习与实作 TODO

更新时间：2026-10-27。

## 如何阅读这份清单

- `[x] 已实现`：能从当前代码确认，不代表所有边界情况都已实测。
- `[x] 已验收`：你已经确认操作结果，或提供了相应截图。
- `[ ] 待验收`：功能已有代码，但没有足够证据确认该场景通过。
- `[ ] 未实现／可选`：后续功能或学习方向，不属于已完成的单链基本流程。
- 不需要重做已经确认的 Lock、Claim 和 Refund。可以为现有交易补充记录；本文不保存真实 secret、私钥或助记词。

## 当前结论

**TBC Testnet 单链 FT Token HTLC 的 Lock、B Claim、A Refund 基本流程已经走通。**

当前没有实现 wrapped token 的 Lock and Mint，也没有实现跨链 Atomic Swap。

**下一条学习主线已确定（2026-10-26）：自建 TBC Testnet ↔ HyperEVM Testnet 学习桥，参考 Turing Bridge 的产品流程。** 当前只确定网络与学习目标，桥接机制、资产及合约尚待设计，未部署或完成跨链。STUDY2.md 为老师提供的原始资料，始终只读；个人分析与项目计划记录在本文件。

| 操作 | 已有结果／依据 | 状态 |
| --- | --- | --- |
| A 创建 Lock | 后续 Claim／Refund 查询均能识别其原 lock 和合约条件 | 已走通 |
| B Claim | Mega Token（MT），1,000,000 MT；2026-10-26 截图显示 Claimed，至少 1 次确认；后续截图确认数继续增加 | 已验收链上确认 |
| A Refund（另一笔 lock） | 4 Decimal Token，100,000 MDT；截图显示 Refunded，至少 8 次确认 | 已验收链上确认 |
| A Refund（另一笔 lock） | Test Token，5,000,000 TT；截图显示 Refunded，至少 420 次确认；你已确认这两笔是 A 自己退款 | 已验收链上确认 |
| Secret 保存与取回 | A 正常取回已由你确认；2026-10-26 完成 A 拒绝签名不显示 secret、B 没有取回按钮的验证 | 正常流程及这两项 UI 权限场景已验收 |
| 最新后端自动列表查询 | 2026-10-26 用户确认及截图：列表显示 Locked／Claimed／Refunded；逐笔 Check 已移除，已完成记录操作按钮禁用 | 正常载入与显示已验收；缓存／分页／异常场景待验证 |

> Claim 和 Refund 的成功记录来自不同 lock。同一笔已花费的 lock 不能再次领取或退款。余额、手续费截图可补充归档，不要求为了补记录重新创建交易。

## 接下来按这个顺序做

> 当前安排（2026-10-26）：单链 HTLC 基本流程和主要 UI 优化已有成果，第 1–4 节保留剩余验收记录，暂缓额外 testing，不自动勾选。后续优先执行第 6 节的 TBC／HyperEVM 自建学习桥准备，不要求先完成双链 HTLC 或 BitBus Marketplace。

### 1. 后端自动查询：正常流程完成，额外场景待验证

- [x] 已验收正常载入与显示（2026-10-26，用户确认及截图）：My HTLC Requests 无需逐笔 Check，列表显示 Locked／Claimed／Refunded；已完成记录操作按钮禁用。缓存、分页和网络错误场景不由这张截图单独证明。
- [ ] 查看 Network：列表状态请求使用 `POST /__htlc/locks/status`，body 只传 `address`；超过 25 笔时另带后端返回的 cursor。正常列表载入不应为每一行额外调用 `/__htlc/token/inspect`。
- [ ] 快速切换 HTLC Testnet／My HTLC Requests、切换 A／B，确认没有持续请求、卡住的 loading 或重复查询导致的 429。
- [ ] 验证后端同钱包／同页的并发查询能复用：成功结果最多复用 15 秒、错误最多 5 秒。Refresh requests 在缓存期内可能显示相同的 checked time；过期后应得到新查询结果。
- [x] 单笔错误的前端显示模拟通过（2026-10-26，用户 Console 操作与截图）：给已成功查询的 lock 注入 `Simulated status check failure` 后，该行显示 Status unavailable、Previous result: Locked、原 checked time 与错误原因，Refund 禁用并提示先刷新；其他成功记录仍正常显示。
- [ ] 后端真实单笔查询失败的完整流程、无自动广播／重试，以及 Refresh requests 成功后的恢复尚待验证；前端状态注入不等同于这些场景已通过。
- [ ] 在有足够记录时验证分页：每页最多 25 笔，cursor 继续前进，不能重复或遗漏同一轮中未变化的记录。
- [ ] 验证取消／断线／超时后可以继续查询，不会长期占满处理名额。已有共享后台只读任务允许在离开页面后完成，前端不应把旧钱包结果显示到新钱包。

### 2. 验收权限和错误场景（已有代码，需要实际确认）

- [x] A 拒绝 secret 取回消息签名：不显示 secret，出现 `User dismissed the request!`，取回按钮恢复可操作。（2026-10-26，用户确认及截图）
- [x] 切换到 B 并 reconnect：同一批请求显示 Recipient B，不显示 A 的 Retrieve claim secret 按钮。（2026-10-26，用户确认及截图）
- [x] A 批准消息签名后正常取回原 secret：你已在之前完成并再次确认，无需重做。
- [ ] 直接 API 权限补充验证：未签名／无效签名／过期或重复使用的 challenge 不应返回 secret。B 没有按钮的 UI 验证不等于这些直接 API 场景均已通过。
- [x] 静态路径检查通过（2026-10-26，用户截图）：访问 `/storage/htlc/secrets/.encryption-key` 返回 HTTP 403，没有显示密钥内容。这是该路径的实测结果，不代表所有路径变体均已测试。
- [x] 公开列表响应检查（2026-10-26，用户截图）：`GET /__htlc/locks?address=...` 正常返回公开记录；截图可见字段包含 TXID、合约、地址、金额、token 资料和 recovery 记录，没有 secret、签名、raw transaction 或 encryption key。截图未覆盖完整响应，其他资源响应仍可后续抽查。
- [x] B 拒绝 Claim 交易签名（2026-10-26，用户操作截图）：显示 `User dismissed the request!`，保留 Claim 表单且 secret 输入已清空，没有出现 Submit claim；页面仍显示 Locked。本截图未展示 Network，不单独据此确认 finalize／broadcast 请求记录。
- [x] 错误网络的界面保护（2026-10-26，用户截图）：切到 `tbc / mainnet` 后显示 Wallet not connected to Devnet；My HTLC Requests 不显示 Testnet 记录，Refresh requests 禁用，并提示连接 TBC Testnet。HTLC Testnet 页面也显示错误网络提示。截图未覆盖全部表单按钮及实际 API 调用。
- [ ] 切回 Testnet 并 Reconnect，确认列表与操作恢复正常。
- [ ] 验证签名期间切换账户，应用能停止旧账户操作并显示明确错误。
- [x] 错误 secret 的前端 Claim 校验（2026-10-26，用户截图）：500,000 MT lock 显示 `The secret does not match the on-chain hashlock.`，页面仍显示 Locked。截图中可见状态／inspect／settle 请求，没有展示新的 finalize／broadcast；不将此项等同于服务端绕过请求或错误签名验证。
- [ ] 验证余额不足、已花费输出和重复点击的处理；先使用不会广播的校验路径，避免重复建立 lock。
- [ ] 验证已 Claimed／Refunded 的记录在 My HTLC Requests 和下拉列表都不能再次操作；未确认或查询失败时不能启用操作。
- [ ] 确认链上时间未满足条件时不能退款；原来遇到的 `non-final-pool-full` 可作为失败案例归档，不要求再次广播故意失败的交易。

### 3. 补齐记录与恢复验收

- [ ] 为已有成功交易补充完整 lock／claim／refund TXID、合约 ID、网络、实际手续费和确认截图；可附 B 收到 MT 的余额／输出记录。
- [ ] 重启 server、刷新浏览器、切换钱包，确认已保存记录无需重复上传；无关钱包不显示这些记录。
- [ ] 如仍有只下载过、未导入的旧 JSON，验证一次导入；如果有旧 browser history，再验证迁移。没有这些旧数据时可注明“不适用”。
- [ ] 备份 `wallet/storage/htlc/testnet/` 与整个 `wallet/storage/htlc/secrets/`，包括隐藏的 `.encryption-key`；在副本中确认可恢复，不删除正在使用的原文件。
- [ ] 说明 server 重启后签名 session 会失效，但公开记录和已保存的 secret 保留；签过名不等于已广播，查不到交易也不能直接认定被拒绝。

### 4. 完善使用体验（基本界面已由用户确认，补充验收暂缓）

- [x] 已实现 All／Active／Completed 筛选及数量，All 放在首位并默认选中；切换钱包或网络后恢复 All。仅查询成功且 recovery 有确认的 Claim／Refund 归为 Completed；未知、待确认、查询失败、仅 Spent / unavailable 都不归为 Completed。筛选只操作当前数据，不新增 API 调用。
- [x] My HTLC Requests 已按角色显示操作：A 显示 Refund，链上时间未到禁用并说明原因；B 显示 Claim；同一钱包兼任两角色时分别显示。已完成记录只保留 View details。
- [x] 已实现统一的 View details 弹窗：token／合约／精确金额、A／B 地址、退款条件、确认数、最近查询时间、公开 hashlock、关联交易及费用。费用来自后端既有 decode 结果；没有数据时显示 Unavailable，不额外查询节点。时间统一显示 MYT，支持 Close／Escape。
- [x] Secret 取回入口移至 View details，继续仅由 A 通过钱包消息签名授权取回；不在表格逐行显示。弹窗打开、筛选、关闭不发交易。
- [x] 用户已确认基本界面满足需求，截图展示筛选计数、A／B 角色操作与详情弹窗。
- [x] 详情弹窗标题及 Close 按钮保持可见，下方内容独立滚动；独立 Chrome 使用真实组件和模拟资料，在 390×700 视口实测 body 滚动后标题位置不变、Close 可见、内容无横向溢出（2026-10-26）。All 默认选中亦在桌面截图确认；不等同于真实钱包流程全部验收。
- [ ] 补充 UI 浏览器验收暂缓：筛选在错误状态下的归类、弹窗键盘操作及其他小屏场景尚未完整实测；本次已检查 390×700 下的详情滚动与日期选择器，单笔错误的列表显示模拟已通过，见第 1 节。
- [x] 已统一列表、View details 与 Claim／Refund 页的链上状态：Locked、Refundable、Lock pending、Claim pending／Refund pending、Claimed／Refunded、Spent / unavailable；查询失败在列表与详情显示 Status unavailable，并将保留的成功结果标为 Previous result。
- [x] 日期时间显示改为 12 小时制、精确到分钟，例如 `26 Oct 2026, 3:40 p.m.`：列表、详情、Lock review、Claim／Refund、Overview 与交易历史统一使用 MYT；退款日期选择器保留已标示的本地时区，时间选项统一为 `h:mm a.m.／p.m.`。仅调整显示，时间戳与到期判断不变。
- [x] 日期时间浏览器显示检查通过（2026-10-26，独立 Chrome headless）：真实列表、详情、Lock review 与日期选择器组件使用模拟钱包／状态资料，确认分钟格式、无秒数及 a.m.／p.m. 后缀；浏览器内确认午夜 `12:00 a.m.`、中午 `12:00 p.m.`、`3:05 p.m.` 前导分钟零和交易历史日期 formatter。检查 1440×1000 桌面及 390×700 小屏，截图保存在 `/tmp/htlc-display-check/`；未连接真实钱包、签名或广播，未将其记为 Claim／Refund 和交易历史整页的完整实测。
- [x] Refundable 仅在 lock 已确认、两项输出均未花费、没有 recovery 且后端 `refundEligible` 为真时显示，仍归 Active；不使用浏览器时钟，不增加 API 调用。退款须由 A 主动提交，输出未花费前 B 仍可能 Claim。没有链上查询结果的保存记录保留 submission／unverified 标签，不推断为链上 pending，也不新增 Draft。
- [x] 新状态的列表部分已有用户截图（2026-10-26）：Lock pending、Claimed、Refunded，以及前端模拟的 Status unavailable／Previous result: Locked；证据范围见第 1 节。
- [x] Refundable 的列表显示与角色按钮已有用户截图（2026-10-26）：退款期限为 3:00 p.m. 的 lock 显示 Refundable，A 的 Refund 启用；3:40 p.m. 的另一笔仍显示 Locked 且 Refund 禁用，提示等待链上时间。此截图不代表后一笔已退款。
- [ ] 新状态的补充浏览器验收暂缓：Claim pending／Refund pending、Refundable 详情、错误状态详情弹窗及错误后刷新恢复尚未完整确认，不将部分截图记为全部通过。

### 5. 后续路线（已选择主线，其余保留为可选）

| 路线 | 目前情况 | 接下来要确认 |
| --- | --- | --- |
| 自建 TBC ↔ HyperEVM 学习桥 | 已选为下一条主线；尚未实现 | 两侧测试钱包与 gas、资产及桥接机制；详见第 6 节 |
| 继续完善 TBC 单链 HTLC | 基本流程已走通 | 先完成上面的近期改动与错误场景验收 |
| TBC 同链 Lock and Mint | 未实现；这是后来讨论的可选方向 | 先确认 FT 的受控增发／销毁、托管释放及防重复处理能力，再决定实现方案 |
| TBC → Sepolia Lock and Mint | 未实现；原有计划保留在文档上方 | 第二条测试链、wrapped token、锁定证明验证、mint 权限与赎回机制 |
| 双链 HTLC Atomic Swap | 未实现；详见阶段 7 | 第二条测试链、兼容脚本、共同 hash 和两侧退款期限 |
| BitBus 风格 Marketplace | 未实现；详见阶段 8 | 订单、报价、身份验证，以及订单和链上状态协调 |

### 6. 新主线：TBC Testnet ↔ HyperEVM Testnet 自建学习桥

目标：自己实现一个可以理解和解释的跨链项目，参考 Turing Bridge 的网络选择、订单、付款、进度和双链交易记录流程。老师的 STUDY2.md 作为只读参考，不能改动。现有单链 HTLC 保留为独立学习成果。

- [x] 已确定两侧网络：TBC Testnet 与 HyperEVM Testnet，使用测试资产学习。
- [x] 已明确是自建学习桥，不是调用官方桥完成全部流程，也不宣称复制官方底层协议。官方教程展示 TBC 主网 → HyperEVM 的订单流程；仅凭该教程，尚不能确认其采用 Lock and Mint 或其他结算机制。
- [x] 目标链钱包已准备（2026-10-27，用户截图）：创建 MetaMask 账户 `HyperEVM Learning`，已有公开 `0x...` 地址。
- [x] 目标链测试网络已添加并切换（2026-10-27，用户截图）：按 chain ID `998`、RPC `https://rpc.hyperliquid-testnet.xyz/evm`、gas 币 HYPE 配置；钱包筛选显示 `Hyperliquid EVM Testnet`。后续 Testnet Bridge 截图已确认应用实际读取到 chain ID `998`。
- [x] 测试 HYPE 已到账（2026-10-27，用户截图）：ZalalenA 水龙头提交后，MetaMask 测试网络下显示 `0.000500 HYPE`。Quicknode 因主网 HYPE 余额门槛未能领取，Thirdweb 提示 Free plan 无法使用水龙头；实际通过社区水龙头获取。TBC 一侧继续使用 Turing Wallet 与 native test TBC 支付手续费。
- [x] 已实现钱包准备页面（2026-10-27）：Bridge Lab 新增 **Testnet Bridge** 标签，复用 Turing Wallet 会话；MetaMask 按钮连接、读取地址／chain ID／原生 HYPE 余额，支持请求切换或添加 chain `998`。账户／网络切换会清除旧数据并重新读取；无轮询，支持手动刷新、错误提示和读取超时。此处记录代码实现，不代表真实浏览器验收或跨链完成。
- [x] Testnet Bridge 正常连接场景已验收（2026-10-27，用户真实浏览器截图）：Turing Wallet 显示 `tbc / testnet`；MetaMask 显示 `HyperEVM Testnet / 998`，应用地址与扩展显示的地址首尾一致，页面与钱包均显示 `0.000500 HYPE`，汇总提示 **Both wallets are connected**。此证据只确认连接及读取成功，不代表部署或跨链交易完成。
- [ ] Testnet Bridge 其余浏览器验收：检查拒绝连接、切错网络、切换账户、钱包断开及余额变化后手动刷新的表现。
- [ ] 部署和交易前估算 gas 与实际费用，不仅凭已到账 `0.000500 HYPE` 推断余额足够。
- [ ] 明确首版资产与机制：曾讨论以 native test TBC 为源资产，采用托管式 Lock and Mint；目前只是候选设计。若选该方案，需说明桥控制的保管地址、验证服务及 mint 权限；不能将普通转入托管地址称为无需信任的链上锁定。
- [ ] 设计正向最小流程：创建订单 → 源链付款 → 后端核验网络、付款输出、金额、确认数及订单绑定 → 目标链结算 → 核对到账与订单完成。
- [ ] 实现持久化订单、付款与目标地址绑定、唯一入金识别和防重复结算；源链 TXID 与目标链交易哈希均需关联到订单。付款截止时间与旧 HTLC 的退款时间是不同规则，需分别设计。
- [ ] 若选择 Lock and Mint，部署独立的实验 wrapped token 与受控 mint 功能，确定单位、精度及资产对应关系。先走通一个方向，再实现 burn → 验证 → 源链释放的赎回流程。
- [ ] 记录双链结果、费用、确认与异常处理，区分模拟展示、真实测试网交易和已验收场景。HyperEVM 测试网存在，不代表官方 Turing Bridge 已提供对应测试网服务。

学习顺序：先完成两侧钱包与 gas 准备，再确定首版机制和资产，接着实现单向订单／结算，最后补齐反向赎回。

参考：[Turing Bridge 官方产品教程](https://docs.turingbitchain.io/en/guides/TBC-to-HyperCore)、[HyperEVM 官方网络参数](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm)、[HyperEVM 官方工具目录与测试水龙头入口](https://hyperliquid.gitbook.io/hyperliquid-docs/builder-tools/hyperevm-tools)。

---

## 原有阶段：按最新进度更新

以下保留原有学习顺序，按钮与操作说明已替换为当前界面。当前操作细节见 `wallet/README.md`。

### 阶段 0：理解目标与角色

- [x] 已讨论并在本文记录 Bridge、Swap、HTLC、Wrapped token、Lock and Mint、Attestation 和 Smart Contract 的区别。
- [x] 已明确当前实验是 TBC Testnet 上 A／B 两个钱包之间的单链 HTLC；锁定资产为 FT token，native test TBC 用于手续费和协议输出。
- [ ] 学习归纳：用自己的话写出“B 领取原 token”与“锁原资产后 mint wrapped token”的区别。
- [ ] 进阶准备：阅读 BitBus User Guide，整理 Maker／Taker、订单、两侧锁定、secret 揭露和 auto-claim 流程。聊天中解释过概念不代表你已独立完成这些学习记录。

### 阶段 1：Secret 与 Hash

- [x] 已实现浏览器生成 32-byte secret，并计算 SHA-256 hash；以 64 个十六进制字符显示。
- [x] 已验收旧教学页中的生成 secret 和正确 secret 的匹配流程；后续成功 Claim 也用到了原始 secret。
- [x] 当前 Review lock 自动生成 secret/hash；独立 Generate／Check 教学界面已按你的要求移除，无需再寻找旧按钮。
- [x] 已实现新 lock 签名时加密保存 secret、A 用钱包消息签名取回；正常取回、A 拒绝签名、B 不显示取回按钮均已由你确认，详见第 2 步。
- [ ] 学习归纳：解释 hash 可公开、secret 在 Claim 广播后会公开，以及 secret 与钱包私钥的区别。
- [x] 合法长度但不匹配的 secret 已触发 Claim 错误提示，见第 2 步。
- [ ] 非 hex／长度不足等非法输入边界仍需验收；未保存过的旧 secret 不能靠现在的功能恢复。

### 阶段 2：技术路线与钱包准备

- [x] 已实现并实际使用 Turing Wallet 连接 A／B、读取地址／网络／公钥及钱包签名。
- [x] A／B 已有足够 native test TBC 完成已有的锁定、领取、退款；“B 无手续费所以无法 Claim”已不再是当前阻塞。
- [x] 已实现并成功使用 FT HTLC 的构建、钱包签名、签名验证、显式提交及确认查询。
- [x] SDK／provider 已纳入 TypeScript 项目。当前 package.json 固定 `tbc-contract@1.7.3`、`tbc-lib-js@1.0.31`；provider 声明为 `turing-wallet-provider@^1.5.8`。
- [x] 源码已调查 HTLC 控制脚本、SHA-256、签名参数、timestamp、locktime／sequence；退款资格使用 Testnet median chain time，不只看浏览器时钟。
- [x] 只读 Check Testnet wallet 教学界面已移除；连接及校验逻辑保留在现有操作流程中。
- [ ] 补充实验环境记录：实际安装的 SDK／provider 版本、钱包扩展版本、API 与公开地址。截图曾显示钱包版本 3.2.1；以之后实际测试环境为准。

源码参考：[HTLC 文档](https://github.com/TuringBitChain/tbc-contract/blob/2f3fe7873e05d8b6f1f53b8720f066776b847b03/docs/tbc-htlc.md)。这份历史调查曾注明“签名未验证”；现已被后续成功的 Lock／Claim／Refund 用户操作结果更新。

### 阶段 3：单链 FT Token Lock

- [x] 已实现 token 选择、名称／symbol／合约显示、按 decimals 转换金额、地址校验、token 资金选择和找零核对。
- [x] 已实现 recipient autocomplete：输入匹配、下拉选择、新地址在成功提交 lock 后记入浏览器缓存，最多 100 个。
- [x] 已实现未来日期／时间 picker、快捷选择与退款时间校验；到期不自动退款。
- [x] 当前流程为 Review lock → Sign with wallet → Submit lock。Review 已包含构建 unsigned transaction 和费用计算，不再需要旧教学页的独立 Build 按钮。
- [x] 已实现 raw transaction／ancestor proofs 构建、签名归属与 ALL|FORKID 核验、inputs／outputs／sequence／locktime 不变检查、费用及 input scripts 校验。
- [x] 已验收：A 已创建可供后续成功 Claim／Refund 的链上 lock。无需重复做基本 Lock 演示。
- [x] 已保存公开请求记录与关联 TXID；签名与提交分开，提交结果区分 submitted／rejected／unknown。
- [ ] 可补充：归档既有 lock 的完整 TXID、输出 index、金额、手续费和确认依据，见第 3 步。

实现范围：普通 legacy FT；尚未实现 TBC20／stablecoin 的 proof adapter。Native TBC 不能选择为当前练习的锁定资产。

### 阶段 4：Claim

- [x] 已实现从保存记录或手动 TXID／contract ID 加载 lock，核验脚本、token、金额、地址及输出状态。
- [x] 已实现 B 的 Claim 构建、正确 secret 校验、钱包签名及显式提交；Claim 会公开 secret 的提示保留。
- [x] 已验收：B 的 Mega Token Claim 显示 Claimed 且有区块确认；相关 Claim TXID 在请求历史中可查看。
- [x] 已实现查看关联交易时跳转站内 `/transaction?txid=...` 并定位、展开详情；不是直接打开 API JSON。
- [x] 已验收错误 secret 的前端拦截提示，见第 2 步。
- [x] 已验收 B 拒绝 Claim 交易签名后的拒绝提示与表单状态，见第 2 步。
- [ ] 待验收：错误签名、直接 API 的 secret 校验、重复领取、已花费输出等失败路径，集中放在上面的第 2 步，不代表成功 Claim 尚未完成。
- [ ] 可补充：B 的到账输出／余额及实际费用记录，集中放在第 3 步。

### 阶段 5：Refund（与 Claim 使用不同的 lock）

- [x] 已实现 A 的 Refund 构建、钱包签名及显式提交，不需要 secret；使用正确 locktime／sequence 和链上时间检查。
- [x] 已验收：两笔独立 lock 显示 Refunded 且有确认，你已说明是 A 自己按 Refund 收回。不需要重做基本退款演示。
- [x] 已观察到 `non-final-pool-full` 失败案例；后续也有成功退款结果，可用于记录时间条件与节点接收策略的区别。
- [x] 已讨论当前 Claim 没有同样的退款到期上限：退款时间后，输出仍未花费时 B 仍可能 Claim；最终只能有一条花费成功。
- [ ] 学习归纳：记录失败案例的错误、时间条件和最终退款 TXID，并解释为何不能重复花费同一个 lock。无需再次广播故意失败的交易。

### 阶段 6：可靠性与维护

- [x] 已迁移到 TypeScript，并按 pages／components／hooks／services／utils／types／config 与 server 分工。
- [x] 已实现 My HTLC Requests、钱包角色显示、token 名称／精确金额、关联交易和最近查询时间。
- [x] 已实现 public history 自动写入 `wallet/storage/htlc/testnet/`；secret 独立加密保存到 `wallet/storage/htlc/secrets/`。列表不是全网 HTLC 索引。
- [x] 已实现 Claim／Refund 操作与下拉选项的资格判断：已完成、已花费、未确认、查询失败时禁用。
- [x] 已实现请求取消、提交防重复、错误显示、unknown 提交后的只读查询；不自动重播交易。
- [x] 已实现钱包资源 API：`GET /__htlc/locks?address=...`、`GET /__htlc/locks/:lockTxid`、`POST /__htlc/locks/status`；批量刷新只提交钱包地址和可选 cursor。
- [x] 已实现打开列表时由后端读取保存记录、查询节点、汇总每笔状态；逐笔 Check 已移除，保留整体 Refresh requests。
- [x] 已实现最多 25 笔一页、批内数据复用、每笔独立结果、节点限流／时间预算处理；成功结果不因别的 lock 失败而被丢弃。
- [x] 已实现 HTTP 处理队列（2 个运行、8 个等待）、90 秒总期限，以及独立共享钱包查询队列（1 个运行、8 个等待）；共享查询有自己的期限，不会无限后台执行。
- [x] 已实现同钱包／页的查询合并、成功 15 秒／错误 5 秒缓存、最多 100 页；这些只供显示，签名／广播前仍重新检查链上条件。
- [x] 近期代码变更已通过 TypeScript 检查；这不是浏览器、钱包或并发场景实测结果。
- [x] 已验收：最新后端列表的正常载入与状态显示，见上方第 1 步。
- [ ] 额外验收：分页、缓存、并发、断线及错误场景，见上方第 1 步的剩余项。
- [x] 已验收 secret 取回的正常流程、A 拒绝消息签名，以及 B 不显示取回入口。
- [x] 已验收 B 拒绝 Claim 交易签名后的界面处理，与取回 secret 的消息签名测试分别记录。
- [x] 已验收切到 Mainnet 后的错误网络提示、Testnet 列表隐藏和刷新禁用。
- [ ] 额外验收：直接 API 权限、切回 Testnet 后恢复、签名期间切换账户等，按上方第 2 步执行。
- [ ] 待验收：server 重启、旧记录恢复及备份副本恢复，按上方第 3 步执行。
- [x] 已实测 `.encryption-key` 静态 URL 返回 403，并检查公开 lock 列表的可见响应字段；证据与范围见第 2 步。
- [ ] 补充核查：日志、完整响应、单笔 lock／status API 及静态路径变体，确认不提前泄露 secret／密钥／签名交易。
- [ ] 下一次需要验证实现时运行 `npm --prefix wallet run typecheck`；生产构建另运行 `npm --prefix wallet run build`。本次只整理文档，没有重新执行这些命令或交易。

### 阶段 7：双链 Atomic Swap（可选进阶，未实现）

单链 Claim／Refund 的确认条件已有证据；下一步先决定是否要做此路线。它不是同链 HTLC 的必做步骤，也不是 Lock and Mint。

- [ ] 学习归纳 Maker／Taker、同一 hash、secret 揭露后双方领取的流程。
- [ ] 确定第二条测试链，准备对应钱包与手续费资产，确认网络／地址／API 一致。
- [ ] 查证两边 hash、preimage 编码和脚本条件兼容；核对资产、金额、领取方、退款方。
- [ ] 设计两侧不同的退款期限，并解释为什么必须留足时间差；不同链的区块高度不能直接当成同一个时间比较。
- [ ] 实现两侧锁定、确认、领取，并分别保存交易证据；交换金额来自报价，不自动等于 1:1。
- [ ] 演练对手不锁定、延迟确认、没有继续领取时的退款路径。
- [ ] 研究 BitBus 的 Maker pre-signed claim／auto-claim 的保管、广播条件和费用有效性。

### 阶段 8：BitBus 风格 Marketplace（可选，未实现）

- [ ] 增加 Listing：交易对、方向、报价、数量和每单上下限。
- [ ] 增加 Order：接单、双方地址、截止条件与交易 ID。
- [ ] 建立公开订单存储和钱包签名身份验证。现有 lock 文件不等于完整订单系统。
- [ ] 分开管理订单状态与链上交易状态，以交易证据更新进度。
- [ ] 增加分页、筛选、恢复和限量并发处理。
- [ ] 若接入真实 BitBus，另行核实 Testnet endpoint、认证和交易对；Overview 的公共查询不代表已经能使用其 Testnet 交易功能。

## 每次实作的记录模板

记录已有交易即可，不必为了填写重新发交易。不要写入真实 secret 或钱包密钥。

```text
日期：
阶段／目标：
网络及 API：
SDK／provider／钱包版本：
账户 A 公开地址：
账户 B 公开地址：
Token 名称／symbol／contract ID／decimals：
操作与金额：
预期结果：
实际结果：
lock TXID + output index：
claim／refund TXID：
确认数／区块高度与查询时间：
实际手续费：
错误及处理方式：
证据（链接／不含敏感数据的截图）：
学到了什么：
下一步：
```

## 参考资料

以下保留原有参考链接，本次整理没有重新联网核实其最新内容。

- [BitBus User Guide](https://bitbus.net/user-guide)：产品流程、Maker/Taker、锁定、领取、退款和 auto-claim。
- [TBC API 文档](https://docs.turingbitchain.io/)：链上查询和广播接口。
- [Turing Wallet 文档](https://docs.turingwallet.xyz/)：钱包连接与签名。
- [TBC Contract SDK](https://github.com/TuringBitChain/tbc-contract)：合约实现和 SDK。
- [TBC HTLC sample](https://sample.tbcdev.org/htlc)：交互参考，不假定其默认网络是 Testnet。
https://airdrop.tbcdev.org/
https://github.com/TuringBitChain/turing-wallet-provider

**当前安排：第 6 节 Testnet Bridge 的真实浏览器正常连接场景已由用户截图验收：两侧测试钱包已连接，应用实际读取 chain `998`，HYPE 余额与 MetaMask 的 `0.000500 HYPE` 一致；异常及余额刷新场景仍待验收。下一步确定自建学习桥的首版资产与结算机制；部署前估算费用。原有单链 HTLC 成果保留，剩余验收暂缓；双链 HTLC 和 BitBus Marketplace 为可选，STUDY2.md 始终只读。**
