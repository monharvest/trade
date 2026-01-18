const io = require('socket.io-client');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const cors = require('cors');

require('dotenv').config();

const CHECK_INTERVAL = 20 * 60 * 1000; // 20 minutes
const PORT = process.env.PORT || 3000;
const ALERT_BELOW = parseFloat(process.env.ALERT_BELOW) || 3630;
const ALERT_ABOVE = parseFloat(process.env.ALERT_ABOVE) || 3660;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = path.join(__dirname, 'alert-state.json');

let currentPrice = null;
let socket = null;
let lastAlertState = 'none'; // 'none', 'below', 'above', or 'normal'

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Load alert state from file
async function loadAlertState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    const state = JSON.parse(data);
    lastAlertState = state.lastAlertState || 'none';
    log(`📂 Loaded alert state: ${lastAlertState}`);
  } catch (error) {
    lastAlertState = 'none';
    log(`📂 No previous alert state, starting fresh`);
  }
}

// Save alert state to file
async function saveAlertState(state) {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify({ lastAlertState: state, timestamp: new Date().toISOString() }));
    lastAlertState = state;
  } catch (error) {
    log(`⚠️ Failed to save alert state: ${error.message}`);
  }
}

// Send Telegram notification
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
        parse_mode: 'Markdown'
      })
    });

    if (response.ok) {
      log('✅ Telegram notification sent successfully');
      return true;
    } else {
      const error = await response.text();
      log(`❌ Telegram API error: ${error}`);
      return false;
    }
  } catch (error) {
    log(`❌ Failed to send Telegram notification: ${error.message}`);
    return false;
  }
}

// Scrape price from Trade.mn website as fallback
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
  
  log(`❌ All API endpoints failed`);
  return null;
}

// Check price and send alerts if needed
async function checkPriceAndAlert() {
  let priceToCheck = currentPrice;
  
  if (!priceToCheck) {
    log('⚠️ No WebSocket price data, trying API scraping...');
    priceToCheck = await scrapePriceFromWebsite();
  }
  
  if (!priceToCheck) {
    log('⚠️ No price data available from any source');
    return;
  }
  
  log(`💰 Checking price: ${priceToCheck} MNT (thresholds: ≤${ALERT_BELOW} / ≥${ALERT_ABOVE})`);
  
  let newState = 'normal';
  let alertTriggered = false;
  
  // Check below threshold - only alert if crossing down
  if (priceToCheck <= ALERT_BELOW) {
    newState = 'below';
    if (lastAlertState !== 'below') {
      alertTriggered = true;
      const message = `🔔 *PRICE ALERT!*

📉 USDT/MNT is *BELOW* threshold!

💰 Current Price: *${priceToCheck.toLocaleString()} MNT*
🎯 Alert Threshold: *${ALERT_BELOW.toLocaleString()} MNT*

⏰ Time: ${new Date().toISOString()}

[Open Trade.mn →](https://trade.mn/exchange/USDT/MNT/)`;
      
      await sendTelegramNotification(message);
      log(`🔔 Alert sent: Price dropped below ${ALERT_BELOW} MNT`);
    } else {
      log(`⏸️ Price still below threshold, no alert sent (last state: ${lastAlertState})`);
    }
  }
  // Check above threshold - only alert if crossing up
  else if (priceToCheck >= ALERT_ABOVE) {
    newState = 'above';
    if (lastAlertState !== 'above') {
      alertTriggered = true;
      const message = `🔔 *PRICE ALERT!*

📈 USDT/MNT is *ABOVE* threshold!

💰 Current Price: *${priceToCheck.toLocaleString()} MNT*
🎯 Alert Threshold: *${ALERT_ABOVE.toLocaleString()} MNT*

⏰ Time: ${new Date().toISOString()}

[Open Trade.mn →](https://trade.mn/exchange/USDT/MNT/)`;
      
      await sendTelegramNotification(message);
      log(`🔔 Alert sent: Price went above ${ALERT_ABOVE} MNT`);
    } else {
      log(`⏸️ Price still above threshold, no alert sent (last state: ${lastAlertState})`);
    }
  }
  // Price is in normal range
  else {
    newState = 'normal';
    log(`✅ Price in normal range (${ALERT_BELOW} - ${ALERT_ABOVE})`);
  }
  
  // Save new state if it changed
  if (newState !== lastAlertState) {
    await saveAlertState(newState);
    log(`📝 Alert state changed: ${lastAlertState} → ${newState}`);
  }
  
  if (!alertTriggered) {
    log(`✅ Price checked - no alert needed`);
  }
}

// Connect to Trade.mn
function connectToTrade() {
  log('🔌 Connecting to Trade.mn WebSocket...');
  
  socket = io('https://trade.mn:8989', {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionAttempts: Infinity
  });
  
  socket.on('connect', () => {
    log('✅ Connected to Trade.mn');
    socket.emit('message', ['join', 'USDT/MNT']);
    log('📡 Joined USDT/MNT channel');
  });
  
  socket.on('disconnect', () => {
    log('⚠️ Disconnected from Trade.mn');
  });
  
  socket.on('connect_error', (error) => {
    log(`❌ Connection error: ${error.message}`);
  });
  
  // Listen for 24h change data (most reliable)
  socket.on('change24', (data) => {
    try {
      if (data && data['USDT/MNT'] && data['USDT/MNT'].lastPrice) {
        currentPrice = parseFloat(data['USDT/MNT'].lastPrice);
        log(`💰 Price updated: ${currentPrice} MNT (from change24)`);
      }
    } catch (e) {
      log(`⚠️ Failed to parse change24: ${e.message}`);
    }
  });
  
  // Listen for price updates
  socket.on('orders', (data) => {
    try {
      if (data.buy && data.sell) {
        const buyPrices = Object.keys(data.buy).map(Number).filter(n => !isNaN(n));
        const sellPrices = Object.keys(data.sell).map(Number).filter(n => !isNaN(n));
        
        if (buyPrices.length > 0 && sellPrices.length > 0) {
          const bestBid = Math.max(...buyPrices);
          const bestAsk = Math.min(...sellPrices);
          currentPrice = (bestBid + bestAsk) / 2;
          log(`💰 Price updated: ${currentPrice} MNT (from orderbook)`);
        }
      }
    } catch (e) {
      log(`⚠️ Failed to parse orders: ${e.message}`);
    }
  });
  
  socket.on('trades', (trades) => {
    try {
      if (Array.isArray(trades) && trades.length > 0 && trades[0].price) {
        currentPrice = parseFloat(trades[0].price);
        log(`💰 Price updated: ${currentPrice} MNT (from trade)`);
      }
    } catch (e) {
      log(`⚠️ Failed to parse trades: ${e.message}`);
    }
  });
  
  socket.on('matched_order', (order) => {
    try {
      if (order && order.price) {
        currentPrice = parseFloat(order.price);
        log(`💰 Price updated: ${currentPrice} MNT (from matched order)`);
      }
    } catch (e) {
      log(`⚠️ Failed to parse matched order: ${e.message}`);
    }
  });
}

// Initialize
async function initialize() {
  log('🚀 Trade.mn 24/7 Monitor starting...');
  log(`📊 Alert thresholds: Below ${ALERT_BELOW} MNT / Above ${ALERT_ABOVE} MNT`);
  log(`⏱️  Check interval: ${CHECK_INTERVAL / 60000} minutes`);
  log(`📱 Telegram configured: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'Yes' : 'No'}`);
  
  await loadAlertState();
  connectToTrade();

  // Check price immediately after 10 seconds
  setTimeout(() => {
    if (currentPrice) {
      checkPriceAndAlert();
    } else {
      log('⚠️ No price data yet, waiting...');
    }
  }, 10000);

  // Check price every 20 minutes
  setInterval(checkPriceAndAlert, CHECK_INTERVAL);

  // Reconnect check every minute
  setInterval(() => {
    if (!socket || !socket.connected) {
      log('🔄 Reconnecting...');
      connectToTrade();
    }
  }, 60000);
}

// Keep process alive
process.on('SIGTERM', () => {
  log('📴 SIGTERM received, closing...');
  if (socket) socket.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('📴 SIGINT received, closing...');
  if (socket) socket.close();
  process.exit(0);
});

log('✅ Monitor is running...');

// Create HTTP server for health checks
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      connected: socket?.connected || false,
      currentPrice: currentPrice,
      lastAlertState: lastAlertState,
      thresholds: { below: ALERT_BELOW, above: ALERT_ABOVE },
      uptime: process.uptime()
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log(`🌐 HTTP server listening on port ${PORT}`);
});

// Create Express API for manual checks
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/check', async (req, res) => {
  await checkPriceAndAlert();
  res.json({ 
    success: true, 
    message: 'Check completed', 
    currentPrice, 
    lastAlertState 
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    connected: socket?.connected || false,
    currentPrice,
    lastAlertState,
    thresholds: { below: ALERT_BELOW, above: ALERT_ABOVE },
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    uptime: process.uptime()
  });
});

app.listen(PORT + 1, '0.0.0.0', () => {
  log(`🌐 API server listening on port ${PORT + 1}`);
});

initialize();
