const express = require('express');
const fetch = require('node-fetch');
const webpush = require('web-push');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

// ===== VAPID KEYS =====
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL       = process.env.VAPID_EMAIL || 'mailto:admin@signalpro.app';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('✅ Web Push configured');
} else {
  console.log('⚠️ VAPID keys not set - push notifications disabled');
}

// ===== STORAGE =====
let subscriptions   = {};
let trade           = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
let journal         = [];
let lastSignalState = '';
let livePrice       = 0;
let isClosingTrade  = false;

// ===== GLOBAL INDICATORS (sent to frontend via API) =====
let indicators = {
  nwUpper: 0, nwLower: 0,
  atrMid: 0, atrUpper: 0, atrLower: 0, atr: 0,
  rsi: null, rsiPrev: null,
  candleTime: 0, candleClose: 0,
  c1: false, c2: false, c3: false, allMet: false
};

// ============================================================
// ===== INDICATOR MATH (ALL GLOBAL — no nested functions) =====
// ============================================================

// Nadaraya-Watson Gaussian kernel regression
function gaussKernel(x, bw) {
  return Math.exp(-(x * x) / (2 * bw * bw));
}

function calcNW(closes, bandwidth) {
  // LuxAlgo Nadaraya-Watson Envelope — Repainting Mode (barstate.islast)
  // Pine Script source: "Nadaraya-Watson Envelope [LuxAlgo]" v5
  //
  // Pine Script logic (repainting):
  //   gauss(x, h) = exp(-(x^2) / (h*h*2))        ← Gaussian kernel
  //   for i = 0 to min(499, n-1):                 ← each bar
  //     for j = 0 to min(499, n-1):               ← all bars
  //       w = gauss(i-j, h)
  //       sum += src[j] * w  ;  sumw += w
  //     y2 = sum / sumw
  //     sae += |src[i] - y2|
  //   sae = sae / min(499, n-1) * mult            ← divide by 499, multiply by 3
  //   upper = y2[0] + sae  ;  lower = y2[0] - sae
  //
  // Pine indexing: src[0]=current, src[j]=j bars ago
  // JS indexing:   closes[0]=oldest, closes[n-1]=current
  // So Pine's src[j] = our closes[n-1-j]

  const n        = closes.length;
  const lookback = Math.min(499, n - 1);   // math.min(499, n-1) — exact Pine match
  const mult     = 3.0;                    // LuxAlgo default multiplier = 3
  const h        = bandwidth;              // h = 8

  // Pre-compute Gaussian weights for distances 0..lookback
  // gauss is symmetric: gauss(-d) = gauss(d), so gw[|d|] covers all cases
  const gw = new Array(lookback + 1);
  for (let d = 0; d <= lookback; d++) {
    gw[d] = Math.exp(-(d * d) / (h * h * 2));
  }

  let sae      = 0;
  let currentY = 0;   // NW estimate for current bar (i=0)

  for (let i = 0; i <= lookback; i++) {
    let sum = 0, sumw = 0;
    for (let j = 0; j <= lookback; j++) {
      const w = gw[Math.abs(i - j)];       // gauss(i-j, h)
      sum  += closes[n - 1 - j] * w;       // src[j] in Pine
      sumw += w;
    }
    const y2 = sum / sumw;
    sae += Math.abs(closes[n - 1 - i] - y2);  // |src[i] - y2|
    if (i === 0) currentY = y2;
  }

  // Pine: sae := sae / math.min(499, n-1) * mult
  sae = (sae / lookback) * mult;

  // mae already includes mult — caller uses: nwLower = mid - mae, nwUpper = mid + mae
  return { mid: currentY, mae: sae };
}

// Wilder's ATR — True Range averaged with RMA
function calcATR(highs, lows, closes, period) {
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// ===== RMA / Wilder's Moving Average =====
// Formula (matches TradingView ta.rma exactly):
//   seed  = SMA of first `period` bars
//   RMA[i] = (RMA[i-1] * (period-1) + source[i]) / period
//          = (1 - 1/period)*RMA[i-1] + (1/period)*source[i]
// NOTE: defined GLOBALLY so no scoping issues inside async functions
function calcRMA(data, period) {
  if (!data || data.length < period) return null;
  // Seed with SMA of the first `period` values (oldest bars)
  let rma = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  // Wilder's smoothing forward through the rest of the array
  for (let i = period; i < data.length; i++) {
    rma = (rma * (period - 1) + data[i]) / period;
  }
  return rma;
}

// RSI
function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d,  0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function fmt(v, d = 2) {
  return v != null ? parseFloat(v).toFixed(d) : '---';
}

// ===== TP/SL CHECK (WebSocket real-time) =====
async function checkTpSl(price) {
  if (!trade.active || isClosingTrade) return;
  const { entry, tp, sl } = trade;

  if (price >= tp) {
    isClosingTrade = true;
    console.log(`⚡🏆 TP HIT! Price:${price} TP:${tp}`);
    journal.unshift({
      sym: 'PAXG', entry: entry.toFixed(2), tp: tp.toFixed(2), sl: sl.toFixed(2),
      result: 'win', date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString()
    });
    trade = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
    lastSignalState = '';
    await sendPushToAll('🏆 TP HIT — PAXG/USDT',
      `Take Profit reached!\nEntry: $${fmt(entry)}\nTP: $${fmt(tp)}\nHit: $${fmt(price)}`);
    isClosingTrade = false;
    return;
  }

  if (price <= sl) {
    isClosingTrade = true;
    console.log(`⚡🛑 SL HIT! Price:${price} SL:${sl}`);
    journal.unshift({
      sym: 'PAXG', entry: entry.toFixed(2), tp: tp.toFixed(2), sl: sl.toFixed(2),
      result: 'loss', date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString()
    });
    trade = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
    lastSignalState = '';
    await sendPushToAll('🛑 SL HIT — PAXG/USDT',
      `Stop Loss hit!\nEntry: $${fmt(entry)}\nSL: $${fmt(sl)}\nHit: $${fmt(price)}`);
    isClosingTrade = false;
  }
}

// ===== WEBSOCKET: LIVE PRICE FEED =====
let ws = null;
function connectWebSocket() {
  try {
    ws = new WebSocket('wss://stream.binance.com:9443/ws/paxgusdt@trade');
    ws.on('open',    () => console.log('🔌 WebSocket connected - real-time price feed active'));
    ws.on('message', (data) => {
      try {
        const p = parseFloat(JSON.parse(data).p);
        if (p) { livePrice = p; checkTpSl(p); }
      } catch (e) {}
    });
    ws.on('error',   (err) => console.log('⚠️ WebSocket error:', err.message));
    ws.on('close',   () => {
      console.log('🔌 WebSocket closed - reconnecting in 3s...');
      setTimeout(connectWebSocket, 3000);
    });
  } catch (e) {
    console.log('WebSocket failed:', e.message);
    setTimeout(connectWebSocket, 3000);
  }
}
connectWebSocket();

// ===== PUSHOVER =====
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;
const PUSHOVER_USER  = process.env.PUSHOVER_USER;

async function sendPushover(title, message) {
  if (!PUSHOVER_TOKEN || !PUSHOVER_USER) return;
  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: PUSHOVER_TOKEN, user: PUSHOVER_USER,
        title, message, priority: '1', sound: 'persistent'
      })
    });
    const d = await res.json();
    console.log(d.status === 1 ? `✅ Pushover: ${title}` : `⚠️ Pushover error: ${JSON.stringify(d)}`);
  } catch (err) {
    console.log('Pushover error:', err.message);
  }
}

async function sendPushToAll(title, body) {
  await sendPushover(title, body);
  const subs = Object.values(subscriptions);
  if (!subs.length) return;
  const payload = JSON.stringify({ title, body });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      const key = Object.keys(subscriptions).find(k => subscriptions[k] === sub);
      if (key) delete subscriptions[key];
    }
  }
}

// ===== FETCH BINANCE KLINES =====
const LIMIT = 500;

async function fetchKlines(symbol, interval = '15m', limit = LIMIT) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return res.json();
}

// ===== MAIN SIGNAL LOGIC =====
let lastSignalCandleTime = 0;

async function checkSignal() {
  try {
    const klines = await fetchKlines('PAXGUSDT', '15m', LIMIT);
    const len = klines.length;

    // Last CLOSED candle = index len-2  (live candle = len-1, never used for signals)
    const closedIdx    = len - 2;
    const prevIdx      = len - 3;
    const closedKlines = klines.slice(0, closedIdx + 1);

    console.log("Kline limit =", LIMIT);
    console.log("Candles received =", klines.length);
    console.log("Closed candles used =", closedKlines.length);
    console.log("First candle =", new Date(closedKlines[0][0]).toISOString());
    console.log("Last candle =", new Date(closedKlines[closedKlines.length - 1][0]).toISOString());

    const closes = klines.map(k => parseFloat(k[4]));
    const opens  = klines.map(k => parseFloat(k[1]));
    const highs  = klines.map(k => parseFloat(k[2]));
    const lows   = klines.map(k => parseFloat(k[3]));
    const times  = klines.map(k => k[0]);

    const candleClose = closes[closedIdx];
    const candleOpen  = opens[closedIdx];
    const candleTime  = times[closedIdx];

    // Slice: only closed candles
    const closedCloses = closes.slice(0, closedIdx + 1);
    const closedHighs  = highs.slice(0,  closedIdx + 1);
    const closedLows   = lows.slice(0,   closedIdx + 1);

    // ===== 1. NADARAYA-WATSON ENVELOPE (bandwidth=8, mult=3, repainting) =====
    // LuxAlgo Pine: upper = y2 + sae, lower = y2 - sae (sae includes mult=3)
    const nw      = calcNW(closedCloses, 8);
    const nwLower = nw.mid - nw.mae;   // mae = SAE/499 * 3  (mult already applied)
    const nwUpper = nw.mid + nw.mae;

    // ===== 2. ATR BANDS =====
    // Pine Script (confirmed source):
    //   src1 = input(high),  src2 = input(low),  m = 0.5
    //   x  = rma(tr(true), 14) * m + src1   → upper = ATR*m + candle HIGH
    //   x2 = src2 - rma(tr(true), 14) * m   → lower = candle LOW - ATR*m
    const atr      = calcATR(closedHighs, closedLows, closedCloses, 14);  // rma(tr, 14)
    const atrUpper = closedHighs[closedIdx] + atr * 0.5;  // x  = high + ATR*0.5
    const atrLower = closedLows[closedIdx]  - atr * 0.5;  // x2 = low  - ATR*0.5 ← SL ref

    // ===== 3. RSI(6) — closed candle + previous candle =====
    const closedPrev  = closes.slice(0, prevIdx + 1);
    const rsiCurrent  = calcRSI(closedCloses, 6);
    const rsiPrevious = calcRSI(closedPrev,   6);

    // ===== DIAGNOSTIC LOG — every candle, compare with TradingView manually =====
    const lastHigh   = closedHighs[closedHighs.length - 1];
    const lastLow    = closedLows[closedLows.length  - 1];
    const lastClose  = closedCloses[closedCloses.length - 1];
    const prevClose  = closedCloses[closedCloses.length - 2];
    const lastTR     = Math.max(
      lastHigh - lastLow,
      Math.abs(lastHigh - prevClose),
      Math.abs(lastLow  - prevClose)
    );
    const last5H = closedHighs.slice(-5).map(v => v.toFixed(2)).join(', ');
    const last5L = closedLows.slice(-5).map(v => v.toFixed(2)).join(', ');

    console.log(
      `\n📐 ======= DIAGNOSTIC (compare with TradingView) =======\n` +
      `📐 Klines fetched   : ${len} total | ${closedIdx + 1} closed candles used\n` +
      `📐 Columns check    : k[2]=High k[3]=Low (Binance format)\n` +
      `📐 Last closed candle High : ${lastHigh.toFixed(2)}   Low: ${lastLow.toFixed(2)}   Close: ${lastClose.toFixed(2)}\n` +
      `📐 High > Low check : ${lastHigh > lastLow ? '✅ OK' : '❌ INVERTED BUG!'}\n` +
      `📐 Last 5 Highs     : [${last5H}]\n` +
      `📐 Last 5 Lows      : [${last5L}]\n` +
      `📐 Last TR          : ${lastTR.toFixed(3)}\n` +
      `📐 ATR(14) Wilder's : ${atr.toFixed(4)}\n` +
      `📐 Formula (Pine)   : upper = high + ATR*0.5 | lower = low - ATR*0.5\n` +
      `📐 ATR UPPER = ${lastHigh.toFixed(2)} + ${atr.toFixed(2)}×0.5 = ${atrUpper.toFixed(2)}\n` +
      `📐 ATR LOWER = ${lastLow.toFixed(2)} - ${atr.toFixed(2)}×0.5 = ${atrLower.toFixed(2)}\n` +
      `📐 TV expected (check screenshot): H=? L=?\n` +
      `📐 =====================================================\n`
    );

    // ===== STORE INDICATORS GLOBALLY (frontend reads from API) =====
    indicators = {
      nwUpper:    +nwUpper.toFixed(2),
      nwLower:    +nwLower.toFixed(2),
      atrUpper:   +atrUpper.toFixed(2),
      atrLower:   +atrLower.toFixed(2),
      atr:        +atr.toFixed(2),
      rsi:        rsiCurrent  ? +rsiCurrent.toFixed(1)  : null,
      rsiPrev:    rsiPrevious ? +rsiPrevious.toFixed(1) : null,
      candleTime,
      candleClose: +candleClose.toFixed(2)
    };

    // ===== 4. THREE ENTRY CONDITIONS (last CLOSED candle only) =====
    const c1 = candleClose <= nwLower;                          // price at/below NW lower
    const c2 = (rsiCurrent < 30) || (rsiPrevious < 30);        // RSI oversold
    const c3 = candleClose > candleOpen;                        // bullish (green) candle
    const allMet = c1 && c2 && c3;

    indicators.c1 = c1;
    indicators.c2 = c2;
    indicators.c3 = c3;
    indicators.allMet = allMet;

    const reasons = [];
    if (!c1) reasons.push(`Price did not touch lower band`);
    if (!c2) reasons.push(`RSI not oversold (cur:${fmt(rsiCurrent,1)} prev:${fmt(rsiPrevious,1)})`);
    if (!c3) reasons.push(`Bullish candle not confirmed`);

    // ===== LOG (every 10s) =====
    const tStr = new Date(candleTime).toLocaleTimeString('en-PK', { hour:'2-digit', minute:'2-digit' });
    console.log(
      `📅 ${new Date(candleTime).toLocaleDateString()} ${tStr}` +
      ` | 💰 Price: ${fmt(candleClose)}` +
      ` | 📉 NW Lower: ${fmt(nwLower)}` +
      ` | 📊 ATR Upper: ${fmt(atrUpper)} (high+ATR*0.5) | ATR Lower: ${fmt(atrLower)} (low-ATR*0.5)` +
      ` | RSI cur:${fmt(rsiCurrent,1)} prev:${fmt(rsiPrevious,1)}` +
      ` | 🕯️ Bullish: ${c3}` +
      ` | 🟢 BUY: ${allMet}` +
      (allMet ? '' : ` | ❌ ${reasons.join(' | ')}`)
    );

    // Active trade — WebSocket handles TP/SL
    if (trade.active) {
      console.log(`📊 Trade active | Live: ${livePrice} | TP: ${trade.tp} | SL: ${trade.sl}`);
      return;
    }

    // Duplicate prevention
    if (allMet && candleTime === lastSignalCandleTime) {
      console.log(`🔄 Signal already sent for this candle (${tStr}), skipping`);
      return;
    }

    // ===== GENERATE LONG SIGNAL =====
    if (allMet) {
      const entryPrice = livePrice || candleClose;
      const slPrice    = parseFloat((atrLower - 1.00).toFixed(2));  // ATR lower - $1 buffer
      const slDist     = entryPrice - slPrice;

      // Guard: reject if SL is above entry (can happen when RMA lags above price)
      if (slDist <= 0) {
        console.log(`⚠️ Signal rejected: SL (${fmt(slPrice)}) above entry (${fmt(entryPrice)}) — ATR RMA still lagging, wait for more candles`);
        return;
      }

      const tpPrice = parseFloat((entryPrice + slDist).toFixed(2));  // 1:1 R:R

      console.log(`🟢 LONG! Entry:${fmt(entryPrice)} TP:${fmt(tpPrice)} SL:${fmt(slPrice)} | RR 1:1`);

      lastSignalCandleTime = candleTime;
      lastSignalState      = 'buy';
      trade = { active: true, entry: entryPrice, tp: tpPrice, sl: slPrice, ts: Date.now() };

      journal.unshift({
        sym: 'PAXG', entry: fmt(entryPrice), tp: fmt(tpPrice), sl: fmt(slPrice),
        result: 'open', date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString()
      });

      await sendPushToAll(
        '🟢 LONG — PAXG/USDT',
        `Entry: $${fmt(entryPrice)}\nTP: $${fmt(tpPrice)}\nSL: $${fmt(slPrice)}\nR:R 1:1\nRSI: ${fmt(rsiCurrent,1)}`
      );
    } else {
      if (lastSignalState === 'buy' && candleTime !== lastSignalCandleTime) {
        lastSignalState = '';
      }
    }

  } catch (err) {
    console.error('checkSignal error:', err.message);
  }
}

// ===== MAIN LOOP: every 10 seconds =====
let isRunning = false;
async function runBotCycle() {
  if (isRunning) return;
  isRunning = true;
  try { await checkSignal(); } catch (e) { console.error('Cycle error:', e.message); }
  isRunning = false;
}
setInterval(runBotCycle, 10000);
runBotCycle();
console.log('🤖 PAXG NW Envelope bot started — checking every 10s');

// ===== API ROUTES =====
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    strategy: 'NW Envelope + ATR(14,RMA,0.5) + RSI(6)',
    livePrice,
    websocketConnected: ws && ws.readyState === WebSocket.OPEN,
    trade,
    lastSignalState,
    indicators,
    subscribers: Object.keys(subscriptions).length,
    journalCount: journal.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/state', (req, res) => {
  res.json({ trade, lastSignalState, indicators, journal: journal.slice(0, 50) });
});

app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY || '' });
});

app.post('/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  subscriptions[sub.endpoint.slice(-20)] = sub;
  console.log(`Subscriber added | Total: ${Object.keys(subscriptions).length}`);
  res.json({ success: true });
});

app.post('/unsubscribe', (req, res) => {
  if (req.body.endpoint) delete subscriptions[req.body.endpoint.slice(-20)];
  res.json({ success: true });
});

app.post('/close-trade', (req, res) => {
  trade = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
  lastSignalState = '';
  console.log('Manual trade close');
  res.json({ success: true });
});

app.post('/clear-journal', (req, res) => {
  journal = [];
  res.json({ success: true });
});

app.get('/test-notif', async (req, res) => {
  await sendPushToAll('🔔 Test', 'PAXG bot running! (browser link test)');
  res.json({ success: true, message: 'Test sent — check Pushover!', subscribers: Object.keys(subscriptions).length });
});

app.post('/test-notif', async (req, res) => {
  await sendPushToAll('🔔 Test', 'PAXG bot running!');
  res.json({ success: true, sent: Object.keys(subscriptions).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
