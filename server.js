const express = require('express');
const fetch = require('node-fetch');
const webpush = require('web-push');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ===== VAPID KEYS (Web Push) =====
// These will be set via Render environment variables
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@signalpro.app';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('✅ Web Push configured');
} else {
  console.log('⚠️ VAPID keys not set - push notifications disabled');
}

// ===== IN-MEMORY STORAGE =====
// Subscribers (phone subscriptions)
let subscriptions = {};

// Active trades
let trades = {
  paxg: { active: false, entry: 0, tp: 0, sl: 0, ts: 0 },
  btc:  { active: false, entry: 0, tp: 0, sl: 0, ts: 0 }
};

// Journal
let journal = [];

// Last signal state (to avoid duplicate notifications)
let lastSignal = { paxg: '', btc: '' };

// ===== INDICATOR CALCULATIONS =====
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
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

// ===== SEND PUSH NOTIFICATION =====
async function sendPushToAll(title, body) {
  const subList = Object.values(subscriptions);
  if (subList.length === 0) {
    console.log('No subscribers to notify');
    return;
  }
  console.log(`Sending push to ${subList.length} subscriber(s): ${title}`);
  const payload = JSON.stringify({ title, body });
  for (const sub of subList) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      console.log('Push error (removing dead sub):', err.statusCode);
      // Remove dead subscription
      const key = Object.keys(subscriptions).find(k => subscriptions[k] === sub);
      if (key) delete subscriptions[key];
    }
  }
}

// ===== FETCH BINANCE DATA =====
async function fetchKlines(symbol, interval = '15m', limit = 250) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  return await res.json();
}

// ===== STRATEGY LOGIC =====
async function checkSignal(sym) {
  const isBtc = sym === 'btc';
  const symbol = isBtc ? 'BTCUSDT' : 'PAXGUSDT';
  const dec = isBtc ? 0 : 2;

  try {
    const klines = await fetchKlines(symbol);
    const closes = klines.map(k => parseFloat(k[4]));
    const opens  = klines.map(k => parseFloat(k[1]));
    const lows   = klines.map(k => parseFloat(k[3]));

    const price = closes[closes.length - 1];
    const ema20  = calcEMA(closes, 20);
    const ema50  = calcEMA(closes, 50);
    const ema200 = calcEMA(closes, 200);
    const rsi    = calcRSI(closes, 14);
    const swingLow = Math.min(...lows.slice(-20));
    const bullishCandle = closes[closes.length - 1] > opens[opens.length - 1];

    // 5 Classic conditions
    const c1 = ema20 > ema50 && ema50 > ema200;
    const c2 = Math.abs(price - ema20) / ema20 < 0.005 || Math.abs(price - ema50) / ema50 < 0.005;
    const c3 = bullishCandle;
    const c4 = rsi >= 50 && rsi <= 70;
    const c5 = price > ema200;

    const passCount = [c1, c2, c3, c4, c5].filter(Boolean).length;
    const allMet = passCount === 5;

    // ===== TRADE ACTIVE: CHECK TP/SL =====
    if (trades[sym].active) {
      const { entry, tp, sl } = trades[sym];

      if (price >= tp) {
        // TP HIT
        console.log(`🏆 ${sym.toUpperCase()} TP HIT! Price: ${price}, TP: ${tp}`);
        journal.unshift({
          sym: sym.toUpperCase(), entry: entry.toFixed(dec),
          tp: tp.toFixed(dec), sl: sl.toFixed(dec),
          result: 'win', date: new Date().toLocaleDateString(),
          time: new Date().toLocaleTimeString()
        });
        trades[sym] = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
        lastSignal[sym] = '';
        await sendPushToAll(
          `🏆 TP HIT — ${sym.toUpperCase()}/USDT`,
          `Take Profit reached!\nEntry: $${fmt(entry, dec)}\nTP: $${fmt(tp, dec)}`
        );
        return;
      }

      if (price <= sl) {
        // SL HIT
        console.log(`❌ ${sym.toUpperCase()} SL HIT! Price: ${price}, SL: ${sl}`);
        journal.unshift({
          sym: sym.toUpperCase(), entry: entry.toFixed(dec),
          tp: tp.toFixed(dec), sl: sl.toFixed(dec),
          result: 'loss', date: new Date().toLocaleDateString(),
          time: new Date().toLocaleTimeString()
        });
        trades[sym] = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
        lastSignal[sym] = '';
        await sendPushToAll(
          `❌ SL HIT — ${sym.toUpperCase()}/USDT`,
          `Stop Loss hit!\nEntry: $${fmt(entry, dec)}\nSL: $${fmt(sl, dec)}`
        );
        return;
      }

      // Trade still active
      console.log(`📊 ${sym.toUpperCase()} trade active | Price: ${price} | TP: ${tp} | SL: ${sl}`);
      return;
    }

    // ===== NO ACTIVE TRADE: CHECK BUY SIGNAL =====
    if (allMet) {
      const buffer   = price * 0.0005;
      const slPrice  = swingLow - buffer;
      const slDist   = (price - slPrice) / price * 100;

      if (slDist > 1.5 || slDist <= 0) {
        console.log(`⚠️ ${sym.toUpperCase()} signal rejected: SL too wide (${slDist.toFixed(2)}%)`);
        return;
      }

      const tpPrice = parseFloat((price * 1.01).toFixed(dec));
      const slFinal = parseFloat(slPrice.toFixed(dec));

      if (lastSignal[sym] === 'buy') {
        console.log(`🔄 ${sym.toUpperCase()} BUY already notified, skipping`);
        return;
      }

      console.log(`🟢 ${sym.toUpperCase()} BUY SIGNAL! Price: ${price}, TP: ${tpPrice}, SL: ${slFinal}`);

      // Lock trade
      trades[sym] = { active: true, entry: price, tp: tpPrice, sl: slFinal, ts: Date.now() };
      lastSignal[sym] = 'buy';

      // Add to journal
      journal.unshift({
        sym: sym.toUpperCase(), entry: fmt(price, dec),
        tp: tpPrice.toFixed(dec), sl: slFinal.toFixed(dec),
        result: 'open', date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString()
      });

      await sendPushToAll(
        `🟢 BUY — ${sym.toUpperCase()}/USDT`,
        `Entry: $${fmt(price, dec)}\nTP: $${tpPrice.toFixed(dec)}\nSL: $${slFinal.toFixed(dec)}\nScore: 5/5`
      );

    } else {
      if (lastSignal[sym] !== '') lastSignal[sym] = '';
      console.log(`⏳ ${sym.toUpperCase()} waiting: ${passCount}/5 conditions | RSI: ${fmt(rsi, 1)} | Price: ${price}`);
    }

  } catch (err) {
    console.error(`Error checking ${sym}:`, err.message);
  }
}

// ===== MAIN LOOP =====
let isRunning = false;
async function runBotCycle() {
  if (isRunning) return;
  isRunning = true;
  try {
    await checkSignal('paxg');
    await checkSignal('btc');
  } catch (e) {
    console.error('Bot cycle error:', e.message);
  }
  isRunning = false;
}

// Run every 10 seconds
setInterval(runBotCycle, 10000);
runBotCycle(); // Run immediately on start
console.log('🤖 Signal bot started - checking every 10 seconds');

// ===== API ROUTES =====

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    trades,
    lastSignal,
    subscribers: Object.keys(subscriptions).length,
    journalCount: journal.length,
    timestamp: new Date().toISOString()
  });
});

// Subscribe to push notifications
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

// Unsubscribe
app.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) {
    const key = endpoint.slice(-20);
    delete subscriptions[key];
  }
  res.json({ success: true });
});

// Get current state (for app dashboard)
app.get('/state', (req, res) => {
  res.json({ trades, lastSignal, journal: journal.slice(0, 50) });
});

// Get VAPID public key (for app to subscribe)
app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY || '' });
});

// Manual close trade (from app)
app.post('/close-trade', (req, res) => {
  const { sym } = req.body;
  if (sym && trades[sym]) {
    trades[sym] = { active: false, entry: 0, tp: 0, sl: 0, ts: 0 };
    lastSignal[sym] = '';
    console.log(`Manual close: ${sym}`);
  }
  res.json({ success: true });
});

// Clear journal
app.post('/clear-journal', (req, res) => {
  journal = [];
  res.json({ success: true });
});

// Test notification
app.post('/test-notif', async (req, res) => {
  await sendPushToAll('🔔 Test Notification', 'SignalPro server is working!');
  res.json({ success: true, sent: Object.keys(subscriptions).length });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
