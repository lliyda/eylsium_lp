# HYPE / KNTQ 流动性查询

启用 GitHub Pages 之后的地址：<https://lliyda.github.io/eylsium_lp/>（目前还是 404，打开步骤见文末）

这是一个纯静态、只读的单页工具。在浏览器里输入钱包地址，即可查看该地址在 Elysium（Kinetiq L2）Uniswap v4 **HYPE/KNTQ** 池中的 LP 仓位，包括本金和未领取手续费。

页面不会连接钱包，不会请求签名，也不会发送交易。所有链上读取都是 `eth_call`。

## 怎么查询

1. 打开 <https://lliyda.github.io/eylsium_lp/>（需要先按文末步骤打开 Pages）。
2. 钱包地址栏里已经填好示例地址 `0xe9b9ab375c0b3bc83af239bb30908f5d710d12a8`，也可以换成任意地址。
3. 点击「查询」。

每个属于 HYPE/KNTQ 池的仓位 NFT 会显示：

- tokenId
- tick 区间，以及当前价格是否在区间内
- 仓位本金（HYPE 与 KNTQ 的人类可读数量）
- 未领取手续费（HYPE 与 KNTQ），以及美元估算
- 本金合计与手续费合计

页面顶部还会显示当前 tick、隐含价格（1 HYPE ≈ N KNTQ）、区块高度，以及区块时间和查询时间。时间使用 Asia/Shanghai（UTC+8），并标注为北京时间。

如果该地址没有 HYPE/KNTQ 仓位，页面会明确说明。节点或价格接口失败时，会显示错误；拿不到美元价格时，代币数量仍然显示，并注明美元估值不可用。

本地预览请在仓库根目录启动静态服务器，例如 `python3 -m http.server`，然后打开 `http://127.0.0.1:8000/`。

## 链与合约

这些地址已用真实仓位（tokenId 810、814、5307）在链上核对。PoolKey 与下面列出的值一致，因此页面按这些参数计算。

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
| 手续费 | `10000`（1%） |
| tickSpacing | `200` |
| hooks | 零地址 |
| PoolId | `0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac` |

官方文档里的免钥公共主网 RPC 只有上面这一条，所以页面没有另加备用节点。

## 数字是怎么来的

- 用 PositionManager 的 `Transfer` 日志找出钱包当前持有的 NFT，并用 `balanceOf` 核对。这个合约没有 `tokenOfOwnerByIndex`。如果日志和余额对不上，页面会改用 Multicall3 逐个 `ownerOf`。
- 只保留 PoolId 等于 HYPE/KNTQ 池的仓位。
- 本金使用当前 sqrt price、liquidity 和 tick 区间，按 Uniswap v3/v4 的 amount0/amount1 公式计算。`currency0` 是 HYPE，`currency1` 是 KNTQ。
- 未领取手续费使用 StateView 的 `getFeeGrowthInside` 减去仓位里记录的 `feeGrowthInsideLast`，再乘以 liquidity，除以 2^128。减法按 uint256 回绕。
- 美元价格优先读取 [GeckoTerminal 上的这个池子](https://www.geckoterminal.com/elysium/pools/0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac)。如果该接口失败，则用 CoinGecko 的 HYPE 价格，再按池内价格折算 KNTQ。

在区块 `3752301`（约 2026-11-10 12:37 北京时间）用上述公式读取示例地址，三个仓位都在范围内，未领取手续费为 `0.565774` HYPE + `102.892378` KNTQ，与当时约 `0.5658` HYPE + `102.90` KNTQ 的参考值一致。之后的区块里，手续费会继续变化。

## GitHub Pages

预期地址：<https://lliyda.github.io/eylsium_lp/>

静态文件已经在 `main` 分支的仓库根目录，入口是 `index.html`。仓库里有 `.nojekyll`，避免 Jekyll 处理这些文件。

Pages 目前没有打开，所以上面的地址仍是 404。自动打开也被拒绝了两次，都是 `403 Resource not accessible by integration`：

- 直接调用 GitHub API 创建 Pages 站点。
- GitHub Actions 里的 `actions/configure-pages`（`enablement: true`）创建站点。Actions 自带的 `GITHUB_TOKEN` 同样没有管理员权限，不能代为打开 Pages。

请仓库所有者手动打开一次：

1. 打开 <https://github.com/lliyda/eylsium_lp/settings/pages>。
2. 进入 **Settings → Pages**。
3. 在 **Build and deployment** 里选择 **Deploy from a branch**。
4. Branch 选择 **main**，文件夹选择 **/ (root)**。
5. 点击 **Save**。
6. 等一两分钟，再打开 <https://lliyda.github.io/eylsium_lp/>。

查询库使用随仓库提供的 [ethers.js](https://github.com/ethers-io/ethers.js) v6.13.5（MIT，见 `vendor/LICENSE-ethers.txt`）。

---

# HYPE / KNTQ liquidity viewer

URL after GitHub Pages is enabled: <https://lliyda.github.io/eylsium_lp/> (it is still a 404; the click path is at the end)

This is a static, read-only single page. Paste a wallet address to see that wallet's Uniswap v4 **HYPE/KNTQ** LP positions on Elysium (Kinetiq L2), including principal and unclaimed trading fees.

There is no wallet connection, no signature request, and no transaction. Every chain read is an `eth_call`.

## How to query

1. Open <https://lliyda.github.io/eylsium_lp/> (enable Pages first, using the steps at the end).
2. The address field is prefilled with `0xe9b9ab375c0b3bc83af239bb30908f5d710d12a8`. Any other address works too.
3. Click **查询**.

For each position NFT in the HYPE/KNTQ pool, the page shows the tokenId, tick range and whether it is in range, principal amounts of HYPE and KNTQ, unclaimed fees in both tokens plus a USD estimate, and totals for principal and fees.

It also shows the current tick, the implied price (1 HYPE ≈ N KNTQ), the block number, and both the block time and the query time in Asia/Shanghai (UTC+8), labeled 北京时间.

If the wallet has no matching position, the page says so. RPC failures are shown as errors. If USD prices cannot be loaded, token amounts still appear and the page says the USD estimate is unavailable.

To preview locally, serve the repository root (`python3 -m http.server`) and open the local URL.

## Chain and contracts

The PoolKey below was read from existing positions (tokenIds 810, 814, and 5307). Currency order, fee, and tick spacing match these values, so the page uses them.

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
| Fee | `10000` (1%) |
| tickSpacing | `200` |
| Hooks | zero address |
| PoolId | `0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac` |

The official keyless public mainnet RPC listed in the docs is the one above, so the page does not add another endpoint.

## How the numbers are computed

- Current PositionManager NFTs are discovered from `Transfer` logs and checked against `balanceOf`. This contract does not implement `tokenOfOwnerByIndex`. If the logs and the balance disagree, the page scans `ownerOf` through Multicall3.
- Only positions whose pool id is the HYPE/KNTQ pool are shown.
- Principal uses the current sqrt price, liquidity, and tick range (Uniswap v3/v4 amount0/amount1). `currency0` is HYPE and `currency1` is KNTQ.
- Unclaimed fees are `(feeGrowthInside - feeGrowthInsideLast) * liquidity / 2^128`, using StateView `getFeeGrowthInside` and the growth checkpoint stored on the position. Subtraction wraps as a uint256.
- USD prices come from the [GeckoTerminal pool](https://www.geckoterminal.com/elysium/pools/0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac). If that request fails, the page uses CoinGecko's HYPE price and converts KNTQ with the pool price.

At block `3752301` (about 12:37 Beijing time on 2026-11-10), the example wallet's three positions were all in range, and this formula returned `0.565774` HYPE + `102.892378` KNTQ of unclaimed fees. That matches the reference of about `0.5658` HYPE + `102.90` KNTQ. Later blocks will show larger or different fees.

## GitHub Pages

Expected URL: <https://lliyda.github.io/eylsium_lp/>

The static files are already at the root of `main` (`index.html`). `.nojekyll` keeps Jekyll from processing them.

Pages is not enabled, so that URL is still a 404. Two attempts to enable it were refused with `403 Resource not accessible by integration`:

- Creating the site directly through the GitHub API.
- Creating it from GitHub Actions with `actions/configure-pages` and `enablement: true`. The workflow `GITHUB_TOKEN` does not have admin permission either, so it cannot turn Pages on.

The repository owner needs to do this once:

1. Open <https://github.com/lliyda/eylsium_lp/settings/pages>.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Choose branch **main** and folder **/ (root)**.
5. Click **Save**.
6. Wait a minute, then open <https://lliyda.github.io/eylsium_lp/>.

The query library is [ethers.js](https://github.com/ethers-io/ethers.js) v6.13.5, vendored under `vendor/` (MIT, see `vendor/LICENSE-ethers.txt`).
