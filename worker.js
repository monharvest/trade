// Cloudflare Worker for Trade.mn Price Monitoring & Telegram Notifications
// Deploy this at: https://dash.cloudflare.com > Workers & Pages > Create Worker
// 
// Required Secrets:
// - TELEGRAM_BOT_TOKEN: Your Telegram bot token
// - TELEGRAM_CHAT_ID: Your Telegram chat ID
//
// Required Variables (in wrangler.toml or dashboard):
// - ALERT_BELOW: 3630
// - ALERT_ABOVE: 3660

export default {
  // HTTP request handler
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }
    
    // Manual price check endpoint
    if (url.pathname === '/api/check' || url.pathname === '/check') {
      const result = await checkPriceAndNotify(env);
      return jsonResponse(result);
    }
    
    // Health check
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      return jsonResponse({
        status: 'ok',
        service: 'Trade.mn Price Monitor',
        alerts: {
          below: env.ALERT_BELOW || 3630,
          above: env.ALERT_ABOVE || 3660
        },
        schedule: 'Every 20 minutes'
      });
    }
    
    // Current price endpoint
    if (url.pathname === '/api/current-price') {
      const pair = url.searchParams.get('pair') || 'USDT/MNT';
      const price = await fetchCurrentPrice();
      return jsonResponse({ pair, price, timestamp: new Date().toISOString() });
    }

    // Notification endpoint (existing functionality)
    if (request.method === 'POST' && url.pathname.includes('/api/notify')) {
      return handleNotify(request, env);
    }
    
    // Dashboard
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(getDashboardHTML(env), {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    return new Response('Not Found', { status: 404 });
  },

  // Scheduled (Cron) handler - runs every 20 minutes
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkPriceAndNotify(env));
  }
};

// JSON response helper
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
}

// Handle notification requests
async function handleNotify(request, env) {
  try {
    const body = await request.json();
    const { message, pair, price, targetPrice, type } = body;

    const formattedMessage = `
🔔 *Price Alert Triggered!*

Trading Pair: ${pair || 'USDT/MNT'}
Current Price: ${price ? price.toLocaleString() : 'N/A'} MNT
Target Price: ${targetPrice ? targetPrice.toLocaleString() : 'N/A'} MNT
Alert Type: ${type === 'above' ? 'Price Above ↑' : 'Price Below ↓'}

${message}
    `.trim();

    const success = await sendTelegramNotification(env, formattedMessage);
    
    if (success) {
      return jsonResponse({ success: true, message: 'Notification sent successfully' });
    } else {
      return jsonResponse({ error: 'Failed to send notification' }, 500);
    }
  } catch (error) {
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

// Fetch current price from Trade.mn - multiple methods
async function fetchCurrentPrice() {
  // Method 1: Try REST API
  try {
    const apiResponse = await fetch('https://trade.mn/api/market/USDT/MNT', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    });
    if (apiResponse.ok) {
      const data = await apiResponse.json();
      if (data && data.last_price) {
        return parseFloat(data.last_price);
      }
    }
  } catch (e) {
    console.log('REST API failed:', e.message);
  }

  // Method 2: Try Socket.IO with proper headers
  try {
    const initResponse = await fetch('https://trade.mn:8989/socket.io/?EIO=4&transport=polling', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Origin': 'https://trade.mn',
        'Referer': 'https://trade.mn/'
      }
    });
    
    if (!initResponse.ok) {
      console.log('Socket.IO init failed:', initResponse.status);
      return null;
    }
    
    const initText = await initResponse.text();
    const sidMatch = initText.match(/"sid":"([^"]+)"/);
    if (!sidMatch) return null;
    
    const sid = sidMatch[1];
    
    await fetch(`https://trade.mn:8989/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
      method: 'POST',
      body: '42["message",["join","USDT/MNT"]]',
      headers: { 
        'Content-Type': 'text/plain',
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://trade.mn'
      }
    });
    
    await new Promise(r => setTimeout(r, 500));
    
    const dataResponse = await fetch(`https://trade.mn:8989/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://trade.mn'
      }
    });
    
    if (!dataResponse.ok) return null;
    
    const dataText = await dataResponse.text();
    
    // Try orders
    const ordersMatch = dataText.match(/\["orders",(\{.*?\})\]/s);
    if (ordersMatch) {
      try {
        const ordersData = JSON.parse(ordersMatch[1]);
        if (ordersData.buy && ordersData.sell) {
          const buyPrices = Object.keys(ordersData.buy).map(Number).filter(n => !isNaN(n));
          const sellPrices = Object.keys(ordersData.sell).map(Number).filter(n => !isNaN(n));
          if (buyPrices.length > 0 && sellPrices.length > 0) {
            const bestBid = Math.max(...buyPrices);
            const bestAsk = Math.min(...sellPrices);
            return (bestBid + bestAsk) / 2;
          }
        }
      } catch (e) {}
    }
    
    // Try trades
    const tradesMatch = dataText.match(/\["trades",\[(.*?)\]\]/s);
    if (tradesMatch) {
      try {
        const tradesData = JSON.parse('[' + tradesMatch[1] + ']');
        if (tradesData.length > 0 && tradesData[0].price) {
          return parseFloat(tradesData[0].price);
        }
      } catch (e) {}
    }
  } catch (error) {
    console.error('Socket.IO failed:', error.message);
  }
  
  return null;
}

// Send Telegram notification
async function sendTelegramNotification(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log('Telegram not configured');
    return false;
  }
  
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'Markdown'
        })
      }
    );
    
    const data = await response.json();
    return data.ok;
  } catch (error) {
    console.error('Error sending Telegram:', error);
    return false;
  }
}

// Main scheduled check function
async function checkPriceAndNotify(env) {
  const now = new Date().toISOString();
  console.log(`[${now}] Checking USDT/MNT price...`);
  
  const price = await fetchCurrentPrice();
  
  if (!price) {
    console.log('Failed to fetch price');
    return { success: false, error: 'Could not fetch price', timestamp: now };
  }
  
  console.log(`Current price: ${price} MNT`);
  
  const alertBelow = parseFloat(env.ALERT_BELOW) || 3630;
  const alertAbove = parseFloat(env.ALERT_ABOVE) || 3660;
  
  let alertTriggered = false;
  let alertType = null;
  
  // Check below threshold
  if (price <= alertBelow) {
    alertType = 'below';
    alertTriggered = true;
    
    const message = `
🔔 *PRICE ALERT!*

📉 USDT/MNT is *BELOW* threshold!

💰 Current Price: *${price.toLocaleString()} MNT*
🎯 Alert Threshold: *${alertBelow.toLocaleString()} MNT*

⏰ Time: ${now}

[Open Trade.mn →](https://trade.mn/exchange/USDT/MNT/)
    `.trim();
    
    await sendTelegramNotification(env, message);
    console.log('Alert sent: below threshold');
  }
  
  // Check above threshold
  if (price >= alertAbove) {
    alertType = 'above';
    alertTriggered = true;
    
    const message = `
🔔 *PRICE ALERT!*

📈 USDT/MNT is *ABOVE* threshold!

💰 Current Price: *${price.toLocaleString()} MNT*
🎯 Alert Threshold: *${alertAbove.toLocaleString()} MNT*

⏰ Time: ${now}

[Open Trade.mn →](https://trade.mn/exchange/USDT/MNT/)
    `.trim();
    
    await sendTelegramNotification(env, message);
    console.log('Alert sent: above threshold');
  }
  
  return {
    success: true,
    price,
    alertBelow,
    alertAbove,
    alertTriggered,
    alertType,
    timestamp: now
  };
}

// Dashboard HTML
function getDashboardHTML(env) {
  const alertBelow = env.ALERT_BELOW || 3630;
  const alertAbove = env.ALERT_ABOVE || 3660;
  
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Trade.mn Price Monitor</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
           max-width: 600px; margin: 50px auto; padding: 20px; background: #1a1a2e; color: #fff; }
    h1 { color: #4ade80; }
    .card { background: #16213e; padding: 20px; border-radius: 12px; margin: 20px 0; }
    .alert { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #333; }
    .alert:last-child { border: none; }
    a { color: #60a5fa; }
    .btn { display: inline-block; background: #3b82f6; color: white; padding: 10px 20px; 
           border-radius: 8px; text-decoration: none; margin: 5px; }
    .btn:hover { background: #2563eb; }
    code { background: #0f0f23; padding: 2px 8px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>📊 Trade.mn Price Monitor</h1>
  <p>Cloudflare Worker monitoring USDT/MNT every 20 minutes.</p>
  
  <div class="card">
    <h3>🔔 Alert Thresholds</h3>
    <div class="alert">
      <span>📉 Below</span>
      <strong>${alertBelow.toLocaleString()} MNT</strong>
    </div>
    <div class="alert">
      <span>📈 Above</span>
      <strong>${alertAbove.toLocaleString()} MNT</strong>
    </div>
  </div>
  
  <div class="card">
    <h3>🔗 Endpoints</h3>
    <p><a href="/check">/check</a> - Check price now</p>
    <p><a href="/health">/health</a> - Health status</p>
    <p><a href="/api/current-price">/api/current-price</a> - Get current price</p>
  </div>
  
  <div class="card">
    <h3>⏰ Schedule</h3>
    <p>Price is checked automatically every <strong>20 minutes</strong></p>
  </div>
  
  <p style="text-align: center; margin-top: 30px;">
    <a href="/check" class="btn">🔍 Check Now</a>
    <a href="https://trade.mn/exchange/USDT/MNT/" class="btn" target="_blank">📈 Trade.mn</a>
  </p>
</body>
</html>
  `.trim();
}

