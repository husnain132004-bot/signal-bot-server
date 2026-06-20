const express = require('express');
const fetch = require('node-fetch');
const webpush = require('web-push');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ===== VAPID KEYS =====
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@signalpro.app';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('✅ Web Push configured');
} else {
  console.log('⚠️ VAPID keys not set - push notifications disabled');
}

// ===== STORAGE =====
let subscriptions = {};
let trade = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
let journal = [];
let lastSignalState = '';

// ===== INDICATOR MATH =====
function gaussKernel(x, bw) {
  return Math.exp(-(x * x) / (2 * bw * bw));
}

function calcNW(closes, bandwidth) {
  const n = closes.length;
  const lookback = Math.min(n, 200);
  const start = n - lookback;
  let nwLine = [];
  for (let i = start; i < n; i++) {
    let sumW = 0, sumWY = 0;
    const winStart = Math.max(start, i - bandwidth * 3);
    for (let j = winStart; j <= i; j++) {
      const w = gaussKernel(i - j, bandwidth);
      sumW += w;
      sumWY += w * closes[j];
    }
    nwLine.push(sumWY / sumW);
  }
  let maeSum = 0;
  for (let k = 0; k < nwLine.length; k++) {
    maeSum += Math.abs(closes[start + k] - nwLine[k]);
  }
  const mae = maeSum / nwLine.length;
  const mid = nwLine[nwLine.length - 1];
  return { mid, mae };
}

function calcATR(highs, lows, closes, period) {
  let trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

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
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function fmt(v, d = 2) {
  return v != null ? parseFloat(v).toFixed(d) : '---';
}

// ===== PUSHOVER (system-level guaranteed notifications) =====
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;
const PUSHOVER_USER  = process.env.PUSHOVER_USER;

async function sendPushover(title, message) {
  if (!PUSHOVER_TOKEN || !PUSHOVER_USER) {
    console.log('⚠️ Pushover not configured');
    return;
  }
  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: PUSHOVER_TOKEN,
        user: PUSHOVER_USER,
        title,
        message,
        priority: '1',
        sound: 'persistent'
      })
    });
    const data = await res.json();
    if (data.status === 1) {
      console.log('✅ Pushover sent:', title);
    } else {
      console.log('⚠️ Pushover error:', JSON.stringify(data));
    }
  } catch (err) {
    console.log('Pushover send error:', err.message);
  }
}

// ===== SEND PUSH (Web Push + Pushover together) =====
async function sendPushToAll(title, body) {
  // Pushover - guaranteed system-level delivery
  await sendPushover(title, body);

  // Web Push - for browser/PWA (best effort)
  const subList = Object.values(subscriptions);
  if (subList.length === 0) {
    console.log('No web push subscribers');
    return;
  }
  console.log(`Sending web push to ${subList.length} subscriber(s): ${title}`);
  const payload = JSON.stringify({ title, body });
  for (const sub of subList) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      console.log('Push error (removing dead sub):', err.statusCode);
      const key = Object.keys(subscriptions).find(k => subscriptions[k] === sub);
      if (key) delete subscriptions[key];
    }
  }
}

// ===== FETCH BINANCE =====
async function fetchKlines(symbol, interval = '15m', limit = 250) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  return await res.json();
}

// ===== STRATEGY: NW ENVELOPE + ATR + RSI(6) =====
async function checkSignal() {
  try {
    const klines = await fetchKlines('PAXGUSDT');
    const closes = klines.map(k => parseFloat(k[4]));
    const opens  = klines.map(k => parseFloat(k[1]));
    const highs  = klines.map(k => parseFloat(k[2]));
    const lows   = klines.map(k => parseFloat(k[3]));
    const price  = closes[closes.length - 1];

    const nw = calcNW(closes, 8);
    const nwLower = nw.mid - nw.mae * 2;

    const atr = calcATR(highs, lows, closes, 14);
    const atrMid = calcEMA(closes, 14);
    const atrLower = atrMid - atr * 0.5;

    const rsi = calcRSI(closes, 6);

    const lastIdx = closes.length - 1;
    const bullishCandle = closes[lastIdx] > opens[lastIdx];

    const c1 = price <= nwLower;
    const c2 = rsi < 30;
    const c3 = bullishCandle;
    const passCount = [c1, c2, c3].filter(Boolean).length;
    const allMet = passCount === 3;

    if (trade.active) {
      const { entry, tp, sl } = trade;

      if (price >= tp) {
        console.log(`🏆 TP HIT! Price: ${price}, TP: ${tp}`);
        journal.unshift({
          sym: 'PAXG', entry: entry.toFixed(2), tp: tp.toFixed(2), sl: sl.toFixed(2),
          result: 'win', date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString()
        });
        trade = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
        lastSignalState = '';
        await sendPushToAll('🏆 TP HIT — PAXG/USDT', `Take Profit reached!\nEntry: $${fmt(entry)}\nTP: $${fmt(tp)}`);
        return;
      }

      if (price <= sl) {
        console.log(`🛑 SL HIT! Price: ${price}, SL: ${sl}`);
        journal.unshift({
          sym: 'PAXG', entry: entry.toFixed(2), tp: tp.toFixed(2), sl: sl.toFixed(2),
          result: 'loss', date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString()
        });
        trade = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
        lastSignalState = '';
        await sendPushToAll('🛑 SL HIT — PAXG/USDT', `Stop Loss hit!\nEntry: $${fmt(entry)}\nSL: $${fmt(sl)}`);
        return;
      }

      console.log(`📊 Trade active | Price: ${price} | TP: ${tp} | SL: ${sl}`);
      return;
    }

    if (allMet) {
      const slPrice = atrLower - 1.00;
      const slDist = price - slPrice;

      if (slDist <= 0) {
        console.log(`⚠️ Signal rejected: invalid SL distance`);
        return;
      }

      const tpPrice = price + slDist;

      if (lastSignalState === 'buy') {
        console.log('🔄 LONG already notified, skipping');
        return;
      }

      console.log(`🟢 LONG SIGNAL! Price: ${price}, TP: ${tpPrice.toFixed(2)}, SL: ${slPrice.toFixed(2)}`);

      trade = { active: true, entry: price, tp: parseFloat(tpPrice.toFixed(2)), sl: parseFloat(slPrice.toFixed(2)), ts: Date.now() };
      lastSignalState = 'buy';

      journal.unshift({
        sym: 'PAXG', entry: fmt(price), tp: tpPrice.toFixed(2), sl: slPrice.toFixed(2),
        result: 'open', date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString()
      });

      await sendPushToAll('🟢 LONG — PAXG/USDT', `Entry: $${fmt(price)}\nTP: $${tpPrice.toFixed(2)}\nSL: $${slPrice.toFixed(2)}\nR:R 1:1`);

    } else {
      if (lastSignalState !== '') lastSignalState = '';
      console.log(`⏳ Waiting: ${passCount}/3 | RSI(6): ${fmt(rsi, 1)} | Price: ${price} | NW Lower: ${fmt(nwLower)}`);
    }

  } catch (err) {
    console.error('Error checking signal:', err.message);
  }
}

// ===== MAIN LOOP =====
let isRunning = false;
async function runBotCycle() {
  if (isRunning) return;
  isRunning = true;
  try {
    await checkSignal();
  } catch (e) {
    console.error('Bot cycle error:', e.message);
  }
  isRunning = false;
}

setInterval(runBotCycle, 10000);
runBotCycle();
console.log('🤖 PAXG NW Envelope bot started - checking every 10 seconds');

// ===== API ROUTES =====
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    strategy: 'NW Envelope + ATR + RSI(6)',
    trade,
    lastSignalState,
    subscribers: Object.keys(subscriptions).length,
    journalCount: journal.length,
    timestamp: new Date().toISOString()
  });
});

app.post('/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const key = subscription.endpoint.slice(-20);
  subscriptions[key] = subscription;
  console.log(`New subscriber: ${key} | Total: ${Object.keys(subscriptions).length}`);
  res.json({ success: true, message: 'Subscribed successfully' });
});

app.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) {
    const key = endpoint.slice(-20);
    delete subscriptions[key];
  }
  res.json({ success: true });
});

app.get('/state', (req, res) => {
  res.json({ trade, lastSignalState, journal: journal.slice(0, 50) });
});

app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY || '' });
});

app.post('/close-trade', (req, res) => {
  trade = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
  lastSignalState = '';
  console.log('Manual close');
  res.json({ success: true });
});

app.post('/clear-journal', (req, res) => {
  journal = [];
  res.json({ success: true });
});

app.post('/test-notif', async (req, res) => {
  await sendPushToAll('🔔 Test Notification', 'PAXG NW Envelope server is working!');
  res.json({ success: true, sent: Object.keys(subscriptions).length });
});

// GET version for easy browser testing (just open the link)
app.get('/test-notif', async (req, res) => {
  await sendPushToAll('🔔 Test Notification', 'PAXG NW Envelope server is working! (sent via browser link)');
  res.json({ success: true, message: 'Test notification sent! Check your Pushover app.', webPushSubscribers: Object.keys(subscriptions).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
