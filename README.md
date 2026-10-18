# Caffi Auto Check-in Bot

**Source:**
[github.com/tachibana-shin/caffi-checkin-bot](https://github.com/tachibana-shin/caffi-checkin-bot) ·
**Live:**
[caffi-checkin-bot.tachibshin.workers.dev](https://caffi-checkin-bot.tachibshin.workers.dev) ·
**License:** [GNU GPL v3.0](LICENSE)

A Telegram bot that logs into the **Caffi** app (`vn.caffiliate.customer`) with a username/password

- OTP and performs the daily check-in at **00:00 (midnight) Vietnam time**. When the server drops
  the session, the bot messages you to log in again.

The transport is [grammY](https://grammy.dev) — long polling, retries, offsets and 409 conflict
handling all come from the library. One command layer (`src/commands.ts`), one store and one
scheduler; only the delivery differs.

It runs in three shapes, picked by `RUNTIME_MODE` in [`src/config.ts`](src/config.ts):

| shape     | where it runs         | transport                          | state                 | schedule                         |
| --------- | --------------------- | ---------------------------------- | --------------------- | -------------------------------- |
| `polling` | `deno task start`     | grammY long polling                | `data/store.kv`       | interval in `scheduler.ts`       |
| `webhook` | Deno Deploy (retired) | `POST /telegram` from `Deno.serve` | Deno KV               | `Deno.cron`                      |
| `worker`  | Cloudflare Workers    | `POST /telegram` from `fetch()`    | D1 (`src/records.ts`) | `scheduled` → self-`fetch /race` |

**Anyone can use the bot.** Every chat is keyed by its own id (`tg:<chat>`), so each person manages
exactly one set of accounts and can never see another user's data.

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
directly: the day flips at **exactly 00:00:00.000 VN** and first place sits a couple of hundred
milliseconds later (**+134ms** and **+263ms** on two measured nights), while 10th place still needed
~2.9s. So the bot **wakes up before** the scheduled time instead of at it — and it does not wait to
_see_ the flip at all: it fires a blind grid of POSTs across it.

| Env var                    | Default | Meaning                                                                           |
| -------------------------- | ------- | --------------------------------------------------------------------------------- |
| `CHECKIN_EARLY_SECONDS`    | `5`     | Start attempting at **23:59:55** for a 00:00 schedule                             |
| `CHECKIN_MAX_WAIT_SECONDS` | `600`   | If the server still counts the previous day, keep knocking for this long (10 min) |

What happens at run time (`runCheckIn` for one account, `runCheckInAll` for the nightly batch):

1. Before midnight (`runCheckInAll`), each account **fires a short grid of `POST /check-in`**
   anchored to midnight (`sprintShots`): the first shot leaves 900ms before 00:00, then one every
   200ms for two seconds — ten in total, and a second account interleaves halfway between shots.
   Every shot that lands _before_ the flip is answered "Hôm nay bạn đã điểm danh rồi" (the previous
   day is still today, and it is done); the first shot that lands _after_ it **is** the check-in.
   What bounds the arrival is the grid spacing, not the round trip: a 90ms connection and a 265ms
   one score the same instant. Measured 15–18 Oct 2026, the read-then-POST version of this race
   landed **+582…+1215ms** past midnight while first place sat at +263ms. One status read goes out
   before the grid — five seconds early, off the critical path — to answer a different question: is
   the day the server calls "today" already booked? It normally is, and then every pre-flip shot can
   only be answered "already done", which is what makes a 200 readable as the flip.
2. A 200 wins and cancels the rest of its grid — provided the pre-race read vouched for the day. If
   it could not (the read failed, or it showed yesterday was never booked), the shot's own
   `history[].checkInDate` must reach `runDate` first (`OPEN (verified)`). The status is then read
   back until it actually reflects the check-in — the wallet row is written ~200ms before the
   check-in row, so the very first read can still return the previous streak (observed: it answered
   3 when the correct value was 4).
3. A grid that never sees 200 — a server clock further from ours than the grid assumes — falls back
   to `runCheckIn`, which reads first: `todayCheckedIn === false` → the day opened →
   `POST
   /check-in` **immediately**; otherwise, while the newest `history[].checkInDate` is still
   _before_ the target day, it keeps re-reading — **50ms** across the two seconds either side of the
   deadline, then 1s for the first 20s, then 10s (`pollDelay`). A premature `POST` that the server
   rejects is retried the same way, until `CHECKIN_MAX_WAIT_SECONDS` elapses. Rate-limited responses
   are _not_ retried.
4. A run that starts once the day is already open — a restart, the catch-up cron, a re-run — cannot
   race anyone, so each account answers on its own session and "already checked in" is honoured per
   login.
5. Access tokens are refreshed up front (`CaffiApi.warm`) when their JWT `exp` is near: a 401-driven
   refresh costs two extra round trips, and they must not land on the grid.

**Why a grid, and why blind.** The flip is only visible inside a status response, so a POST sent
after seeing it leaves one full round trip after the server has already opened — on a ~265ms link
that is most of the ranking, and it is why 2026-10-09 put one account at rank 3 / 00:00:00 and the
next at rank 10 / 00:00:01. Midnight itself needs no reading: it is a fixed epoch per `runDate`. So
instead of waiting for the flip to be _seen_, the grid _arrives_ at it: the first shot leaves 900ms
early (a server clock ahead of ours is still scored) and the grid runs 900ms past midnight (a clock
behind by up to a second still finds a shot after the flip). Every shot but the winner costs one
rejected duplicate lookup, and the winner cancels the rest. A grid that never sees 200 falls back to
read-and-post, which is what keeps a clock surprise from losing the day. The geometry is pinned in
`scripts/timing.ts`; `scripts/batch.ts` replays the whole night offline against a stubbed Caffi.

A missed night is the one wrinkle: if yesterday was never booked, the server's "today" is still
yesterday, and the first shot of the grid books **it** — a 200 that would otherwise look like
tonight's win and cancel the shots that book tonight. That is what the pre-race read is for, and why
a dubious 200 is settled by the history date: a shot that books yesterday is logged as
`booked an earlier day` and the grid keeps firing. If a wrong-day 200 ever slips through, the day is
reported unfinished (`pending_day`) rather than marked done, so the 00:28 catch-up finishes it —
never a night lost to a misread 200.

The pre-roll also makes one read per account **before** it naps — a cold isolate's first request to
Caffi costs ~1.1s against ~265ms warm, and on 09-10 that cold start was most of the +1730ms the
server recorded.

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

## Bot identity

`assets/logo.png` is the icon lifted out of the APK.

- **Telegram photo** — the Bot API has no call for a bot's own picture. Send `assets/logo.png` to
  @BotFather and run `/setuserpic` there.

## Using the bot

The commands:

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
/login <user> <password>           ← log in (private chat only)
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
- Replies are private to the chat they came from, and the login family only runs in a private chat,
  so a password typed in a group cannot even be submitted.
- Without `BOT_SECRET` the store is written **plaintext** — the bot warns about it. The payload is
  sealed the same way before it reaches the store, whatever the backend.
- Locally everything lives in `data/` — do not commit it. On the serverless hosts the same records
  live in the platform's own KV/D1, sealed with `BOT_SECRET`.

## Deploying to Cloudflare Workers

The bot lives on a Cloudflare Worker (`RUNTIME_MODE=worker`, entry point
[`src/worker.ts`](src/worker.ts)). Workers has no writable filesystem and no long-lived process, so
the same three splits apply as they did on Deno Deploy — HTTP in, state in a database, schedule in a
cron trigger — and `src/records.ts` hides which database is behind the store:

|          | local (`deno task start`)                  | Cloudflare Worker                                           |
| -------- | ------------------------------------------ | ----------------------------------------------------------- |
| Telegram | grammY long polling                        | `POST /telegram`, `X-Telegram-Bot-Api-Secret-Token` checked |
| state    | `data/store.kv` (`store.json` before that) | one row in D1, key `caffi store`                            |
| schedule | timers in `src/scheduler.ts`               | `scheduled` → self-`fetch /race` → the same runner          |

### The schedule

|            |                                                                          |
| ---------- | ------------------------------------------------------------------------ |
| **Race**   | Cloudflare cron `56 16 * * *` (23:56 VN) — warm, nap 235s, then the grid |
| **Net**    | Cloudflare cron `28 17 * * *` (00:28 VN) — `tick(true)`, if unfinished   |
| **Backup** | cron-job.com calls `/race?job=pre-roll` at 00:00 VN (optional)           |

Cron has minute resolution, and every scheduler measured so far fires late — so the pre-roll fires
three minutes early and the handler **naps** the rest. The nap is what turns a jittery trigger into
an on-time one:

- Cloudflare, measured: `17:28:00` fired at **17:28:30**.
- cron-job.com, measured: `00:00:00` fired at **00:01:04** — which is why two nights of check-ins
  went out at 00:01 and this section was rewritten.

A cron invocation may run for 15 minutes of wall time and sleeping costs no CPU, so 235 seconds of
nap are free. What the pre-roll then does, in order: boot, one status read per account (which pays
the cold isolate's ~1.1s while the second is still worth nothing), nap to 23:59:55, re-warm — the
connections idled for minutes and a server may have dropped them — and only then fire the blind
grid: each account's shots start 900ms before midnight and land every 200ms, and the first one after
the flip is the check-in.

**Why the race does not go over HTTP any more.** Smart Placement applies to fetch handlers only, so
an HTTP trigger does end up placed near the Caffi servers while the cron handler does not. But the
grid is bounded by its own spacing, not by the round trip, so placement no longer decides the race —
while a late trigger still costs a minute: 64 seconds late is not a trade worth a 200ms round trip.

The old HTTP arrangement could not have won anyway — a Worker cannot subrequest itself
(`workers.dev` answers 404, a custom domain 522), so the cron handler's "wake `/race` over HTTP"
never ran. On 2026-10-11 the pre-roll fired at 23:56:26, reported Success, and the day's check-in
landed at 00:14:55 — by hand.

**cron-job.com is a backup, not the race.** Its free tier cuts a job off after 30 seconds and its
crontab has no seconds field, so it cannot aim at 23:59:55 and it fires late; but if a platform
trigger ever fails to propagate, a check-in at 00:01 still beats waiting for the 00:28 net. `?key=`
carries the secret because it sends no custom headers; a bearer token and basic auth are accepted
too.

Cloudflare needs up to 15 minutes to propagate a trigger change — worth knowing when editing
`[triggers]`, since a new spec that "does not fire" usually has not arrived yet.

Every run leaves a trace in the store: `cron:warm` (the measured RTT) and `cron:runs`, a ring buffer
of the last dozen fires from the platform cron **and** the HTTP race alike — job, who fired it, when
the trigger landed, nap length, RTT, and what the attempt found: `skipped` (outside the window or
already booked), `booked <date>`, or `unfinished: <reason>` per account. `cron:lastRun` still points
at the newest entry, but it is no longer the only one: the catch-up at 00:28 used to overwrite
whatever the pre-roll at 23:56 had to say, which is exactly what made 13→14 Oct unexplainable.

```bash
bunx wrangler d1 execute caffi --remote \
  --command "SELECT key, value FROM records WHERE key LIKE 'caffi meta cron%';"
```

**A day is marked finished only when every account is in.** On 13→14 Oct an attempt completed
without a single check-in landing — the marker went down anyway, so the HTTP race at 00:01 and the
catch-up at 00:28 were both turned away and the day was lost. A failed POST, or a day the server
never opened before the window closed, now leaves the marker off and drops the "already started"
guard, so the next trigger of the same night may retry it. The 00:28 catch-up still runs with
`force`, which is the net.

### First deploy

```bash
# 1. The repo is linked to the Worker (Workers Builds):
#    dash.cloudflare.com → Workers → caffi-checkin-bot → Settings → Builds →
#    Connect. Branch main, build command `bun install`, deploy command
#    `bunx wrangler deploy`. Every push to main then builds and ships itself.
#
#    A one-off still works from a checkout:
bunx wrangler deploy

# 2. Secrets live on the Worker, never in the repo:
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put BOT_SECRET
bunx wrangler secret put PUBLIC_URL        # https://<worker>.<subdomain>.workers.dev
bunx wrangler secret put WORKER_SECRET     # defaults to BOT_SECRET when unset

# 3. The state store: a D1 database in the region nearest the API it talks to.
bunx wrangler d1 create caffi --location apac
bunx wrangler d1 execute caffi --remote \
  --command "CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL);"

# 4. Move an existing store over. The records are copied byte for byte — still
#    sealed with BOT_SECRET, so the Worker opens them with the round count
#    recorded inside the envelope. kv-backup.ts dumps the old host, d1-seed.ts
#    writes them in.
deno run -A scripts/kv-backup.ts <database-id> /tmp/store.json     # from the old host
deno run -A scripts/d1-seed.ts /tmp/store.json /tmp/seed.sql
bunx wrangler d1 execute caffi --remote --file /tmp/seed.sql
```

The build image ships **bun 1.2**, which cannot read the lockfile a newer bun writes, so `bun.lock`
is not committed — the two dependencies are pinned in `package.json` instead.

**The round count matters.** A Worker's free plan bills **10ms of CPU per invocation** and PBKDF2 at
the rounds the store was originally sealed with (150,000 → ~1s) exceeds it by two orders of
magnitude, so `unseal` would fail and the store would read as empty. `scripts/re-seal.ts` re-seals
the record with `KDF_ITERATIONS` (1000, ~3ms) without touching the plaintext, and the round count
travels inside the envelope so an old record still opens.

```bash
deno run -A scripts/re-seal.ts /tmp/store.json /tmp/reseal.sql
bunx wrangler d1 execute caffi --remote --file /tmp/reseal.sql
```

### Checking a deployment

```bash
bunx wrangler tail                       # live logs
bunx wrangler deployments list
deno task webhook status                 # Telegram -> PUBLIC_URL/telegram, last error
deno task deploycheck                    # offline pre-flight + live probes
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
deno task timing        # offline: midnight window, grid geometry, poll cadence, decision rules
deno task view          # offline: every screen rendered as Telegram HTML
deno task wiring        # offline grammY routing test (no Telegram calls)
deno task smoke         # store encryption round-trip + live API error branches
deno task batch         # offline: the nightly batch — the blind grid across a stubbed midnight
deno task deploycheck   # offline pre-flight + live probes once PUBLIC_URL is in .env
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
