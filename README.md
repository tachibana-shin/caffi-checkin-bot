# Caffi Auto Check-in Bot

**Source:**
[github.com/tachibana-shin/caffi-checkin-bot](https://github.com/tachibana-shin/caffi-checkin-bot) ·
**Live:**
[caffi-checkin-bot.tachibana-shin.deno.net](https://caffi-checkin-bot.tachibana-shin.deno.net) ·
**License:** [GNU GPL v3.0](LICENSE)

A Telegram **and** Discord bot that logs into the **Caffi** app (`vn.caffiliate.customer`) with a
username/password + OTP and performs the daily check-in at **00:00 (midnight) Vietnam time**. When
the server drops the session, the bot messages you to log in again.

The transports are [grammY](https://grammy.dev) for Telegram and
[discordeno](https://discordeno.js.org) for Discord — long polling, retries, offsets and 409
conflict handling all come from the libraries. Both sides share one command layer
(`src/commands.ts`), one store and one scheduler; only the delivery differs.

It runs in two shapes, picked by `RUNTIME_MODE` in [`src/config.ts`](src/config.ts): **polling**
(the default locally) is grammY long polling + the Discord gateway + a `data/store.kv` file;
**webhook** (the default as soon as `DENO_DEPLOY=true`) serves `POST /telegram` and `POST /discord`
from `Deno.serve`, keeps the state in Deno KV and hands the schedule to `Deno.cron`. The command
layer and the check-in arithmetic are the same in both — see
[Deploying to Deno Deploy](#deploying-to-deno-deploy).

**Anyone can use the bot.** Every chat is keyed by its own id (`tg:<chat>` / `ds:<user>`), so each
person manages exactly one set of accounts and can never see another user's data. On Discord every
reply is ephemeral, and the `/login` family is restricted to DMs so credentials never land in a
server channel.

## Where the API came from

Every endpoint below was extracted from `assets/index.android.bundle` (Hermes bytecode) inside the
APK `vn.caffiliate.customer` v1.4.2, using `hermes-dec`.

The **full surface** — 76 distinct routes / 88 call sites, with HTTP verb, client function name,
query params and body keys, plus every host the app talks to — is in
[`docs/api-surface.md`](docs/api-surface.md).

| Action             | Endpoint                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| Login              | `POST /auth/mobile/password-login`                                                                 |
| Verify OTP         | `POST /auth/mobile/password-login/verify-otp`                                                      |
| Resend OTP         | `POST /auth/mobile/password-login/resend-otp`                                                      |
| Refresh session    | `POST /auth/mobile/refresh`                                                                        |
| Check-in status    | `GET /api/v2/xeng/check-in/status`                                                                 |
| Check in           | `POST /api/v2/xeng/check-in`                                                                       |
| Today's fastest 10 | `GET /api/v2/xeng/check-in/earliest`                                                               |
| Coin wallet        | `GET /api/v2/xeng/wallet`                                                                          |
| Xèng config        | `GET /api/v2/xeng/config`                                                                          |
| Redeem history     | `GET /api/v2/xeng/redeem/history`                                                                  |
| User info          | `GET /api/v2/user/info`                                                                            |
| User stats         | `GET /api/v2/user/stats`                                                                           |
| Orders             | `GET /api/v2/orders`, `/orders/details?order_id=`                                                  |
| Balance timeline   | `GET /api/v2/balance-timeline`                                                                     |
| Withdrawals        | `GET /api/v2/withdrawals`                                                                          |
| Invited users      | `GET /api/v2/invited-users`                                                                        |
| Share commission   | `GET /api/v2/shareother`                                                                           |
| Notifications      | `GET /api/v2/notifications/user`, `/summary`                                                       |
| Announcements      | `GET /api/v2/announcements`                                                                        |
| Leaderboard        | `GET /api/v2/user-rank`                                                                            |
| Platform averages  | `GET /api/v2/cashback-averages?days=`                                                              |
| Security settings  | `GET /api/v2/profile/security`                                                                     |
| Payout account     | `GET /api/v2/profile/payment-method`                                                               |
| Community deals    | `GET /api/v2/deals`, `/deals/{id}`, `/deals/{id}/comments`, `/deals/me`, `/deals/community-status` |
| Bookmarks          | `GET /api/v2/bookmarks`, `/bookmarks/count`                                                        |
| Purchase reminders | `GET /api/v2/purchase-reminders`                                                                   |
| Supported shops    | `GET /api/v2/router/providers`                                                                     |

The bot is **read-only** apart from the two login endpoints and `POST /check-in`. Every screen above
is a plain `GET`. It never calls `redeem/cash`, `redeem/item`, `POST /withdrawals`, any
`PUT /profile/...` or any mark-as-read — redemptions, withdrawals and profile changes are whatever
you did in the app yourself.

Base URL: `https://client-api.caffiliate.vn`

Headers: `Content-Type: application/json` + `Authorization: Bearer <accessToken>`

`deviceInfo` sent along at login time (identical to the app):

```json
{ "deviceId": "caffiliate-mobile", "platform": "android", "appVersion": "1.4.2" }
```

### When the check-in day resets

`GET /api/v2/xeng/check-in/status` allows exactly one check-in per "day". That day is keyed by
**Vietnam time** and resets at **00:00 VN**, not UTC. Derived from `wallet.logs` (consecutive streak
5→6→7→8):

| createdAt (UTC)    | Vietnam time       | Note  |
| ------------------ | ------------------ | ----- |
| `2026-08-28 04:54` | 11:54 VN 08-28     | day 6 |
| `2026-08-28 17:59` | **01:59 VN 08-29** | day 7 |

Two valid check-ins on the same UTC date `08-28` → the day key is not UTC. A UTC cron would skip
days or get rejected. The scheduler therefore runs in `Asia/Ho_Chi_Minh` with a 30-minute catch-up
window.

### Being first at midnight

The fastest check-in of the day earns a bigger reward. The server's own
`GET /api/v2/xeng/check-in/earliest` returns today's top 10, and it answers both open questions
directly: the day flips at **exactly 00:00:00.000 VN** (first place arrived at **+134ms**) and 10th
place still needed ~2.9s. So the bot **wakes up before** the scheduled time instead of at it, and
polls in 50ms steps across the flip rather than once a second.

| Env var                    | Default | Meaning                                                                           |
| -------------------------- | ------- | --------------------------------------------------------------------------------- |
| `CHECKIN_EARLY_SECONDS`    | `5`     | Start attempting at **23:59:55** for a 00:00 schedule                             |
| `CHECKIN_MAX_WAIT_SECONDS` | `600`   | If the server still counts the previous day, keep knocking for this long (10 min) |

What happens at run time (`runCheckIn` for one account, `runCheckInAll` for the nightly batch):

1. `GET /check-in/status`.
2. `todayCheckedIn === false` → the server opened the new day → `POST /check-in` **immediately**.
3. `todayCheckedIn === true` but the newest `history[].checkInDate` is still _before_ the target day
   → the clock has not rolled over yet → poll again. The cadence comes from `pollDelay`: **50ms**
   across the two seconds either side of the deadline (first place on the server's own `earliest`
   leaderboard sits at +134ms), then 1s for the first 20s, then 10s.
4. A premature `POST` that the server rejects is retried the same way, until
   `CHECKIN_MAX_WAIT_SECONDS` elapses. Rate-limited responses are _not_ retried.
5. After a successful `POST` the status is read back until it actually reflects it — the wallet row
   is written ~200ms before the check-in row, so the very first read can still return the previous
   streak (observed: it answered 3 when the correct value was 4).

**Several accounts, one race.** One account's session watches for the flip (`waitForDayOpen`); the
moment it lands, **every** `POST` is issued from the same `Promise.all`, with the per-account status
read skipped on purpose. That read is one round trip (~265ms from the `ord`/`ams` regions to the
Caffi servers in Vietnam), and one read per account is exactly what used to cost the ranking:
measured on 2026-10-09, the account that had been watching since the pre-roll got **rank 3 at
00:00:00** while the one that woke up at midnight and had to discover the flip by itself got **rank
10 at 00:00:01** — a round trip of distance between two check-ins that should have been
simultaneous. One poller also keeps the request rate at one session instead of N.

The watch itself is pipelined: three reads stay in flight, so a reader that waits for its own
response cannot miss the flip for two round trips. The pre-roll also makes one read per account
**before** it naps — a cold isolate's first request to Caffi costs ~1.1s against ~265ms warm, and on
09-10 that cold start was most of the +1730ms the server recorded.

A run that starts when the day is already open — a restart, the catch-up cron, a re-run — cannot
race anyone, so `runCheckInAll` asks each account on its own session instead and honours "already
checked in" per login. If the watcher's session is dead the watch passes to the next account, and a
POST that still answers "day not open" falls back to that account's own `runCheckIn` loop. Access
tokens are refreshed up front (`CaffiApi.warm`) when their JWT `exp` is near: a 401-driven refresh
costs two extra round trips, which must not land on the POST being timed.

The run is keyed by the **target day**, not by the wall clock, so a run that starts at 23:59:55 and
one that continues at 00:00:03 count as the same run — no double check-in across midnight.

### Limits worth knowing

- `POST /auth/mobile/password-login` is rate limited to **20 requests / 900 seconds**. The bot only
  calls it when you type `/login`, never retries on its own, and additionally enforces a **20-second
  cooldown per chat** so a flood of commands cannot burn the budget.
- Server errors look like `{"success":false,"error":{"code":"...","message":"..."}}`. Codes
  `TOKEN_INVALID` / `NOT_AUTHENTICATED` mean the session is gone → the bot asks you to log in again.
- The wallet balance is nested: `response.wallet.balance`.

## Setup

```bash
cd caffi-bot
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN and BOT_SECRET
deno task check
deno task start
```

`BOT_SECRET` encrypts the passwords + JWTs stored on disk (AES-256-GCM, key derived via PBKDF2 with
150k iterations). Generate it with:

```bash
openssl rand -hex 32
```

### Adding Discord

1. Create an application at <https://discord.com/developers/applications> and add a **bot**.
2. Copy the bot token into `DISCORD_TOKEN` (the application id is optional — it is derived from the
   token). Invite the bot with the `bot` scope and the `applications.commands` scope.
3. Restart. On start-up the bot pushes its slash commands globally; Discord can take up to an hour
   to show them the first time.
4. Only for the webhook shape (Deno Deploy): copy **General Information → Public Key** into
   `DISCORD_PUBLIC_KEY` and set **Interactions Endpoint URL** to `PUBLIC_URL/discord`. Discord signs
   a PING with that public key and wants its `challenge` echoed back — when the handshake fails the
   slash commands stay dead while everything else still looks fine, so it is worth checking the logs
   for `[discord] ping from Discord`.

With `DISCORD_TOKEN` empty the Discord side is skipped entirely.

## Bot identity

```bash
deno task logo   # name + description on Telegram, avatar + application icon on Discord
```

Everything comes from `assets/logo.png`, the icon lifted out of the APK. The script sets the names
and descriptions on both platforms plus the Discord **bot avatar** (the picture people actually see
in a chat). Two more pictures have to go up by hand — neither API exposes them:

- **Telegram photo** — the Bot API has no call for a bot's own picture. Send `assets/logo.png` to
  @BotFather and run `/setuserpic` there.
- **Discord application icon** — `PATCH /oauth2/applications/@me` wants a _user_ token and answers a
  bot token with `403 Bots cannot use this endpoint`. Developer Portal → General Information → App
  Icon → upload `assets/logo.png` (512×512 PNG).

## Using the bot

Both platforms understand the same commands:

```
/help                              ← the menu (Telegram also shows buttons)
/status                            ← today: streak, rank, coins, 7-day preview
/wallet                            ← Xèng, đồng equivalent, redemptions, commission
/info                              ← profile, rank, progress to the next tier, orders
/rewards                           ← check-in rewards + the gift catalogue
/history                           ← the last 10 check-ins
/top                               ← today's 10 fastest check-ins (millisecond resolution)
/checkin                           ← check in right now
/orders [mã]                       ← orders, or one order by its code
/balance                           ← income/expense timeline + withdrawal history
/rank                              ← monthly leaderboard + platform averages
/notify                            ← your notifications (never marked read)
/news                              ← system announcements
/security                          ← OTP, password age, payout account (masked)
/invite                            ← friends invited + share commission
/deals [id]                        ← community deals, or one deal with its comments
/saved                             ← bookmarks + purchase reminders
/shops                             ← the shops the link router supports
/login <user> <password>           ← log in (Discord: DM only)
123456 /otp 123456                 ← enter the OTP
/resend                            ← request a new code
/cancel                            ← abandon a pending OTP session
/accounts                          ← list accounts
/use <name>                        ← pick the active account
/auto on|off                       ← auto check-in for the active account
/logout [name]                     ← remove an account from the bot
```

Every command from `/orders` down to `/shops` is **read-only**: the bot fetches and displays, it
never acts on your account. The only writes it ever performs are the login flow and `/checkin`.

Each chat can hold **several accounts**; switch the active one with `/use <name>`.

## Security — read before running

- The bot **must** keep `username` + `password` to resend OTPs and log back in after a forced
  logout. "Re-login automatically" is impossible without storing the password.
- Data is stored **per chat id**. There is no allowlist and no shared state: `/accounts`, `/wallet`
  and everything else only ever read the caller's own records.
- Discord replies are ephemeral, and `/login`, `/otp`, `/resend` and `/cancel` are hidden outside
  DMs, so a password typed in a server channel cannot even be submitted.
- Without `BOT_SECRET` the store is written **plaintext** — the bot warns about it. On Deno Deploy
  the payload is sealed the same way before it reaches Deno KV.
- Locally everything lives in `data/` — do not commit it. On Deno Deploy the same records live in
  Deno KV, attached to the app.

## Deploying to Deno Deploy

Deno Deploy has no writable filesystem and no single long-lived process, so there the bot runs
`RUNTIME_MODE=webhook` (`src/main.ts`):

|          | local (`deno task start`)                  | Deno Deploy                                                 |
| -------- | ------------------------------------------ | ----------------------------------------------------------- |
| Telegram | grammY long polling                        | `POST /telegram`, `X-Telegram-Bot-Api-Secret-Token` checked |
| Discord  | gateway                                    | `POST /discord`, Ed25519 over `timestamp + body`            |
| state    | `data/store.kv` (`store.json` before that) | Deno KV, one record under `["caffi", "store"]`              |
| schedule | timers in `src/scheduler.ts`               | two `Deno.cron` jobs from `src/cron.ts`                     |

The handler still naps to the exact second (`msUntilWindow`), so the cron only has to wake an
isolate _near_ the window: `caffi-checkin-pre-roll` at `56 16 * * *` UTC (23:56 VN) and
`caffi-checkin-catch-up` at `28 17 * * *` UTC (00:28 VN). The pre-roll deliberately fires **three
minutes early**: Deno Deploy documents that "the exact invocation time of your `Deno.cron` handler
may vary by up to a minute from the scheduled time", and a spec in the minute right before midnight
leaves less than a minute of slack for that jitter. On 2026-10-08 the job started at 00:00:02
instead of 23:59:00, so the isolate opened the connection _after_ the day had turned and the
check-in landed on second 6. The catch-up run no-ops when the pre-roll already finished, so a
redeploy in the middle of the window cannot check in twice.

### First deploy

```bash
# 1. Environment. `DENO_*` names are rejected — the platform owns that prefix
#    and sets DENO_DEPLOY itself.
cat > /tmp/app.env <<'EOF'
TELEGRAM_BOT_TOKEN=...
BOT_SECRET=...
DISCORD_TOKEN=...
DISCORD_APPLICATION_ID=...
DISCORD_PUBLIC_KEY=...
PUBLIC_URL=https://<app>.<org>.deno.net
RUNTIME_MODE=webhook
EOF
deno deploy env load /tmp/app.env --replace --org <org> --app <app>

# 2. A KV database to attach — the plan allows one, so an existing one may have
#    to be shared (the keys are namespaced under "caffi").
deno deploy database assign <db> --org <org> --app <app>

# 3. Ship it. The app is linked to the GitHub repo, so the normal way to ship is a push:
git push origin main            # main is built and deployed to production automatically
# A one-off without a commit still works:
# deno deploy --prod --non-interactive --org <org> --app <app> .
```

Without step 2 the first boot dies with _"no KV database is attached to this app"_.

**Bringing the accounts over.** There is no `data/store.json` on Deno Deploy, so the KV starts empty
and every account has to be logged in again. To keep the ones you already have, hand the file over
as an env var — it is still sealed with `BOT_SECRET`, so the platform only ever stores ciphertext:

```bash
deno deploy env add --secret STORE_IMPORT "$(tr -d '\n' < data/store.json)" \
  --org <org> --app <app>
deno deploy --prod ...        # boot logs "🚚 Seeded Deno KV from STORE_IMPORT — n chat(s)"
deno deploy env remove STORE_IMPORT --org <org> --app <app>   # one shot, then drop it
```

The branch only fires while the KV record is missing, so leaving the variable behind is harmless —
but it goes stale, and removing it keeps one copy of the accounts instead of two.

### Checking a deployment

```bash
deno task webhook status   # Telegram -> PUBLIC_URL/telegram, last error
deno deploy logs --once --json --non-interactive --org <org> --app <app>
deno task deploycheck      # offline pre-flight + live probes once PUBLIC_URL is set
```

## Running in the background

```bash
deno task start &                 # simple
# or
nohup deno task start > bot.log 2>&1 &
```

## Tests

```bash
deno task check         # type check
deno task lint
deno task timing        # offline: midnight window, poll cadence, check-in decision rules
deno task view          # offline: every screen rendered as Telegram HTML + Discord embed
deno task wiring        # offline grammY routing test (no Telegram calls)
deno task smoke         # store encryption round-trip + live API error branches
deno task batch         # offline: the nightly batch — one watcher, POSTs together
deno task deploycheck   # offline pre-flight for the Deno Deploy shape (+ live probes
                        #  when PUBLIC_URL is in .env)
```

Live-account smoke scripts (manual, not part of CI):

```bash
CAFFI_USER=... CAFFI_PASS=... deno run -A scripts/test-login.ts start
CAFFI_USER=... CAFFI_PASS=... deno run -A scripts/test-login.ts verify 123456
deno run -A scripts/test-session.ts            # read-only
deno run -A scripts/test-session.ts checkin    # performs the check-in
```

## License

[GNU General Public License v3.0](LICENSE) — the full text is in [`LICENSE`](LICENSE), its SPDX
identifier is `GPL-3.0-only`.

You are free to run, study, share and modify this program. Anything you distribute based on it must
carry the same licence and its source must stay available — that is the whole point of copy-left:
the bot that starts checking people in keeps the code that does it open too.
