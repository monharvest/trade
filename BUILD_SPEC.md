# Build Spec: Trade.mn Alert Manager

**Goal:** stop editing code to change price alerts. Manage them from a password-protected page
served by the existing Fly server, which keeps watching the market 24/7 and sending Telegram.

> ⚠️ **The Fly app is live and in daily use.** Follow the rollout order in §7.

---

## 1. Decisions (settled — do not re-open)

| Decision | Choice | Why |
|---|---|---|
| Who watches the price | Fly.io, 24/7 | A Mac sleeps; alerts must fire overnight. |
| UI | **One page served by the same Fly server** | Works on Mac *and* phone — adjust an alert right after a Telegram fires. No .dmg, no Gatekeeper, no Electron. |
| Alert channel | **Telegram only** | No native macOS notifications. |
| Storage | JSON file on a Fly volume | Survives redeploys. SQLite is overkill. |
| Pairs | **`USDT/MNT` hardcoded** | The feed hardcodes it in both the channel join and the parse key. |

**Explicitly out of scope:** Electron/menu-bar app, multi-pair, cooldown timers, alert notes,
price history/charts. A SwiftBar tray script that `curl`s `/api/status` is a possible later
add-on — not part of this build.

---

## 2. Architecture

```
 browser (Mac or phone)      Fly.io  (app: trade-monitor, region nrt)
 ┌──────────────────┐        ┌──────────────────────────┐   socket.io
 │ price + alert    │ HTTPS  │  monitor-server.js       │◄─────────────  trade.mn:8989
 │ list + add form  │◄──────►│  ├─ lib/evaluator.js     │
 └──────────────────┘        │  └─ lib/store.js         │──────────────► Telegram Bot API
                             │  /data/alerts.json (vol) │
                             └──────────────────────────┘
```

---

## 3. Layout

Keep `monitor-server.js` at the repo root — the Dockerfile does a bare `COPY . .`, and moving
files invites a broken deploy on a live app. Two new modules only; routes stay in the server file.

```
trade/
├── monitor-server.js     # feed, routes, wiring (existing file, extended)
├── lib/
│   ├── store.js          # load/save alerts.json, atomic writes
│   └── evaluator.js      # per-alert trigger logic
├── public/
│   └── index.html        # the whole UI: one file, no build step, inline CSS/JS
├── fly.toml
└── Dockerfile
```

---

## 4. Data model

`/data/alerts.json`:

```json
{
  "version": 1,
  "alerts": [
    {
      "id": "alr_k3f9x2",
      "direction": "above",
      "target": 3700,
      "enabled": true,
      "repeat": "always",
      "hysteresis": 5,
      "createdAt": "2026-08-22T10:00:00.000Z",
      "state": { "armed": true, "lastTriggeredAt": null, "triggerCount": 0 }
    }
  ]
}
```

- `id` — server-generated `alr_` + 6 base36 chars. Never client-supplied.
- `direction` — `"above"` | `"below"` only.
- `target` — positive finite number. Reject NaN, non-numeric strings, ≤ 0.
- `repeat` — `"once"` (fire, then set `enabled: false`) or `"always"` (re-arm).
- `hysteresis` — MNT the price must retrace before re-arming. Default `5`.
- `state` — server-owned. **Ignore `state` in any client payload.**

**Atomic writes:** write `alerts.json.tmp`, then `fs.rename()`. A truncated file from a mid-write
crash loses every alert.

---

## 5. Evaluation logic — the core of this change

Delete the global `lastAlertState` string and its if/else chain. It is why 3665 and 3700 got
messy. Each alert owns its `state.armed`.

For target `T`, hysteresis `H`, observed price `P`:

**above:** `armed && P >= T` → fire. `!armed && P <= T - H` → re-arm (if `repeat: always`).
**below:** `armed && P <= T` → fire. `!armed && P >= T + H` → re-arm (if `repeat: always`).

Fire = send Telegram, `armed = false`, `lastTriggeredAt = now`, `triggerCount++`.
If `repeat: "once"`, also `enabled = false`.

### Priming — prevents an alert storm on deploy

When an alert enters the evaluator without a meaningful `armed` value (server boot, or a newly
created alert), **prime it against the current price instead of evaluating it**: already past the
target → `armed: false`; otherwise `armed: true`.

Alerts then fire on a genuine *crossing*, never on the mere fact that a condition is already true.
Without this, the first boot Telegrams every satisfied alert at once and repeats it every restart.

Creating "above 3700" while the price is 3750 therefore does not fire immediately. The page must
say so inline: *"Price is already above this — will alert on the next crossing."*

### When to evaluate

- On every websocket price tick, **debounced to once per 10s**. Alerts currently fire up to 20
  minutes late; this is the real upgrade.
- Keep the existing 20-minute interval as the fallback for when the socket is dead — that path
  already falls back to the REST endpoints.

### Seeding from the current setup

If `/data/alerts.json` is missing on boot, seed from the **effective** threshold values (env var
if set, else the code default) and prime all of them:

| Source | Becomes |
|---|---|
| `ALERT_BELOW` (default 3630) | `{direction: "below", target: 3630, repeat: "always"}` |
| `ALERT_ABOVE` (default 3660) | `{direction: "above", target: 3660, repeat: "always"}` |
| `ALERT_ABOVE3` (default 3700) | `{direction: "above", target: 3700, repeat: "always"}` |

⚠️ **Check what is actually set on Fly first — `fly secrets list`.** The local `.env` only defines
`ALERT_BELOW` and `ALERT_ABOVE`; the machine may differ. Log the seeded values loudly.

After seeding, the env vars are legacy: keep them set, stop reading them for anything else.
The old `alert-state.json` is obsolete — ignore it, do not migrate it.

---

## 6. HTTP API + page

### Auth

`ADMIN_PASSWORD` via `fly secrets set`. `POST /api/login {password}` → on success set an
HttpOnly, Secure, SameSite=Lax signed cookie (long-lived, so the phone stays logged in).
Middleware accepts that cookie **or** `Authorization: Bearer <ADMIN_PASSWORD>` for `curl`.
Compare with `crypto.timingSafeEqual`, not `===`. Rate-limit failed logins.

Refuse to start if `ADMIN_PASSWORD` is unset rather than serving alerts unprotected.

- `GET /health` — **must stay unauthenticated.** Fly health checks hit it; auth here fails
  deploys and can restart-loop the machine.
- `GET /` and `/api/*` — authenticated (`/` redirects to a login form).

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Unauth. `{status, connected, currentPrice, uptime, memory}` |
| `GET` | `/api/status` | `{price, connected, priceAgeSeconds, telegramConfigured, alertCount}` |
| `GET` | `/api/alerts` | `{alerts: [...]}` |
| `POST` | `/api/alerts` | `{direction, target, repeat?, hysteresis?}` → 201 |
| `PATCH` | `/api/alerts/:id` | Partial. Changing `target`/`direction` re-primes. |
| `DELETE` | `/api/alerts/:id` | → 204 |
| `POST` | `/api/test-telegram` | Sends a test message. |
| `POST` | `/api/check` | Force an evaluation pass. |

Validation failure → `400 {error: "reason"}`. Unknown id → `404`.

### The page (`public/index.html`)

One file, inline CSS/JS, no framework, no build step. Mobile-first — it will be used on a phone.

1. **Header** — current price, connection dot (green = socket connected, amber = server up but
   socket down, red = unreachable), last-updated time. Poll `/api/status` every 15s.
   If `priceAgeSeconds > 120`, show it as stale. **Never render a stale price as live.**
2. **Alert list** — `▲ 3,700` / enable toggle / delete. Show "watching" vs "triggered — waiting
   to re-arm".
3. **Add form** — Above/Below toggle, price field, repeat dropdown, hysteresis behind an
   "advanced" disclosure. Inline warning when the target is already met.
4. **Footer** — "Test Telegram" button.

Tap targets ≥ 44px. Delete asks for confirmation.

---

## 7. Rollout order

The `/health` `ReferenceError` fix is **already committed** (`6845731`) — `HEAD` is a clean,
verified baseline with thresholds 3630 / 3660 / 3700 and all three endpoints returning 200.
That commit is **not yet deployed**: the live machine still runs `9b617a7` with the old 3665
thresholds. Deploying this work therefore also changes alerting behavior — 3665 goes away,
3700 arrives. Confirm the user wants that before step 3.

1. **Branch.** All work below goes on a feature branch, not `main`.
2. **Create the volume, deploy that alone.** Confirm `/health` returns 200 and Telegram still
   works. Isolates infra risk from code risk.
   ```bash
   fly volumes create trade_data --size 1 --region nrt --app trade-monitor
   ```
   ```toml
   [mounts]
     source = "trade_data"
     destination = "/data"
   ```
   Server reads `DATA_DIR` (default `/data`, falling back to `__dirname` for local dev).
   A volume binds to one machine: keep `min_machines_running = 1` and **do not scale to 2** —
   a second machine gets its own empty volume and duplicates every Telegram.
3. **Server work** — `lib/store.js`, `lib/evaluator.js`, seeding, API, auth.
   `fly secrets set ADMIN_PASSWORD=...` (note: this restarts the machine).
4. **Verify via `curl`** against §8 before writing the page. The server is fully usable headless
   at this point; that is the checkpoint that matters.
5. **Build the page** last.

Rollback: `fly releases` → `fly deploy --image <previous>`. The volume survives rollbacks and old
code ignores `/data`, so rolling back is safe.

---

## 8. Acceptance criteria

- [ ] `GET /health` returns 200 **without** auth; `/api/alerts` returns 401 without, 200 with.
- [ ] Fresh boot with no `alerts.json` seeds three alerts and sends **zero** Telegrams.
- [ ] `fly deploy` twice → alerts persist, no duplicates, no storm.
- [ ] Creating an alert already satisfied by the current price does not fire immediately.
- [ ] `repeat: "once"` fires exactly once, then shows `enabled: false`.
- [ ] `repeat: "always"` re-fires only after the price retraces past `target ± hysteresis`.
- [ ] A crossing triggers a Telegram within ~10s, not up to 20 minutes.
- [ ] Socket killed → alerts still fire via the 20-minute REST fallback.
- [ ] Page works on an iPhone browser; stays logged in across visits.
- [ ] Server unreachable → page shows a clear error, never a stale price as live.
- [ ] Memory under ~150MB RSS after an hour (machine capped at 256MB,
      `--max-old-space-size=200`).

---

## 9. Gotchas

- **Persistence risk (verified as a mechanism, not observed):** `fly.toml` has no `[mounts]`, so
  `/app` is wiped on redeploy. `alert-state.json` therefore resets to `'none'`, which by the
  edge-triggered logic *would* re-fire an already-satisfied threshold. Treat as the reason for
  step 2, not as a measured bug report.
- **The socket emits several event shapes** (`change24`, `orders`, `trades`, `matched_order`) and
  the orderbook path uses the **bid/ask midpoint**, which can differ from last-traded by a few
  MNT. Keep it — the thresholds are calibrated to it. Do not "fix" it without asking.
- **Telegram Markdown is unforgiving.** All message text is server-generated now (no user notes),
  so keep it that way rather than reintroducing an escaping hazard.
- **`fly secrets set` restarts the machine.** Don't do it mid-verification.
- **Add nothing to `.dockerignore`'s blind spots** — `public/` and `lib/` must ship in the image.
