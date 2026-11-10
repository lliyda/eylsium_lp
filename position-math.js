/* Uniswap v3/v4 tick and fee math. Pure functions, no network access. */
(function (root) {
  "use strict";

  var Q96 = 1n << 96n;
  var Q128 = 1n << 128n;
  var MAX_UINT256 = (1n << 256n) - 1n;

  function getSqrtRatioAtTick(tick) {
    var absTick = tick < 0 ? -tick : tick;
    if (absTick > 887272) {
      throw new Error("tick 超出 Uniswap 允许范围");
    }
    var ratio =
      (absTick & 0x1) !== 0
        ? 0xfffcb933bd6fad37aa2d162d1a594001n
        : 0x100000000000000000000000000000000n;
    if (absTick & 0x2) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
    if (absTick & 0x4) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
    if (absTick & 0x8) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
    if (absTick & 0x10) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
    if (absTick & 0x20) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
    if (absTick & 0x40) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
    if (absTick & 0x80) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
    if (absTick & 0x100) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
    if (absTick & 0x200) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
    if (absTick & 0x400) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
    if (absTick & 0x800) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
    if (absTick & 0x1000) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
    if (absTick & 0x2000) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
    if (absTick & 0x4000) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
    if (absTick & 0x8000) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
    if (absTick & 0x10000) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
    if (absTick & 0x20000) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
    if (absTick & 0x40000) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
    if (absTick & 0x80000) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
    if (tick > 0) ratio = MAX_UINT256 / ratio;
    return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
  }

  function amount0Delta(sqrtA, sqrtB, liquidity) {
    if (sqrtA > sqrtB) {
      var swap = sqrtA;
      sqrtA = sqrtB;
      sqrtB = swap;
    }
    return ((liquidity << 96n) * (sqrtB - sqrtA)) / sqrtB / sqrtA;
  }

  function amount1Delta(sqrtA, sqrtB, liquidity) {
    if (sqrtA > sqrtB) {
      var swap = sqrtA;
      sqrtA = sqrtB;
      sqrtB = swap;
    }
    return (liquidity * (sqrtB - sqrtA)) / Q96;
  }

  function getAmounts(args) {
    var tick = args.tick;
    var tickLower = args.tickLower;
    var tickUpper = args.tickUpper;
    var liquidity = BigInt(args.liquidity);
    var sqrtPriceX96 = BigInt(args.sqrtPriceX96);
    var sqrtLower = getSqrtRatioAtTick(tickLower);
    var sqrtUpper = getSqrtRatioAtTick(tickUpper);
    var amount0 = 0n;
    var amount1 = 0n;
    if (tick < tickLower) {
      amount0 = amount0Delta(sqrtLower, sqrtUpper, liquidity);
    } else if (tick >= tickUpper) {
      amount1 = amount1Delta(sqrtLower, sqrtUpper, liquidity);
    } else {
      amount0 = amount0Delta(sqrtPriceX96, sqrtUpper, liquidity);
      amount1 = amount1Delta(sqrtLower, sqrtPriceX96, liquidity);
    }
    return { amount0: amount0, amount1: amount1 };
  }

  function getUnclaimedFees(growth0, growth1, last0, last1, liquidity) {
    var liq = BigInt(liquidity);
    var delta0 = (BigInt(growth0) - BigInt(last0)) & MAX_UINT256;
    var delta1 = (BigInt(growth1) - BigInt(last1)) & MAX_UINT256;
    return {
      fee0: (delta0 * liq) / Q128,
      fee1: (delta1 * liq) / Q128,
    };
  }

  function decodePositionInfo(info) {
    var value = BigInt(info);
    function sign24(raw) {
      return raw >= 0x800000 ? raw - 0x1000000 : raw;
    }
    return {
      tickLower: sign24(Number((value >> 8n) & 0xffffffn)),
      tickUpper: sign24(Number((value >> 32n) & 0xffffffn)),
      hasSubscriber: (value & 0xffn) !== 0n,
    };
  }

  function priceX18FromSqrt(sqrtPriceX96) {
    var sqrt = BigInt(sqrtPriceX96);
    var scale = 10n ** 18n;
    return (sqrt * sqrt * scale) / (Q96 * Q96);
  }

  function tickToPriceX18(tick) {
    return priceX18FromSqrt(getSqrtRatioAtTick(tick));
  }

  function formatScaled(amount, decimals, maxFrac, groupDigits) {
    var neg = amount < 0n;
    var value = neg ? -amount : amount;
    var places = decimals;
    if (maxFrac < places) {
      var factor = 10n ** BigInt(places - maxFrac);
      value = (value + factor / 2n) / factor;
      places = maxFrac;
    }
    var base = 10n ** BigInt(places);
    var whole = value / base;
    var frac = (value % base).toString().padStart(places, "0").replace(/0+$/, "");
    var wholeText = whole.toString();
    if (groupDigits) {
      wholeText = wholeText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
    var text = wholeText + (frac ? "." + frac : "");
    return neg ? "-" + text : text;
  }

  function formatToken(amount, decimals) {
    var shown = formatScaled(amount, decimals, 6, true);
    if (shown === "0" && amount !== 0n) {
      shown = formatScaled(amount, decimals, 12, true);
    }
    return shown;
  }

  function amountToUsdE8(amountRaw, decimals, priceStr) {
    if (priceStr == null) return null;
    var text = String(priceStr).trim();
    if (!/^\d+(\.\d+)?$/.test(text)) return null;
    var parts = text.split(".");
    var whole = parts[0];
    var frac = parts[1] || "";
    var priceInt = BigInt(whole + frac);
    var extra = 8n;
    var numerator = amountRaw * priceInt * 10n ** extra;
    var denominator = 10n ** BigInt(decimals) * 10n ** BigInt(frac.length);
    return numerator / denominator;
  }

  function formatUsd(scaled) {
    if (scaled == null) return null;
    var shown = formatScaled(scaled, 8, 2, true);
    if ((shown === "0" || shown === "0.00") && scaled !== 0n) {
      return formatScaled(scaled, 8, 6, true);
    }
    if (shown.indexOf(".") === -1) shown += ".00";
    else if (shown.split(".")[1].length === 1) shown += "0";
    return shown;
  }

  function formatBeijing(date) {
    var parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
    function pick(type) {
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === type) return parts[i].value;
      }
      return "";
    }
    var hour = pick("hour");
    if (hour === "24") hour = "00";
    return (
      pick("year") +
      "-" +
      pick("month") +
      "-" +
      pick("day") +
      " " +
      hour +
      ":" +
      pick("minute") +
      ":" +
      pick("second") +
      " 北京时间"
    );
  }

  if (getSqrtRatioAtTick(0) !== Q96) {
    throw new Error("TickMath 自检失败");
  }

  root.PositionMath = {
    getSqrtRatioAtTick: getSqrtRatioAtTick,
    getAmounts: getAmounts,
    getUnclaimedFees: getUnclaimedFees,
    decodePositionInfo: decodePositionInfo,
    priceX18FromSqrt: priceX18FromSqrt,
    tickToPriceX18: tickToPriceX18,
    formatScaled: formatScaled,
    formatToken: formatToken,
    amountToUsdE8: amountToUsdE8,
    formatUsd: formatUsd,
    formatBeijing: formatBeijing,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
