const express = require('express');
const fetch = require('node-fetch');
const webpush = require('web-push');
const cors = require('cors');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

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
let livePrice       = 0;
let isClosingTrade  = false;

// ===== PERSISTENT STORAGE (journal + active trade survive restarts) =====
// IMPORTANT: This only survives across Railway REDEPLOYS if a Volume is
// mounted at DATA_DIR. Without a Volume, Railway gives every new deploy a
// fresh filesystem (same as the in-memory array was losing data before) —
// this code alone fixes mid-session crashes/restarts, but for full
// redeploy-survival the Volume step below is required.
const DATA_DIR     = process.env.DATA_DIR || '/data';
const JOURNAL_FILE = path.join(DATA_DIR, 'journal.json');
const TRADE_FILE   = path.join(DATA_DIR, 'trade.json');
let persistenceAvailable = false;

function loadPersistedState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(JOURNAL_FILE)) {
      journal = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8'));
      console.log(`📂 Journal loaded from disk: ${journal.length} entries`);
    }
    if (fs.existsSync(TRADE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TRADE_FILE, 'utf8'));
      if (saved && saved.active) {
        trade = saved;
        console.log(`📂 Active trade restored from disk: Entry:${trade.entry} TP:${trade.tp} SL:${trade.sl}`);
      }
    }
    persistenceAvailable = true;
    console.log(`✅ Persistent storage ready at ${DATA_DIR}`);
  } catch (err) {
    persistenceAvailable = false;
    console.log(
      `⚠️ Persistent storage NOT available (${err.message}) — journal/trade will reset on next redeploy.\n` +
      `   To fix: in Railway → service → Settings → Volumes → add a volume mounted at ${DATA_DIR}`
    );
  }
}

function saveJournal() {
  if (!persistenceAvailable) return;
  try { fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal)); }
  catch (err) { console.log('⚠️ Failed to save journal:', err.message); }
}

function saveTrade() {
  if (!persistenceAvailable) return;
  try { fs.writeFileSync(TRADE_FILE, JSON.stringify(trade)); }
  catch (err) { console.log('⚠️ Failed to save trade:', err.message); }
}

loadPersistedState();

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

// ===== TIMEZONE HELPERS — Pakistan time (Asia/Karachi, UTC+5) =====
// Plain new Date().toLocaleDateString()/toLocaleTimeString() use the
// SERVER's default timezone (Railway containers default to UTC), not the
// user's. Locale alone (e.g. 'en-PK') only changes formatting style, not
// the actual zone — timeZone must be passed explicitly.
function pktDate(ts) {
  return new Date(ts || Date.now()).toLocaleDateString('en-PK', { timeZone: 'Asia/Karachi' });
}
function pktTime(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString('en-PK', { timeZone: 'Asia/Karachi' });
}
function pktTimeShort(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString('en-PK', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit' });
}

// ===== TP/SL CHECK (WebSocket real-time) =====
// Updates the matching 'open' journal row (by trade.ts id) to its final
// result, instead of unshifting a brand-new row — fixes the bug where every
// closed trade left a permanently-stuck duplicate "OPEN" entry behind.
function closeJournalEntry(tradeTs, result, entry, tp, sl) {
  const idx = journal.findIndex(j => j.id === tradeTs);
  if (idx !== -1) {
    journal[idx].result = result;
    journal[idx].closeDate = pktDate();
    journal[idx].closeTime = pktTime();
  } else {
    // Fallback: no matching 'open' row found (e.g. trade was restored from
    // disk before this fix existed) — create one so the result isn't lost.
    journal.unshift({
      id: tradeTs, sym: 'PAXG',
      entry: entry.toFixed(2), tp: tp.toFixed(2), sl: sl.toFixed(2),
      result, date: pktDate(), time: pktTime()
    });
  }
}

async function checkTpSl(price) {
  if (!trade.active || isClosingTrade) return;
  const { entry, tp, sl, ts } = trade;

  if (price >= tp) {
    isClosingTrade = true;
    console.log(`⚡🏆 TP HIT! Price:${price} TP:${tp}`);
    closeJournalEntry(ts, 'win', entry, tp, sl);
    trade = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
    saveJournal();
    saveTrade();
    await sendPushToAll('🏆 TP HIT — PAXG/USDT',
      `Take Profit reached!\nEntry: $${fmt(entry)}\nTP: $${fmt(tp)}\nHit: $${fmt(price)}`);
    isClosingTrade = false;
    return;
  }

  if (price <= sl) {
    isClosingTrade = true;
    console.log(`⚡🛑 SL HIT! Price:${price} SL:${sl}`);
    closeJournalEntry(ts, 'loss', entry, tp, sl);
    trade = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
    saveJournal();
    saveTrade();
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

async function fetchKlines(symbol, interval = '5m', limit = LIMIT) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return res.json();
}

// ===== MAIN SIGNAL LOGIC =====
// ╔══════════════════════════════════════════════════════════════════════╗
// ║  BUY SIGNAL ENGINE — TRUE LIVE (WebSocket-driven)                   ║
// ║  Source:  Binance paxgusdt@kline_5m WebSocket (every trade tick)    ║
// ║  History: REST API refresh on startup + every candle close           ║
// ║                                                                      ║
// ║  States:  IDLE → SETUP_LOCKED → WAITING_CONFIRMATION                ║
// ║                                                                      ║
// ║  Rules:                                                              ║
// ║  • Setup locked when live price <= NW lower AND live RSI < 30        ║
// ║  • Setup FROZEN after lock — never unlocked by indicator changes     ║
// ║  • Same candle bullish close → BUY                                   ║
// ║  • Next candle bullish close → BUY                                   ║
// ║  • Next candle bearish close → EXPIRE                                ║
// ║  • New setup in newer candle → REPLACE (rules 5 + 6)                ║
// ╚══════════════════════════════════════════════════════════════════════╝

// ── State labels ──────────────────────────────────────────────────────────
const S = {
  IDLE:   'IDLE',
  LOCKED: 'SETUP_LOCKED',
  WAIT:   'WAITING_CONFIRMATION'
};

// ── Signal state machine ──────────────────────────────────────────────────
let sm = {
  state: S.IDLE,
  setup: null
  // When state !== IDLE, setup contains:
  // {
  //   candleOpenTime:        openTime (ms) of the candle that triggered setup
  //   confirmCandleOpenTime: openTime (ms) of the confirm candle (null until known)
  //   nwLower:               frozen NW lower band at lock time
  //   atrLower:              frozen ATR lower at lock time (used for SL)
  //   rsiAtLock:             RSI value at lock time (logging only)
  //   lockedAt:              Date.now() at lock time
  // }
};

// ── Historical indicator store ────────────────────────────────────────────
// Refreshed via REST on startup and on every candle close.
// NW and ATR are expensive to compute — kept stable between candle closes.
// RSI baseline enables O(1) live RSI on every WebSocket tick.
let hist = {
  nwLower:            0,
  nwUpper:            0,
  atrLower:           0,
  atrUpper:           0,
  atr:                0,
  rsiAvgGain:         0,   // RSI(6) smoothed avg gain from last N closed candles
  rsiAvgLoss:         0,   // RSI(6) smoothed avg loss from last N closed candles
  lastClosedOpenTime: 0,
  lastClosedClose:    0,   // needed for incremental live RSI diff
  lastClosedOpen:     0,   // needed to judge bullish/bearish on candle close
  initialized:        false
};

// ── Live candle state ─────────────────────────────────────────────────────
// Updated on every WebSocket kline_5m message (fires on every trade).
let liveKline = {
  openTime: 0,
  open:     0,
  close:    0,   // = current live price
  isClosed: false
};

// ════════════════════════════════════════════════════════════════════════════
//  HELPER: RSI with baseline state (avgGain/avgLoss)
//  Same Wilder smoothing as calcRSI, but also returns the smoothed state
//  so we can do O(1) incremental updates on every live tick.
// ════════════════════════════════════════════════════════════════════════════
function calcRSIState(closes, period) {
  if (closes.length < period + 1) return { rsi: null, avgGain: 0, avgLoss: 0 };
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0))  / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  const rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  return { rsi, avgGain: ag, avgLoss: al };
}

// ════════════════════════════════════════════════════════════════════════════
//  HELPER: Live RSI — O(1) incremental update
//  Uses hist.rsiAvgGain/Loss (from last closed candle) + live price diff.
// ════════════════════════════════════════════════════════════════════════════
function computeLiveRSI(liveClose) {
  if (!hist.initialized) return null;
  const diff = liveClose - hist.lastClosedClose;
  const ag   = (hist.rsiAvgGain * 5 + Math.max(diff, 0))  / 6;
  const al   = (hist.rsiAvgLoss * 5 + Math.max(-diff, 0)) / 6;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

// ════════════════════════════════════════════════════════════════════════════
//  HELPER: Refresh historical data via REST
//  Called: (1) on startup  (2) on every candle close  (3) on WS reconnect
//  Computes NW (O(n²)), ATR, and RSI baseline — safe because called ≤1/5min
// ════════════════════════════════════════════════════════════════════════════
async function refreshHistoricalData() {
  try {
    const klines = await fetchKlines('PAXGUSDT', '5m', LIMIT);
    const len    = klines.length;
    const ci     = len - 2;   // last closed candle index (len-1 is live)

    const closes = klines.map(k => parseFloat(k[4]));
    const opens  = klines.map(k => parseFloat(k[1]));
    const highs  = klines.map(k => parseFloat(k[2]));
    const lows   = klines.map(k => parseFloat(k[3]));

    const closedCloses = closes.slice(0, ci + 1);
    const closedHighs  = highs.slice(0,  ci + 1);
    const closedLows   = lows.slice(0,   ci + 1);

    // NW — O(n²), only runs once per candle close
    const nw      = calcNW(closedCloses, 8);
    const nwLower = nw.mid - nw.mae;
    const nwUpper = nw.mid + nw.mae;

    // ATR
    const atr      = calcATR(closedHighs, closedLows, closedCloses, 14);
    const atrLower = closedLows[ci]  - atr * 0.5;
    const atrUpper = closedHighs[ci] + atr * 0.5;

    // RSI baseline for O(1) live updates
    const rsiState = calcRSIState(closedCloses, 6);

    hist = {
      nwLower, nwUpper,
      atrLower, atrUpper, atr,
      rsiAvgGain:         rsiState.avgGain,
      rsiAvgLoss:         rsiState.avgLoss,
      lastClosedOpenTime: parseInt(klines[ci][0]),
      lastClosedClose:    closes[ci],
      lastClosedOpen:     opens[ci],
      initialized:        true
    };

    // Expose to API
    indicators = {
      nwUpper:    +nwUpper.toFixed(2),
      nwLower:    +nwLower.toFixed(2),
      atrUpper:   +atrUpper.toFixed(2),
      atrLower:   +atrLower.toFixed(2),
      atr:        +atr.toFixed(2),
      rsi:        rsiState.rsi ? +rsiState.rsi.toFixed(1) : null,
      candleTime: hist.lastClosedOpenTime,
      candleClose: +hist.lastClosedClose.toFixed(2),
      smState:    sm.state
    };

    console.log(
      `♻️  Hist OK | NW⬇${nwLower.toFixed(2)} ATR⬇${atrLower.toFixed(2)}` +
      ` RSI:${rsiState.rsi ? rsiState.rsi.toFixed(1) : '?'}` +
      ` | Last closed: ${pktTimeShort(hist.lastClosedOpenTime)}`
    );
  } catch (err) {
    console.error('refreshHistoricalData error:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  HELPER: Lock a new setup
// ════════════════════════════════════════════════════════════════════════════
function lockSetup(candleOpenTime, nwLower, atrLower, rsiAtLock) {
  sm = {
    state: S.LOCKED,
    setup: {
      candleOpenTime,
      confirmCandleOpenTime: null,   // set when confirm candle starts
      nwLower, atrLower, rsiAtLock,
      lockedAt: Date.now()
    }
  };
  console.log(
    `🔒 SETUP LOCKED | candle:${pktTimeShort(candleOpenTime)}` +
    ` | NW⬇:${fmt(nwLower)} ATR⬇:${fmt(atrLower)} RSI:${fmt(rsiAtLock,1)}`
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  HELPER: Execute BUY and reset state machine
// ════════════════════════════════════════════════════════════════════════════
async function executeBuy(entryPrice, atrLower, rsiAtEntry) {
  const slPrice = parseFloat((atrLower - 1.00).toFixed(2));
  const slDist  = entryPrice - slPrice;

  if (slDist <= 0) {
    console.log(`⚠️ BUY rejected: SL(${fmt(slPrice)}) >= entry(${fmt(entryPrice)}) → IDLE`);
    sm = { state: S.IDLE, setup: null };
    return;
  }

  const tpPrice = parseFloat((entryPrice + slDist).toFixed(2));

  trade = { active: true, entry: entryPrice, tp: tpPrice, sl: slPrice, ts: Date.now() };
  sm    = { state: S.IDLE, setup: null };

  journal.unshift({
    id: trade.ts,   // unique key — lets TP/SL handler UPDATE this row instead of creating a duplicate
    sym: 'PAXG', entry: fmt(entryPrice), tp: fmt(tpPrice), sl: fmt(slPrice),
    result: 'open', date: pktDate(), time: pktTime()
  });
  saveTrade();
  saveJournal();

  console.log(`🟢 BUY | Entry:${fmt(entryPrice)} TP:${fmt(tpPrice)} SL:${fmt(slPrice)} RSI:${fmt(rsiAtEntry,1)} | R:R 1:1`);

  await sendPushToAll(
    '🟢 LONG — PAXG/USDT',
    `Entry: $${fmt(entryPrice)}\nTP: $${fmt(tpPrice)}\nSL: $${fmt(slPrice)}\nR:R 1:1\nRSI: ${fmt(rsiAtEntry,1)}`
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  STATE MACHINE — called on every live WebSocket tick
//  Runs at trade tick frequency (~10-500ms) — must be lightweight (no REST)
// ════════════════════════════════════════════════════════════════════════════
function onLiveTick(liveClose, rsiLive) {
  if (!hist.initialized || trade.active) return;

  const liveSetupMet = liveClose <= hist.nwLower && rsiLive < 30;
  const ot           = liveKline.openTime;   // current running candle openTime

  switch (sm.state) {

    // ── IDLE: wait for live setup conditions ──────────────────────────────
    case S.IDLE:
      if (liveSetupMet) {
        lockSetup(ot, hist.nwLower, hist.atrLower, rsiLive);
      }
      break;

    // ── SETUP_LOCKED: frozen — only watch for replacement ─────────────────
    case S.LOCKED:
      // Rule 8: same candle already locked — ignore repeated ticks
      if (ot === sm.setup.candleOpenTime) break;

      // Rule 5: NEW candle with new setup → replace
      if (liveSetupMet) {
        console.log(`🔄 REPLACED (LOCKED→LOCKED) | ${pktTimeShort(sm.setup.candleOpenTime)} → ${pktTimeShort(ot)}`);
        lockSetup(ot, hist.nwLower, hist.atrLower, rsiLive);
      }
      break;

    // ── WAITING_CONFIRMATION: record confirm candle + watch replacement ────
    case S.WAIT:
      // First tick of the confirm candle — record its openTime
      if (sm.setup.confirmCandleOpenTime === null && ot !== sm.setup.candleOpenTime) {
        sm.setup.confirmCandleOpenTime = ot;
        console.log(`⏳ Confirm candle started: ${pktTimeShort(ot)}`);
      }

      // Rule 5: NEW candle (past confirm candle) with new setup → replace
      if (sm.setup.confirmCandleOpenTime !== null &&
          ot !== sm.setup.candleOpenTime &&
          ot !== sm.setup.confirmCandleOpenTime &&
          liveSetupMet) {
        console.log(`🔄 REPLACED (WAITING→LOCKED) | → ${pktTimeShort(ot)}`);
        lockSetup(ot, hist.nwLower, hist.atrLower, rsiLive);
      }
      break;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  STATE MACHINE — called on candle CLOSE events
//  Handles bullish/bearish confirmation and expiry.
//  Entry price = live price at the moment of close (most accurate).
// ════════════════════════════════════════════════════════════════════════════
async function onCandleClose(closedOpenTime, closedOpen, closedClose) {
  if (trade.active) return;

  const bullish = closedClose > closedOpen;

  switch (sm.state) {

    // ── SETUP_LOCKED: check if the setup candle just closed ───────────────
    case S.LOCKED:
      if (closedOpenTime !== sm.setup.candleOpenTime) break;

      if (bullish) {
        // Rule 2: same candle closed bullish → BUY
        // Entry = closedClose (exact close of this bullish candle)
        // NOT liveKline.close — that would be next candle's price due to 1.5s delay
        console.log(`✅ SETUP CANDLE BULLISH → BUY at close: ${closedClose}`);
        await executeBuy(closedClose, sm.setup.atrLower, sm.setup.rsiAtLock);
      } else {
        // Rule 3: bearish → keep setup, wait for next candle
        sm.state = S.WAIT;
        // confirmCandleOpenTime will be set by onLiveTick when new candle starts
        console.log(`⏳ WAITING CONFIRMATION | Setup candle bearish`);
      }
      break;

    // ── WAITING_CONFIRMATION: check if confirm candle just closed ─────────
    case S.WAIT:
      if (!sm.setup.confirmCandleOpenTime) break;
      if (closedOpenTime !== sm.setup.confirmCandleOpenTime) {
        // Candle after confirm closed — window missed
        if (closedOpenTime > sm.setup.confirmCandleOpenTime) {
          console.log(`⚠️ CONFIRM WINDOW MISSED → IDLE`);
          sm = { state: S.IDLE, setup: null };
        }
        break;
      }

      if (bullish) {
        // Rule 3: confirm candle bullish → BUY
        // Entry = closedClose (exact close of confirmation candle)
        console.log(`✅ CONFIRM CANDLE BULLISH → BUY at close: ${closedClose}`);
        await executeBuy(closedClose, sm.setup.atrLower, sm.setup.rsiAtLock);
      } else {
        // Rule 4: both bearish → expire
        console.log(`❌ EXPIRED | Both candles bearish → IDLE`);
        sm = { state: S.IDLE, setup: null };
      }
      break;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  SIGNAL WEBSOCKET — Binance kline_5m stream
//  Fires on every trade tick with aggregated candle OHLCV.
//  Message rate: same as trade frequency (~1-100ms during active market)
// ════════════════════════════════════════════════════════════════════════════
let wsSig = null;

function connectSignalWebSocket() {
  try {
    wsSig = new WebSocket('wss://stream.binance.com:9443/ws/paxgusdt@kline_5m');

    wsSig.on('open', () => {
      console.log('📡 Signal WS connected (kline_5m) — TRUE LIVE mode active');
    });

    wsSig.on('message', async (data) => {
      try {
        const k = JSON.parse(data).k;   // kline object from Binance
        /*  k fields used:
            k.t  = candle openTime (ms)
            k.o  = open
            k.c  = close (= latest trade price)
            k.x  = isClosed (true on final tick of that candle)
        */

        const prevOpenTime = liveKline.openTime;

        // Update live candle state
        liveKline = {
          openTime: k.t,
          open:     parseFloat(k.o),
          close:    parseFloat(k.c),
          isClosed: k.x
        };

        // Keep global livePrice in sync (used by TP/SL trade WebSocket)
        livePrice = liveKline.close;

        // ── CANDLE CLOSE EVENT ─────────────────────────────────────────
        if (k.x) {
          console.log(
            `🕯️  Candle closed ${pktTimeShort(k.t)}` +
            ` O:${parseFloat(k.o).toFixed(2)} C:${parseFloat(k.c).toFixed(2)}` +
            ` ${parseFloat(k.c) > parseFloat(k.o) ? '🟢' : '🔴'}`
          );

          // FIX: Binance REST /klines can lag a few hundred ms behind the WS
          // close event — calling it instantly can return a snapshot where
          // the just-closed candle isn't appended yet, making refreshHistoricalData()
          // pick up the PREVIOUS candle as "last closed" (off-by-one bug).
          // Wait briefly, then verify REST agrees with the WS-confirmed close time;
          // retry once more if it's still stale.
          await new Promise(r => setTimeout(r, 1500));
          await refreshHistoricalData();

          if (hist.lastClosedOpenTime !== k.t) {
            console.log(
              `⚠️ REST lag detected: hist=${pktTimeShort(hist.lastClosedOpenTime)}` +
              ` vs WS-confirmed=${pktTimeShort(k.t)} — retrying in 2s`
            );
            await new Promise(r => setTimeout(r, 2000));
            await refreshHistoricalData();

            if (hist.lastClosedOpenTime !== k.t) {
              console.log(`⚠️ REST still lagging after retry — will self-correct on next candle close or 5-min safety refresh`);
            } else {
              console.log(`✅ REST caught up after retry`);
            }
          }

          // Process state machine for this close event
          await onCandleClose(k.t, parseFloat(k.o), parseFloat(k.c));
          return;
        }

        // ── LIVE TICK ──────────────────────────────────────────────────
        if (!hist.initialized) return;

        // Compute live RSI — O(1), no REST call needed
        const rsiLive = computeLiveRSI(liveKline.close);

        // Update indicators for API on every tick (lightweight)
        if (indicators) {
          indicators.livePrice  = +liveKline.close.toFixed(2);
          indicators.rsiLive    = rsiLive ? +rsiLive.toFixed(1) : null;
          indicators.smState    = sm.state;
          indicators.smSetup    = sm.setup ? {
            candleOpenTime:        sm.setup.candleOpenTime,
            confirmCandleOpenTime: sm.setup.confirmCandleOpenTime
          } : null;
        }

        // Run state machine on this live tick
        onLiveTick(liveKline.close, rsiLive);

      } catch (e) {
        console.error('Signal WS message error:', e.message);
      }
    });

    wsSig.on('error', (e) => console.log('📡 Signal WS error:', e.message));

    wsSig.on('close', () => {
      console.log('📡 Signal WS closed — reconnecting in 3s');
      setTimeout(connectSignalWebSocket, 3000);
    });

  } catch (e) {
    console.error('Signal WS connect failed:', e.message);
    setTimeout(connectSignalWebSocket, 3000);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  STARTUP — load history then connect signal WebSocket
// ════════════════════════════════════════════════════════════════════════════
refreshHistoricalData().then(() => {
  connectSignalWebSocket();
});

// Safety net: re-sync history every 5 minutes in case WS close was missed
setInterval(refreshHistoricalData, 5 * 60 * 1000);

console.log('🤖 PAXG Signal Bot — TRUE LIVE mode | kline_5m WebSocket | State Machine ready');


// ===== API ROUTES =====
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    strategy: 'NW Envelope + ATR(14,RMA,0.5) + RSI(6)',
    livePrice,
    websocketConnected: ws && ws.readyState === WebSocket.OPEN,
    trade,
    signalState: sm.state,
    signalSetup: sm.setup,
    indicators,
    subscribers: Object.keys(subscriptions).length,
    journalCount: journal.length,
    persistenceAvailable,
    timestamp: new Date().toISOString()
  });
});

app.get('/state', (req, res) => {
  res.json({ trade, signalState: sm.state, signalSetup: sm.setup, indicators, journal: journal.slice(0, 50) });
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
  if (trade.active) {
    closeJournalEntry(trade.ts, 'manual', trade.entry, trade.tp, trade.sl);
    saveJournal();
  }
  trade = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
  sm = { state: S.IDLE, setup: null };
  saveTrade();
  console.log('Manual trade close');
  res.json({ success: true });
});

app.post('/clear-journal', (req, res) => {
  journal = [];
  saveJournal();
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
