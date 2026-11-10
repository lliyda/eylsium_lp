# HYPE / KNTQ 流动性查询

在线页面：<https://lliyda.github.io/eylsium_lp/>

GitHub Pages 已从 `main` 分支根目录发布。当前线上版本只查询 1% 池。本分支同时查询 0.3%、0.8% 和 1% 三档，合并进 `main` 之后才会出现在上面的地址。

这是一个纯静态、只读的单页工具。在浏览器里输入钱包地址，即可查看该地址在 Elysium（Kinetiq L2）Uniswap v4 **HYPE/KNTQ** 三个手续费档里的 LP 仓位，包括本金和未领取手续费。

页面不会连接钱包，不会请求签名，也不会发送交易。所有链上读取都是 `eth_call`。

## 怎么查询

1. 打开页面。合并前请在本地预览本分支；合并后直接打开 <https://lliyda.github.io/eylsium_lp/>。
2. 钱包地址栏里已经填好示例地址 `0xe9b9ab375c0b3bc83af239bb30908f5d710d12a8`，也可以换成任意地址。
3. 点击「查询」。页面一次查出 0.3%、0.8%、1% 三档，按池分组，并给出三池合计。

每个属于这三档的仓位 NFT 会显示：

- tokenId 和手续费档
- tick 区间，以及用**该池自己的 tick** 判断是否在范围内
- 仓位本金（HYPE 与 KNTQ 的人类可读数量）
- 未领取手续费（HYPE 与 KNTQ），以及美元估算
- 该池的本金小计、手续费小计（代币数量和美元）
- 三个池加总后的本金与手续费（代币数量和美元），每个仓位只计一次

页面顶部会分别显示三个池的隐含价格（1 HYPE ≈ N KNTQ）和 tick，以及共用的区块高度、区块时间和查询时间。时间使用 Asia/Shanghai（UTC+8），并标注为北京时间。

某一档没有仓位时，该池会单独说明。三档都没有时，合计区也会说明。某个池的价格读失败时，只跳过该池的本金和在范围判断，不用别的池的 tick 顶上。拿不到美元价格时，代币数量仍然显示，并注明美元估值不可用。

本地预览请在仓库根目录启动静态服务器，例如 `python3 -m http.server`，然后打开 `http://127.0.0.1:8000/`。

## 链与合约

三档池的 PoolKey 都用 PositionManager.`poolKeys` 核对过：`currency0` 是原生 HYPE，`currency1` 是 KNTQ，hooks 是零地址。fee 和 tickSpacing 以链上返回为准，不是按费率猜的。

| 项目 | 值 |
| --- | --- |
| 网络 | Elysium，chainId `99901`，gas 代币为 HYPE |
| 公共 RPC | `https://rpc.elysium.kinetiq.xyz` |
| 浏览器 | <https://elysium.kinetiq.xyz/explorer/> |
| PositionManager | `0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518` |
| StateView | `0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE` |
| PoolManager | `0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1` |
| HYPE | 原生代币。PoolKey 的 `currency0` 为 `0x0000000000000000000000000000000000000000` |
| KNTQ | `0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0`，18 位小数，Kinetiq Governance Token |
| hooks | 零地址 |
| 0.3% | fee `3000`，tickSpacing `60`，PoolId `0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a` |
| 0.8% | fee `8000`，tickSpacing `120`，PoolId `0xd210029ab684d92240876c54ec6d5a8b2b1998b71c2c907c1e55de02e13e3472` |
| 1% | fee `10000`，tickSpacing `200`，PoolId `0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac` |

官方文档里的免钥公共主网 RPC 只有上面这一条，所以页面没有另加备用节点。

## 数字是怎么来的

- 用 PositionManager 的 `Transfer` 日志找出钱包当前持有的 NFT，并用 `balanceOf` 核对。这个合约没有 `tokenOfOwnerByIndex`。如果日志和余额对不上，页面会改用 Multicall3 逐个 `ownerOf`。NFT 只查一次，再按 PoolId 分到三档。
- 每个池单独读取自己的 `getSlot0`。本金和是否在范围内只用这个池的 sqrt price 和 tick。
- 本金按 Uniswap v3/v4 的 amount0/amount1 公式计算。`currency0` 是 HYPE，`currency1` 是 KNTQ。
- 未领取手续费使用该池的 StateView `getFeeGrowthInside` 减去仓位里记录的 `feeGrowthInsideLast`，再乘以 liquidity，除以 2^128。减法按 uint256 回绕。
- 美元价格优先读 GeckoTerminal 上的 HYPE/KNTQ 池（先 1%，失败再试另外两档）。三池共用这一套代币美元价。如果接口都失败，则用 CoinGecko 的 HYPE 价格，再按 1% 池的兑换价折算 KNTQ。

在区块 `3752301`（约 2026-11-10 12:37 北京时间）读取示例地址，1% 池有 tokenId 810、814、5307，都在范围内，未领取手续费为 `0.565774` HYPE + `102.892378` KNTQ，与当时约 `0.5658` HYPE + `102.90` KNTQ 的参考值一致。同一区块里 0.3% 池的 tick 是 52190，0.8% 是 52237，1% 是 52240，三池价格并不相同。之后示例地址把这三笔 1% 仓位移走了；在区块 `4207900` 它只持有 0.3% 池的 tokenId 9479。

## 测试

```bash
node --test test/positions.test.mjs
```

包含固定区块上的 1% 回归、0.3% 与 0.8% 的真实仓位、不同 tick 的本金计算、空钱包、价格接口失败，以及手续费合计。

## GitHub Pages

在线地址：<https://lliyda.github.io/eylsium_lp/>

站点从 `main` 分支根目录发布（Deploy from a branch，文件夹 `/ (root)`），入口是 `index.html`。`.nojekyll` 用来跳过 Jekyll。静态资源带 `?v=3`，避免 Pages 缓存把新的 HTML 和旧的脚本混在一起。

本分支还没有合并，所以上面的线上页面在合并前仍是只查 1% 池的版本。

查询库使用随仓库提供的 [ethers.js](https://github.com/ethers-io/ethers.js) v6.13.5（MIT，见 `vendor/LICENSE-ethers.txt`）。

---

# HYPE / KNTQ liquidity viewer

Live page: <https://lliyda.github.io/eylsium_lp/>

GitHub Pages is already serving the `main` branch root. The live site still queries only the 1% pool. This branch queries the 0.3%, 0.8%, and 1% pools together, and that behavior reaches the URL above only after this branch is merged.

This is a static, read-only single page. Paste a wallet address to see that wallet's Uniswap v4 **HYPE/KNTQ** LP positions on Elysium (Kinetiq L2) across those three fee tiers, including principal and unclaimed trading fees.

There is no wallet connection, no signature request, and no transaction. Every chain read is an `eth_call`.

## How to query

1. Before merge, preview this branch locally. After merge, open <https://lliyda.github.io/eylsium_lp/>.
2. The address field is prefilled with `0xe9b9ab375c0b3bc83af239bb30908f5d710d12a8`. Any other address works too.
3. Click **查询**. The page loads all three fee tiers, groups positions by pool, and shows a cross-pool total.

For each matching position NFT the page shows the tokenId and fee tier, the tick range, whether it is in range using **that pool's own tick**, principal in HYPE and KNTQ, unclaimed fees in both tokens plus a USD estimate, a per-pool subtotal, and a three-pool total. Each position is counted once.

The header shows each pool's implied price (1 HYPE ≈ N KNTQ) and tick, plus the shared block number, block time, and query time in Asia/Shanghai (UTC+8), labeled 北京时间.

An empty fee tier says so on its own. If all three are empty, the total says so too. A failed pool price skips that pool's principal and in-range flag instead of borrowing another pool's tick. If USD prices cannot be loaded, token amounts still appear and the page says the USD estimate is unavailable.

To preview locally, serve the repository root (`python3 -m http.server`) and open the local URL.

## Chain and contracts

Each PoolKey was read from PositionManager `poolKeys`. `currency0` is native HYPE, `currency1` is KNTQ, and hooks are the zero address. Fee and tick spacing are the on-chain values.

| Item | Value |
| --- | --- |
| Network | Elysium, chainId `99901`, gas token HYPE |
| Public RPC | `https://rpc.elysium.kinetiq.xyz` |
| Explorer | <https://elysium.kinetiq.xyz/explorer/> |
| PositionManager | `0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518` |
| StateView | `0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE` |
| PoolManager | `0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1` |
| HYPE | Native gas token. PoolKey `currency0` is `0x0000000000000000000000000000000000000000` |
| KNTQ | `0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0`, 18 decimals, Kinetiq Governance Token |
| Hooks | zero address |
| 0.3% | fee `3000`, tickSpacing `60`, PoolId `0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a` |
| 0.8% | fee `8000`, tickSpacing `120`, PoolId `0xd210029ab684d92240876c54ec6d5a8b2b1998b71c2c907c1e55de02e13e3472` |
| 1% | fee `10000`, tickSpacing `200`, PoolId `0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac` |

The official keyless public mainnet RPC listed in the docs is the one above, so the page does not add another endpoint.

## How the numbers are computed

- Current PositionManager NFTs are discovered once from `Transfer` logs and checked against `balanceOf`. This contract does not implement `tokenOfOwnerByIndex`. If the logs and the balance disagree, the page scans `ownerOf` through Multicall3. Positions are then matched to the three pool ids.
- Each pool has its own `getSlot0`. Principal and the in-range flag use only that pool's sqrt price and tick.
- Principal uses Uniswap v3/v4 amount0/amount1 math. `currency0` is HYPE and `currency1` is KNTQ.
- Unclaimed fees are `(feeGrowthInside - feeGrowthInsideLast) * liquidity / 2^128` from that pool's StateView. Subtraction wraps as a uint256.
- USD prices prefer GeckoTerminal (the 1% pool first, then the other two). The same token prices are used for every pool. If those requests fail, the page uses CoinGecko's HYPE price and converts KNTQ with the 1% pool price.

At block `3752301` (about 12:37 Beijing time on 2026-11-10), the example wallet's 1% positions 810, 814, and 5307 were all in range, and this formula returned `0.565774` HYPE + `102.892378` KNTQ. That matches the reference of about `0.5658` HYPE + `102.90` KNTQ. At that block the ticks differed: 52190 (0.3%), 52237 (0.8%), and 52240 (1%). The example wallet later moved those 1% positions; at block `4207900` it only holds tokenId 9479 in the 0.3% pool.

## Tests

```bash
node --test test/positions.test.mjs
```

The file covers the fixed-block 1% regression, real 0.3% and 0.8% positions, principal math when ticks differ, an empty wallet, a failed price API, and fee totals.

## GitHub Pages

Live URL: <https://lliyda.github.io/eylsium_lp/>

The site is deployed from the root of `main` (Deploy from a branch, folder `/ (root)`). `.nojekyll` skips Jekyll. Static assets use `?v=3` so Pages does not mix new HTML with a cached older script.

This branch is not merged, so the live page keeps the 1% only query until then.

The query library is [ethers.js](https://github.com/ethers-io/ethers.js) v6.13.5, vendored under `vendor/` (MIT, see `vendor/LICENSE-ethers.txt`).
