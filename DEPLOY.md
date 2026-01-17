# Trade.mn 24/7 Price Monitor

Deploy this to a free hosting service for 24/7 monitoring without keeping your computer on.

## Quick Deploy Options

### Option 1: Render.com (Recommended - Free Forever)
1. Go to [render.com](https://render.com)
2. Sign up with GitHub
3. Click **New** → **Background Worker**
4. Connect your `monharvest/trade` repo
5. Settings:
   - **Name**: `trade-monitor`
   - **Start Command**: `node monitor-server.js`
   - **Plan**: Free
6. Add environment variable:
   - `WORKER_URL` = `https://trade-telegram-bot.monharvest.workers.dev`
7. Click **Create**

### Option 2: Railway.app (Free Trial)
1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Click **New Project** → **Deploy from GitHub repo**
4. Select `monharvest/trade`
5. Add environment variable:
   - `WORKER_URL` = `https://trade-telegram-bot.monharvest.workers.dev`
6. Railway will auto-detect Node.js and run `monitor-server.js`

### Option 3: Fly.io (Free Tier)
1. Install flyctl: `brew install flyctl`
2. Run: `flyctl auth signup`
3. In this folder, run: `flyctl launch`
4. Set env: `flyctl secrets set WORKER_URL=https://trade-telegram-bot.monharvest.workers.dev`

## How It Works

1. **Node.js server** connects to Trade.mn WebSocket 24/7
2. Tracks USDT/MNT price in real-time
3. Every **20 minutes**, sends current price to Cloudflare Worker
4. Worker checks thresholds (3630 / 3660)
5. If crossed → **Telegram alert** 🔔

## Local Testing

```bash
npm install socket.io-client
node monitor-server.js
```

## Monitor Status

Once deployed, check logs in your hosting dashboard to see:
- ✅ Connected to Trade.mn
- 💰 Price updates
- 📤 Sending to worker
- 🔔 Alerts triggered
