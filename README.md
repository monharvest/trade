# Trade.mn USDT/MNT Price Alerts

A small Node service that watches the USDT/MNT price on Trade.mn and sends a Telegram message
when it crosses a threshold you choose. Alerts are edited from a password-protected web page —
no code changes, no redeploys.

Runs 24/7 on Fly.io, so alerts fire whether or not your Mac is awake.

## How it works

1. Connects to the Trade.mn socket (`trade.mn:8989`) and tracks USDT/MNT continuously.
   If the socket is down, it falls back to polling Trade.mn's REST tickers.
2. Evaluates every alert on each price tick (debounced to once per 10s), plus a full sweep
   every 20 minutes as a safety net.
3. Sends a Telegram message when an alert **crosses** its threshold.
4. Alerts live in `alerts.json` on a Fly volume at `/data`, so they survive redeploys.

### Alerts

Each alert is a direction (`above`/`below`), a target price, and:

- **repeat** — `always` (re-arms and keeps watching) or `once` (fires one time, then switches off).
- **hysteresis** — how far the price must retrace before the alert can fire again. Default 5 MNT.
  Stops a price hovering on the line from spamming you.

**Alerts fire on a crossing, never on a condition that is already true.** Adding "above 3700"
while the price is 3750 does not fire immediately — it waits for the price to come back down and
cross up again. Same on restart: alerts are primed against the current price at boot, which is
what stops a deploy from firing every satisfied alert at once.

## The page

Visit the app URL, enter the password (`ADMIN_PASSWORD`), and you get the live price plus
add/toggle/delete for alerts. It's mobile-first — the point is to adjust an alert on your phone
right after a Telegram lands. The session cookie lasts 30 days.

## Local development

```bash
npm install
ADMIN_PASSWORD=whatever npm start
```

Then open http://localhost:3000. Without `ADMIN_PASSWORD` the server refuses to start.
Locally, `alerts.json` is written next to the source (and is gitignored); on Fly it goes to `/data`.

`.env` holds the Telegram credentials:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Run the alert-logic self-checks with:

```bash
node lib/evaluator.js
```

## API

Auth is a session cookie from `POST /api/login`, or `Authorization: Bearer $ADMIN_PASSWORD`
for scripts. `/health` is deliberately open — Fly's health checks use it.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness. No auth. |
| `POST` | `/api/login` | `{password}` → sets the session cookie |
| `GET` | `/api/status` | Price, socket state, price age |
| `GET` | `/api/alerts` | List alerts |
| `POST` | `/api/alerts` | `{direction, target, repeat?, hysteresis?}` |
| `PATCH` | `/api/alerts/:id` | Partial update; changing target/direction re-primes |
| `DELETE` | `/api/alerts/:id` | Remove one |
| `POST` | `/api/test-telegram` | Send a test message |
| `POST` | `/api/check` | Force an evaluation now |

```bash
curl -H "Authorization: Bearer $ADMIN_PASSWORD" https://trade-monitor.fly.dev/api/alerts
```

## Layout

```
monitor-server.js   price feed, HTTP routes, wiring
lib/store.js        alerts.json load/save (atomic, serialized)
lib/evaluator.js    per-alert trigger logic + self-checks
public/index.html   the whole UI, one file
```

Deployment lives in [DEPLOY.md](DEPLOY.md).
