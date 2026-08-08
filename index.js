const axios        = require("axios");
const yahooFinance = require("yahoo-finance2").default;

// ─────────────────────────────────────────────────────────
// CONFIG — set all values as Railway environment variables
// No API key needed for Yahoo Finance — completely free
// ─────────────────────────────────────────────────────────
const CONFIG = {
  telegramToken:  process.env.TELEGRAM_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  symbol:         "NQ=F",        // NQ Futures on Yahoo Finance
  activeScanMs:   60  * 1000,    // 60 seconds during active session
  idleScanMs:     5 * 60 * 1000, // 5 minutes outside session (saves resources)
};

// ─────────────────────────────────────────────────────────
// SESSION HOURS (EST)
// London:  2:00am — 4:30am EST
// Asia:    7:00pm — 9:30pm EST
// ─────────────────────────────────────────────────────────
function isActiveSession() {
  const now     = new Date();
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const estMins = (utcMins - 300 + 1440) % 1440;

  const londonStart = 120;   // 2:00am EST
  const londonEnd   = 270;   // 4:30am EST
  const asiaStart   = 1140;  // 7:00pm EST
  const asiaEnd     = 1170;  // 9:30pm EST

  return (
    (estMins >= londonStart && estMins < londonEnd) ||
    (estMins >= asiaStart   && estMins < asiaEnd)
  );
}

function currentSessionName() {
  const now     = new Date();
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const estMins = (utcMins - 300 + 1440) % 1440;
  if (estMins >= 120  && estMins < 270)  return "London";
  if (estMins >= 1140 && estMins < 1170) return "Asia";
  return "Outside session";
}

// Returns next session start time as a readable string
function nextSessionInfo() {
  const now     = new Date();
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const estMins = (utcMins - 300 + 1440) % 1440;

  if (estMins < 120)  return "London opens at 2:00am EST";
  if (estMins < 1140) return "Asia opens at 7:00pm EST";
  return "London opens at 2:00am EST tomorrow";
}

// ─────────────────────────────────────────────────────────
// HTF TIMEFRAMES — for AOI zone detection
// ─────────────────────────────────────────────────────────
const HTF_TIMEFRAMES = [
  { name: "15m", interval: "15m", period: "5d",  count: 20 },
  { name: "30m", interval: "30m", period: "10d", count: 20 },
  { name: "1H",  interval: "1h",  period: "30d", count: 20 },
  { name: "4H",  interval: "4h",  period: "60d", count: 15 },
  { name: "1D",  interval: "1d",  period: "90d", count: 10 },
];

// LTF timeframes — for ChoCh detection
const LTF_TIMEFRAMES = [
  { name: "1m", interval: "1m", period: "1d", count: 30 },
  { name: "5m", interval: "5m", period: "5d", count: 30 },
];

// ─────────────────────────────────────────────────────────
// STATE — tracks setup progress per session
// Resets after full setup fires or session ends
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
  console.log("  🔄 State reset — ready for next setup.");
}

// ─────────────────────────────────────────────────────────
// DYNAMIC SCAN INTERVAL
// 60s during active session, 5 mins outside session
// Restarts timer automatically when session changes
// ─────────────────────────────────────────────────────────
function scheduleScan() {
  const active   = isActiveSession();
  const interval = active ? CONFIG.activeScanMs : CONFIG.idleScanMs;

  if (state.scanTimer) clearTimeout(state.scanTimer);

  state.scanTimer = setTimeout(async () => {
    await scan();
    scheduleScan(); // reschedule after each scan
  }, interval);
}

// ─────────────────────────────────────────────────────────
// FETCH CANDLES FROM YAHOO FINANCE
// Returns normalized candle array
// ─────────────────────────────────────────────────────────
async function getCandles(interval, period, count) {
  try {
    const result = await yahooFinance.chart(CONFIG.symbol, {
      interval,
      range: period,
    });

    const quotes = result?.quotes;
    if (!quotes || quotes.length === 0) return [];

    const sliced = quotes.slice(-count);

    return sliced.map((q, i) => ({
      open:     q.open   ?? 0,
      high:     q.high   ?? 0,
      low:      q.low    ?? 0,
      close:    q.close  ?? 0,
      datetime: q.date?.toISOString?.() ?? "",
      isLive:   i === sliced.length - 1,
    }));
  } catch (err) {
    console.error(`  ⚠️  Yahoo Finance error (${interval}):`, err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// GET CURRENT LIVE PRICE
// ─────────────────────────────────────────────────────────
async function getCurrentPrice() {
  try {
    const result = await yahooFinance.quote(CONFIG.symbol);
    return result?.regularMarketPrice ?? null;
  } catch (err) {
    console.error("  ⚠️  Price fetch error:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// DETECT FVG ZONES IN CLOSED CANDLES
// Bullish FVG: c3.low > c1.high
// Bearish FVG: c3.high < c1.low
// ─────────────────────────────────────────────────────────
function detectFVGs(candles) {
  const fvgs   = [];
  const closed = candles.filter((c) => !c.isLive);

  for (let i = 0; i < closed.length - 2; i++) {
    const c1 = closed[i];
    const c2 = closed[i + 1];
    const c3 = closed[i + 2];

    if (!c1.high || !c3.low) continue;

    // Bullish FVG
    if (c3.low > c1.high) {
      fvgs.push({
        type:      "BULLISH",
        direction: "BULLISH",
        top:       c3.low,
        bottom:    c1.high,
        midpoint:  (c3.low + c1.high) / 2,
        size:      c3.low - c1.high,
        time:      c2.datetime,
        candleIdx: i + 2,
      });
    }

    // Bearish FVG
    if (c3.high < c1.low) {
      fvgs.push({
        type:      "BEARISH",
        direction: "BEARISH",
        top:       c1.low,
        bottom:    c3.high,
        midpoint:  (c1.low + c3.high) / 2,
        size:      c1.low - c3.high,
        time:      c2.datetime,
        candleIdx: i + 2,
      });
    }
  }

  return fvgs;
}

// ─────────────────────────────────────────────────────────
// CHECK IF PRICE IS INSIDE AN AOI ZONE
// ─────────────────────────────────────────────────────────
function isPriceTappingAOI(price, aoi) {
  return price >= aoi.bottom && price <= aoi.top;
}

// ─────────────────────────────────────────────────────────
// DETECT CHOCH ON LTF
// Bullish ChoCh: live candle closes above recent swing high
// Bearish ChoCh: live candle closes below recent swing low
// Looks back 10 candles for swing point
// ─────────────────────────────────────────────────────────
function detectChoCh(candles) {
  const closed = candles.filter((c) => !c.isLive);
  const live   = candles.find((c)  => c.isLive);
  if (!live || closed.length < 5) return null;

  const lookback  = closed.slice(-10);
  const swingHigh = Math.max(...lookback.map((c) => c.high));
  const swingLow  = Math.min(...lookback.map((c) => c.low));

  if (live.close > swingHigh) {
    return {
      direction: "BULLISH",
      level:     swingHigh,
      signal:    `Bullish ChoCh — closed above swing high ${swingHigh.toFixed(2)}`,
    };
  }

  if (live.close < swingLow) {
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
function detectLTFAOI(candles, direction) {
  const fvgs     = detectFVGs(candles);
  const matching = fvgs.filter((f) => f.direction === direction);
  if (matching.length === 0) return null;
  return matching[matching.length - 1];
}

// ─────────────────────────────────────────────────────────
// FORMAT TELEGRAM ALERT MESSAGE
// ─────────────────────────────────────────────────────────
function formatAlert(htfAOI, choch, ltfAOI, currentPrice, session) {
  const isBull = choch.direction === "BULLISH";
  const emoji  = isBull ? "🟢" : "🔴";
  const arrow  = isBull ? "⬆️" : "⬇️";
  const entry  = isBull ? "BUY STOP" : "SELL STOP";
  const sl     = isBull
    ? "Below the impulse/correction low"
    : "Above the impulse/correction high";

  return (
    `${emoji} <b>NQ_Devbmt — FULL SETUP ALERT</b> ${arrow}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Instrument:</b>  NQ Futures\n` +
    `<b>Session:</b>     ${session}\n` +
    `<b>Direction:</b>   ${choch.direction}\n` +
    `<b>Price:</b>       ${currentPrice?.toFixed(2) ?? "—"}\n` +
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
    console.log("  📨 Telegram alert sent.");
  } catch (err) {
    console.error("  ❌ Telegram error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// MAIN SCAN — called every 60s (active) or 5min (idle)
// ─────────────────────────────────────────────────────────
async function scan() {
  const ts      = new Date().toISOString().slice(0, 16).replace("T", " ");
  const session = currentSessionName();
  const active  = isActiveSession();

  // ── Outside session ──
  if (!active) {
    // Reset state when session just ended
    if (state.lastSessionName && state.lastSessionName !== "Outside session") {
      console.log(`[${ts}] 💤 Session ended — resetting state.`);
      resetState();
    }
    state.lastSessionName = "Outside session";
    console.log(`[${ts}] 💤 Idle — ${nextSessionInfo()} (scanning every 5 min)`);
    return;
  }

  // Track session change
  if (state.lastSessionName !== session) {
    console.log(`[${ts}] 🟡 ${session} session started — resetting state for fresh scan.`);
    resetState();
    state.lastSessionName = session;
  }

  console.log(`\n[${ts} UTC] 🔍 ${session} session — scanning NQ...`);

  try {

    // ── STEP 1: Find most recent HTF AOI ────────────────
    if (!state.htfAOI) {
      console.log("  Step 1: Looking for HTF AOI (FVG)...");

      for (const tf of HTF_TIMEFRAMES) {
        const candles = await getCandles(tf.interval, tf.period, tf.count);
        if (candles.length < 4) continue;

        const fvgs = detectFVGs(candles);
        if (fvgs.length === 0) continue;

        const latest = fvgs[fvgs.length - 1];
        state.htfAOI = { ...latest, timeframe: tf.name };

        console.log(
          `  ✅ HTF AOI found on ${tf.name}: ${latest.direction} FVG ` +
          `${latest.bottom.toFixed(2)} — ${latest.top.toFixed(2)}`
        );
        break;
      }

      if (!state.htfAOI) {
        console.log("  ℹ️  No HTF AOI found this scan.");
        return;
      }
    }

    // ── STEP 2: Check if price tapped HTF AOI ───────────
    if (!state.htfTapped) {
      const price = await getCurrentPrice();
      if (!price) return;

      console.log(
        `  Step 2: Price ${price.toFixed(2)} — watching HTF AOI ` +
        `${state.htfAOI.bottom.toFixed(2)} — ${state.htfAOI.top.toFixed(2)}...`
      );

      if (isPriceTappingAOI(price, state.htfAOI)) {
        state.htfTapped = true;
        console.log(`  ✅ HTF AOI tapped at ${price.toFixed(2)}! Dropping to LTF...`);

        await sendTelegram(
          `⚡ <b>HTF AOI Tapped — NQ Futures</b>\n\n` +
          `<b>Session:</b>    ${session}\n` +
          `<b>Timeframe:</b>  ${state.htfAOI.timeframe}\n` +
          `<b>Zone:</b>       ${state.htfAOI.direction} FVG\n` +
          `<b>Zone range:</b> ${state.htfAOI.bottom.toFixed(2)} — ${state.htfAOI.top.toFixed(2)}\n` +
          `<b>Price:</b>      ${price.toFixed(2)}\n\n` +
          `<i>Now watching for ${state.htfAOI.direction} ChoCh on 1m or 5m...</i>`
        );
      }
      return;
    }

    // ── STEP 3: Wait for LTF ChoCh aligning with HTF ────
    if (!state.chochFound) {
      console.log(`  Step 3: Watching for ${state.htfAOI.direction} ChoCh on LTF...`);

      for (const ltf of LTF_TIMEFRAMES) {
        const candles = await getCandles(ltf.interval, ltf.period, ltf.count);
        if (candles.length < 5) continue;

        const choch = detectChoCh(candles);
        if (!choch) continue;

        if (choch.direction !== state.htfAOI.direction) {
          console.log(
            `  ⚠️  ChoCh on ${ltf.name} is ${choch.direction} ` +
            `but HTF is ${state.htfAOI.direction} — skipping.`
          );
          continue;
        }

        state.chochFound     = true;
        state.chochDirection = choch.direction;
        state.choch          = { ...choch, timeframe: ltf.name };

        console.log(
          `  ✅ ${choch.direction} ChoCh confirmed on ${ltf.name}! ` +
          `Now watching for LTF AOI tap...`
        );
        break;
      }

      if (!state.chochFound) {
        console.log("  ℹ️  No valid ChoCh yet.");
      }
      return;
    }

    // ── STEP 4: Wait for LTF AOI tap — fire full alert ──
    console.log(`  Step 4: Looking for LTF AOI in ${state.chochDirection} direction...`);

    const price = await getCurrentPrice();
    if (!price) return;

    for (const ltf of LTF_TIMEFRAMES) {
      const candles = await getCandles(ltf.interval, ltf.period, ltf.count);
      if (candles.length < 4) continue;

      const ltfAOI = detectLTFAOI(candles, state.chochDirection);
      if (!ltfAOI) continue;

      if (!isPriceTappingAOI(price, ltfAOI)) continue;

      const alertKey = `${state.htfAOI.timeframe}_${ltfAOI.time}_${price.toFixed(0)}`;
      if (state.alertsSent.has(alertKey)) continue;

      console.log("  🚨 ALL CONDITIONS MET — Firing full alert!");

      const message = formatAlert(
        state.htfAOI,
        state.choch,
        ltfAOI,
        price,
        session
      );

      await sendTelegram(message);
      state.alertsSent.add(alertKey);
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
  const required = [
    ["TELEGRAM_TOKEN",   CONFIG.telegramToken],
    ["TELEGRAM_CHAT_ID", CONFIG.telegramChatId],
  ];

  const missing = required.filter(([, v]) => !v).map(([k]) => k);

  if (missing.length > 0) {
    console.error("❌ Missing env variables:", missing.join(", "));
    console.error("   Add them in Railway → Variables tab.");
    process.exit(1);
  }

  console.log("✅ Environment variables loaded.");
  console.log("✅ Yahoo Finance — no API key needed, no rate limits.");
}

// ─────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────
async function start() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🤖  NQ_Devbmt Alert Bot");
  console.log("📊  Instrument: NQ Futures (NQ=F)");
  console.log("📡  Data: Yahoo Finance (free, no API key)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  validateConfig();

  console.log("⏰  Active sessions (EST):");
  console.log("    London: 2:00am — 4:30am");
  console.log("    Asia:   7:00pm — 9:30pm");
  console.log("🔄  Scan: 60s during session / 5min outside session");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await sendTelegram(
    `🤖 <b>NQ_Devbmt Bot is Online</b>\n\n` +
    `<b>Instrument:</b> NQ Futures\n\n` +
    `<b>Active sessions:</b>\n` +
    `• London: 2:00am — 4:30am EST\n` +
    `• Asia: 7:00pm — 9:30pm EST\n\n` +
    `<b>Alert sequence:</b>\n` +
    `1️⃣ HTF AOI tapped → first alert fires\n` +
    `2️⃣ LTF ChoCh confirmed in same direction\n` +
    `3️⃣ LTF AOI tapped → full setup alert fires\n\n` +
    `<b>Scan rate:</b> 60s during session / 5min when idle\n\n` +
    `<i>Waiting for active session to begin...</i>`
  );

  // Run first scan immediately then schedule dynamically
  await scan();
  scheduleScan();
}

process.on("unhandledRejection", (err) => {
  console.error("Unhandled:", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught:", err?.message || err);
});

start();