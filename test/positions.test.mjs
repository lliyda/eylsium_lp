import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = "0xe9b9ab375c0b3bc83af239bb30908f5d710d12a8";
const EIGHT_OWNER = "0x102EBb8154900a3c3B601e7b0B2FC88650FBFD10";
const EMPTY = "0x0000000000000000000000000000000000000001";

function loadApp() {
  const context = {
    console,
    fetch: globalThis.fetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    Headers,
    Request,
    Response,
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    BigInt,
    Math,
    Date,
    Intl,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    Promise,
    JSON,
    Uint8Array,
    Uint8ClampedArray,
    Uint16Array,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    DataView,
    ArrayBuffer,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    WeakMap,
    WeakSet,
    Proxy,
    Reflect,
    Symbol,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    isFinite,
    isNaN,
    navigator: { userAgent: "Mozilla/5.0" },
  };
  context.window = context;
  context.self = context;
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["vendor/ethers-6.13.5.umd.min.js", "position-math.js", "app.js"]) {
    vm.runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  return context;
}

const ctx = loadApp();
const math = ctx.PositionMath;
const lp = ctx.ElysiumLp;

function fmt(amount) {
  return math.formatScaled(amount, 18, 18, false);
}

function poolByFee(result, fee) {
  return result.pools.find((pool) => pool.fee === fee);
}

test("canonical pool ids match the verified PoolKeys", () => {
  const zero = ctx.ethers.ZeroAddress;
  const kntq = "0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0";
  for (const pool of lp.pools) {
    const id = lp.poolIdOf({
      currency0: zero,
      currency1: kntq,
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      hooks: zero,
    });
    assert.equal(id.toLowerCase(), pool.id.toLowerCase());
  }
  assert.equal(Array.from(lp.pools, (pool) => pool.fee).join(","), "3000,8000,10000");
  assert.equal(Array.from(lp.pools, (pool) => pool.tickSpacing).join(","), "60,120,200");
});

test("fee subtraction wraps as uint256", () => {
  const fees = math.getUnclaimedFees(1n, 2n, 10n, 4n, 1n << 128n);
  const mask = (1n << 256n) - 1n;
  assert.equal(fees.fee0, (1n - 10n) & mask);
  assert.equal(fees.fee1, (2n - 4n) & mask);
});

test("positions in two pools use their own ticks and fees are summed once", () => {
  const sqrtAt0 = math.getSqrtRatioAtTick(0);
  const sqrtAt200 = math.getSqrtRatioAtTick(200);
  const liquidity = 10n ** 18n;
  const pools = [
    { id: "0xaaa", fee: 3000, tickSpacing: 60, tick: 0, sqrtPriceX96: sqrtAt0, error: null },
    { id: "0xbbb", fee: 8000, tickSpacing: 120, tick: 200, sqrtPriceX96: sqrtAt200, error: null },
  ];
  const raw = [
    {
      poolId: "0xaaa",
      tokenId: 1n,
      fee: 3000,
      tickSpacing: 60,
      tickLower: -600,
      tickUpper: 600,
      liquidity,
      feeGrowth0: 5n << 128n,
      feeGrowth1: 0n,
      feeGrowth0Last: 0n,
      feeGrowth1Last: 0n,
    },
    {
      poolId: "0xbbb",
      tokenId: 2n,
      fee: 8000,
      tickSpacing: 120,
      tickLower: -120,
      tickUpper: 120,
      liquidity,
      feeGrowth0: 1n << 128n,
      feeGrowth1: 2n << 128n,
      feeGrowth0Last: 0n,
      feeGrowth1Last: 0n,
    },
  ];
  const valued = lp.valuePositions(raw, pools);
  assert.equal(valued[0].poolTick, 0);
  assert.equal(valued[0].inRange, true);
  assert.equal(valued[0].fee0, 5n * liquidity);
  assert.ok(valued[0].principal0 > 0n);
  assert.ok(valued[0].principal1 > 0n);
  assert.equal(valued[1].poolTick, 200);
  assert.equal(valued[1].inRange, false);
  assert.equal(valued[1].principal0, 0n);
  assert.ok(valued[1].principal1 > 0n);
  assert.equal(valued[1].fee0, liquidity);
  assert.equal(valued[1].fee1, 2n * liquidity);

  const borrowed = lp.valuePositions(raw, [
    pools[0],
    { id: "0xbbb", fee: 8000, tickSpacing: 120, tick: 0, sqrtPriceX96: sqrtAt0, error: null },
  ]);
  assert.notEqual(borrowed[1].principal0, valued[1].principal0);
  assert.equal(borrowed[1].inRange, true);

  const summary = lp.summarizePositions(valued);
  const left = lp.summarizePositions([valued[0]]);
  const right = lp.summarizePositions([valued[1]]);
  assert.equal(summary.fee0, left.fee0 + right.fee0);
  assert.equal(summary.fee1, left.fee1 + right.fee1);
  assert.equal(summary.principal0, left.principal0 + right.principal0);
  assert.equal(summary.principal1, left.principal1 + right.principal1);
  assert.equal(summary.count, 2);

  const missing = lp.valuePositions(raw, [
    pools[0],
    { id: "0xbbb", fee: 8000, tickSpacing: 120, tick: null, sqrtPriceX96: null, error: "读取池子价格失败" },
  ]);
  assert.equal(missing[1].principal0, null);
  assert.equal(missing[1].principal1, null);
  assert.equal(missing[1].inRange, null);
  assert.equal(missing[1].poolTick, null);
  assert.equal(missing[1].fee0, liquidity);
  assert.equal(missing[0].poolTick, 0);
  const partial = lp.summarizePositions(missing);
  assert.equal(partial.feesKnown, true);
  assert.equal(partial.principalKnown, false);
  assert.equal(partial.fee0, summary.fee0);
});

test("fixed-block reads for 1%, 0.3%, and 0.8% pools", { timeout: 180000 }, async () => {
  const historical = await lp.queryPositions(EXAMPLE, { blockTag: 3752301, skipPrices: true });
  assert.equal(historical.blockNumber, 3752301);
  const one = poolByFee(historical, 10000);
  const narrow = poolByFee(historical, 3000);
  const mid = poolByFee(historical, 8000);
  assert.equal(one.tick, 52240);
  assert.equal(narrow.tick, 52190);
  assert.equal(mid.tick, 52237);
  assert.equal(one.tickSpacing, 200);
  assert.equal(narrow.tickSpacing, 60);
  assert.equal(mid.tickSpacing, 120);
  assert.equal(Array.from(one.positions, (pos) => String(pos.tokenId)).join(","), "810,814,5307");
  assert.equal(narrow.positions.length, 0);
  assert.equal(mid.positions.length, 0);
  for (const pos of one.positions) {
    assert.equal(pos.fee, 10000);
    assert.equal(pos.tickSpacing, 200);
    assert.equal(pos.poolTick, 52240);
    assert.equal(pos.inRange, true);
    assert.notEqual(pos.poolTick, narrow.tick);
  }
  assert.equal(fmt(one.positions[0].fee0), "0.296026520212986397");
  assert.equal(fmt(one.positions[0].fee1), "52.406123931997879096");
  assert.equal(fmt(one.positions[0].principal0), "0.460021991622816888");
  assert.equal(fmt(one.positions[0].principal1), "117.645407189398417055");
  assert.equal(fmt(one.positions[1].fee0), "0.128960879487181206");
  assert.equal(fmt(one.positions[1].fee1), "24.210225168482695863");
  assert.equal(fmt(one.positions[2].fee0), "0.140786702406062737");
  assert.equal(fmt(one.positions[2].fee1), "26.27602923816375064");
  assert.equal(fmt(historical.totals.fee0), "0.56577410210623034");
  assert.equal(fmt(historical.totals.fee1), "102.892378338644325599");
  assert.equal(historical.totals.fee0, one.subtotal.fee0);
  assert.equal(historical.totals.principal0, one.subtotal.principal0);
  assert.equal(historical.totals.count, 3);

  const moved = await lp.queryPositions(EXAMPLE, { blockTag: 4207900, skipPrices: true });
  const movedNarrow = poolByFee(moved, 3000);
  assert.equal(movedNarrow.tick, 53384);
  assert.equal(movedNarrow.positions.length, 1);
  assert.equal(movedNarrow.positions[0].tokenId, 9479n);
  assert.equal(movedNarrow.positions[0].fee, 3000);
  assert.equal(movedNarrow.positions[0].tickSpacing, 60);
  assert.equal(movedNarrow.positions[0].poolTick, 53384);
  assert.notEqual(movedNarrow.positions[0].poolTick, poolByFee(moved, 10000).tick);
  assert.equal(poolByFee(moved, 10000).positions.length, 0);
  assert.equal(poolByFee(moved, 8000).positions.length, 0);
  assert.equal(moved.totals.count, 1);
  assert.equal(moved.totals.fee0, movedNarrow.positions[0].fee0);
  assert.equal(moved.totals.fee1, movedNarrow.positions[0].fee1);

  const wide = await lp.queryPositions(EIGHT_OWNER, { blockTag: 4207900, skipPrices: true });
  const eight = poolByFee(wide, 8000);
  const hit = eight.positions.find((pos) => pos.tokenId === 9534n);
  assert.ok(hit, "expected 0.8% token 9534");
  assert.equal(hit.fee, 8000);
  assert.equal(hit.tickSpacing, 120);
  assert.equal(hit.poolTick, 53422);
  assert.equal(eight.tick, 53422);
  assert.notEqual(hit.poolTick, poolByFee(wide, 10000).tick);
  let fee0 = 0n;
  let fee1 = 0n;
  for (const pool of wide.pools) {
    fee0 += pool.subtotal.fee0;
    fee1 += pool.subtotal.fee1;
  }
  assert.equal(wide.totals.fee0, fee0);
  assert.equal(wide.totals.fee1, fee1);

  const empty = await lp.queryPositions(EMPTY, { blockTag: 4207900, skipPrices: true });
  assert.equal(empty.nftCount, 0);
  assert.equal(empty.totals.count, 0);
  assert.equal(empty.totals.fee0, 0n);
  assert.equal(empty.totals.fee1, 0n);
  assert.equal(empty.pools.every((pool) => pool.positions.length === 0), true);

  const realFetch = ctx.fetch;
  ctx.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes("geckoterminal") || target.includes("coingecko")) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return realFetch(url, options);
  };
  try {
    const failedPrice = await lp.queryPositions(EXAMPLE, { blockTag: 4207900 });
    assert.equal(failedPrice.prices, null);
    assert.equal(failedPrice.positions.length, 1);
    assert.equal(failedPrice.positions[0].tokenId, 9479n);
    assert.ok(failedPrice.positions[0].fee0 >= 0n);
    assert.equal(failedPrice.positions[0].poolTick, 53384);
  } finally {
    ctx.fetch = realFetch;
  }
});
