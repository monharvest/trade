// Simple Express server to handle Telegram notifications securely
// This keeps your bot token safe on the server side

const express = require('express');
const cors = require('cors');
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

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
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

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Telegram notifications configured: ${!!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID}`);
});
