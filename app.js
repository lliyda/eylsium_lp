/* Read-only HYPE/KNTQ Uniswap v4 position viewer. No wallet, no transactions.
   Queries the 0.3%, 0.8%, and 1% pools. Each pool keeps its own slot0. */
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
  var HYPE_DECIMALS = 18;
  var POOLS = [
    {
      id: "0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a",
      fee: 3000,
      tickSpacing: 60,
    },
    {
      id: "0xd210029ab684d92240876c54ec6d5a8b2b1998b71c2c907c1e55de02e13e3472",
      fee: 8000,
      tickSpacing: 120,
    },
    {
      id: "0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac",
      fee: 10000,
      tickSpacing: 200,
    },
  ];

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

  function canonicalKey(pool) {
    return {
      currency0: ethers.ZeroAddress,
      currency1: KNTQ,
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      hooks: ethers.ZeroAddress,
    };
  }

  function assertCanonicalPools() {
    for (var i = 0; i < POOLS.length; i++) {
      var computed = poolIdOf(canonicalKey(POOLS[i]));
      if (computed.toLowerCase() !== POOLS[i].id.toLowerCase()) {
        throw new Error("池子参数与 PoolId 不一致：" + feeLabel(POOLS[i].fee));
      }
    }
  }

  function matchPool(key) {
    var id = poolIdOf(key).toLowerCase();
    for (var i = 0; i < POOLS.length; i++) {
      if (POOLS[i].id.toLowerCase() === id) return POOLS[i];
    }
    return null;
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
        var pool = matchPool(decoded[0]);
        if (!pool) continue;
        var ticks = math.decodePositionInfo(decoded[1]);
        matched.push({
          tokenId: slice[i],
          poolId: pool.id,
          fee: Number(decoded[0].fee),
          tickSpacing: Number(decoded[0].tickSpacing),
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
            pos.poolId,
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
            pos.poolId,
            pos.tickLower,
            pos.tickUpper,
          ]),
        });
      });
      var stateResults = await aggregate(provider, stateCalls, blockTag);
      for (var n = 0; n < matched.length; n++) {
        var infoResult = stateResults[n * 2];
        var growthResult = stateResults[n * 2 + 1];
        var base = matched[n];
        if (!infoResult.success || !growthResult.success || infoResult.returnData === "0x" || growthResult.returnData === "0x") {
          positions.push({
            tokenId: base.tokenId,
            poolId: base.poolId,
            fee: base.fee,
            tickSpacing: base.tickSpacing,
            tickLower: base.tickLower,
            tickUpper: base.tickUpper,
            readError: "读取仓位 #" + base.tokenId.toString() + " 失败",
          });
          continue;
        }
        var posInfo = svIface.decodeFunctionResult("getPositionInfo", infoResult.returnData);
        var growth = svIface.decodeFunctionResult("getFeeGrowthInside", growthResult.returnData);
        positions.push({
          tokenId: base.tokenId,
          poolId: base.poolId,
          fee: base.fee,
          tickSpacing: base.tickSpacing,
          tickLower: base.tickLower,
          tickUpper: base.tickUpper,
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

  function valuePositions(rawPositions, poolStates) {
    var byId = {};
    poolStates.forEach(function (pool) {
      byId[pool.id.toLowerCase()] = pool;
    });
    return rawPositions.map(function (pos) {
      var pool = byId[String(pos.poolId).toLowerCase()];
      if (pos.readError || pos.liquidity == null) {
        return {
          tokenId: pos.tokenId,
          poolId: pos.poolId,
          fee: pos.fee,
          tickSpacing: pos.tickSpacing,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          readError: pos.readError || "读取仓位失败",
          fee0: null,
          fee1: null,
          principal0: null,
          principal1: null,
          inRange: null,
          poolTick: null,
        };
      }
      var fees = math.getUnclaimedFees(
        pos.feeGrowth0,
        pos.feeGrowth1,
        pos.feeGrowth0Last,
        pos.feeGrowth1Last,
        pos.liquidity
      );
      var priced = pool && !pool.error && pool.sqrtPriceX96 != null && pool.tick != null;
      var amounts = null;
      if (priced) {
        amounts = math.getAmounts({
          sqrtPriceX96: pool.sqrtPriceX96,
          tick: pool.tick,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          liquidity: pos.liquidity,
        });
      }
      return {
        tokenId: pos.tokenId,
        poolId: pos.poolId,
        fee: pos.fee,
        tickSpacing: pos.tickSpacing,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        liquidity: pos.liquidity,
        fee0: fees.fee0,
        fee1: fees.fee1,
        principal0: amounts ? amounts.amount0 : null,
        principal1: amounts ? amounts.amount1 : null,
        inRange: priced ? pool.tick >= pos.tickLower && pool.tick < pos.tickUpper : null,
        poolTick: priced ? pool.tick : null,
      };
    });
  }

  function summarizePositions(list) {
    var fee0 = 0n;
    var fee1 = 0n;
    var principal0 = 0n;
    var principal1 = 0n;
    var feesKnown = true;
    var principalKnown = true;
    var inRange = 0;
    for (var i = 0; i < list.length; i++) {
      var pos = list[i];
      if (pos.fee0 == null || pos.fee1 == null) {
        feesKnown = false;
        principalKnown = false;
        continue;
      }
      fee0 += pos.fee0;
      fee1 += pos.fee1;
      if (pos.principal0 == null || pos.principal1 == null) principalKnown = false;
      else {
        principal0 += pos.principal0;
        principal1 += pos.principal1;
      }
      if (pos.inRange === true) inRange += 1;
    }
    return {
      count: list.length,
      inRange: inRange,
      fee0: fee0,
      fee1: fee1,
      principal0: principal0,
      principal1: principal1,
      feesKnown: feesKnown,
      principalKnown: principalKnown,
    };
  }

  function decodeSlot0(result) {
    if (!result || !result.success || !result.returnData || result.returnData === "0x") return null;
    try {
      var slot0 = svIface.decodeFunctionResult("getSlot0", result.returnData);
      return {
        sqrtPriceX96: slot0[0],
        tick: Number(slot0[1]),
        lpFee: Number(slot0[3]),
        priceX18: math.priceX18FromSqrt(slot0[0]),
        error: null,
      };
    } catch (err) {
      return null;
    }
  }

  async function fetchGeckoPool(poolId) {
    var response = await fetch(
      "https://api.geckoterminal.com/api/v2/networks/elysium/pools/" + poolId,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
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

  async function fetchGeckoPrices() {
    var order = [POOLS[2], POOLS[0], POOLS[1]];
    var lastErr = null;
    for (var i = 0; i < order.length; i++) {
      try {
        return await fetchGeckoPool(order[i].id);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("GeckoTerminal 不可用");
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
      source: "CoinGecko 的 HYPE 价格，KNTQ 按 1% 池价格折算",
    };
  }

  async function loadPrices(humanPriceStr) {
    try {
      return await fetchGeckoPrices();
    } catch (err) {
      try {
        if (!humanPriceStr) return null;
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
    assertCanonicalPools();
    var wallet = ethers.getAddress(address);
    var queriedAt = new Date();
    var provider = makeProvider();
    try {
      onStatus("正在读取区块和三个池的价格…");
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
      POOLS.forEach(function (pool) {
        headCalls.push({
          target: STATE_VIEW,
          allowFailure: true,
          callData: svIface.encodeFunctionData("getSlot0", [pool.id]),
        });
      });
      var head = await aggregate(provider, headCalls, blockTag);
      var balance = pmIface.decodeFunctionResult("balanceOf", must(head[0], "读取 NFT 余额").returnData)[0];
      var nextTokenId = pmIface.decodeFunctionResult("nextTokenId", must(head[1], "读取 NFT 序号").returnData)[0];
      var kntqDecimals = HYPE_DECIMALS;
      var kntqSymbol = "KNTQ";
      if (head[3].success && head[3].returnData !== "0x") {
        kntqSymbol = erc20Iface.decodeFunctionResult("symbol", head[3].returnData)[0];
      }
      if (head[2].success && head[2].returnData !== "0x") {
        kntqDecimals = Number(erc20Iface.decodeFunctionResult("decimals", head[2].returnData)[0]);
      }
      var poolStates = POOLS.map(function (pool, index) {
        var decoded = decodeSlot0(head[4 + index]);
        if (!decoded) {
          return {
            id: pool.id,
            fee: pool.fee,
            tickSpacing: pool.tickSpacing,
            sqrtPriceX96: null,
            tick: null,
            lpFee: null,
            priceX18: null,
            error: "读取池子价格失败",
          };
        }
        return {
          id: pool.id,
          fee: pool.fee,
          tickSpacing: pool.tickSpacing,
          sqrtPriceX96: decoded.sqrtPriceX96,
          tick: decoded.tick,
          lpFee: decoded.lpFee,
          priceX18: decoded.priceX18,
          error: null,
        };
      });
      var tokenIds = await findTokenIds(provider, wallet, balance, nextTokenId, blockTag, onStatus);
      var rawPositions = await readPositions(provider, tokenIds, blockTag, onStatus);
      var valued = valuePositions(rawPositions, poolStates);
      var onePercent = poolStates[poolStates.length - 1];
      var humanPriceStr = onePercent && onePercent.priceX18 != null
        ? math.formatScaled(onePercent.priceX18, 18, 18, false)
        : null;
      onStatus("正在获取美元价格…");
      var prices = opts.skipPrices ? null : await loadPrices(humanPriceStr);
      var groups = poolStates.map(function (pool) {
        var positions = valued.filter(function (pos) {
          return pos.poolId.toLowerCase() === pool.id.toLowerCase();
        });
        return {
          id: pool.id,
          fee: pool.fee,
          tickSpacing: pool.tickSpacing,
          tick: pool.tick,
          sqrtPriceX96: pool.sqrtPriceX96,
          priceX18: pool.priceX18,
          lpFee: pool.lpFee,
          error: pool.error,
          positions: positions,
          subtotal: summarizePositions(positions),
        };
      });
      var flat = [];
      groups.forEach(function (group) {
        flat = flat.concat(group.positions);
      });
      onStatus("");
      return {
        wallet: wallet,
        blockNumber: blockTag,
        blockTime: new Date(Number(block.timestamp) * 1000),
        queriedAt: queriedAt,
        kntqSymbol: kntqSymbol,
        kntqDecimals: kntqDecimals,
        nftCount: Number(balance),
        prices: prices,
        pools: groups,
        positions: flat,
        totals: summarizePositions(flat),
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
    if (Math.abs(pct - Math.round(pct)) < 1e-9) return String(Math.round(pct)) + "%";
    return String(Math.round(pct * 100) / 100) + "%";
  }

  function usdFor(amount, decimals, price) {
    if (amount == null || !price) return null;
    return math.amountToUsdE8(amount, decimals, price);
  }

  function pairUsd(amount0, amount1, decimals, prices) {
    if (!prices || amount0 == null || amount1 == null) return null;
    var usd0 = usdFor(amount0, HYPE_DECIMALS, prices.hype);
    var usd1 = usdFor(amount1, decimals, prices.kntq);
    if (usd0 == null || usd1 == null) return null;
    return math.formatUsd(usd0 + usd1);
  }

  function appendMoney(parent, title, lines, usd) {
    var box = el("div");
    box.append(el("h3", null, title));
    lines.forEach(function (line) {
      var row = el("div", "v", line.text);
      if (line.name) row.dataset[line.name] = line.raw == null ? "" : line.raw;
      box.append(row);
    });
    if (usd) box.append(el("div", "sub", "约 $" + usd));
    parent.append(box);
  }

  function tokenLine(amount, decimals, symbol) {
    if (amount == null) return "暂不可用";
    return math.formatToken(amount, decimals) + " " + symbol;
  }

  function rawAmount(amount, decimals) {
    if (amount == null) return "";
    return math.formatScaled(amount, decimals, 18, false);
  }

  function renderPool(result) {
    var pool = document.getElementById("pool");
    pool.hidden = false;
    pool.replaceChildren();
    var title = el("div", "section-title");
    title.append(el("h2", null, "三个池的当前价格"));
    title.append(el("span", "sub", "HYPE / " + result.kntqSymbol + " · 0.3% · 0.8% · 1%"));
    pool.append(title);
    var grid = el("div", "stats");
    result.pools.forEach(function (group) {
      var card = el("div", "stat");
      card.dataset.poolFee = String(group.fee);
      card.append(el("div", "k", feeLabel(group.fee) + " · 间距 " + group.tickSpacing));
      if (group.error || group.priceX18 == null) {
        card.append(el("div", "v", group.error || "价格不可用"));
      } else {
        var price = el("div", "v", "1 HYPE ≈ " + math.formatToken(group.priceX18, 18) + " " + result.kntqSymbol);
        price.dataset.field = "price";
        price.dataset.fee = String(group.fee);
        card.append(price);
        var tick = el("div", "sub", "Tick " + group.tick);
        tick.dataset.field = "tick";
        tick.dataset.fee = String(group.fee);
        card.append(tick);
      }
      grid.append(card);
    });
    pool.append(grid);
    var meta = el("div", "stats meta-stats");
    [
      ["区块高度", String(result.blockNumber), "block"],
      ["区块时间", math.formatBeijing(result.blockTime), "block-time"],
      ["查询时间", math.formatBeijing(result.queriedAt), "time"],
    ].forEach(function (item) {
      var card = el("div", "stat");
      card.append(el("div", "k", item[0]));
      var value = el("div", "v", item[1]);
      value.dataset.field = item[2];
      card.append(value);
      meta.append(card);
    });
    pool.append(meta);
  }

  function renderTotals(parent, summary, result, names) {
    var money = el("div", "money");
    var principalUsd = summary.principalKnown
      ? pairUsd(summary.principal0, summary.principal1, result.kntqDecimals, result.prices)
      : null;
    var feeUsd = summary.feesKnown
      ? pairUsd(summary.fee0, summary.fee1, result.kntqDecimals, result.prices)
      : null;
    appendMoney(money, "本金合计", [
      {
        name: names.principal0,
        raw: rawAmount(summary.principalKnown ? summary.principal0 : null, HYPE_DECIMALS),
        text: summary.principalKnown
          ? tokenLine(summary.principal0, HYPE_DECIMALS, "HYPE")
          : "本金不完整",
      },
      {
        name: names.principal1,
        raw: rawAmount(summary.principalKnown ? summary.principal1 : null, result.kntqDecimals),
        text: summary.principalKnown
          ? tokenLine(summary.principal1, result.kntqDecimals, result.kntqSymbol)
          : "本金不完整",
      },
    ], principalUsd);
    appendMoney(money, "手续费合计", [
      {
        name: names.fee0,
        raw: rawAmount(summary.feesKnown ? summary.fee0 : null, HYPE_DECIMALS),
        text: summary.feesKnown
          ? tokenLine(summary.fee0, HYPE_DECIMALS, "HYPE")
          : "手续费不完整",
      },
      {
        name: names.fee1,
        raw: rawAmount(summary.feesKnown ? summary.fee1 : null, result.kntqDecimals),
        text: summary.feesKnown
          ? tokenLine(summary.fee1, result.kntqDecimals, result.kntqSymbol)
          : "手续费不完整",
      },
    ], feeUsd);
    parent.append(money);
    if (principalUsd) {
      var p = el("span", "usd-principal");
      p.dataset[names.principalUsd] = principalUsd;
      p.hidden = true;
      parent.append(p);
    }
    if (feeUsd) {
      var f = el("span", "usd-fee");
      f.dataset[names.feeUsd] = feeUsd;
      f.hidden = true;
      parent.append(f);
    }
  }

  function renderSummary(result) {
    var summary = document.getElementById("summary");
    var positions = document.getElementById("positions");
    summary.replaceChildren();
    positions.replaceChildren();
    summary.hidden = false;
    var activePools = result.pools.filter(function (pool) { return pool.positions.length > 0; }).length;
    var head = el("div", "section-title");
    head.append(el("h2", null, "三池合计"));
    head.append(el("span", "sub", result.totals.count + " 个仓位 · " + activePools + " 个池有仓位"));
    summary.append(head);
    if (result.totals.count === 0) {
      var empty = el("p", "note");
      empty.dataset.field = "empty";
      if (result.nftCount === 0) {
        empty.textContent = "这个地址没有任何 Uniswap v4 仓位 NFT。下面三个 HYPE/KNTQ 池都是空的。";
      } else {
        empty.textContent =
          "这个地址有 " + result.nftCount + " 个 Uniswap v4 仓位 NFT，但都不在这三档 HYPE/KNTQ 池里。";
      }
      summary.append(empty);
    }
    renderTotals(summary, result.totals, result, {
      principal0: "totalPrincipal0",
      principal1: "totalPrincipal1",
      fee0: "totalFee0",
      fee1: "totalFee1",
      principalUsd: "totalPrincipalUsd",
      feeUsd: "totalFeeUsd",
    });
    var note = el("p", "note");
    note.dataset.field = "price-note";
    if (!result.prices) {
      note.textContent = "暂时拿不到美元价格，上面只显示代币数量。美元估值不可用。";
    } else {
      note.textContent =
        "美元价格来自 " +
        result.prices.source +
        "，三池共用同一套代币美元价，仅供参考。HYPE $" +
        formatUnitPrice(result.prices.hype) +
        " · " +
        result.kntqSymbol +
        " $" +
        formatUnitPrice(result.prices.kntq) +
        "。各池的 HYPE/KNTQ 兑换价仍用该池自己的 tick。";
    }
    summary.append(note);

    result.pools.forEach(function (group) {
      positions.append(renderPoolGroup(group, result));
    });
  }

  function renderPoolGroup(group, result) {
    var section = el("section", "panel pool-group");
    section.dataset.poolFee = String(group.fee);
    var head = el("div", "section-title");
    head.append(el("h2", null, feeLabel(group.fee) + " 池"));
    var rangeCount = group.positions.filter(function (pos) { return pos.inRange === true; }).length;
    head.append(el("span", "sub", group.positions.length + " 个仓位 · " + rangeCount + " 个在范围内"));
    section.append(head);
    if (group.error) section.append(el("p", "note", group.error + "。本金和是否在范围内暂不计算，避免误用其他池的价格。"));
    if (!group.positions.length) {
      var empty = el("div", "empty");
      empty.dataset.emptyPool = String(group.fee);
      empty.textContent = "这个地址在 " + feeLabel(group.fee) + " 池里没有 LP 仓位。";
      section.append(empty);
      return section;
    }
    renderTotals(section, group.subtotal, result, {
      principal0: "poolPrincipal0",
      principal1: "poolPrincipal1",
      fee0: "poolFee0",
      fee1: "poolFee1",
      principalUsd: "poolPrincipalUsd",
      feeUsd: "poolFeeUsd",
    });
    group.positions.forEach(function (pos) {
      section.append(renderPosition(pos, result, group));
    });
    return section;
  }

  function renderPosition(pos, result, group) {
    var card = el("article", "pos");
    card.dataset.tokenId = pos.tokenId.toString();
    card.dataset.fee = String(pos.fee);
    if (pos.poolTick != null) card.dataset.poolTick = String(pos.poolTick);
    var head = el("div", "pos-head");
    var title = el("div", "token-id", "仓位 NFT #" + pos.tokenId.toString());
    head.append(title);
    var badges = el("div", "pos-head");
    badges.append(el("span", "badge", feeLabel(pos.fee)));
    if (pos.readError) badges.append(el("span", "badge bad", "读取失败"));
    else if (pos.inRange === true) badges.append(el("span", "badge good", "在范围内"));
    else if (pos.inRange === false) badges.append(el("span", "badge bad", "超出范围"));
    else badges.append(el("span", "badge bad", "价格未知"));
    head.append(badges);
    card.append(head);
    if (pos.readError) {
      card.append(el("p", "note", pos.readError));
      return card;
    }

    var lowerPrice = math.formatToken(math.tickToPriceX18(pos.tickLower), 18);
    var upperPrice = math.formatToken(math.tickToPriceX18(pos.tickUpper), 18);
    var meta = el("div", "range-meta");
    meta.append(el("div", null, "Tick 区间 " + pos.tickLower + " → " + pos.tickUpper + " · 间距 " + pos.tickSpacing));
    meta.append(el("div", null, "价格区间约 " + lowerPrice + " → " + upperPrice + " " + result.kntqSymbol + " / HYPE"));
    card.append(meta);

    if (pos.poolTick != null) {
      var width = pos.tickUpper - pos.tickLower;
      var ratio = width === 0 ? 0.5 : (pos.poolTick - pos.tickLower) / width;
      var clamped = Math.min(1, Math.max(0, ratio));
      var track = el("div", "track");
      var mark = el("span", "tick-mark");
      mark.style.left = (clamped * 100).toFixed(2) + "%";
      track.append(mark);
      card.append(track);
      var sentence = pos.inRange
        ? "当前价格落在这个区间内，仓位同时持有 HYPE 和 " + result.kntqSymbol + "。"
        : pos.poolTick >= pos.tickUpper
          ? "当前价格高于区间，仓位目前全部是 " + result.kntqSymbol + "。"
          : "当前价格低于区间，仓位目前全部是 HYPE。";
      card.append(el("div", "sub", sentence + " 使用 " + feeLabel(group.fee) + " 池的 tick " + pos.poolTick + "。"));
    } else {
      card.append(el("div", "sub", "这个池的当前价格没有读到，所以不计算本金，也不借用其他池的 tick。"));
    }

    var feeUsd = pairUsd(pos.fee0, pos.fee1, result.kntqDecimals, result.prices);
    var principalUsd = pairUsd(pos.principal0, pos.principal1, result.kntqDecimals, result.prices);
    var money = el("div", "money");
    appendMoney(money, "本金", [
      { name: "principal0", raw: rawAmount(pos.principal0, HYPE_DECIMALS), text: tokenLine(pos.principal0, HYPE_DECIMALS, "HYPE") },
      { name: "principal1", raw: rawAmount(pos.principal1, result.kntqDecimals), text: tokenLine(pos.principal1, result.kntqDecimals, result.kntqSymbol) },
    ], principalUsd);
    appendMoney(money, "未领取手续费", [
      { name: "fee0", raw: rawAmount(pos.fee0, HYPE_DECIMALS), text: tokenLine(pos.fee0, HYPE_DECIMALS, "HYPE") },
      { name: "fee1", raw: rawAmount(pos.fee1, result.kntqDecimals), text: tokenLine(pos.fee1, result.kntqDecimals, result.kntqSymbol) },
    ], feeUsd);
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
      "hooks = " + ethers.ZeroAddress,
    ];
    POOLS.forEach(function (pool) {
      rows.push(feeLabel(pool.fee) + " fee " + pool.fee + "，tickSpacing " + pool.tickSpacing + "，PoolId " + pool.id);
    });
    rows.push("未领取手续费 = (feeGrowthInside − feeGrowthInsideLast) × liquidity / 2^128。每个池用自己的 slot0。");
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
      if (message.indexOf("请输入有效的钱包地址") !== -1) status.textContent = message;
      else status.textContent = "查询失败：" + message + "。公共 RPC 为 " + RPC_URL + "，请稍后重试。";
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
    valuePositions: valuePositions,
    summarizePositions: summarizePositions,
    pools: POOLS,
    poolIdOf: poolIdOf,
  };

  boot();
})();
