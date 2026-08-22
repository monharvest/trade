# Deploying to Fly.io

App: `trade-monitor`, region `nrt` (Tokyo), one 256MB machine, always on.

## First-time setup

These must exist **before** the first deploy of the alert-manager version, or the machine will
crash-loop: no `ADMIN_PASSWORD` means the server exits on purpose, and no volume means the
`[mounts]` block in `fly.toml` fails the deploy.

```bash
fly volumes create trade_data --size 1 --region nrt --app trade-monitor
```

```bash
fly secrets set ADMIN_PASSWORD="$(openssl rand -base64 18)" --app trade-monitor
```

Telegram credentials, if not already set:

```bash
fly secrets set TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... --app trade-monitor
```

Setting a secret restarts the machine, so do it before verifying, not during.

## Deploy

```bash
fly deploy
```

## Verify

```bash
fly logs --app trade-monitor
```

Expect `📂 Loaded N alert(s)` (or `🌱 Seeded alerts:` on the very first run), then
`✅ Connected to Trade.mn`. A `🧭 Primed N alert(s)` line is normal and means no Telegram was
sent for already-satisfied alerts.

```bash
curl https://trade-monitor.fly.dev/health
curl -H "Authorization: Bearer $ADMIN_PASSWORD" https://trade-monitor.fly.dev/api/alerts
```

Then open the app URL in a browser and press **Test Telegram**.

## Constraints

- **One machine only.** The volume binds to a single machine; a second one would get its own
  empty volume and duplicate every Telegram. Keep `min_machines_running = 1` and do not scale up.
- **`/health` must stay unauthenticated** — Fly's health checks call it.
- Alerts live at `/data/alerts.json` on the volume. Redeploys do not touch it.

## Rollback

```bash
fly releases --app trade-monitor
fly deploy --image <previous-image>
```

The volume survives rollbacks, and older code ignores `/data`, so rolling back is safe.

## Recovery

If `alerts.json` is ever unreadable, the server sets it aside as `alerts.json.corrupt-<timestamp>`,
reseeds the default alerts, and sends a Telegram saying so. To inspect the damaged file:

```bash
fly ssh console --app trade-monitor -C "ls -la /data"
```
