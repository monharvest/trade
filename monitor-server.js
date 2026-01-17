const io = require('socket.io-client');
const http = require('http');

const WORKER_URL = process.env.WORKER_URL || 'https://trade-telegram-bot.monharvest.workers.dev';
const CHECK_INTERVAL = 20 * 60 * 1000; // 20 minutes
const PORT = process.env.PORT || 3000;

let currentPrice = null;
let socket = null;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Send price to worker
async function sendPriceToWorker() {
  if (!currentPrice) {
    log('⚠️ No price data to send');
    return;
  }
  
  try {
    log(`📤 Sending price ${currentPrice} MNT to worker...`);
    
    const response = await fetch(`${WORKER_URL}/api/price-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pair: 'USDT/MNT',
        price: currentPrice,
        timestamp: new Date().toISOString()
      })
    });
    
    const data = await response.json();
    
    if (data.alertTriggered) {
      log(`🔔 Alert triggered! ${data.alertType} threshold (${currentPrice} MNT)`);
    } else {
      log(`✅ Price checked - no alert (${currentPrice} MNT)`);
    }
  } catch (error) {
    log(`❌ Failed to send to worker: ${error.message}`);
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
log('🚀 Trade.mn 24/7 Monitor starting...');
log(`📍 Worker URL: ${WORKER_URL}`);
log(`⏱️  Check interval: ${CHECK_INTERVAL / 60000} minutes`);

connectToTrade();

// Send price immediately after 10 seconds
setTimeout(() => {
  if (currentPrice) {
    sendPriceToWorker();
  } else {
    log('⚠️ No price data yet, waiting...');
  }
}, 10000);

// Check price every 20 minutes
setInterval(sendPriceToWorker, CHECK_INTERVAL);

// Reconnect check every minute
setInterval(() => {
  if (!socket || !socket.connected) {
    log('🔄 Reconnecting...');
    connectToTrade();
  }
}, 60000);

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
      workerUrl: WORKER_URL,
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
