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