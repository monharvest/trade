// Cloudflare Worker for Telegram Notifications
// Deploy this at: https://dash.cloudflare.com > Workers & Pages > Create Worker

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // Only allow POST to /api/notify
    if (request.method !== 'POST' || !request.url.includes('/api/notify')) {
      return new Response('Not Found', { status: 404 });
    }

    try {
      const body = await request.json();
      const { message, pair, price, targetPrice, type } = body;

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
      const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const response = await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: formattedMessage,
          parse_mode: 'Markdown'
        })
      });

      const data = await response.json();

      if (data.ok) {
        return new Response(
          JSON.stringify({ success: true, message: 'Notification sent successfully' }),
          {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            }
          }
        );
      } else {
        return new Response(
          JSON.stringify({ error: 'Failed to send notification' }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            }
          }
        );
      }
    } catch (error) {
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        }
      );
    }
  }
};
