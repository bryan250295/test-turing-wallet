# Docker / NestJS / PostgreSQL

## 中文：启动

前端继续使用 React + TypeScript；NestJS 是独立 Node.js 后端；PostgreSQL
运行 SQL。Prisma 从 `backend/prisma/schema.prisma` 生成 TypeScript 数据库客户端。

首次在仓库根目录执行：

```bash
node scripts/setup-local.mjs
docker compose up --build -d
```

之后日常启动：

```bash
docker compose up
```

首次构建需要下载镜像和依赖。钱包 SDK 的 npm 包已下架，现有 1.5.8 已按原样保存在
`wallet/vendor/`，校验信息见其 README；TBC 合约 SDK 只在 backend 安装。修改依赖或 Dockerfile 后重新 `up --build`。
Docker Desktop 必须先运行。若旧版 Compose 不能处理依赖条件，请升级 Docker
Desktop / Compose；仓库使用 Compose V2 命令。当前开发配置会按顺序完成：

1. 启动 PostgreSQL，并等待健康检查。
2. `migrate` 一次性任务应用 SQL migration、授予应用账户业务表权限，并导入旧 storage。
3. 导入成功后启动 NestJS；导入失败会阻止后端启动。
4. 后端健康后启动 React Vite 开发服务器。

开发模式挂载前后端源码和 shared，修改源码会触发更新。没有把本机的
`node_modules` 挂入 Linux 容器；新增依赖需要重建镜像。

访问 `http://localhost:5173`。刷新页面只读取钱包状态并恢复有效 Session，不请求新签名。
点击 **Connect wallet**／**Reconnect** 后，若没有当前钱包的有效 Session，应用才请求
钱包签署登录消息，然后加载 HTLC 请求。账户／网络事件本身不触发登录签名。
无需单独点击后端登录。取消签名或连接失败后点击 **Reconnect** 重试，不会反复弹出签名请求。
Session 当前配置为 12 小时；过期后需要主动 Reconnect，启动 Docker 本身不会发出钱包请求。
登录签名不发送交易，也不授权后台代替用户签署资金交易。

| 服务 | 本机入口 |
| --- | --- |
| React | `http://localhost:5173` |
| API / Swagger | 同源 `/api/docs`、`/__htlc/*` |
| PostgreSQL / DBeaver | Host `127.0.0.1`，Port `5433` |

数据库名默认是 `learning_bridge`；DBeaver／日常应用使用 `learning_bridge_app`。
密码由 setup 随机生成，查看本机 `.env` 的 `APP_DB_PASSWORD`，不需要把密码放进代码或聊天。建表和导入任务独立使用迁移管理员，API 账户不能修改表结构或导入登记表。
容器之间使用 `postgres:5432`，DBeaver 使用本机映射端口 `5433`。后端没有直接暴露主机端口。

Compose 默认只绑定本机。手机访问需要显式调整端口绑定和 `APP_ORIGIN`，并使用
钱包支持的安全访问环境；不要沿用旧文档的任意 LAN URL。

## 数据迁移与密钥

- 旧 `wallet/storage/htlc/testnet/*.json` 导入 `htlc_requests`、`htlc_recoveries`。
- 加密 secret 导入 `claim_secrets`，继续采用 AES-256-GCM，保存密文、IV、tag 和
  原始 AAD 所需字段。导入前逐条认证密文并核对 hashlock，不输出明文。
- 原 `.encryption-key` 复制到独立的 `.secrets/htlc.key`，通过 Compose secret
  挂载到需要它的后端容器，不放进数据库或 Docker image。
- `.secrets` 主机目录权限为 `0700`；key 文件为 `0644`，用于非 root 容器读取
  Compose 文件 secret。主机目录限制访问，只有后端和迁移容器挂载该密钥。
- setup 在 `.backups/legacy-*` 创建一次迁移前备份。原 storage 只读挂载给迁移任务，
  业务读写已切到数据库。原文件保留，新的资料不会再写进旧 JSON。
  一次性导入容器以 root 读取旧主机的私有文件，API 和前端容器以非 root 用户运行。
- 导入以单个事务执行；失败回滚本次导入。文件 hash 登记在 `storage_imports`，
  相同文件再次执行会跳过；已导入原文件被修改时会停止，避免覆盖数据库新资料。
- 旧记录标记 `legacy_import`，不能当成已完成链上验证。浏览器导入的记录只作为
  TXID／Contract ID 提示，后端查询链上数据后才保存其公开字段。
- 目前浏览器的 recipient suggestions 仍是本机偏好，未作为账户业务资料搬入数据库。
  旧 `wallet/logs` 是历史调试日志，保留原文件；新操作只向数据库写入白名单摘要。
- `htlc_observations` 保存最近成功结果和最近错误，显示缓存与签名／广播验证分开。

同一个 secret 的数据库备份和解密 key 必须都能恢复。setup 在检测到旧密文但缺少
密钥时会拒绝生成替代密钥。现有 key 不会在容器重启时自动更换。

## 持久化、备份与恢复

PostgreSQL 使用 named volume。`docker compose down` 停止并移除容器，保留数据库。
**`down -v` 会删除数据库 volume**，不要用于日常重启。

备份当前数据库：

```bash
node scripts/backup-database.mjs
```

输出为 `.backups/postgres-*.dump`。独立备份 `.secrets/htlc.key` 和
`.secrets/bridge-custody.key`；数据库及其对应解密密钥必须一起保留。
恢复时先停止 frontend/backend，保留目标库副本，再使用容器内 `pg_restore` 将 dump
导入一个明确选择的空数据库；恢复正确的 key 后启动后端。不要把原 JSON 重新导入
已经恢复了 `storage_imports` 的数据库来覆盖新数据。尚未执行恢复演练。

## 目录和职责

```text
wallet/                 React UI、钱包连接、用户签名、Solidity 实验合约
backend/src/auth/       钱包 challenge、session、CSRF 与访问控制
backend/src/htlc/       Controller → Service → Repository
backend/src/htlc/engine/ TBC SDK 构建、签名／脚本验证、限量排队
backend/src/bridge/     桥资产、部署、准备订单与独立加密保管服务
backend/prisma/         Model、索引、约束、版本化 SQL migration
shared/src/            共用类型、链上只读 API client 与纯函数
scripts/               本地配置和备份入口
compose.yaml           开发环境
compose.production.yaml 正式构建配置，需要自行配置 HTTPS
```

`wallet/server/` 的旧 Vite middleware 已迁走。前端通过同源代理访问 NestJS，
现有 HTLC URL 保留，避免更换页面功能。API 返回格式保留 `{ data }`／`{ message }`，
错误增加 requestId；日志不记录请求正文、cookie、签名或 secret。

迁移清理：删除旧 `wallet/server/` middleware，移除未引用的前端
`services/htlcTokenLock.ts`／`utils/htlcTokenLock.ts` 转导出文件、旧
`loadHtlcHistory` 加载分支、前端 `signOutBackend` 和 engine
`getStoredHtlcRequest` 辅助函数。仍有调用的 shared 转导出入口继续保留。
engine 内的 `requestStorage.ts`／`secretStorage.ts` 现在调用数据库 Repository，
仍是运行代码；旧 storage、原 key、备份及导入脚本保留用于迁移和恢复。

金额以十进制字符串进入／离开 API。现有 HTLC 为兼容旧格式使用 `NUMERIC(100,0)`；
新的 EVM uint256 业务应使用 `NUMERIC(78,0)` 并加上 uint256 范围约束，不能只靠位数。
时间使用 PostgreSQL `timestamptz`，前端继续显示 MYT。

### 首个桥资产 / First bridge asset

用户于 2026-10-28 选择 Mega Token (MT)，Contract ID
`ac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c`，1 位精度。
共享公开配置位于 `shared/src/config/learningBridge.ts`，服务端额外固定 genesis 区块、
mint-source outpoint 和 legacy v3 模板版本，不能由客户端传入 metadata／RPC 来覆盖。

新增 migration `202610280001_bridge_assets` 只建立 `bridge_assets` 及约束／索引；
旧 initial SQL 不改动。迁移任务给应用账号授予此表的 SELECT／INSERT／UPDATE。
登记前从固定 tbcdev API 读取 raw genesis、decode、metadata、nodeinfo 和 mint source：
核对 TXID、已确认区块 checkpoint、SDK 发布模板、Code／Tape 长度、原始 outpoint、
六个 uint64 slots、名称／symbol／精度／raw supply 和 mint-source Tape。使用事务和
route advisory lock 保存，已登记的资产身份不可被后续验证覆盖；失败保留原登记。

`GET /api/bridge/assets/:contractId` 读取历史登记；`POST /api/bridge/assets/verify`
只接收 Contract ID，要求 TBC 登录、Origin 和 CSRF 校验，限流并只允许一个正在处理的验证。
历史登记不是实时入金证明。当前网络接口返回 `chain="main"`，所以还固定 tbcdev
数据源及所选 genesis 的区块 checkpoint；这是信任该 API 的核验，不是独立 SPV／Merkle 证明。

页面选择 FT 后点击 **Verify selected FT**，成功才显示已验证并保存；读取错误不自动重试。
保留运营者入口 `docker compose exec -T backend npm run bridge:verify`，调用同一验证及持久化逻辑。
它不签资金交易、不产生 gas、不部署合约或 mint。后续部署／入金仍需独立的新鲜验证。

### 部署预览 / Deployment preview

`POST /api/bridge/deployments/preview` 接收 `{ contractId, deployer, admin, minter }`，
经过 Controller／DTO／SessionGuard／Service；要求 TBC Testnet 登录、Origin、CSRF、
非零 EVM 地址，以及 10 分钟内的 MT 资产验证记录。每身份只允许一个正在运行的估算，
全局最多 4 个，每分钟 6 次请求，40 秒总超时并在客户端断开时取消 RPC。

构造 ABI／bytecode 来自 `shared/src/contracts/learningWrappedFT.ts`，由
`wallet/scripts/compileBridgeContract.mjs` 与完整 artifact 同时生成。固定官方 RPC，
两次检查 chain 998；在同一区块读取部署者余额、账户代码及估算 gas，另外读取当前
gas price。返回原始估算、加 20% gas units 的预算、余额差额、构建指纹、报价时间和
60 秒有效期。所有金额为十进制整数字符串，使用 bigint 计算。未开放智能账户部署。

此 API 只读，不把请求中的地址当作所有权证明，不保存角色授权、不访问私钥或广播。
当前 minter／Admin 可在页面选用同一个 MetaMask 账户，也可填写不同公开地址；
未来真正部署必须重新估算并由钱包签名，再验证收据、合约代码和初始化状态。

### 钱包部署与合约登记 / Wallet deployment lifecycle

新增独立 migration `202610280002_bridge_deployments`，只创建 `bridge_deployments`，
关联原钱包身份与 `bridge_assets`；旧表不重建、不清空，旧迁移文件不修改。表保存
构造数据、运行代码及 immutableReferences 快照、报价、nonce、生命周期、收据和核验时间。
应用角色仅有 SELECT／INSERT／UPDATE。自定义 partial unique indexes 保护同用户／路由
与同链／部署者／nonce 的活跃记录，不要通过 db push 或重建数据库绕过这些约束。

所有端点要求原 TBC Testnet 登录、Origin／CSRF 校验：

| Endpoint | Responsibility |
| --- | --- |
| `GET /api/bridge/deployments` | 最近 20 条本人记录；读取不发送交易 |
| `POST /api/bridge/deployments/prepare` | 新鲜报价、构建快照、pending nonce，保存 prepared |
| `POST /api/bridge/deployments/:id/begin` | 再估算／核对 nonce，原子领取 awaiting_wallet，返回固定交易字段 |
| `POST /api/bridge/deployments/:id/submit` | 挂接钱包公开哈希，不据此推断成功 |
| `POST /api/bridge/deployments/:id/check` | 固定 RPC 核验交易／6 次确认／代码／部署区块初始状态 |
| `POST /api/bridge/deployments/:id/cancel` | 关闭无哈希准备；不取消钱包或链上交易 |

发送只由 MetaMask 执行。前端比较 constructor 编码、nonce、gas、价格、from、chain 和
零 value，省略 to，切换账户／网络／标签会阻止迟到的自动弹窗。数据库发送槽位防刷新后
重复签名；未知结果不自动发送第二次。sessionStorage 仅短暂保留 API 未保存成功的公开
receipt 指针，后端数据库仍是历史来源，手动粘贴 MetaMask 哈希也可恢复。

验证器比较完整创建 input 和 runtime（屏蔽编译器指定 immutable 位置后再读取实际
immutable 值），验证创建地址和规范区块，要求 owner／minter／FT／精度匹配、初始
paused=true、totalSupply=0。记录 actual fee、block hash、runtime hash。RPC 失败保留
旧结果并标为 unavailable；原子 updatedAt 条件阻止迟到检查覆盖更新结果。链上查询
信任固定 RPC，不是独立轻客户端证明；记录不授予用户全局桥操作权限，也不解除暂停。

### 准备订单与加密保管 / Prepared orders and encrypted custody

`202610280003_bridge_orders` 只新增 `bridge_orders` 与 `bridge_custody`，
关联原钱包身份、已验证部署，并保留全部旧表。订单金额为 `NUMERIC(78,0)`，
额外限制在 legacy FT 的正 uint64 范围，API 以十进制字符串传输。

订单 API 见 backend README。服务端固定 MT、精度 1、chain 998、源／目标 6 次确认
和策略版本；用户选择的是本人已验证的 deployment ID，不能提交任意 RPC、源地址、
目标合约或保管地址。创建前要求 10 分钟内的 MT 身份核验，并从固定 RPC 重新检查
部署所在规范区块、当前 runtime hash、owner／minter、MT 绑定和精度。最初准备阶段要求
paused=true／零供应；结算接通后允许已 unpause／已有供应的同一已验证合约继续处理订单。
这些查询信任指定节点，仍不是独立轻客户端证明，也不是入金证明。

事务取得身份级 advisory lock，核对 `identityId + idempotencyKey`；相同请求／条款
返回原订单，条款不同返回 409。订单与保管密文在同一事务提交，每身份最多 3 个
prepared 订单。条款 hash 绑定订单、身份、请求 ID、源资产、数量、接收地址、网络、
部署和确认策略。应用角色只能 INSERT／SELECT 条款，UPDATE 仅限 status／cancelledAt。
关闭 unused preparation 只写 cancelled，保留加密地址记录，永不复用地址或删除密钥。

保管私钥由服务器 `tbc-lib-js` 安全随机生成，每订单一个 compressed P2PKH 地址。
SDK 的 `livenet` 参数仅选择 tbcdev／Turing 使用的 `0x00` 地址编码，不选择主网节点；
网络与用途在密文 AAD 中绑定 Testnet。API 不返回可付款地址、QR、私钥或 WIF。

- 独立 32-byte 主密钥：`.secrets/bridge-custody.key`，`setup-local` 创建并将初始
  副本保存于 `.backups/bridge-custody.key`。不复用 HTLC key；已有文件不会被覆盖。
  两者冲突会停止 setup；缺主文件时优先恢复现有副本。两份都丢失时新生成的 key
  无法解密旧资料，后台检测数据库 key fingerprint 不匹配后禁止新建订单。
- Compose 只把它以只读 secret 挂入 backend；postgres、frontend、migrate 不获得它。
  文件 `0644` 供非 root 容器读取，主机父目录 `0700`；本地副本 `0600`。
- HKDF-SHA256 按订单 UUID 派生 AES-256 key，固定域 `learning-bridge/custody/testnet/v1`。
  AES-256-GCM 使用随机 12-byte IV 与 16-byte tag；AAD 绑定版本、网络、身份、订单、
  条款 hash、地址和公钥。写入前在内存认证解密并核对派生地址，仅返回密文给 Repository。
  恢复时显式保留 compressed 编码；该 SDK 从裸 32-byte scalar 恢复默认是不压缩公钥，
  不能直接把裸 scalar 交给 `PrivateKey.fromBuffer` 后就认为派生地址不变。
- `bridge_custody` 保存密文、IV、tag、key fingerprint、地址和公钥；key fingerprint
  是密钥标识，不是解密密钥。应用角色仅 SELECT／INSERT，不获 UPDATE／DELETE。
  日志与审计仅记录订单 ID／条款摘要，不记录密钥、正文或密文内容。
- 备份必须包含 PostgreSQL 和匹配主密钥，并将密钥在此电脑之外单独妥善保存。
  本机 `.backups` 副本不是异地备份；完整恢复演练尚待进行。加密不防止整台后端
  被控制，JavaScript 运行时也不保证清除 SDK 对象的所有内部副本。

最初阶段仅实现 review → prepared → cancelled，并隐藏付款地址。结算接通后，原条款
不变，资金状态独立保存。订单摘要仍不含地址；用户通过下方显式开放接口查看。
切标签／钱包／网络清空表单，数据库历史保留。同一 review 重试复用请求 ID，
不自动重发或另配地址；准备记录本身不证明已收款。

### 入金与钱包确认结算 / Deposits and wallet-confirmed settlement

`202610280004_bridge_settlement` 只新增 `bridge_settlements`、`bridge_deposits` 和
`bridge_call_attempts`，保留旧订单／条款／密文，不修改此前四个 migration。资金状态
独立为 awaiting_payment → confirming → ready_to_mint → mint_pending → completed，
异常进入 needs_review。完成的订单不再占 3 个未完成名额；未完成订单优先显示。

用户明确接受托管、精确金额和无自动退款后，后台认证解密原密文并核对恢复地址／公钥，
核查源链 checkpoint endpoint 及当前目标合约，才记录开放时间并显示付款地址。
该 API 不发送资金。用户在 Turing Wallet 发送一次普通 FT 转账并提交 TXID。开放后的
订单不能关闭为 unused，不自动过期；旧 prepared 订单直接继续使用，无需重建。

入金验证固定 tbcdev 数据源与 MT genesis checkpoint，重新核对 genesis、raw TXID、
完整 Code／Tape 与 MT 绑定。首版收款为 vout 0／Tape 1，最多 6 个连续普通 FT 输入加
1 个发送者 P2PKH fee input。核对父输出归属冻结发送者、Tape 元数据和六槽数量分配、
精确 MT 找零及 native fee；读取祖先并构建 SDK proof，对所有输入执行本地解锁脚本。
还要求指定 Contract ID 的 indexer 识别保管地址下对应未花费输出；按高度读取规范区块，
对照两次 decode，采用较小确认数。限 48 个 raw 交易／8 MB／10 页 UTXO，超限停止。
额外附言、native 同付、批量／多组、不足／超额或不同 FT 不自动接受。

这信任固定节点／FT indexer 的链包含性和祖先归属，不是独立 SPV 或无信任桥。
全库 `(sourceNetwork, txid, vout)` 唯一，不能跨订单或重新部署后重复结算。保存源链
费用、区块、确认及核验时间；API 超时保留历史，不意味着未付款，不自动再次付款。

达到源 6 确认后，MetaMask 分别确认 admin unpause 和 minter mint。报价与 begin 均重新
核验源入金、当前目标代码／角色／绑定和重放标记，固定 ABI／零 value／pending nonce，
估算 gas 并加 20% gas units 预算，60 秒失效。发送者级 advisory lock、active sender
唯一约束和部署互斥防应用自行安排并发 nonce。后台没有 EVM 私钥或自动 mint worker。

订单 bytes32 key 为 SHA-256 `learning-bridge/order/v1:<UUID>`；前端独立计算，逐字比较
mint ABI 六个参数和 unpause selector，再核对账户／chain／nonce／余额，显式按钮才请求
一次发送。数据库先保存 awaiting_wallet，刷新不再签名。公开 hash API 保存失败时用
sessionStorage／内存恢复，或手动补录 Activity。未知结果先查 Activity；只有确认拒绝／
未发送才丢弃本地请求，丢弃不能取消链上交易。进度查询目前用手动 Check，不无限轮询。

收据验证完整 from／to／nonce／chain／value／input、规范区块和 6 次确认；unpause 要求
收据区块 paused=false，mint 要求唯一匹配 DepositMinted 事件及 processed 标记，比较
order key、deposit key、源资产／TXID／vout／金额／recipient。验证 mint 结果前再核验
源入金；已发送后的源重组／确认下降／输出花费或不确定目标结果保留证据并要求对账。
满足两侧策略才 completed，并可显式 wallet_watchAsset 导入 lwFT。记录实际 HYPE fee。

应用角色不能修改钱包意图的 calldata／nonce／角色／预算或入金 TXID／vout／数量／fee，
只更新资金状态、确认、收据和检查时间；不能删除资金记录。保管密钥不向外导出，没有
反向释放／自动退款。2026-10-29 用户截图已验收首笔真实入金、unpause、mint、Completed
及 1,000,000 lwFT 余额；完整异常浏览器场景仍待验收，没有运行自动化测试。公开交易记录及
反向流程兼容性评估见 learning-bridge.md 第 9–10 节。API 路径和职责见 backend README。

## 正式构建与范围

正式镜像中 React 编译成静态文件由 Nginx 提供，后端执行编译后的 JavaScript。
先配置 HTTPS 的 `APP_ORIGIN` 和外层 TLS 代理，再使用独立配置：

```bash
docker compose -f compose.production.yaml up --build -d
```

此配置与本地配置共用 Compose project 和数据库 volume，不能同时运行。
部署前需明确环境、备份、HTTPS、镜像版本与访问范围。当前使用单个后端副本，
Redis、微服务和分布式队列未加入；之后实现真正的 bridge worker 时再扩展。
迁移不会触发链上广播，也不会部署 Solidity 合约或自动 mint。

## English summary

Use `node scripts/setup-local.mjs` once, then `docker compose up --build -d`.
For daily development, `docker compose up` starts PostgreSQL, the migration/import
job, NestJS and React in dependency order. Source edits reload through bind mounts.
The browser talks to the backend through the same-origin frontend proxy.

Sign in explicitly with a TBC Testnet message signature before using HTLC APIs.
Sessions are stored in PostgreSQL with a hashed opaque token and an HttpOnly,
SameSite cookie. Writes require a CSRF token and the configured Origin. A separate
single-use signature still protects secret retrieval. EVM EOA verification is
supported by the API but does not link the two wallets or enable bridge transfers.

The import job authenticates legacy encrypted records, imports public requests
and ciphertext atomically, and records file checksums for repeatable execution.
Original files remain available for rollback; new writes go to PostgreSQL.
Encryption keys stay outside the database and Docker build context. Database
backups require a separately retained matching encryption key.

The bridge supports prepared orders, encrypted custody, explicit payment details,
ordinary MT deposit verification and MetaMask-confirmed unpause/mint calls. It has
no backend EVM signing key, automatic mint worker or reverse redemption. Fixed
node/indexer trust remains explicit. The user accepted the first funded forward
transfer and 1,000,000 lwFT balance on 2026-10-29. Comprehensive error handling,
backup restoration and reverse redemption remain unverified. See learning-bridge.md
sections 9–10 for evidence and reverse-flow compatibility. `STUDY2.md` remains unchanged.

### Reverse bridge preparation — existing token escrow

The selected reverse design permanently locks existing lwFT, leaving totalSupply
unchanged. `BridgeRedemptionController` / `BridgeRedemptionService` currently expose
an authenticated, CSRF-protected preview and persisted deployment under the completed order.
It reads existing repositories and freshly validates custody recovery, source FT
reserves and token binding. A separate compiled `LearningRedemptionEscrow` starts
paused and has no withdrawal/rescue/upgrade path. Preview writes no database rows
and sends no transaction. The additive `202610290001_redemption_escrow_deployments`
migration stores immutable deployment intentions and mutable receipt observations.
The runtime role cannot edit intent fields or delete records. Prepare/begin use
sender locks shared with wrapped-token creation and mint/unpause; begin reserves
one wallet request. Creation verification requires canonical input/receipt/code and
initial token/owner/paused/zero-locked state plus 6 confirmations. Public hash recovery
never opens another send. No deployment has been performed by the agent.

Verified redemption events, unique source-input reservation,
native TBC fee funding, custody signing and fixed-transaction recovery remain to be
connected before enabling token locking or source release. No source custody key
is exported, and no new EVM signing key is introduced.

## 依赖记录 / Dependency notes

- 前端锁文件已更新到兼容的安全补丁，安装审计为 0 项。
- 后端使用 Prisma **7.10.1** 与 PostgreSQL driver adapter，连接池设置连接超时。
  `multer` 与 `js-yaml` 采用 scoped override 的修复版本，未启用文件上传或任意 YAML 导入。
- 后端仍有 TBC SDK 传递依赖的 4 个 low 级审计项（elliptic / secp256k1 及依赖链），
  npm 未提供现有 SDK 的兼容修复。保留 SDK 版本，未替换其密码学实现。
- 类型检查、构建与数据库导入不等于钱包行为验收；没有新增或运行自动化测试。

## 本次执行记录（2026-10-27）

- Prisma Client 生成、NestJS TypeScript 编译、React TypeScript／Vite 构建通过。
- Docker 干净构建已解决 npm 下架的钱包 SDK 下载问题。
- PostgreSQL 与 NestJS 容器 healthy，React 已运行于 `http://localhost:5173`。
- 数据库读取核对：`htlc_requests` **5**、`claim_secrets` **4**、`storage_imports` **9**。
  导入过程中每份密文使用原 key 验证认证标签与 hashlock；重复运行导入成功且新增数为 0。
- 原 storage、独立 key 和迁移前备份保留，`STUDY2.md` 未修改。
- 尚未替用户进行钱包登录、签名、secret 取回或资金交易；未运行自动化测试或恢复演练。

### Fixed source-chain redemption release (2026-10-29)

`RedemptionReleaseService` separates fee-detail opening, funded immutable plan allocation, canonical lock attachment, explicit custody signing, explicit same-bytes broadcasting and confirmation reconciliation. The original full FT input and a confirmed native fee input are uniquely reserved. Every payout output and fee is checked before signing/broadcast; signed raw and TXID persist before the first node POST. Source/API outages retain records and cannot trigger a new payment. Exact permanent escrow events with 6 confirmations gate signing. Runtime grants prohibit changes to frozen plan/inputs/bytes/TXIDs and deletes. The browser offers fee funding, plan review and wallet-confirmed activation/exact allowance/permanent locking (learning-bridge.md section 14). Partial release inventory remains unsupported. The original completed mint is protected from being reclassified by source rechecks after its reserve is committed to a signed reverse release. Details: wallet/docs/learning-bridge.md section 13.

### Persisted redemption wallet calls

`RedemptionWalletService` freshly checks source/fee/plan readiness and current escrow/token state, then selects unpause, allowance reset, exact approval or permanent lock. A 60-second saved quote precedes a fresh begin check and a one-shot awaiting_wallet reservation. Frontend ABI reconstruction and provider account/network/nonce checks precede explicit MetaMask sending. Receipt checks compare full intent, canonical blocks, exact allowance/state and 6 confirmations; lock verification attaches the unique permanent event to the existing release. Activity pointers recover uncertain sends; sender locks now cover these calls alongside forward deployments/mints. Runtime grants prohibit changing intent/nonce/calldata/budgets or deleting requests. Migration 202610290004_redemption_wallet_calls preserves all prior migrations and funded records.
