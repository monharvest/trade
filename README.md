# Trade.mn Price Alert - Secure Setup

This project monitors cryptocurrency prices on Trade.mn and sends Telegram notifications when price alerts are triggered.

## 🔐 Security Setup

Your Telegram bot token is now **securely stored on the backend server** and never exposed in the browser.

## 📋 Setup Instructions

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Configure Telegram Bot

1. **Get a new bot token** (the old one was compromised):
   - Open Telegram and message [@BotFather](https://t.me/botfather)
   - Send `/newbot` and follow the instructions
   - Copy the bot token you receive

2. **Get your Chat ID**:
   - Message [@userinfobot](https://t.me/userinfobot) on Telegram
   - It will reply with your chat ID

3. **Update the `.env` file**:
   ```bash
   TELEGRAM_BOT_TOKEN=your_new_bot_token_here
   TELEGRAM_CHAT_ID=your_chat_id_here
   PORT=3000
   ```

### Step 3: Start the Backend Server

```bash
npm start
```

The server will run on `http://localhost:3000`

### Step 4: Open the Web Interface

Open `index.html` in your browser. The page will connect to your local backend server for notifications.

## 🚀 How It Works

1. **Frontend** (index.html): Monitors prices and displays alerts
2. **Backend** (server.js): Securely sends Telegram notifications
3. **Your token stays safe** on the server, never exposed to users

## 📁 File Structure

```
trade/
├── index.html           # Frontend web interface
├── server.js           # Backend API server (handles Telegram)
├── package.json        # Node.js dependencies
├── .env               # Secret configuration (NOT committed to Git)
├── .gitignore         # Prevents .env from being committed
└── README.md          # This file
```

## ⚠️ Important Security Notes

1. **Never commit `.env` file** to Git (already in `.gitignore`)
2. **Revoke the old compromised token** via @BotFather
3. **Use a new token** in the `.env` file
4. When deploying to production:
   - Use environment variables on your hosting platform
   - Update `BACKEND_API_URL` in index.html to your production server URL

## 🔧 Development

For development with auto-restart on file changes:

```bash
npm run dev
```

## 🌐 Deployment

When deploying to production (e.g., Heroku, Railway, Vercel):

1. Set environment variables on your hosting platform:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   
2. Update `BACKEND_API_URL` in index.html to your production server URL

3. Deploy both the backend server and frontend

## 🐛 Troubleshooting

**"Backend server not running" error:**
- Make sure you ran `npm start` in the terminal
- Check that the server is running on port 3000
- Verify the backend URL in index.html matches your server

**No Telegram notifications:**
- Check your `.env` file has the correct bot token and chat ID
- Make sure you started a chat with your bot on Telegram
- Check the server console for error messages

## 📝 License

ISC
