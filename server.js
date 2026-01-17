// Simple Express server to handle Telegram notifications securely
// This keeps your bot token safe on the server side

const express = require('express');
const cors = require('cors');
const { io } = require('socket.io-client');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files (HTML, CSS, JS)
app.use(express.static(__dirname));

// Telegram Bot Configuration (stored securely in .env file)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Trade.mn WebSocket connection
const WS_URL = 'https://trade.mn:8989';
let tradeSocket = null;
let currentPrice = null;

// In-memory storage for alerts (you can replace this with a database later)
let alerts = [
    // Default alerts - will be overwritten by client sync
    { id: 1, pair: 'USDT/MNT', type: 'below', target: 3630, enabled: true, created: new Date() },
    { id: 2, pair: 'USDT/MNT', type: 'above', target: 3660, enabled: true, created: new Date() }
];
let lastPrices = {}; // Track last known prices for each pair
let priceCheckInterval = null;
const CHECK_INTERVAL_MINUTES = 20; // Check every 20 minutes

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Server is running',
        monitoring: {
            active: !!priceCheckInterval,
            alertCount: alerts.length,
            activeAlerts: alerts.filter(a => a.enabled).length
        }
    });
});

// Endpoint to save/update alerts from the client
app.post('/api/alerts', (req, res) => {
    try {
        const { alerts: clientAlerts } = req.body;
        
        if (!Array.isArray(clientAlerts)) {
            return res.status(400).json({ error: 'Alerts must be an array' });
        }
        
        alerts = clientAlerts;
        console.log(`📊 Updated alerts: ${alerts.length} total, ${alerts.filter(a => a.enabled).length} active`);
        
        // Start monitoring if not already running
        if (!priceCheckInterval) {
            startPriceMonitoring();
        }
        
        res.json({ success: true, alertCount: alerts.length });
    } catch (error) {
        console.error('Error updating alerts:', error);
        res.status(500).json({ error: 'Failed to update alerts' });
    }
});

// Endpoint to get current alerts
app.get('/api/alerts', (req, res) => {
    res.json({ alerts, lastPrices });
});

// Endpoint to send Telegram notifications
app.post('/api/notify', async (req, res) => {
    try {
        const { message, pair, price, targetPrice, type } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        // Validate token is configured
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
            console.error('Telegram credentials not configured');
            return res.status(500).json({ error: 'Telegram not configured' });
        }

        // Format the message
        const formattedMessage = `
🔔 *Price Alert Triggered!*

Trading Pair: ${pair || 'USDT/MNT'}
Current Price: ${price ? price.toLocaleString() : 'N/A'} MNT
Target Price: ${targetPrice ? targetPrice.toLocaleString() : 'N/A'} MNT
Alert Type: ${type === 'above' ? 'Price Above ↑' : 'Price Below ↓'}

${message}
        `.trim();

        // Send to Telegram
        const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await fetch(telegramUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: formattedMessage,
                parse_mode: 'Markdown'
            })
        });

        const data = await response.json();

        if (data.ok) {
            res.json({ success: true, message: 'Notification sent successfully' });
        } else {
            console.error('Telegram API error:', data);
            res.status(500).json({ error: 'Failed to send notification', details: data });
        }
    } catch (error) {
        console.error('Error sending notification:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Connect to Trade.mn WebSocket for real-time prices
function connectToTradeWebSocket() {
    if (tradeSocket && tradeSocket.connected) {
        return;
    }
    
    console.log('🔌 Connecting to Trade.mn WebSocket...');
    
    tradeSocket = io(WS_URL, {
        transports: ['polling', 'websocket'],
        upgrade: true,
        timeout: 15000,
        reconnection: true,
        reconnectionDelay: 5000,
        reconnectionAttempts: 5
    });
    
    tradeSocket.on('connect', () => {
        console.log('✅ Connected to Trade.mn WebSocket');
        tradeSocket.emit('message', ['join', 'USDT/MNT']);
        setTimeout(() => tradeSocket.emit('join', 'USDT/MNT'), 500);
    });
    
    tradeSocket.on('message', (data) => {
        if (Array.isArray(data)) {
            const [event, payload] = data;
            if (event === 'matched_order' && payload && payload.price) {
                currentPrice = parseFloat(payload.price);
                console.log(`💹 Real-time price update: ${currentPrice} MNT`);
            } else if (event === 'trades' && Array.isArray(payload) && payload.length > 0) {
                currentPrice = parseFloat(payload[0].price);
                console.log(`📊 Trade price: ${currentPrice} MNT`);
            } else if (event === 'orders' && payload && payload.buy && payload.sell) {
                const buyPrices = Object.keys(payload.buy).map(Number);
                const sellPrices = Object.keys(payload.sell).map(Number);
                if (buyPrices.length > 0 && sellPrices.length > 0) {
                    const bestBid = Math.max(...buyPrices);
                    const bestAsk = Math.min(...sellPrices);
                    currentPrice = (bestBid + bestAsk) / 2;
                    console.log(`📊 Order book price: ${currentPrice.toFixed(2)} MNT`);
                }
            }
        }
    });
    
    // Also listen for direct events (alternative format from Trade.mn)
    tradeSocket.on('orders', (data) => {
        if (data && data.buy && data.sell) {
            const buyPrices = Object.keys(data.buy).map(Number);
            const sellPrices = Object.keys(data.sell).map(Number);
            if (buyPrices.length > 0 && sellPrices.length > 0) {
                const bestBid = Math.max(...buyPrices);
                const bestAsk = Math.min(...sellPrices);
                currentPrice = (bestBid + bestAsk) / 2;
                console.log(`📈 Direct orders - Price: ${currentPrice.toFixed(2)} MNT`);
            }
        }
    });
    
    tradeSocket.on('matched_order', (data) => {
        if (data && data.price) {
            currentPrice = parseFloat(data.price);
            console.log(`💹 Direct matched_order: ${currentPrice} MNT`);
        }
    });
    
    tradeSocket.on('trades', (data) => {
        if (Array.isArray(data) && data.length > 0 && data[0].price) {
            currentPrice = parseFloat(data[0].price);
            console.log(`📊 Direct trades: ${currentPrice} MNT`);
        }
    });
    
    tradeSocket.on('disconnect', () => {
        console.log('❌ Disconnected from Trade.mn WebSocket');
    });
    
    tradeSocket.on('error', (error) => {
        console.error('WebSocket error:', error.message);
    });
}

// Fetch current price from Trade.mn API
async function fetchCurrentPrice(pair) {
    // If we have a recent WebSocket price, use it
    if (currentPrice) {
        return currentPrice;
    }
    
    try {
        // Try Trade.mn depth API (orderbook)
        const depthResponse = await fetch(`https://trade.mn/api/depth?symbol=${encodeURIComponent(pair)}`);
        if (depthResponse.ok) {
            const data = await depthResponse.json();
            if (data && data.buy && data.sell) {
                const buyPrices = Object.keys(data.buy).map(Number);
                const sellPrices = Object.keys(data.sell).map(Number);
                if (buyPrices.length > 0 && sellPrices.length > 0) {
                    const bestBid = Math.max(...buyPrices);
                    const bestAsk = Math.min(...sellPrices);
                    const midPrice = (bestBid + bestAsk) / 2;
                    return midPrice;
                }
            }
        }
        
        return null;
    } catch (error) {
        console.error(`Error fetching price for ${pair}:`, error.message);
        return null;
    }
}

// Send Telegram notification
async function sendTelegramNotification(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('Telegram not configured, skipping notification');
        return false;
    }
    
    try {
        const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'Markdown'
            })
        });
        
        const data = await response.json();
        return data.ok;
    } catch (error) {
        console.error('Error sending Telegram notification:', error);
        return false;
    }
}

// Check all alerts and send notifications if triggered
async function checkAlertsAndNotify() {
    const now = new Date();
    console.log(`\n⏰ [${now.toLocaleTimeString()}] Checking prices...`);
    
    if (alerts.length === 0) {
        console.log('No alerts configured');
        return;
    }
    
    // Get unique pairs to check
    const pairs = [...new Set(alerts.map(a => a.pair))];
    
    // Fetch prices for all pairs
    for (const pair of pairs) {
        const currentPrice = await fetchCurrentPrice(pair);
        
        if (currentPrice === null) {
            console.log(`❌ ${pair}: Failed to fetch price`);
            continue;
        }
        
        const priceChange = lastPrices[pair] ? ((currentPrice - lastPrices[pair]) / lastPrices[pair] * 100).toFixed(2) : 0;
        const changeSymbol = priceChange > 0 ? '📈' : priceChange < 0 ? '📉' : '➡️';
        
        console.log(`${changeSymbol} ${pair}: ${currentPrice.toLocaleString()} MNT ${priceChange !== 0 ? `(${priceChange > 0 ? '+' : ''}${priceChange}%)` : ''}`);
        lastPrices[pair] = currentPrice;
        
        // Check alerts for this pair
        const pairAlerts = alerts.filter(a => a.pair === pair && a.enabled);
        
        for (const alert of pairAlerts) {
            let triggered = false;
            
            if (alert.type === 'above' && currentPrice >= alert.target) {
                triggered = true;
            } else if (alert.type === 'below' && currentPrice <= alert.target) {
                triggered = true;
            }
            
            if (triggered) {
                const message = `
🔔 *PRICE ALERT TRIGGERED!*

📊 Trading Pair: *${pair}*
💰 Current Price: *${currentPrice.toLocaleString()} MNT*
🎯 Target Price: *${alert.target.toLocaleString()} MNT*
${alert.type === 'above' ? '📈' : '📉'} Alert Type: *${alert.type === 'above' ? 'Price Above' : 'Price Below'}*

⏰ Time: ${now.toLocaleString()}

[Open Trade.mn →](https://trade.mn/exchange/${pair.replace('/', '/')})
                `.trim();
                
                console.log(`🚨 ALERT TRIGGERED: ${pair} ${alert.type} ${alert.target.toLocaleString()}`);
                
                const sent = await sendTelegramNotification(message);
                if (sent) {
                    console.log('✅ Telegram notification sent');
                    // Disable the alert after triggering (optional - comment out to keep it active)
                    // alert.enabled = false;
                } else {
                    console.log('❌ Failed to send notification');
                }
            }
        }
    }
}

// Start periodic price monitoring (every 20 minutes)
function startPriceMonitoring() {
    if (priceCheckInterval) {
        console.log('⚠️  Price monitoring already running');
        return;
    }
    
    console.log(`🎯 Starting price monitoring (checking every ${CHECK_INTERVAL_MINUTES} minutes)...`);
    console.log('🚨 Active alerts:');
    alerts.filter(a => a.enabled).forEach(a => {
        console.log(`   - ${a.pair}: ${a.type} ${a.target.toLocaleString()} MNT`);
    });
    
    // Check immediately on start
    checkAlertsAndNotify();
    
    // Then check every X minutes
    priceCheckInterval = setInterval(checkAlertsAndNotify, CHECK_INTERVAL_MINUTES * 60 * 1000);
}

// Stop monitoring
function stopPriceMonitoring() {
    if (priceCheckInterval) {
        clearInterval(priceCheckInterval);
        priceCheckInterval = null;
        console.log('🛑 Price monitoring stopped');
    }
}

// Endpoint to manually trigger a price check (for testing)
app.post('/api/check-now', async (req, res) => {
    try {
        await checkAlertsAndNotify();
        res.json({ success: true, message: 'Price check completed' });
    } catch (error) {
        console.error('Error in manual price check:', error);
        res.status(500).json({ error: 'Failed to check prices' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Telegram notifications configured: ${!!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID}`);
    console.log(`\n⏰ Price monitoring will check every ${CHECK_INTERVAL_MINUTES} minutes`);
    
    // Connect to Trade.mn WebSocket for real-time prices
    connectToTradeWebSocket();
    
    // Auto-start monitoring with default alerts
    console.log('\n🔔 Starting automatic price monitoring...');
    startPriceMonitoring();
});
