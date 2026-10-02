# order-delivery-notifier

A small Node.js service that reads a furniture-workshop order spreadsheet and sends
**Telegram reminders** when a delivery (Дата здачі) is **X or fewer days away**.

- Runs on a cron schedule (default: every 10 minutes, Europe/Kyiv).
- Notification settings (time of day, days threshold, notification weekdays) live
  **in the spreadsheet** on a `Налаштування` tab and can be changed without restarting.
- Sends to **multiple recipients** — people register themselves with `/add`.
- Reminders **repeat every allowed day** until someone marks the order done by
  replying to the message with «Готово» / «+» / anything confirmation-like.
  A day is never double-sent — dedup state is kept in PostgreSQL.

## Project structure

```
src/
  index.js              entrypoint: checks config, prepares DB, starts cron + bot poller (--once for a single run)
  config.js             .env parsing + validation
  db.js                 PostgreSQL: auto-creates the DB, schema/migrations, recipients, send reservations
  sheets.js             Google Sheets: reads settings tab + orders tab (read-only)
  orders.js             row parsing/validation, DD.MM.YYYY dates, days-left math
  message.js            reminder text (HTML, Ukrainian)
  channels/telegram.js  Telegram Bot API (send, getUpdates, setMyCommands)
  bot.js                command listener: /add, /remove, /help + «Готово» replies that mark orders done
  job.js                one notification pass (settings → orders → per-recipient dedup → send)
  logger.js
```

## Setup

### 1. Google service account (read-only access to the sheet)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create (or pick) a project.
2. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account**.
   Name it e.g. `order-notifier`, no roles needed (skip role selection).
4. Open the service account → **Keys → Add key → Create new key → JSON**.
   Save the downloaded file as `credentials/service-account.json` in this project.
5. Open the JSON file and copy the `client_email` value
   (looks like `order-notifier@project.iam.gserviceaccount.com`).
6. In Google Sheets: **Share** your spreadsheet with that e-mail as **Viewer**.

The app only **reads** the spreadsheet — it never writes to it.

### 2. Settings tab in the spreadsheet

Create a tab named `Налаштування`. Simple settings are label/value rows (label in
column A, value in column B). Notification days use **two rows**: day names in the
first row, TRUE/FALSE checkboxes in the row directly below (same columns):

| A                    | B          | C        | D      | E       | F        |
|----------------------|------------|----------|--------|---------|----------|
| Час сповіщення       | 09:00      |          |        |         |          |
| Кінець сповіщень     | 18:00      |          |        |         |          |
| Днів до здачі        | 3          |          |        |         |          |
| **Сповіщати у дні**  | Понеділок  | Вівторок | Середа | Четвер  | П'ятниця |
|                      | TRUE       | FALSE    | TRUE   | TRUE    | TRUE     |

Meaning: on every **checked** day between `09:00` and `18:00` (Kyiv time) the bot sends
reminders for all orders whose `Дата здачі` is in `0..3` days. Overdue orders are never
notified. Rows you can omit:

- «Кінець сповіщень» — if absent, reminders go out any time after «Час сповіщення».
- «Сповіщати у дні» + checkbox row — if absent, the legacy rule applies: Mon–Fri only,
  or all days when «Сповіщати у вихідні» = `так`. Unchecking **all** boxes disables
  notifications on every day. Full day names («Понеділок»), short ones («Пн») and
  English ones («Monday») all work; unchecked days may simply be left out of the row.
- «Сповіщати у вихідні» — legacy toggle, only used when the day-checkbox rows are absent.

Reminders that fall outside the window (or on an unchecked day) are sent on the next
allowed day — each still exactly once per recipient.

If the tab is missing or malformed, the app falls back to `NOTIFY_TIME` / `NOTIFY_DAYS`
/ `NOTIFY_END_TIME` / `NOTIFY_DAYS_OF_WEEK` (or `NOTIFY_WEEKENDS`) from `.env` and logs
a warning.

### 3. Telegram bot

1. In Telegram, talk to [@BotFather](https://t.me/BotFather) → `/newbot` → follow the steps.
2. Copy the token (`123456789:AAE...`) → `TELEGRAM_BOT_TOKEN`.
3. `TELEGRAM_CHAT_ID` is **optional** — it's the primary chat, auto-registered as the
   first recipient on boot (your own chat id, or a team group id — group ids are negative).
4. **Everyone else registers themselves**: they open the bot, press Start and send `/add`
   (works in private chats and in groups — add the bot to a group and send `/add` there).
   Registered chats are stored in the `recipients` table; `/remove` opts out.

### Bot commands

| Command  | Action |
|----------|--------|
| `/add`   | Register the current chat (private or group) for delivery reminders |
| `/remove`| Unregister the current chat (can be re-enabled later with `/add`) |
| `/undo`  | Resume reminders for a done order (list → `/undo <рядок>`, or reply `/undo` to a reminder) |
| `/help`  | Show help |

#### Marking an order as done

Reply to any reminder message with something confirmation-like — «Готово», «Виконано»,
«Забрали», «+», «Ок», ✅ and similar (full and short Ukrainian forms are recognised).
The bot replies with a threaded ✅ acknowledgment and marks the order done **for all
recipients** — no further reminders for it on any day. Replying to a non-reminder
message, or writing anything that is not a confirmation, is ignored.

#### Undoing (resuming reminders)

- `/undo` — shows done orders (sheet row, order, who/when marked), then send
  `/undo <рядок>` for the one to resume, e.g. `/undo 210`.
- Reply `/undo` to an order's reminder message — resumes that order directly.
- Reminders resume from the **next** allowed day (today's reminder, if already sent,
  is not repeated).

### 4. PostgreSQL

Fill `DATABASE_URL` in `.env` (see `.env.example`). On first start the app:

1. connects to the `postgres` database from the URL,
2. creates the database named in `DB_NAME` (default `order_delivery`) if it doesn't exist,
3. creates the `sent_notifications` table.

If your Postgres needs different SSL handling, set `DATABASE_SSL=require` or `DATABASE_SSL=disable`.

### 5. Configure and run

```bash
cp .env.example .env      # then edit .env
pnpm install
pnpm dry                  # DRY_RUN: shows candidates + message previews, sends nothing
pnpm once                 # single real run
pnpm start                # production: catch-up run + cron schedule
```

### `.env` reference

| Variable | Description |
|---|---|
| `GOOGLE_SHEET_ID` | Spreadsheet ID from the URL |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Inline key (JSON or base64) — takes priority over the file |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | Path to the service-account JSON key (default `./credentials/service-account.json`) |
| `ORDERS_TAB` | Orders tab name; empty = first (leftmost) tab |
| `SETTINGS_TAB` | Settings tab name (default `Налаштування`) |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | Optional primary chat, auto-registered as first recipient |
| `DATABASE_URL` | `postgres://user:pass@host:5432/postgres` (points at the admin DB) |
| `DB_NAME` | App database, auto-created (default `order_delivery`) |
| `CRON` | Cron expression (default `*/10 * * * *`) |
| `TIMEZONE` | IANA timezone (default `Europe/Kyiv`) |
| `NOTIFY_TIME` / `NOTIFY_DAYS` | Fallbacks when the settings tab is unavailable |
| `NOTIFY_END_TIME` | Fallback window end (HH:MM); empty = no upper bound |
| `NOTIFY_WEEKENDS` | Legacy fallback: `1` = send on weekends too (day checkboxes win when present) |
| `NOTIFY_DAYS_OF_WEEK` | Fallback notification days, `0=Sun..6=Sat`, e.g. `1,2,3,4,5`; empty → `NOTIFY_WEEKENDS` |
| `NOTIFY_CHANNELS` | `telegram` (whatsapp/viber adapters planned) |
| `DRY_RUN` | `1` = log what would happen, send/write nothing |

## How the notification pass works

1. Read settings (`Налаштування` tab) → window start/end, days threshold, notification days.
2. Gates: skip unless today's weekday is checked («Сповіщати у дні» row; legacy: weekends
   unless enabled) and skip outside the work-hours window.
3. Read the orders tab, keep rows that have an order label (`Замовник`) and a valid
   `Дата здачі` (DD.MM.YYYY or YYYY-MM-DD). Junk/empty rows are ignored.
4. Candidates = orders with `0 ≤ days_left ≤ X` (overdue skipped), minus orders already
   marked done via the bot.
5. For each candidate × channel × **registered recipient**: **reserve** a row in
   `sent_notifications` (`UNIQUE(sheet_row, delivery_date, channel, recipient_id, send_date)`),
   send, then mark as sent.
   - The reservation is **per day**: every allowed day sends a fresh reminder until
     the order is marked done. Within one day the reminder goes out exactly once
     per recipient, no matter how many cron passes fire.
   - Already reminded **today, to that recipient** → skipped.
   - Send failed → reservation released, retried on the next pass.
   - Crashed mid-send → stale reservations older than 15 min are cleaned up automatically.
   - If you **change a delivery date** on a row, the new date makes it eligible again.
6. Confirmation: a reply to a reminder with confirmation-like text marks the order done
   (`done = true` on all its notification rows) — it leaves the candidate list.
   `/undo <рядок>` clears the flag and reminders resume on the next allowed day.

## Bulk-marking orders done (one-off)

When switching an already-live DB to the repeat-daily logic, existing orders would get
a fresh reminder on the next allowed day. To keep the current orders silent:

```bash
pnpm mark-done          # dry run: lists what would be marked
pnpm mark-done --yes    # marks every order in the notification window as done
```

Run it with the `.env` of the target database (it reads the orders tab with the same
Google credentials as the app). Idempotent — already-done orders are skipped. Undo
single orders later with the bot's `/undo`.

## Migrating from the old database (one-off)

Recipients can be copied from the old production DB (the one in `DATABASE_URL`) into
the app DB (`DB_NAME`) with:

```bash
pnpm migrate-recipients                        # dry run: shows who would move
pnpm migrate-recipients --yes                  # copy
pnpm migrate-history --from postgres --yes     # copy notification history too
```

Idempotent — chats/rows already in the target are skipped (target wins). Copying the
notification history lets the bot recognize replies («Готово», «+») to reminders that
were sent **before** the switch; without it only new reminders are resolvable.

## Running as a service (systemd)

```ini
# /etc/systemd/system/order-notifier.service
[Unit]
Description=Order delivery Telegram notifier
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/alamai/NodeJS/order_delivery
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
User=alamai

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now order-notifier
journalctl -u order-notifier -f     # follow logs
```

## Deployment: Docker + Portainer (VPS)

The GitHub Actions workflow (`.github/workflows/ci.yml`) builds the image on every push
to `main` and publishes it to GHCR as
`ghcr.io/alama1/order-delivery-notifier:{latest,<sha>}`.

The container is fully stateless and **file-less**: all configuration comes from
environment variables managed in Portainer, including the Google service-account key
(`GOOGLE_SERVICE_ACCOUNT_KEY`) — no mounts, nothing to copy to the VPS.

### 1. GHCR access (private package)

The image is private by default. Either pull it once with a token:

```bash
echo "<GHCR_PAT_with_read:packages>" | docker login ghcr.io -u <username> --password-stdin
```

…or make the package public: GitHub → your repo → **Packages** → the package →
**Package settings → Change visibility → Public**.

### 2. Encode the service-account key

On your machine (this project's folder):

```bash
base64 -w0 credentials/service-account.json   # copy the output
```

### 3. Create the stack in Portainer

**Stacks → Add stack → Repository** (this repo, `main`, `docker-compose.yml`) or paste
the file. In the **Environment variables** section, define:

| Variable | Required | Notes |
|---|---|---|
| `GOOGLE_SHEET_ID` | ✅ | spreadsheet ID from its URL |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | ✅ | the base64 output from step 2 |
| `TELEGRAM_BOT_TOKEN` | ✅ | from @BotFather |
| `DATABASE_URL` | ✅ | `postgres://user:pass@db.alamai.dev:5432/postgres` |
| `TELEGRAM_CHAT_ID` | — | optional primary chat, auto-registered |
| `DATABASE_SSL` | — | compose default is `disable` (your PG has no SSL) |
| `CRON`, `TIMEZONE`, `NOTIFY_*`, `DB_NAME`, `ORDERS_TAB`, `SETTINGS_TAB`, `DRY_RUN` | — | sensible defaults, see compose file |

Deploy, then watch logs in Portainer (**Containers → order-delivery-notifier → Logs**).
The app creates the `order_delivery` database and schema on first boot.

### 4. Updating

Push to `main` → Actions builds a new `latest` → in Portainer
**Containers → re-pull and redeploy** (or `docker compose pull && docker compose up -d`
on the host). State lives in Postgres, so redeploys are safe.

Plain-VM alternative: run from source with a `.env` file (`pnpm start`) or use the
systemd unit below; the key is then read from `GOOGLE_SERVICE_ACCOUNT_FILE`.

The container itself is stateless: `.env` and `credentials/` are mounted, dedup state
lives in PostgreSQL.

## Troubleshooting

- **`The caller does not have permission`** — the spreadsheet is not shared with the
  service-account e-mail, or the Sheets API is not enabled.
- **`Unable to parse range`** — wrong tab name; check `ORDERS_TAB` / `SETTINGS_TAB`.
- **No messages but no errors** — run `pnpm dry`; it shows parsed order count and the
  exact candidates. Most often the settings time gate hasn't passed yet.
- **Dates not recognised** — `Дата здачі` must be a real date or a `DD.MM.YYYY` /
  `YYYY-MM-DD` string. Rows without it are silently skipped.
- **Telegram `chat not found`** — wrong `TELEGRAM_CHAT_ID` or the bot is not in the group.

## Roadmap

Channel adapters are pluggable (`src/channels/`, `NOTIFY_CHANNELS`, per-channel dedup):
**WhatsApp** (Meta Cloud API, template messages) and **Viber** (bot + webhook for
subscriber IDs) can be added without schema or job-logic changes.
