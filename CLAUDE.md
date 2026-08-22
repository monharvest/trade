# trade-monitor — working notes

USDT/MNT price alerts for Trade.mn. Node service on Fly.io (`trade-monitor`, region `nrt`),
Telegram out, alerts edited from a password-protected page. See [README.md](README.md) for what
it does and [DEPLOY.md](DEPLOY.md) for the deploy runbook.

**This app is live and someone relies on it.** A mistake here means missed price alerts, silently.

## Invariants — breaking these causes real damage

- **One machine only.** The volume binds to a single machine. A second machine gets its own empty
  volume and sends every Telegram twice. Keep `min_machines_running = 1`; never scale up.
- **`/health` stays unauthenticated.** Fly's health checks call it. Putting auth in front of it
  fails deploys and can restart-loop the machine.
- **Alerts live on the volume at `/data/alerts.json`.** Never write them into the image or the
  repo — `alerts.json` is gitignored and dockerignored, keep it that way.
- **Alerts fire on a *crossing*, never on an already-true condition.** New and restarting alerts
  are primed against the current price first. This is what stops a deploy from Telegram-storming.
  Do not "simplify" priming away.
- **The orderbook path uses the bid/ask midpoint**, which differs from last-traded by a few MNT.
  The thresholds are calibrated to it. Do not change it to last-price-only without asking.

## Before changing alert logic

```bash
node lib/evaluator.js
```

Self-checks for fire / re-arm / hysteresis / `once`. They run in about a second — run them.

To exercise the server without touching anything real, blank the Telegram credentials and use a
throwaway data dir:

```bash
TELEGRAM_BOT_TOKEN="" TELEGRAM_CHAT_ID="" ADMIN_PASSWORD=test DATA_DIR=/tmp/x PORT=3999 node monitor-server.js
```

## Deploying

**Check what is actually running before assuming.** This repo has already been bitten once: the
live machine was running an uncommitted working tree that matched no commit, with every HTTP
endpoint throwing `ReferenceError` for weeks while alerts kept firing. `git log` told you nothing.

```bash
fly logs --app trade-monitor --no-tail | tail -30
```

A healthy boot looks like:

```
📁 DATA_DIR=/data
📂 Loaded N alert(s)          # or 🌱 Seeded alerts: on a fresh volume
✅ Connected to Trade.mn
🧭 Primed N alert(s) against <price> MNT — no Telegram
```

That `Primed … no Telegram` line is the proof the deploy did not alert-storm. Check for it.

If the Depot builder times out (`api.depot.dev … i/o timeout`), build on Fly instead:

```bash
fly deploy --depot=false
```

## Secrets

`ADMIN_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ALERT_BELOW`, `ALERT_ABOVE` are Fly
secrets. `ALERT_*` are legacy — read only to seed a fresh volume; alerts live in the JSON now.
Never paste secret values into chat, commits, or files. Set them via stdin:

```bash
fly secrets import --app trade-monitor   # then type KEY=value, EOF
```
