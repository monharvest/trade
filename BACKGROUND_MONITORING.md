# Background Price Monitoring Setup

Your server now monitors prices every **15 minutes** automatically, even when the app is closed on your computer!

## 🚀 How It Works

1. **Server runs 24/7** - Checks prices every 15 minutes
2. **Alerts sync automatically** - When you create/edit alerts, they're sent to the server
3. **Notifications sent** - Telegram messages when price targets are hit
4. **No browser needed** - Works even when your computer browser is closed

## 📋 Setup Instructions

### 1. Configure Telegram Bot (Required for notifications)

Create a `.env` file in the project root:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
PORT=3000
```

**How to get these values:**
- Create a bot with [@BotFather](https://t.me/BotFather) on Telegram
- Get your chat ID from [@userinfobot](https://t.me/userinfobot)

### 2. Start the Server

```bash
npm install
npm start
```

The server will:
- ✅ Start monitoring immediately
- ✅ Check prices every 15 minutes
- ✅ Send Telegram notifications when alerts trigger
- ✅ Keep running even when browser is closed

### 3. Create Alerts

1. Open http://localhost:3000 in your browser
2. Create your price alerts (e.g., "Alert when USDT/MNT goes above 3450")
3. Alerts automatically sync to the server
4. Close the browser - monitoring continues!

## 🧪 Testing

### Test Immediately (Don't wait 15 minutes)

```bash
curl -X POST http://localhost:3000/api/check-now
```

### Check Server Status

```bash
curl http://localhost:3000/health
```

Response shows:
- Active monitoring status
- Number of alerts configured
- Number of active alerts

## 📊 Monitoring Details

- **Check Interval**: Every 15 minutes
- **Pairs Supported**: USDT/MNT
- **Notification Method**: Telegram messages
- **Alert Types**: Price Above / Price Below

## 🔧 Advanced Configuration

### Change Check Interval

Edit [server.js](server.js#L154) line:
```javascript
// Change 15 to your desired minutes
priceCheckInterval = setInterval(checkAlertsAndNotify, 15 * 60 * 1000);
```

### Keep Server Running 24/7

**Option 1: Use PM2 (Recommended)**
```bash
npm install -g pm2
pm2 start server.js --name trade-monitor
pm2 save
pm2 startup  # Follow the instructions
```

**Option 2: Use nohup**
```bash
nohup node server.js > logs.txt 2>&1 &
```

**Option 3: Use a VPS/Cloud Server**
Deploy to:
- Heroku (free tier)
- Railway.app
- Render.com
- Your own VPS

## 📱 Mobile Alternative

If you want mobile notifications without a server, install the PWA on your phone:
1. Open the app in mobile browser
2. "Add to Home Screen"
3. Grant notification permissions
4. Mobile OS will check in background periodically

## ❓ FAQ

**Q: Does my computer need to stay on?**
A: Yes, unless you deploy the server to a cloud service.

**Q: Can I change the 15-minute interval?**
A: Yes, edit the interval in server.js (see Advanced Configuration above).

**Q: Will alerts be disabled after triggering?**
A: By default, no. Alerts stay active. Uncomment line in server.js to disable after trigger.

**Q: Can I test without waiting 15 minutes?**
A: Yes! Use `curl -X POST http://localhost:3000/api/check-now`

## 🎯 Next Steps

1. ✅ Configure Telegram bot credentials
2. ✅ Start the server with `npm start`
3. ✅ Create your alerts in the web interface
4. ✅ Test with `/api/check-now` endpoint
5. ✅ (Optional) Deploy to cloud for 24/7 monitoring
