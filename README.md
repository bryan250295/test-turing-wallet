
# Learning Materials

Learning Materials for TBC Developers

## Run the learning application

```bash
node scripts/setup-local.mjs
docker compose up --build -d
```

Open `http://localhost:5173`. Subsequent starts use `docker compose up`.
React TypeScript lives in `wallet/`, NestJS in `backend/`, shared types/helpers
in `shared/`, and PostgreSQL runs in Docker with a persistent volume.

Setup preserves the existing HTLC key and prepares a separate bridge custody
encryption key. Keep backups of the database and both `.secrets/htlc.key` and
`.secrets/bridge-custody.key`; keys are excluded from Git and Docker images.
The learning bridge supports verified deployments, prepared orders, explicit
payment details, FT deposit verification and wallet-confirmed unpause/mint calls.
Funding and minting require the user's wallet actions; they never start on refresh.
The first 1,000,000 MT → 1,000,000 lwFT transfer was accepted on 2026-10-29,
including Completed status and the MetaMask balance. Public transaction evidence,
remaining acceptance limits and reverse-redemption options are recorded in
[the bridge guide](wallet/docs/learning-bridge.md#9-首笔正向完成记录--9-first-completed-forward-transfer).

See [setup, authentication, migration and backups / 启动与迁移](docs/backend-architecture.md),
[backend modules](backend/README.md), and [wallet usage](wallet/README.md).

The proposed proof-oriented v2 bridge is still design-only. Its accepted Phase 0
protocol baseline is documented in
[TBC ↔ HyperEVM Bridge v2 Phase 0](docs/tbc-hyperevm-bridge-v2-phase-0.md).
It does not modify the running custodial Learning Bridge.

`STUDY2.md` is teacher-provided, read-only source material.


## Tools & SDK

- [ JaveScript Lib for TBC ](https://github.com/TuringBitChain/tbc-lib-js)
- [ Turing Wallet Provider for Web3 ](https://github.com/TuringBitChain/turing-wallet-provider)

## General 

- [ Learn Me A Bitcoin ](https://learnmeabitcoin.com)

- [ Mastering Bitcoin: Programming the Open Blockchain (3rd Edition) ](https://github.com/bitcoinbook/bitcoinbook/blob/develop/BOOK.md)

- [ Mastering Bitcoin: Programming the Open Blockchain (中文版1) ](MasterBitcoin/精通比特币%20(2016).pdf)

- [ Mastering Bitcoin: Programming the Open Blockchain (中文版2) ](MasterBitcoin/精通比特币%20第二版%20(2018).pdf)

- [ Bitcoin Script ](https://en.bitcoin.it/wiki/Script)

- [ BitcoinSV Script and Wiki ](https://wiki.bitcoinsv.io/index.php/Script)

- [ The Metanet - A Blockchain-based Internet ](https://nchain.com/wp-content/uploads/2022/09/The-Metanet-Technical-Summary-v1.0.pdf)

- [ The Metanet - A Blockchain-based Internet （中文） ](Metanet/The-Metanet-Technical-Summary-v1.0_CN_20190621033127.pdf) 

- [ Bitcoin_Rebirth_or_Vanish (2019-04) ](Bitcoin_Rebirth_or_Vanish/Bitcoin_Rebirth_or_Vanish.md)



## Technology Doc

- [ TXID_New_Hash_Proposal (2021-2024) ](TXID_New_Hash_Proposal/TXID_New_Hash_Proposal.md)

- [ How to Write Bitcoin Smart Contracts by using sCypt](https://docs.scrypt.io)
  - [Basic](https://scryptdoc.readthedocs.io/en/latest/)
  - [sCrypt Academy](https://learn.scrypt.io/)
  - [awesome-scrypt](https://github.com/sCrypt-Inc/awesome-scrypt/)
  - [xiaohuiliu.medium.com](https://xiaohuiliu.medium.com/)
  - [space.bilibili.com/1294122227](https://space.bilibili.com/1294122227)
  - [www.youtube.com/channel](https://www.youtube.com/channel/UCzQsmR836zW8b1kh03Ht04w)
  - [blog.csdn.net](https://blog.csdn.net/freedomhero)
  - [Introduction](https://www.bilibili.com/video/BV18L4y1u7Qd?spm_id_from=333.999.0.0)
  - [threshold signatures](https://mp.weixin.qq.com/s?__biz=MzkxMjUxOTQxMA==&mid=2247486712&idx=1&sn=dfbe33ed875c67931f8c0d5b53f93442&chksm=c10af565f67d7c73ec30c5375125e98273658d1955088b31145e8540a21ae2d918c748840347&mpshare=1&scene=1&srcid=0529RDYujtFO6VITSEffBp8U&sharer_shareinfo=d71ba5cc931bfa8a15a9722578e34a9c&sharer_shareinfo_first=d71ba5cc931bfa8a15a9722578e34a9c&exportkey=n_ChQIAhIQeX2%2FCeNlXB%2FStY47Xsst0BLxAQIE97dBBAEAAAAAAD2CJP3resMAAAAOpnltbLcz9gKNyK89dVj0Fzme6rVByrAdm9kV9MJBRFrUe28goKReuPFzDYPO9HXHyCREYFEaCNAlGJvkrGNe86ZWcpkHZkC8YkusQ4VCx6ovAut6eDXP0ePSipnTvJx7jd8wL681m%2B7WuJimBnTPsSp9%2BZ4tkMs9yU%2FMHg%2BQA4n%2Bmhbuy%2FgJ%2FG0eT%2BsEfeYQhBsN9lGSnVBzKPwsvscuV97wwG2KcMdePVqIHL1TafvxG045xWZmUsRhQ2kdNuUL6zWrJFSLQvcklcubBOC0isGcdCMVF863YeA%3D&acctmode=0&pass_ticket=bk4MPF1ZsHMGuS1zqWg7mTb57Gfxo%2FHZoBfytX0cBddqBwY14xhM1PtcXf4qhbWm&wx_header=0#rd)
  
- [ Stratum V2 are suggested for generating blocks of TBC](https://stratumprotocol.org)
<!--
  - [ braiins-pool ](https://zh.braiins.com/pool?utm_source=BraiinsAcademy)
-->

## Comments

## Documentation
Faucet
- https://airdrop.tbcdev.org/status
Turing Wallet
- https://docs.turingwallet.xyz/en/
TuringBitChain
- https://docs.turingbitchain.io/en/
UTXO
- https://docs.utxocompiler.com
BitBus
- https://bitbus.net/user-guide
