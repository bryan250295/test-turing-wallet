# Bridge and Swap
- 只要可以证明从哪个source chain到哪个destination chain和rules就能成立bridging
- source chain 就是从哪里来
- destination chain 就是要换到哪里去
- rules 包含 （lock and mint，burn and mint， liquidity）

## Bridging 的 flow example (lock and mint)：
‘’‘
10 TBC  
  ↓ 交易成 100 USDC
100 USDC (TBC Network)
  ↓ lock 100 USDC 在 TBC network 和 bridge 到 Ethereum network
100 wrapped USDC 在 Ethereum Network
  ↓ 交易成 ETH
Estimate 100 USDC = 1 ETH
’‘’

## Bridging 的 flow example (burn and mint)：
‘’‘
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
’‘’

## Bridging 的 flow example (liquidity)：
‘’‘
10 TBC
  ↓ 交易成 100 USDC
100 USDC (TBC Network)
  ↓ Deposit（存入桥的资金池）
  ↓ Verify the Deposit（验证存款交易）
  ↓ Release / Payout（目标链资金池支付）
100 USDC on Ethereum Network
  ↓ 交易成 ETH
Estimate 100 USDC = 1 ETH
’‘’

- Attestation（证明／签名凭证）- 负责验证的系统确认交易后，出具一份带数字签名的证明（Digital Sign）
- Smart Contract（智能合约）- kind of contract to avoid 一直被拿来重复领取
- Liquidity Pool（资金池）- 把全部资金集中存放的地方