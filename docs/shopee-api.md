# Shopee daily check-in — reverse-engineering notes

Everything below was taken apart from the JS that `https://shopee.vn/shopee-coins` lazy-loads, not
from anything Shopee documents. Recorded against production on **07-10-2026**.

The client built from these notes lives in [`src/shopee.ts`](../src/shopee.ts); the offline contract
test is `deno task shopee`.

## Where the endpoints live

The route `/shopee-coins` is handled by the `pcmall-coinsrewardpage` chunk, which in turn lazy-loads
the `dailycheckin` chunk. That chunk builds its axios client like this (minified, re-indented):

```js
$ = { sg: "shopee.sg", my: "shopee.com.my", …, vn: "shopee.vn", … };
eb = (() => {
  const n = env === "live" ? "" : env === "liveish" ? "live-test." : `${env}.`;
  return `${n}${$[locale]}`;
})(__ENV__.toLocaleLowerCase(), __LOCALE__.toLocaleLowerCase());

e_ = `https://games-dailycheckin.${eb}/`;
ew = `${e_}mkt/coins/api/v2/`;
ex = axios.create({ baseURL: ew, withCredentials: true });
```

For `__ENV__ = "live"` and `__LOCALE__ = "vn"` that resolves to:

```
https://games-dailycheckin.shopee.vn/mkt/coins/api/v2/
```

Note it is **not** `shopee.vn/api/…`.

## Endpoints

| Method | Path          | Purpose                                               |
| ------ | ------------- | ----------------------------------------------------- |
| GET    | `settings`    | identity + today's state. Read-only.                  |
| POST   | `checkin_new` | performs the check-in. Body `{}`. **The only write.** |

The same bundle also references `/api/v4/coin/get_user_coins_summary` and the whole
`/api/v4/market_coin/redeem_*` namespace (voucher redemption). None of those are used here.

### Headers

Both calls carry:

| Header            | Value                                            |
| ----------------- | ------------------------------------------------ |
| `dci-version`     | `4008000` — a build number, not a secret         |
| `check-in-origin` | `pc` — the call site in the bundle is `eJ("pc")` |
| `cookie`          | the browser's SSO cookies                        |
| `origin`          | `https://shopee.vn`                              |
| `referer`         | `https://shopee.vn/shopee-coins`                 |

The server's CORS reply enumerates what it accepts:

```
access-control-allow-headers: Origin, X-Requested-With, Content-Type, Accept,
                              dci-version, check-in-origin, brand, channel, network
access-control-allow-methods: POST, GET, OPTIONS, DELETE, PUT
```

`POST` also needs `content-type: application/json`. There is **no signature** — the `af-ac-enc-dat`
anti-bot scheme used on some `/api/v4/*` routes does not appear on this namespace.

### `POST checkin_new` body

The page builds `{ dfp, s }`:

- `dfp` — a device fingerprint read from an anti-fraud script (`…/mkt/coins/api/v2/js/ac.js`) loaded
  as `await K().catch(() => {})`. The `catch` means **the page itself sends `undefined` when the
  script fails to load**.
- `s` — `window._xac || ""[decode(eF)]`, where `decode` yields `_ss`. Either branch produces `""` or
  `undefined`.

So `{}` is the fallback the page falls back to, and it is accepted. This is what the bot sends.

## Responses

The wire is **snake_case**. The bundle rewrites keys to camelCase in an axios interceptor
(`er = e => en(e, s => s.replace(/([A-Z])/g, "_$1").toLowerCase())` on the way out, the inverse on
the way in), which is why the identifiers in the minified source never match a raw response.

### `GET settings`, no session — HTTP 200

Captured verbatim (giant `asset_setting` elided):

```json
{"code":0,"msg":"success","data":{
  "@timestamp":"2026-10-07T14:01:35+08:00",
  "activity_id":100510,
  "asset_setting":"{ … UI strings … }",
  "checked_in_today":false,
  "checked_in_today_amount":100,
  "checkin_list":[100,100,100,100,100,100,100,100],
  "checkin_reward_list":[{"type":1,"val":100},…,{"type":1,"val":200},…],
  "dataview_type":"access",
  "deviceid":"-",
  "devicetype":"PC",
  "fraud_detected":false,
  "highlight":[0,0,0,0,0,0,1],
  "ip_addr":"…",
  "last_prize_type":0,
  "logid":"…",
  "login":false,
  "show_guidance_animation":0,
  "slot_id":25,
  "special_week_user_scope":0,
  "timestamp":1791352895,
  "today_index":1,
  "uniqueid":"u-1",
  "userid":"-1"
}}
```

Fields the bot reads:

| Field                     | Meaning                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `login`                   | `false` + `userid:"-1"` = nobody signed in (no/invalid cookie)                |
| `userid`                  | the signed-in user, once there is one                                         |
| `checked_in_today`        | today already covered (by you, in the app, or because the day has not rolled) |
| `checked_in_today_amount` | the reward for today                                                          |
| `today_index`             | 0-based position in the 8-day cycle                                           |
| `checkin_list`            | the 8 daily coin amounts                                                      |
| `checkin_reward_list`     | the same schedule with a `type` tag                                           |
| `fraud_detected`          | anti-fraud flag                                                               |
| `activity_id` / `slot_id` | which campaign instance is running                                            |
| `@timestamp`              | **the cluster's own clock, at +08:00**                                        |

`asset_setting` is a JSON-encoded string of every UI string and image id for the page — Vietnamese
included. It is ignored.

### `POST checkin_new`, credited — HTTP 200

```json
{"code":0,"msg":"success","data":{
  "success":true,
  "increase_coins":100,
  "today_index":1,
  "reward_type":0,
  "checkin_list":[…]
}}
```

### Not signed in

With `content-type: application/json` the SSO middleware answers before the handler runs:

```
HTTP/2 401
{"code":401,"msg":"Unauthorization with sso"}
```

Without a JSON body the request falls through to a generic error page instead:

```json
{
  "is_customized": false,
  "is_login": false,
  "action_type": 2,
  "error": 90309999,
  "tracking_id": "…",
  "redirect_to_error_page": true
}
```

The bot treats `401`, `code:401` and `is_login:false` alike: the cookie is gone, so it stops calling
the API for that session and messages you once every 24 hours until you paste a new one.

## Schedule

The cluster stamps `+08:00`, Vietnam is `+07:00`, so "today" may flip at **23:00 VN** (the cluster's
midnight) or at **00:00 VN**. Two runs cover both readings:

| Job                       | Spec (UTC)    | Vietnam |
| ------------------------- | ------------- | ------- |
| `shopee-checkin`          | `0 17 * * *`  | 00:00   |
| `shopee-checkin-catch-up` | `30 17 * * *` | 00:30   |

There is no race to win here — unlike Caffi, the reward does not depend on how early you are — so
neither job wakes before its minute.

The decision rule, per session:

1. `lastCheckInDay === today` → done, **no request at all**.
2. `GET settings`. `login:false` or a 401 → session expired, stop.
3. `checked_in_today === true` → already covered (by us, by the user in the app, or because the day
   has not rolled yet). Report it and let the 00:30 run look again.
4. Otherwise `POST checkin_new`. `success:true` → record `lastCheckInDay` and stand down.
5. A non-zero `code` is re-checked against `settings`: if the day is now covered, it was an
   "already" in disguise; otherwise it is a real failure and the 00:30 run retries.

## What the bot does not do

- No voucher redemption, no order calls, no profile writes — `settings` (GET) and `checkin_new`
  (POST) are the entire surface.
- No password, no OTP: Shopee has no app-token login to run.
- No retries of `checkin_new` beyond the single 00:30 catch-up, so a slow response can never turn
  into a double check-in (the server enforces one per day anyway).

`deno task deploycheck` asserts "exactly one POST per run" against a stubbed `fetch`, so an
accidental extra endpoint shows up before anything is deployed.
