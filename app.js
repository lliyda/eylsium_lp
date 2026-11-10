/* Read-only HYPE/KNTQ Uniswap v4 position viewer. No wallet, no transactions. */
(function () {
  "use strict";

  var math = globalThis.PositionMath;
  var ethers = globalThis.ethers;

  var RPC_URL = "https://rpc.elysium.kinetiq.xyz";
  var CHAIN_ID = 99901;
  var POSITION_MANAGER = "0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518";
  var STATE_VIEW = "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE";
  var POOL_MANAGER = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1";
  var MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
  var KNTQ = "0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0";
  var POOL_ID = "0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac";
  var FEE = 10000;
  var TICK_SPACING = 200;
  var HYPE_DECIMALS = 18;
  var GECKO_POOL =
    "https://api.geckoterminal.com/api/v2/networks/elysium/pools/" + POOL_ID;

  var pmIface = new ethers.Interface([
    "function balanceOf(address owner) view returns (uint256)",
    "function nextTokenId() view returns (uint256)",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)",
  ]);
  var svIface = new ethers.Interface([
    "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
    "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
    "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
  ]);
  var erc20Iface = new ethers.Interface([
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
  ]);
  var multicallIface = new ethers.Interface([
    "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
  ]);

  function poolIdOf(key) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint24", "int24", "address"],
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
      )
    );
  }

  function canonicalPoolId() {
    return poolIdOf({
      currency0: ethers.ZeroAddress,
      currency1: KNTQ,
      fee: FEE,
      tickSpacing: TICK_SPACING,
      hooks: ethers.ZeroAddress,
    });
  }

  function makeProvider() {
    var network = ethers.Network.from(CHAIN_ID);
    return new ethers.JsonRpcProvider(RPC_URL, network, { staticNetwork: network });
  }

  function shortError(err) {
    var msg = (err && (err.shortMessage || err.message)) || String(err);
    return msg.replace(/\s+/g, " ").slice(0, 280);
  }

  async function aggregate(provider, calls, blockTag) {
    try {
      var data = multicallIface.encodeFunctionData("aggregate3", [calls]);
      var raw = await provider.call({ to: MULTICALL3, data: data, blockTag: blockTag });
      return multicallIface.decodeFunctionResult("aggregate3", raw)[0];
    } catch (err) {
      var out = [];
      for (var i = 0; i < calls.length; i++) {
        try {
          var returnData = await provider.call({
            to: calls[i].target,
            data: calls[i].callData,
            blockTag: blockTag,
          });
          out.push({ success: true, returnData: returnData });
        } catch (inner) {
          if (!calls[i].allowFailure) throw inner;
          out.push({ success: false, returnData: "0x" });
        }
      }
      return out;
    }
  }

  function must(result, label) {
    if (!result || !result.success || !result.returnData || result.returnData === "0x") {
      throw new Error(label + "失败");
    }
    return result;
  }

  async function getLogsRange(provider, filter, fromBlock, toBlock) {
    try {
      return await provider.getLogs({
        address: filter.address,
        topics: filter.topics,
        fromBlock: fromBlock,
        toBlock: toBlock,
      });
    } catch (err) {
      if (toBlock - fromBlock <= 50000) throw err;
      var mid = Math.floor((fromBlock + toBlock) / 2);
      var left = await getLogsRange(provider, filter, fromBlock, mid);
      var right = await getLogsRange(provider, filter, mid + 1, toBlock);
      return left.concat(right);
    }
  }

  function ownedFromLogs(logsIn, logsOut, wallet) {
    var seen = new Map();
    var logs = logsIn.concat(logsOut);
    for (var i = 0; i < logs.length; i++) {
      var log = logs[i];
      seen.set(log.blockNumber + ":" + log.transactionIndex + ":" + log.index, log);
    }
    var events = Array.from(seen.values());
    events.sort(function (a, b) {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
      if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
      return a.index - b.index;
    });
    var owned = new Set();
    var target = wallet.toLowerCase();
    for (var j = 0; j < events.length; j++) {
      var event = events[j];
      var from = ethers.getAddress(ethers.dataSlice(event.topics[1], 12)).toLowerCase();
      var to = ethers.getAddress(ethers.dataSlice(event.topics[2], 12)).toLowerCase();
      var id = BigInt(event.topics[3]).toString();
      if (from === target && to !== target) owned.delete(id);
      else if (to === target && from !== target) owned.add(id);
    }
    return Array.from(owned)
      .map(function (id) { return BigInt(id); })
      .sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
  }

  async function scanOwned(provider, wallet, nextTokenId, balance, blockTag, onStatus) {
    var found = [];
    var batchSize = 150n;
    var end = nextTokenId;
    for (var cursor = 1n; cursor < end; cursor += batchSize) {
      if (found.length >= Number(balance)) break;
      var upper = cursor + batchSize < end ? cursor + batchSize : end;
      var calls = [];
      var ids = [];
      for (var id = cursor; id < upper; id++) {
        ids.push(id);
        calls.push({
          target: POSITION_MANAGER,
          allowFailure: true,
          callData: pmIface.encodeFunctionData("ownerOf", [id]),
        });
      }
      onStatus("日志不完整，正在逐个核对 NFT " + cursor.toString() + " / " + end.toString() + "…");
      var results = await aggregate(provider, calls, blockTag);
      for (var i = 0; i < results.length; i++) {
        if (!results[i].success || results[i].returnData === "0x") continue;
        try {
          var owner = pmIface.decodeFunctionResult("ownerOf", results[i].returnData)[0];
          if (owner.toLowerCase() === wallet.toLowerCase()) found.push(ids[i]);
        } catch (err) {
          /* ownerOf revert or unexpected return data */
        }
      }
    }
    return found;
  }

  async function findTokenIds(provider, wallet, balance, nextTokenId, blockTag, onStatus) {
    if (balance === 0n) return [];
    onStatus("正在查找该地址的仓位 NFT…");
    var transferTopic = ethers.id("Transfer(address,address,uint256)");
    var walletTopic = ethers.zeroPadValue(wallet, 32).toLowerCase();
    try {
      var incoming = await getLogsRange(
        provider,
        { address: POSITION_MANAGER, topics: [transferTopic, null, walletTopic] },
        0,
        blockTag
      );
      var outgoing = await getLogsRange(
        provider,
        { address: POSITION_MANAGER, topics: [transferTopic, walletTopic] },
        0,
        blockTag
      );
      var ids = ownedFromLogs(incoming, outgoing, wallet);
      if (BigInt(ids.length) === balance) return ids;
    } catch (err) {
      onStatus("事件日志不可用，改为逐个核对 NFT…");
    }
    return scanOwned(provider, wallet, nextTokenId, balance, blockTag, onStatus);
  }

  async function readPositions(provider, tokenIds, blockTag, onStatus) {
    onStatus("正在读取流动性与未领取手续费…");
    var positions = [];
    var batch = 40;
    for (var start = 0; start < tokenIds.length; start += batch) {
      var slice = tokenIds.slice(start, start + batch);
      var infoCalls = slice.map(function (id) {
        return {
          target: POSITION_MANAGER,
          allowFailure: true,
          callData: pmIface.encodeFunctionData("getPoolAndPositionInfo", [id]),
        };
      });
      var infoResults = await aggregate(provider, infoCalls, blockTag);
      var matched = [];
      for (var i = 0; i < slice.length; i++) {
        if (!infoResults[i].success || infoResults[i].returnData === "0x") continue;
        var decoded = pmIface.decodeFunctionResult("getPoolAndPositionInfo", infoResults[i].returnData);
        var key = decoded[0];
        var packed = decoded[1];
        if (poolIdOf(key).toLowerCase() !== POOL_ID.toLowerCase()) continue;
        var ticks = math.decodePositionInfo(packed);
        matched.push({
          tokenId: slice[i],
          fee: Number(key.fee),
          tickSpacing: Number(key.tickSpacing),
          tickLower: ticks.tickLower,
          tickUpper: ticks.tickUpper,
        });
      }
      if (!matched.length) continue;
      var stateCalls = [];
      matched.forEach(function (pos) {
        var salt = ethers.zeroPadValue(ethers.toBeHex(pos.tokenId), 32);
        stateCalls.push({
          target: STATE_VIEW,
          allowFailure: true,
          callData: svIface.encodeFunctionData("getPositionInfo", [
            POOL_ID,
            POSITION_MANAGER,
            pos.tickLower,
            pos.tickUpper,
            salt,
          ]),
        });
        stateCalls.push({
          target: STATE_VIEW,
          allowFailure: true,
          callData: svIface.encodeFunctionData("getFeeGrowthInside", [
            POOL_ID,
            pos.tickLower,
            pos.tickUpper,
          ]),
        });
      });
      var stateResults = await aggregate(provider, stateCalls, blockTag);
      for (var n = 0; n < matched.length; n++) {
        var infoResult = stateResults[n * 2];
        var growthResult = stateResults[n * 2 + 1];
        if (!infoResult.success || !growthResult.success || infoResult.returnData === "0x" || growthResult.returnData === "0x") {
          throw new Error("读取仓位 #" + matched[n].tokenId.toString() + " 失败");
        }
        var posInfo = svIface.decodeFunctionResult("getPositionInfo", infoResult.returnData);
        var growth = svIface.decodeFunctionResult("getFeeGrowthInside", growthResult.returnData);
        positions.push({
          tokenId: matched[n].tokenId,
          fee: matched[n].fee,
          tickSpacing: matched[n].tickSpacing,
          tickLower: matched[n].tickLower,
          tickUpper: matched[n].tickUpper,
          liquidity: posInfo[0],
          feeGrowth0Last: posInfo[1],
          feeGrowth1Last: posInfo[2],
          feeGrowth0: growth[0],
          feeGrowth1: growth[1],
        });
      }
    }
    positions.sort(function (a, b) {
      return a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0;
    });
    return positions;
  }

  async function fetchGeckoPrices() {
    var response = await fetch(GECKO_POOL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("GeckoTerminal HTTP " + response.status);
    var body = await response.json();
    var attrs = body && body.data && body.data.attributes;
    var rel = body && body.data && body.data.relationships;
    if (!attrs || !rel) throw new Error("GeckoTerminal 响应不完整");
    var baseId = String(rel.base_token.data.id || "").toLowerCase();
    var quoteId = String(rel.quote_token.data.id || "").toLowerCase();
    var baseUsd = attrs.base_token_price_usd;
    var quoteUsd = attrs.quote_token_price_usd;
    var hype = null;
    var kntq = null;
    if (baseId.indexOf(ethers.ZeroAddress) !== -1) hype = baseUsd;
    if (quoteId.indexOf(ethers.ZeroAddress) !== -1) hype = quoteUsd;
    if (baseId.indexOf(KNTQ.toLowerCase()) !== -1) kntq = baseUsd;
    if (quoteId.indexOf(KNTQ.toLowerCase()) !== -1) kntq = quoteUsd;
    if (!hype || !kntq) throw new Error("GeckoTerminal 缺少代币价格");
    return { hype: String(hype), kntq: String(kntq), source: "GeckoTerminal" };
  }

  async function fetchFallbackPrices(humanPriceStr) {
    var response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=hyperliquid&vs_currencies=usd",
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) throw new Error("CoinGecko HTTP " + response.status);
    var body = await response.json();
    var hype = body && body.hyperliquid && body.hyperliquid.usd;
    var price = Number(humanPriceStr);
    if (typeof hype !== "number" || !isFinite(price) || price <= 0) {
      throw new Error("无法折算 KNTQ 价格");
    }
    return {
      hype: String(hype),
      kntq: (hype / price).toFixed(12).replace(/0+$/, "").replace(/\.$/, ""),
      source: "CoinGecko 的 HYPE 价格，KNTQ 按池内价格折算",
    };
  }

  async function loadPrices(humanPriceStr) {
    try {
      return await fetchGeckoPrices();
    } catch (err) {
      try {
        return await fetchFallbackPrices(humanPriceStr);
      } catch (fallbackErr) {
        return null;
      }
    }
  }

  async function queryPositions(address, options) {
    var opts = options || {};
    var onStatus = opts.onStatus || function () {};
    if (!ethers.isAddress(address)) {
      throw new Error("请输入有效的钱包地址。");
    }
    var wallet = ethers.getAddress(address);
    var computedPool = canonicalPoolId();
    if (computedPool.toLowerCase() !== POOL_ID.toLowerCase()) {
      throw new Error("池子参数与链上 PoolId 不一致。");
    }
    var queriedAt = new Date();
    var provider = makeProvider();
    try {
      onStatus("正在读取区块…");
      var block = await provider.getBlock(opts.blockTag == null ? "latest" : opts.blockTag);
      var blockTag = block.number;
      var headCalls = [
        {
          target: POSITION_MANAGER,
          allowFailure: true,
          callData: pmIface.encodeFunctionData("balanceOf", [wallet]),
        },
        {
          target: POSITION_MANAGER,
          allowFailure: true,
          callData: pmIface.encodeFunctionData("nextTokenId", []),
        },
        {
          target: STATE_VIEW,
          allowFailure: true,
          callData: svIface.encodeFunctionData("getSlot0", [POOL_ID]),
        },
        {
          target: KNTQ,
          allowFailure: true,
          callData: erc20Iface.encodeFunctionData("decimals", []),
        },
        {
          target: KNTQ,
          allowFailure: true,
          callData: erc20Iface.encodeFunctionData("symbol", []),
        },
      ];
      var head = await aggregate(provider, headCalls, blockTag);
      var balance = pmIface.decodeFunctionResult("balanceOf", must(head[0], "读取 NFT 余额").returnData)[0];
      var nextTokenId = pmIface.decodeFunctionResult("nextTokenId", must(head[1], "读取 NFT 序号").returnData)[0];
      var slot0 = svIface.decodeFunctionResult("getSlot0", must(head[2], "读取池子价格").returnData);
      var kntqDecimals = HYPE_DECIMALS;
      var kntqSymbol = "KNTQ";
      if (head[3].success && head[3].returnData !== "0x") {
        kntqDecimals = Number(erc20Iface.decodeFunctionResult("decimals", head[3].returnData)[0]);
      }
      if (head[4].success && head[4].returnData !== "0x") {
        kntqSymbol = erc20Iface.decodeFunctionResult("symbol", head[4].returnData)[0];
      }
      var sqrtPriceX96 = slot0[0];
      var tick = Number(slot0[1]);
      var lpFee = Number(slot0[3]);
      var priceX18 = math.priceX18FromSqrt(sqrtPriceX96);
      var humanPriceStr = math.formatScaled(priceX18, 18, 18, false);
      var tokenIds = await findTokenIds(provider, wallet, balance, nextTokenId, blockTag, onStatus);
      var rawPositions = await readPositions(provider, tokenIds, blockTag, onStatus);
      onStatus("正在获取美元价格…");
      var prices = await loadPrices(humanPriceStr);
      var positions = rawPositions.map(function (pos) {
        var amounts = math.getAmounts({
          sqrtPriceX96: sqrtPriceX96,
          tick: tick,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          liquidity: pos.liquidity,
        });
        var fees = math.getUnclaimedFees(
          pos.feeGrowth0,
          pos.feeGrowth1,
          pos.feeGrowth0Last,
          pos.feeGrowth1Last,
          pos.liquidity
        );
        return {
          tokenId: pos.tokenId,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          inRange: tick >= pos.tickLower && tick < pos.tickUpper,
          liquidity: pos.liquidity,
          fee: pos.fee,
          tickSpacing: pos.tickSpacing,
          principal0: amounts.amount0,
          principal1: amounts.amount1,
          fee0: fees.fee0,
          fee1: fees.fee1,
        };
      });
      onStatus("");
      return {
        wallet: wallet,
        blockNumber: blockTag,
        blockTime: new Date(Number(block.timestamp) * 1000),
        queriedAt: queriedAt,
        tick: tick,
        sqrtPriceX96: sqrtPriceX96,
        priceX18: priceX18,
        lpFee: lpFee,
        kntqSymbol: kntqSymbol,
        kntqDecimals: kntqDecimals,
        nftCount: Number(balance),
        prices: prices,
        positions: positions,
      };
    } finally {
      try {
        provider.destroy();
      } catch (destroyErr) {
        /* The query result does not depend on shutting the provider down. */
      }
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatUnitPrice(value) {
    var n = Number(value);
    if (!isFinite(n)) return String(value);
    var digits = n >= 1 ? 2 : 6;
    return n.toLocaleString("zh-CN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function feeLabel(fee) {
    var pct = Number(fee) / 10000;
    var digits = pct >= 1 ? 0 : 2;
    return pct.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: 2 }) + "%";
  }

  function renderPool(result) {
    var pool = document.getElementById("pool");
    pool.hidden = false;
    pool.replaceChildren();
    var title = el("div", "section-title");
    title.append(el("h2", null, "池子状态"));
    title.append(el("span", "sub", "HYPE / " + result.kntqSymbol + " · " + feeLabel(result.lpFee)));
    pool.append(title);
    var grid = el("div", "stats");
    var items = [
      ["隐含价格", "1 HYPE ≈ " + math.formatToken(result.priceX18, 18) + " " + result.kntqSymbol],
      ["当前 Tick", String(result.tick)],
      ["区块高度", String(result.blockNumber)],
      ["区块时间", math.formatBeijing(result.blockTime)],
      ["查询时间", math.formatBeijing(result.queriedAt)],
      ["手续费档", feeLabel(result.lpFee) + " · 间距 " + String(TICK_SPACING)],
    ];
    items.forEach(function (item) {
      var card = el("div", "stat");
      card.append(el("div", "k", item[0]));
      var value = el("div", "v", item[1]);
      if (item[0] === "区块高度") value.dataset.field = "block";
      if (item[0] === "隐含价格") value.dataset.field = "price";
      if (item[0] === "查询时间") value.dataset.field = "time";
      if (item[0] === "当前 Tick") value.dataset.field = "tick";
      card.append(value);
      grid.append(card);
    });
    pool.append(grid);
  }

  function usdFor(amount, decimals, price) {
    if (!price) return null;
    return math.amountToUsdE8(amount, decimals, price);
  }

  function appendMoney(parent, title, lines, usd) {
    var box = el("div");
    box.append(el("h3", null, title));
    lines.forEach(function (line) {
      var row = el("div", "v", line.text);
      if (line.name) row.dataset[line.name] = line.raw;
      box.append(row);
    });
    if (usd) box.append(el("div", "sub", "约 $" + usd));
    parent.append(box);
  }

  function renderSummary(result) {
    var summary = document.getElementById("summary");
    var positions = document.getElementById("positions");
    summary.replaceChildren();
    positions.replaceChildren();
    if (!result.positions.length) {
      summary.hidden = true;
      var empty = el("div", "empty");
      empty.dataset.field = "empty";
      if (result.nftCount === 0) {
        empty.textContent = "这个地址没有任何 Uniswap v4 仓位 NFT。";
      } else {
        empty.textContent =
          "这个地址有 " +
          result.nftCount +
          " 个 Uniswap v4 仓位 NFT，但都不在 HYPE/" +
          result.kntqSymbol +
          " 池。";
      }
      positions.append(empty);
      return;
    }
    var totals = result.positions.reduce(
      function (acc, pos) {
        acc.principal0 += pos.principal0;
        acc.principal1 += pos.principal1;
        acc.fee0 += pos.fee0;
        acc.fee1 += pos.fee1;
        acc.inRange += pos.inRange ? 1 : 0;
        return acc;
      },
      { principal0: 0n, principal1: 0n, fee0: 0n, fee1: 0n, inRange: 0 }
    );
    var prices = result.prices;
    var feeUsd = null;
    if (prices) {
      var usd0 = usdFor(totals.fee0, HYPE_DECIMALS, prices.hype);
      var usd1 = usdFor(totals.fee1, result.kntqDecimals, prices.kntq);
      if (usd0 != null && usd1 != null) feeUsd = math.formatUsd(usd0 + usd1);
    }
    summary.hidden = false;
    var head = el("div", "section-title");
    head.append(el("h2", null, "合计"));
    head.append(
      el(
        "span",
        "sub",
        result.positions.length + " 个仓位 · " + totals.inRange + " 个在范围内"
      )
    );
    summary.append(head);
    var money = el("div", "money");
    appendMoney(money, "本金合计", [
      {
        name: "totalPrincipal0",
        raw: math.formatScaled(totals.principal0, HYPE_DECIMALS, 18, false),
        text: math.formatToken(totals.principal0, HYPE_DECIMALS) + " HYPE",
      },
      {
        name: "totalPrincipal1",
        raw: math.formatScaled(totals.principal1, result.kntqDecimals, 18, false),
        text: math.formatToken(totals.principal1, result.kntqDecimals) + " " + result.kntqSymbol,
      },
    ]);
    appendMoney(
      money,
      "手续费合计",
      [
        {
          name: "totalFee0",
          raw: math.formatScaled(totals.fee0, HYPE_DECIMALS, 18, false),
          text: math.formatToken(totals.fee0, HYPE_DECIMALS) + " HYPE",
        },
        {
          name: "totalFee1",
          raw: math.formatScaled(totals.fee1, result.kntqDecimals, 18, false),
          text: math.formatToken(totals.fee1, result.kntqDecimals) + " " + result.kntqSymbol,
        },
      ],
      feeUsd
    );
    summary.append(money);
    var note = el("p", "note");
    note.dataset.field = "price-note";
    if (!prices) {
      note.textContent = "暂时拿不到美元价格，上面只显示代币数量。美元估值不可用。";
    } else {
      note.textContent =
        "美元价格来自 " +
        prices.source +
        "，仅供参考。HYPE $" +
        formatUnitPrice(prices.hype) +
        " · " +
        result.kntqSymbol +
        " $" +
        formatUnitPrice(prices.kntq) +
        "。";
    }
    summary.append(note);

    var listHead = el("div", "section-title");
    listHead.append(el("h2", null, "仓位"));
    positions.append(listHead);
    result.positions.forEach(function (pos) {
      positions.append(renderPosition(pos, result));
    });
  }

  function renderPosition(pos, result) {
    var card = el("article", "pos");
    card.dataset.tokenId = pos.tokenId.toString();
    var head = el("div", "pos-head");
    head.append(el("div", "token-id", "仓位 NFT #" + pos.tokenId.toString()));
    head.append(el("span", pos.inRange ? "badge good" : "badge bad", pos.inRange ? "在范围内" : "超出范围"));
    card.append(head);

    var lowerPrice = math.formatToken(math.tickToPriceX18(pos.tickLower), 18);
    var upperPrice = math.formatToken(math.tickToPriceX18(pos.tickUpper), 18);
    var meta = el("div", "range-meta");
    meta.append(el("div", null, "Tick 区间 " + pos.tickLower + " → " + pos.tickUpper));
    meta.append(
      el(
        "div",
        null,
        "价格区间约 " + lowerPrice + " → " + upperPrice + " " + result.kntqSymbol + " / HYPE"
      )
    );
    card.append(meta);

    var width = pos.tickUpper - pos.tickLower;
    var ratio = width === 0 ? 0.5 : (result.tick - pos.tickLower) / width;
    var clamped = Math.min(1, Math.max(0, ratio));
    var track = el("div", "track");
    var mark = el("span", "tick-mark");
    mark.style.left = (clamped * 100).toFixed(2) + "%";
    track.append(mark);
    card.append(track);
    var above = result.tick >= pos.tickUpper;
    var sentence = pos.inRange
      ? "当前价格落在这个区间内，仓位同时持有 HYPE 和 " + result.kntqSymbol + "。"
      : above
        ? "当前价格高于区间，仓位目前全部是 " + result.kntqSymbol + "。"
        : "当前价格低于区间，仓位目前全部是 HYPE。";
    card.append(el("div", "sub", sentence));

    var prices = result.prices;
    var feeUsd = null;
    if (prices) {
      var usd0 = usdFor(pos.fee0, HYPE_DECIMALS, prices.hype);
      var usd1 = usdFor(pos.fee1, result.kntqDecimals, prices.kntq);
      if (usd0 != null && usd1 != null) feeUsd = math.formatUsd(usd0 + usd1);
    }
    var money = el("div", "money");
    appendMoney(money, "本金", [
      {
        name: "principal0",
        raw: math.formatScaled(pos.principal0, HYPE_DECIMALS, 18, false),
        text: math.formatToken(pos.principal0, HYPE_DECIMALS) + " HYPE",
      },
      {
        name: "principal1",
        raw: math.formatScaled(pos.principal1, result.kntqDecimals, 18, false),
        text: math.formatToken(pos.principal1, result.kntqDecimals) + " " + result.kntqSymbol,
      },
    ]);
    appendMoney(
      money,
      "未领取手续费",
      [
        {
          name: "fee0",
          raw: math.formatScaled(pos.fee0, HYPE_DECIMALS, 18, false),
          text: math.formatToken(pos.fee0, HYPE_DECIMALS) + " HYPE",
        },
        {
          name: "fee1",
          raw: math.formatScaled(pos.fee1, result.kntqDecimals, 18, false),
          text: math.formatToken(pos.fee1, result.kntqDecimals) + " " + result.kntqSymbol,
        },
      ],
      feeUsd
    );
    card.append(money);
    return card;
  }

  function fillContracts() {
    var box = document.getElementById("contracts");
    if (!box) return;
    var rows = [
      "链：Elysium，chainId " + CHAIN_ID + "，gas 代币 HYPE",
      "RPC：" + RPC_URL,
      "PositionManager：" + POSITION_MANAGER,
      "StateView：" + STATE_VIEW,
      "PoolManager：" + POOL_MANAGER,
      "HYPE：原生代币，PoolKey currency0 = " + ethers.ZeroAddress,
      "KNTQ：" + ethers.getAddress(KNTQ) + "，18 位小数",
      "手续费 10000（1%），tickSpacing 200，hooks = " + ethers.ZeroAddress,
      "PoolId：" + POOL_ID,
      "未领取手续费 = (feeGrowthInside − feeGrowthInsideLast) × liquidity / 2^128。数值在浏览器内计算。",
    ];
    rows.forEach(function (row) {
      box.append(el("div", null, row));
    });
  }

  var generation = 0;

  async function runQuery() {
    var gen = ++generation;
    var input = document.getElementById("address");
    var button = document.getElementById("query-button");
    var status = document.getElementById("status");
    var address = input.value.trim();
    button.disabled = true;
    status.className = "status";
    status.textContent = "正在查询链上数据…";
    document.getElementById("pool").hidden = true;
    document.getElementById("summary").hidden = true;
    document.getElementById("positions").replaceChildren();
    try {
      var result = await queryPositions(address, {
        onStatus: function (text) {
          if (gen !== generation) return;
          if (text) status.textContent = text;
        },
      });
      if (gen !== generation) return;
      try {
        var url = new URL(window.location.href);
        url.searchParams.set("address", result.wallet);
        window.history.replaceState({}, "", url);
      } catch (err) {
        /* file:// or a locked history API */
      }
      status.textContent = "";
      renderPool(result);
      renderSummary(result);
    } catch (err) {
      if (gen !== generation) return;
      status.className = "status error";
      var message = shortError(err);
      if (message.indexOf("请输入有效的钱包地址") !== -1) {
        status.textContent = message;
      } else {
        status.textContent = "查询失败：" + message + "。公共 RPC 为 " + RPC_URL + "，请稍后重试。";
      }
    } finally {
      if (gen === generation) button.disabled = false;
    }
  }

  function boot() {
    if (typeof document === "undefined") return;
    if (!ethers || !math) {
      var status = document.getElementById("status");
      if (status) {
        status.className = "status error";
        status.textContent = "页面脚本没有加载完整，请刷新后再试。";
      }
      return;
    }
    fillContracts();
    var params = new URLSearchParams(window.location.search);
    var fromUrl = params.get("address");
    var input = document.getElementById("address");
    if (fromUrl) input.value = fromUrl;
    document.getElementById("query-form").addEventListener("submit", function (event) {
      event.preventDefault();
      runQuery();
    });
    runQuery();
  }

  globalThis.ElysiumLp = {
    queryPositions: queryPositions,
    canonicalPoolId: canonicalPoolId,
  };

  boot();
})();
