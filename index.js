const axios = require("axios");

// ─────────────────────────────────────────────────────────
// WHY WE USE DIRECT HTTP INSTEAD OF yahoo-finance2 LIBRARY
//
// yahoo-finance2 v4 changed to a class (must use new YahooFinance())
// AND Railway's network egress blocks the Yahoo Finance domain by
// default, causing every library call to fail silently.
//
// This version calls Yahoo Finance's public JSON endpoints directly
// via axios — same data, no library restrictions, works on Railway.
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────
const CONFIG = {
  telegramToken:  process.env.TELEGRAM_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  symbol:         "NQ%3DF",      // NQ=F URL-encoded for Yahoo Finance
  symbolDisplay:  "NQ=F",
  activeScanMs:   60  * 1000,
  idleScanMs:     5 * 60 * 1000,
};

// Yahoo Finance v8 chart endpoint — public, no auth needed
const YF_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

// Valid Yahoo Finance intervals
// NOTE: Yahoo has NO native 4h — we build it from 60m candles
const YF_INTERVALS = {
  "1m":  "1m",
  "5m":  "5m",
  "15m": "15m",
  "30m": "30m",
  "1H":  "60m",
  "1D":  "1d",
};

// ─────────────────────────────────────────────────────────
// SESSION HOURS (EST)
// London:  2:00am — 4:30am  (120 — 270 mins)
// Asia:    7:00pm — 9:30pm  (1140 — 1290 mins)
// ─────────────────────────────────────────────────────────
function getEstMins() {
  const utcMins = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  return (utcMins - 300 + 1440) % 1440;
}

function isActiveSession() {
  const m = getEstMins();
  return (m >= 120 && m < 270) || (m >= 1140 && m < 1290);
}

function currentSessionName() {
  const m = getEstMins();
  if (m >= 120  && m < 270)  return "London";
  if (m >= 1140 && m < 1290) return "Asia";
  return "Outside session";
}

function nextSessionInfo() {
  const m = getEstMins();
  if (m < 120)  return "London opens at 2:00am EST";
  if (m < 1140) return "Asia opens at 7:00pm EST";
  return "London opens at 2:00am EST tomorrow";
}

// ─────────────────────────────────────────────────────────
// HTF AND LTF TIMEFRAME CONFIGS
// ─────────────────────────────────────────────────────────
const HTF_TIMEFRAMES = [
  { name: "15m", interval: "15m", lookbackDays: 5,   count: 30 },
  { name: "30m", interval: "30m", lookbackDays: 10,  count: 30 },
  { name: "1H",  interval: "1H",  lookbackDays: 30,  count: 30 },
  { name: "4H",  interval: "1H",  lookbackDays: 60,  count: 80, aggregate4h: true },
  { name: "1D",  interval: "1D",  lookbackDays: 200, count: 15 },
];

const LTF_TIMEFRAMES = [
  { name: "1m", interval: "1m", lookbackDays: 2, count: 50 },
  { name: "5m", interval: "5m", lookbackDays: 5, count: 50 },
];

// ─────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────
let state = {
  htfAOI:          null,
  htfTapped:       false,
  chochFound:      false,
  chochDirection:  null,
  choch:           null,
  alertsSent:      new Set(),
  lastSessionName: null,
  scanTimer:       null,
};

function resetState() {
  state.htfAOI         = null;
  state.htfTapped      = false;
  state.chochFound     = false;
  state.chochDirection = null;
  state.choch          = null;
  console.log("  🔄 State reset.");
}

// ─────────────────────────────────────────────────────────
// DYNAMIC SCHEDULER
// ─────────────────────────────────────────────────────────
function scheduleScan() {
  if (state.scanTimer) clearTimeout(state.scanTimer);
  const ms = isActiveSession() ? CONFIG.activeScanMs : CONFIG.idleScanMs;
  state.scanTimer = setTimeout(async () => {
    await scan();
    scheduleScan();
  }, ms);
}

// ─────────────────────────────────────────────────────────
// FETCH CANDLES DIRECTLY FROM YAHOO FINANCE JSON API
// Uses axios so Railway egress settings control access
// Add query1.finance.yahoo.com to Railway egress allowlist
// ─────────────────────────────────────────────────────────
async function getCandles(intervalKey, lookbackDays, count) {
  try {
    const yfInterval = YF_INTERVALS[intervalKey] ?? intervalKey;
    const period2    = Math.floor(Date.now() / 1000);
    const period1    = period2 - lookbackDays * 24 * 60 * 60;

    const url = `${YF_BASE}/${CONFIG.symbol}`;
    const res = await axios.get(url, {
      params: {
        interval:       yfInterval,
        period1,
        period2,
        includePrePost: true,
        events:         "div|split",
      },
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NQBot/1.0)",
      },
      timeout: 15000,
    });

    const result = res.data?.chart?.result?.[0];
    if (!result) {
      console.log(`    ⚠️  No data returned for ${intervalKey}`);
      return [];
    }

    const timestamps = result.timestamp ?? [];
    const ohlc       = result.indicators?.quote?.[0];
    if (!ohlc || timestamps.length === 0) {
      console.log(`    ⚠️  Empty OHLC for ${intervalKey}`);
      return [];
    }

    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = ohlc.open?.[i];
      const h = ohlc.high?.[i];
      const l = ohlc.low?.[i];
      const c = ohlc.close?.[i];
      if (o == null || h == null || l == null || c == null) continue;

      candles.push({
        open:     o,
        high:     h,
        low:      l,
        close:    c,
        datetime: new Date(timestamps[i] * 1000).toISOString(),
        ts:       timestamps[i],
      });
    }

    // Mark last candle as potentially live
    const sliced = candles.slice(-count);
    return sliced.map((c, i) => ({
      ...c,
      isLive: i === sliced.length - 1,
    }));

  } catch (err) {
    if (err.response?.status) {
      console.error(`    ❌ Yahoo HTTP ${err.response.status} for ${intervalKey}`);
    } else {
      console.error(`    ❌ Fetch error (${intervalKey}): ${err.message}`);
    }
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// AGGREGATE 60m CANDLES INTO SYNTHETIC 4H CANDLES
// Yahoo has no native 4h interval — we build it from hourly bars
// Groups every 4 consecutive 1H candles into one 4H candle
// ─────────────────────────────────────────────────────────
function aggregateTo4h(hourlyCandles, targetCount) {
  const closed = hourlyCandles.filter((c) => !c.isLive);
  const groups  = [];

  for (let i = 0; i < closed.length - 3; i += 4) {
    const chunk = closed.slice(i, i + 4);
    if (chunk.length < 4) continue;
    groups.push({
      open:     chunk[0].open,
      high:     Math.max(...chunk.map((c) => c.high)),
      low:      Math.min(...chunk.map((c) => c.low)),
      close:    chunk[3].close,
      datetime: chunk[0].datetime,
      ts:       chunk[0].ts,
      isLive:   false,
    });
  }

  // Add live/partial 4H candle from remaining hourly bars
  const remainder = closed.slice(Math.floor(closed.length / 4) * 4);
  if (remainder.length > 0) {
    groups.push({
      open:     remainder[0].open,
      high:     Math.max(...remainder.map((c) => c.high)),
      low:      Math.min(...remainder.map((c) => c.low)),
      close:    remainder[remainder.length - 1].close,
      datetime: remainder[0].datetime,
      ts:       remainder[0].ts,
      isLive:   true,
    });
  }

  return groups.slice(-targetCount);
}

// ─────────────────────────────────────────────────────────
// GET CANDLES FOR A TIMEFRAME — handles 4H aggregation
// ─────────────────────────────────────────────────────────
async function getCandlesForTF(tf) {
  if (!tf.aggregate4h) {
    const raw = await getCandles(tf.interval, tf.lookbackDays, tf.count);
    console.log(`    📊 ${tf.name}: ${raw.length} candles`);
    return raw;
  }

  // 4H: fetch hourly then aggregate
  const hourly = await getCandles("1H", tf.lookbackDays, tf.count * 4 + 10);
  const agg    = aggregateTo4h(hourly, tf.count);
  console.log(`    📊 4H (from ${hourly.length} hourly): ${agg.length} synthetic candles`);
  return agg;
}

// ─────────────────────────────────────────────────────────
// GET CURRENT LIVE PRICE
// ─────────────────────────────────────────────────────────
async function getCurrentPrice() {
  try {
    const res = await axios.get(`${YF_BASE}/${CONFIG.symbol}`, {
      params: { interval: "1m", period1: Math.floor(Date.now() / 1000) - 120, period2: Math.floor(Date.now() / 1000) },
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NQBot/1.0)" },
      timeout: 10000,
    });

    const result = res.data?.chart?.result?.[0];
    const meta   = result?.meta;

    // regularMarketPrice is the most reliable live price from meta
    const price = meta?.regularMarketPrice ?? meta?.chartPreviousClose ?? null;
    if (price) console.log(`    💰 NQ price: ${price.toFixed(2)}`);
    return price;
  } catch (err) {
    console.error("    ❌ Price error:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// DETECT FVG ZONES
// Bullish FVG: c3.low > c1.high — gap above (upward impulse)
// Bearish FVG: c3.high < c1.low — gap below (downward impulse)
// Filters: minimum 2pt gap, must be within 800pts of price
// ─────────────────────────────────────────────────────────
function detectFVGs(candles, currentPrice = null) {
  const fvgs   = [];
  const closed = candles.filter((c) => !c.isLive);

  for (let i = 0; i < closed.length - 2; i++) {
    const c1 = closed[i];
    const c2 = closed[i + 1];
    const c3 = closed[i + 2];

    if (!c1.high || !c3.low || !c1.low || !c3.high) continue;

    // Bullish FVG
    if (c3.low > c1.high) {
      const size = c3.low - c1.high;
      if (size < 2) continue;
      const fvg = {
        type: "BULLISH", direction: "BULLISH",
        top: c3.low, bottom: c1.high,
        midpoint: (c3.low + c1.high) / 2,
        size, time: c2.datetime, candleIdx: i + 2,
      };
      if (currentPrice && Math.abs(fvg.midpoint - currentPrice) > 800) continue;
      fvgs.push(fvg);
    }

    // Bearish FVG
    if (c3.high < c1.low) {
      const size = c1.low - c3.high;
      if (size < 2) continue;
      const fvg = {
        type: "BEARISH", direction: "BEARISH",
        top: c1.low, bottom: c3.high,
        midpoint: (c1.low + c3.high) / 2,
        size, time: c2.datetime, candleIdx: i + 2,
      };
      if (currentPrice && Math.abs(fvg.midpoint - currentPrice) > 800) continue;
      fvgs.push(fvg);
    }
  }

  return fvgs;
}

// ─────────────────────────────────────────────────────────
// CHECK IF PRICE IS TAPPING AN AOI ZONE
// 2pt buffer so price just outside still counts
// ─────────────────────────────────────────────────────────
function isPriceTappingAOI(price, aoi) {
  return price >= (aoi.bottom - 2) && price <= (aoi.top + 2);
}

// ─────────────────────────────────────────────────────────
// DETECT CHOCH ON LTF
// Bullish ChoCh: closes 3+ points above recent 10-bar swing high
// Bearish ChoCh: closes 3+ points below recent 10-bar swing low
// ─────────────────────────────────────────────────────────
function detectChoCh(candles) {
  const closed  = candles.filter((c) => !c.isLive);
  // Use last closed candle as current if no live candle
  const current = candles.find((c) => c.isLive) ?? closed[closed.length - 1];
  if (!current || closed.length < 5) return null;

  const lookback  = closed.slice(-10);
  const swingHigh = Math.max(...lookback.map((c) => c.high));
  const swingLow  = Math.min(...lookback.map((c) => c.low));
  const minBreak  = 3; // require 3pt break to filter noise

  if (current.close > swingHigh + minBreak) {
    return {
      direction: "BULLISH",
      level:     swingHigh,
      signal:    `Bullish ChoCh — closed above swing high ${swingHigh.toFixed(2)}`,
    };
  }

  if (current.close < swingLow - minBreak) {
    return {
      direction: "BEARISH",
      level:     swingLow,
      signal:    `Bearish ChoCh — closed below swing low ${swingLow.toFixed(2)}`,
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────
// DETECT LTF AOI MATCHING CHOCH DIRECTION
// ─────────────────────────────────────────────────────────
function detectLTFAOI(candles, direction, price) {
  const fvgs     = detectFVGs(candles, price);
  const matching = fvgs.filter((f) => f.direction === direction);
  return matching.length > 0 ? matching[matching.length - 1] : null;
}

// ─────────────────────────────────────────────────────────
// FORMAT TELEGRAM ALERT
// ─────────────────────────────────────────────────────────
function formatAlert(htfAOI, choch, ltfAOI, price, session) {
  const isBull = choch.direction === "BULLISH";
  const emoji  = isBull ? "🟢" : "🔴";
  const arrow  = isBull ? "⬆️" : "⬇️";
  const entry  = isBull ? "BUY STOP" : "SELL STOP";
  const sl     = isBull ? "Below the impulse/correction low" : "Above the impulse/correction high";

  return (
    `${emoji} <b>NQ_Devbmt — FULL SETUP ALERT</b> ${arrow}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Instrument:</b>  NQ Futures\n` +
    `<b>Session:</b>     ${session}\n` +
    `<b>Direction:</b>   ${choch.direction}\n` +
    `<b>Price:</b>       ${price?.toFixed(2) ?? "—"}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Step 1 — HTF AOI (${htfAOI.timeframe}):</b>\n` +
    `  ${htfAOI.direction} FVG\n` +
    `  Top:    ${htfAOI.top.toFixed(2)}\n` +
    `  Bottom: ${htfAOI.bottom.toFixed(2)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Step 2 — LTF ChoCh (${choch.timeframe}):</b>\n` +
    `  ${choch.signal}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Step 3 — LTF AOI Tapped:</b>\n` +
    `  ${ltfAOI.direction} FVG/OB\n` +
    `  Top:    ${ltfAOI.top.toFixed(2)}\n` +
    `  Bottom: ${ltfAOI.bottom.toFixed(2)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Entry:</b> ${entry} at IC level\n` +
    `<b>SL:</b>    ${sl}\n` +
    `<b>TP:</b>    Most recent liquidity level\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ <i>All 3 conditions met. Check chart and place manually.</i>`
  );
}

// ─────────────────────────────────────────────────────────
// SEND TELEGRAM MESSAGE
// ─────────────────────────────────────────────────────────
async function sendTelegram(text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`,
      { chat_id: CONFIG.telegramChatId, text, parse_mode: "HTML" },
      { timeout: 10000 }
    );
    console.log("  📨 Telegram sent.");
  } catch (err) {
    console.error("  ❌ Telegram error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// MAIN SCAN
// ─────────────────────────────────────────────────────────
async function scan() {
  const ts      = new Date().toISOString().slice(0, 16).replace("T", " ");
  const session = currentSessionName();
  const active  = isActiveSession();

  if (!active) {
    if (state.lastSessionName && state.lastSessionName !== "Outside session") {
      console.log(`[${ts}] 💤 Session ended — resetting state.`);
      resetState();
    }
    state.lastSessionName = "Outside session";
    console.log(`[${ts}] 💤 Idle — ${nextSessionInfo()} (check in 5min)`);
    return;
  }

  if (state.lastSessionName !== session) {
    console.log(`[${ts}] 🟡 ${session} session started.`);
    resetState();
    state.lastSessionName = session;
  }

  console.log(`\n[${ts} UTC] 🔍 ${session} — scanning NQ...`);

  try {

    // ── STEP 1: Find HTF AOI near current price ──────────
    if (!state.htfAOI) {
      console.log("  Step 1: Finding HTF AOI...");
      const priceNow = await getCurrentPrice();
      if (!priceNow) { console.log("  ⚠️  No price — skipping."); return; }

      for (const tf of HTF_TIMEFRAMES) {
        const candles = await getCandlesForTF(tf);
        if (candles.length < 4) continue;

        const fvgs = detectFVGs(candles, priceNow);
        if (fvgs.length === 0) { console.log(`    ℹ️  No FVGs near price on ${tf.name}`); continue; }

        // Pick FVG closest to current price
        const closest = fvgs.reduce((a, b) =>
          Math.abs(a.midpoint - priceNow) < Math.abs(b.midpoint - priceNow) ? a : b
        );

        state.htfAOI = { ...closest, timeframe: tf.name };
        console.log(
          `  ✅ HTF AOI: ${closest.direction} FVG on ${tf.name} ` +
          `[${closest.bottom.toFixed(2)} — ${closest.top.toFixed(2)}] ` +
          `${Math.abs(closest.midpoint - priceNow).toFixed(0)}pts from price`
        );
        break;
      }

      if (!state.htfAOI) { console.log("  ℹ️  No HTF AOI found."); return; }
    }

    // ── STEP 2: Watch for price to tap HTF AOI ───────────
    if (!state.htfTapped) {
      const price = await getCurrentPrice();
      if (!price) return;

      console.log(
        `  Step 2: Price ${price.toFixed(2)} | ` +
        `AOI [${state.htfAOI.bottom.toFixed(2)}—${state.htfAOI.top.toFixed(2)}] | ` +
        `${Math.abs(price - state.htfAOI.midpoint).toFixed(0)}pts away`
      );

      if (isPriceTappingAOI(price, state.htfAOI)) {
        state.htfTapped = true;
        console.log(`  ✅ HTF AOI tapped at ${price.toFixed(2)}!`);
        await sendTelegram(
          `⚡ <b>HTF AOI Tapped — NQ Futures</b>\n\n` +
          `<b>Session:</b>    ${session}\n` +
          `<b>Timeframe:</b>  ${state.htfAOI.timeframe}\n` +
          `<b>Zone:</b>       ${state.htfAOI.direction} FVG\n` +
          `<b>Range:</b>      ${state.htfAOI.bottom.toFixed(2)} — ${state.htfAOI.top.toFixed(2)}\n` +
          `<b>Price:</b>      ${price.toFixed(2)}\n\n` +
          `<i>Watching for ${state.htfAOI.direction} ChoCh on 1m/5m...</i>`
        );
      }
      return;
    }

    // ── STEP 3: Watch for LTF ChoCh ─────────────────────
    if (!state.chochFound) {
      console.log(`  Step 3: Watching for ${state.htfAOI.direction} ChoCh...`);

      for (const ltf of LTF_TIMEFRAMES) {
        const candles = await getCandles(ltf.interval, ltf.lookbackDays, ltf.count);
        if (candles.length < 5) continue;

        const choch = detectChoCh(candles);
        if (!choch) { console.log(`    ℹ️  No ChoCh on ${ltf.name}`); continue; }

        if (choch.direction !== state.htfAOI.direction) {
          console.log(`    ⚠️  ChoCh ${choch.direction} ≠ HTF ${state.htfAOI.direction} — skip`);
          continue;
        }

        state.chochFound     = true;
        state.chochDirection = choch.direction;
        state.choch          = { ...choch, timeframe: ltf.name };
        console.log(`  ✅ ${choch.direction} ChoCh on ${ltf.name}!`);
        break;
      }

      if (!state.chochFound) console.log("  ℹ️  No ChoCh yet.");
      return;
    }

    // ── STEP 4: Watch for LTF AOI tap → fire alert ──────
    console.log(`  Step 4: Looking for ${state.chochDirection} LTF AOI...`);
    const price = await getCurrentPrice();
    if (!price) return;

    for (const ltf of LTF_TIMEFRAMES) {
      const candles = await getCandles(ltf.interval, ltf.lookbackDays, ltf.count);
      if (candles.length < 4) continue;

      const ltfAOI = detectLTFAOI(candles, state.chochDirection, price);
      if (!ltfAOI) { console.log(`    ℹ️  No LTF AOI on ${ltf.name}`); continue; }

      console.log(
        `    LTF AOI [${ltfAOI.bottom.toFixed(2)}—${ltfAOI.top.toFixed(2)}] ` +
        `| Price ${price.toFixed(2)}`
      );

      if (!isPriceTappingAOI(price, ltfAOI)) { console.log("    ⏳ Not tapping yet."); continue; }

      const key = `${state.htfAOI.timeframe}_${ltfAOI.time}_${price.toFixed(0)}`;
      if (state.alertsSent.has(key)) { console.log("    ℹ️  Already alerted."); continue; }

      console.log("  🚨 ALL CONDITIONS MET!");
      await sendTelegram(formatAlert(state.htfAOI, state.choch, ltfAOI, price, session));
      state.alertsSent.add(key);
      resetState();
      break;
    }

  } catch (err) {
    console.error("  ❌ Scan error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// VALIDATE CONFIG
// ─────────────────────────────────────────────────────────
function validateConfig() {
  const missing = [
    ["TELEGRAM_TOKEN",   CONFIG.telegramToken],
    ["TELEGRAM_CHAT_ID", CONFIG.telegramChatId],
  ].filter(([, v]) => !v).map(([k]) => k);

  if (missing.length) {
    console.error("❌ Missing env variables:", missing.join(", "));
    process.exit(1);
  }
  console.log("✅ Config valid.");
}

// ─────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────
async function start() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🤖  NQ_Devbmt Alert Bot");
  console.log("📊  NQ=F via Yahoo Finance direct HTTP");
  console.log("🔧  No yahoo-finance2 library — axios only");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  validateConfig();

  console.log("⏰  London 2:00-4:30am EST | Asia 7:00-9:30pm EST");
  console.log("🔄  60s during session / 5min idle");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await sendTelegram(
    `🤖 <b>NQ_Devbmt Bot Online</b>\n\n` +
    `<b>Data:</b> Yahoo Finance direct API\n\n` +
    `<b>Sessions:</b>\n• London: 2:00am — 4:30am EST\n• Asia: 7:00pm — 9:30pm EST\n\n` +
    `<b>Alerts:</b>\n1️⃣ HTF AOI tapped\n2️⃣ LTF ChoCh confirmed\n3️⃣ LTF AOI tapped → full alert\n\n` +
    `<i>Waiting for active session...</i>`
  );

  await scan();
  scheduleScan();
}

process.on("unhandledRejection", (err) => console.error("Unhandled:", err?.message));
process.on("uncaughtException",  (err) => console.error("Uncaught:",  err?.message));

start();