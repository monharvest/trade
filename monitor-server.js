'use strict';

const io = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

require('dotenv').config();

const { createStore, newId, seedAlerts } = require('./lib/store');
const { evaluateAll, formatTelegram, needsPrime, prime, isPastTarget } = require('./lib/evaluator');

const CHECK_INTERVAL = 20 * 60 * 1000;
const EVAL_DEBOUNCE_MS = 10 * 1000;
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PRICE_LOG_THRESHOLD = 5;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'sid';

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : __dirname);
const store = createStore(path.join(DATA_DIR, 'alerts.json'), log);

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is unset — refusing to start');
  process.exit(1);
}

let currentPrice = null;
let lastPriceAt = null;
let lastLoggedPrice = null;
let socket = null;
let db = { version: 1, alerts: [] };
let evalTimer = null;
let primedOnce = false;

const loginFails = new Map(); // ip -> { count, reset }; in-memory is fine for one machine

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function logPriceUpdate(price, source) {
  if (!lastLoggedPrice || Math.abs(price - lastLoggedPrice) >= PRICE_LOG_THRESHOLD) {
    log(`💰 Price updated: ${price} MNT (from ${source})`);
    lastLoggedPrice = price;
  }
}

function setPrice(price, source) {
  currentPrice = price;
  lastPriceAt = Date.now();
  logPriceUpdate(price, source);
  if (!evalTimer) {
    evalTimer = setTimeout(() => {
      evalTimer = null;
      checkPriceAndAlert().catch((err) => log(`⚠️ eval error: ${err.message}`));
    }, EVAL_DEBOUNCE_MS);
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function signSession() {
  const exp = String(Date.now() + SESSION_MS);
  const sig = crypto.createHmac('sha256', ADMIN_PASSWORD).update(exp).digest('hex');
  return `${exp}.${sig}`;
}

function validSession(token) {
  if (!token || !token.includes('.')) return false;
  const i = token.lastIndexOf('.');
  const exp = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', ADMIN_PASSWORD).update(exp).digest('hex');
  if (!safeEqual(sig, expected)) return false;
  return Date.now() < Number(exp);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return null;
}

function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.reset) {
    loginFails.delete(ip);
    return false;
  }
  return rec.count >= 5;
}

function recordLoginFail(ip) {
  const rec = loginFails.get(ip);
  if (!rec || Date.now() > rec.reset) {
    loginFails.set(ip, { count: 1, reset: Date.now() + 15 * 60 * 1000 });
    return;
  }
  rec.count += 1;
}

async function persist() {
  await store.save(db);
}

async function sendTelegramNotification(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log('⚠️ Telegram credentials not configured');
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
    });
    if (response.ok) {
      log('✅ Telegram notification sent successfully');
      return true;
    }
    log(`❌ Telegram API error: ${await response.text()}`);
    return false;
  } catch (error) {
    log(`❌ Failed to send Telegram notification: ${error.message}`);
    return false;
  }
}

async function scrapePriceFromWebsite() {
  const endpoints = [
    'https://trade.mn/api/v2/peatio/public/markets/usdtmnt/tickers',
    'https://trade.mn/api/v2/markets/usdtmnt/ticker',
    'https://trade.mn/api/markets/usdtmnt/ticker',
  ];
  for (const url of endpoints) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const data = await response.json();
      const price = data?.ticker?.last || data?.last || data?.price;
      if (price) {
        const priceNum = parseFloat(price);
        log(`💰 Scraped price from API (${url}): ${priceNum} MNT`);
        return priceNum;
      }
    } catch (error) {
      log(`⚠️ Failed endpoint ${url}: ${error.message}`);
    }
  }
  log('❌ All API endpoints failed');
  return null;
}

async function checkPriceAndAlert() {
  let price = currentPrice;
  if (!price) {
    log('⚠️ No WebSocket price data, trying API scraping...');
    price = await scrapePriceFromWebsite();
    if (price) {
      currentPrice = price;
      lastPriceAt = Date.now();
    }
  }
  if (!price) {
    log('⚠️ No price data available from any source');
    return { ok: false, fired: 0 };
  }

  if (!primedOnce) {
    let primed = 0;
    for (const alert of db.alerts) {
      if (needsPrime(alert)) {
        prime(alert, price);
        primed += 1;
      }
    }
    primedOnce = true;
    if (primed) {
      await persist();
      log(`🧭 Primed ${primed} alert(s) against ${price} MNT — no Telegram`);
    }
  }

  const { fires, changed } = evaluateAll(db.alerts, price);
  if (changed) await persist();
  for (const alert of fires) {
    await sendTelegramNotification(formatTelegram(alert, price));
    log(`🔔 Alert ${alert.id} fired: ${alert.direction} ${alert.target}`);
  }
  if (!fires.length) log(`✅ Price checked ${price} MNT — no alert`);
  return { ok: true, fired: fires.length, currentPrice: price };
}

function connectToTrade() {
  log('🔌 Connecting to Trade.mn WebSocket...');
  if (socket) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }
  socket = io('https://trade.mn:8989', {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionAttempts: Infinity,
  });
  socket.on('connect', () => {
    log('✅ Connected to Trade.mn');
    socket.emit('message', ['join', 'USDT/MNT']);
    log('📡 Joined USDT/MNT channel');
  });
  socket.on('disconnect', () => log('⚠️ Disconnected from Trade.mn'));
  socket.on('connect_error', (error) => log(`❌ Connection error: ${error.message}`));
  socket.on('change24', (data) => {
    try {
      if (data && data['USDT/MNT'] && data['USDT/MNT'].lastPrice) {
        setPrice(parseFloat(data['USDT/MNT'].lastPrice), 'change24');
      }
    } catch (e) {
      log(`⚠️ Failed to parse change24: ${e.message}`);
    }
  });
  socket.on('orders', (data) => {
    try {
      if (data.buy && data.sell) {
        const buyPrices = Object.keys(data.buy).map(Number).filter((n) => !isNaN(n));
        const sellPrices = Object.keys(data.sell).map(Number).filter((n) => !isNaN(n));
        if (buyPrices.length > 0 && sellPrices.length > 0) {
          setPrice((Math.max(...buyPrices) + Math.min(...sellPrices)) / 2, 'orderbook');
        }
      }
    } catch (e) {
      log(`⚠️ Failed to parse orders: ${e.message}`);
    }
  });
  socket.on('trades', (trades) => {
    try {
      if (Array.isArray(trades) && trades.length > 0 && trades[0].price) {
        setPrice(parseFloat(trades[0].price), 'trade');
      }
    } catch (e) {
      log(`⚠️ Failed to parse trades: ${e.message}`);
    }
  });
  socket.on('matched_order', (order) => {
    try {
      if (order && order.price) setPrice(parseFloat(order.price), 'matched order');
    } catch (e) {
      log(`⚠️ Failed to parse matched order: ${e.message}`);
    }
  });
}

function parseTarget(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function validateAlertBody(body, partial) {
  const out = {};
  if (!partial || body.direction !== undefined) {
    if (body.direction !== 'above' && body.direction !== 'below') {
      return { error: 'direction must be above or below' };
    }
    out.direction = body.direction;
  }
  if (!partial || body.target !== undefined) {
    const target = parseTarget(body.target);
    if (target == null) return { error: 'target must be a positive number' };
    out.target = target;
  }
  if (body.repeat !== undefined) {
    if (body.repeat !== 'once' && body.repeat !== 'always') {
      return { error: 'repeat must be once or always' };
    }
    out.repeat = body.repeat;
  }
  if (body.hysteresis !== undefined) {
    const h = Number(body.hysteresis);
    if (!Number.isFinite(h) || h < 0) return { error: 'hysteresis must be >= 0' };
    out.hysteresis = h;
  }
  if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
  return { value: out };
}

function findAlert(id) {
  return db.alerts.find((a) => a.id === id);
}

const app = express();
app.set('trust proxy', 1); // one hop: Fly's proxy. 'true' would trust a client-supplied XFF.
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    connected: socket?.connected || false,
    currentPrice,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

app.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  if (loginBlocked(ip)) return res.status(429).json({ error: 'too many attempts' });
  const password = req.body && req.body.password;
  if (!safeEqual(password || '', ADMIN_PASSWORD)) {
    recordLoginFail(ip);
    return res.status(401).json({ error: 'bad password' });
  }
  loginFails.delete(ip);
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(signSession())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`
  );
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (bearer && safeEqual(bearer, ADMIN_PASSWORD)) return next();
  if (validSession(readCookie(req, COOKIE))) return next();
  res.status(401).json({ error: 'unauthorized' });
}

app.use('/api', requireAuth);

app.get('/api/status', (_req, res) => {
  res.json({
    price: currentPrice,
    connected: socket?.connected || false,
    priceAgeSeconds: lastPriceAt ? Math.round((Date.now() - lastPriceAt) / 1000) : null,
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    alertCount: db.alerts.length,
  });
});

app.get('/api/alerts', (_req, res) => {
  res.json({ alerts: db.alerts, price: currentPrice });
});

app.post('/api/alerts', async (req, res) => {
  const parsed = validateAlertBody(req.body || {}, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const alert = {
    id: newId(),
    direction: parsed.value.direction,
    target: parsed.value.target,
    enabled: true,
    repeat: parsed.value.repeat || 'always',
    hysteresis: parsed.value.hysteresis ?? 5,
    createdAt: new Date().toISOString(),
    state: { armed: null, lastTriggeredAt: null, triggerCount: 0 },
  };
  if (currentPrice != null) prime(alert, currentPrice);
  db.alerts.push(alert);
  await persist();
  log(`➕ Alert ${alert.id} ${alert.direction} ${alert.target} armed=${alert.state.armed}`);
  res.status(201).json({
    alert,
    alreadyMet: currentPrice != null && isPastTarget(alert, currentPrice),
  });
});

app.patch('/api/alerts/:id', async (req, res) => {
  const alert = findAlert(req.params.id);
  if (!alert) return res.status(404).json({ error: 'not found' });
  const parsed = validateAlertBody(req.body || {}, true);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const reprime = parsed.value.direction !== undefined || parsed.value.target !== undefined;
  Object.assign(alert, parsed.value);
  if (reprime || parsed.value.enabled === true) {
    alert.state.armed = null;
    if (currentPrice != null) prime(alert, currentPrice);
  }
  await persist();
  res.json({ alert });
});

app.delete('/api/alerts/:id', async (req, res) => {
  const idx = db.alerts.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [removed] = db.alerts.splice(idx, 1);
  await persist();
  log(`➖ Alert ${removed.id} deleted`);
  res.status(204).end();
});

app.post('/api/test-telegram', async (_req, res) => {
  const ok = await sendTelegramNotification(
    `🔔 Test from Trade.mn monitor\n\n💰 Current Price: *${currentPrice != null ? currentPrice.toLocaleString() : 'n/a'} MNT*`
  );
  res.json({ ok });
});

app.post('/api/check', async (_req, res) => {
  const result = await checkPriceAndAlert();
  res.json(result);
});

async function initialize() {
  log('🚀 Trade.mn 24/7 Monitor starting...');
  log(`📁 DATA_DIR=${DATA_DIR}`);
  log(`📱 Telegram configured: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'Yes' : 'No'}`);

  const existing = await store.load();
  if (existing) {
    db = existing;
    log(`📂 Loaded ${db.alerts.length} alert(s)`);
  } else {
    db = seedAlerts();
    await persist();
    log(`🌱 Seeded alerts: ${db.alerts.map((a) => `${a.direction} ${a.target}`).join(', ')}`);
    if (store.wasQuarantined()) {
      await sendTelegramNotification(
        '⚠️ *Monitor recovered*\n\nThe saved alert list was unreadable and has been reset to defaults. ' +
          'The damaged file was kept next to it on the volume. Check the alert page.'
      );
    }
  }

  connectToTrade();
  setTimeout(() => {
    checkPriceAndAlert().catch((err) => log(`⚠️ initial check: ${err.message}`));
  }, 10000);
  setInterval(() => {
    checkPriceAndAlert().catch((err) => log(`⚠️ interval check: ${err.message}`));
  }, CHECK_INTERVAL);
  setInterval(() => {
    if (!socket || !socket.connected) {
      log('🔄 Reconnecting...');
      connectToTrade();
    }
  }, 60000);
}

const server = app.listen(PORT, '0.0.0.0', () => {
  log(`🌐 Server listening on port ${PORT}`);
});

function cleanup() {
  log('📴 Shutting down gracefully...');
  if (socket) {
    socket.removeAllListeners();
    socket.close();
  }
  server.close(() => {
    log('✅ Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

if (global.gc) {
  setInterval(() => {
    global.gc();
    log(`♻️  Manual GC triggered - Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  }, 30 * 60 * 1000);
}

initialize().catch((err) => {
  log(`❌ init failed: ${err.message}`);
  process.exit(1);
});
