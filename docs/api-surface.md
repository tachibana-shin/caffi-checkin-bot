# Caffi API surface

_Trích xuất tự động từ APK `vn.caffiliate.customer` 1.4.2 (versionCode 67)_ _qua bundle Hermes
decompile — `deno task` không dùng file này, chỉ để đối chiếu._

- **Base URL**: `https://client-api.caffiliate.vn`
- **Auth**: `Authorization: Bearer <accessToken>` (lấy từ
  `POST /auth/mobile/password-login/verify-otp`)
- **deviceInfo**: `{"deviceId":"caffiliate-mobile","platform":"android","appVersion":"1.4.2"}`
- **Envelope lỗi**: `{"success":false,"error":{"code","message"}}`
- Gộp URL bằng `HermesInternal.concat(API_BASE_URL, path)` — không có GraphQL, không có WebSocket.

Ký hiệu cột **Loại**: `đọc` = read-only, `ghi` = thay đổi dữ liệu, `tiền` = đụng tới tiền/thông tin
nhạy cảm.

## Bot đã nối endpoint nào

`src/caffi.ts` chỉ phát **GET** cho các mục dưới đây. Ngoại lệ duy nhất là luồng đăng nhập
(`password-login`, `verify-otp`, `resend-otp`, `refresh`) và `POST /api/v2/xeng/check-in`.

| Lệnh        | Endpoint                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/status`   | `GET /api/v2/xeng/check-in/status`, `/api/v2/xeng/wallet`, `/api/v2/xeng/config`                                               |
| `/wallet`   | `GET /api/v2/xeng/wallet`, `/api/v2/xeng/config`, `/api/v2/xeng/redeem/history`, `/api/v2/user/stats`                          |
| `/info`     | `GET /api/v2/user/info`, `/api/v2/user/stats`, `/api/v2/xeng/wallet`                                                           |
| `/rewards`  | `GET /api/v2/xeng/check-in/status`, `/api/v2/xeng/config`                                                                      |
| `/history`  | `GET /api/v2/xeng/check-in/status`                                                                                             |
| `/top`      | `GET /api/v2/xeng/check-in/earliest`                                                                                           |
| `/orders`   | `GET /api/v2/orders`, `/api/v2/orders/details?order_id=`, `/api/v2/user/stats`                                                 |
| `/balance`  | `GET /api/v2/balance-timeline`, `/api/v2/withdrawals`                                                                          |
| `/rank`     | `GET /api/v2/user-rank`, `/api/v2/cashback-averages?days=`                                                                     |
| `/notify`   | `GET /api/v2/notifications/summary`, `/api/v2/notifications/user`                                                              |
| `/news`     | `GET /api/v2/announcements`                                                                                                    |
| `/security` | `GET /api/v2/profile/security`, `/api/v2/profile/payment-method`                                                               |
| `/invite`   | `GET /api/v2/invited-users`, `/api/v2/shareother`                                                                              |
| `/deals`    | `GET /api/v2/deals`, `/api/v2/deals/me`, `/api/v2/deals/community-status`, `/api/v2/deals/{id}`, `/api/v2/deals/{id}/comments` |
| `/saved`    | `GET /api/v2/bookmarks`, `/api/v2/bookmarks/count`, `/api/v2/purchase-reminders`                                               |
| `/shops`    | `GET /api/v2/router/providers`                                                                                                 |

**Chưa dùng**: `/api/v2/app-version`, `/api/v2/orders/v2/{id}`, `/api/v2/notifications/unread-count`
(trùng `summary`), `/api/v2/deals/metadata`, `/api/v2/deals/settings`,
`/api/v2/deals/post-references` (chỉ phục vụ soạn bài), `/api/v2/chat/token` (token phiên chat).
`GET /api/v2/deals/{id}/click` tuy là `GET` nhưng **ghi lại lượt click** nên không gọi.

## Auth

| Loại | Method | Path                                     | Hàm client                   | Tham số                       |
| ---- | ------ | ---------------------------------------- | ---------------------------- | ----------------------------- |
| ghi  | `POST` | `/auth/mobile/apple`                     | `_loginWithApple`            | —                             |
| ghi  | `POST` | `/auth/mobile/backdoor`                  | `_backdoorLogin`             | passcode deviceInfo           |
| ghi  | `POST` | `/auth/mobile/google`                    | `_loginWithGoogle`           | —                             |
| ghi  | `POST` | `/auth/mobile/logout`                    | `_logout`                    | refreshToken                  |
| ghi  | `POST` | `/auth/mobile/password-login`            | `_passwordLogin`             | username password deviceInfo  |
| ghi  | `POST` | `/auth/mobile/password-login/resend-otp` | `_resendPasswordLoginOtp`    | challengeId username password |
| ghi  | `POST` | `/auth/mobile/password-login/verify-otp` | `_verifyPasswordLoginOtp`    | challengeId otp deviceInfo    |
| ghi  | `POST` | `/auth/mobile/refresh`                   | `_refreshAccessToken`        | refreshToken                  |
| ghi  | `POST` | `/auth/mobile/refresh`                   | `axios response interceptor` | —                             |

## Xèng — check-in, ví, đổi thưởng

| Loại | Method | Path                             | Hàm client            | Tham số           |
| ---- | ------ | -------------------------------- | --------------------- | ----------------- |
| ghi  | `POST` | `/api/v2/xeng/check-in`          | `postCheckIn`         | —                 |
| đọc  | `GET`  | `/api/v2/xeng/check-in/earliest` | `getEarliestCheckIns` | —                 |
| đọc  | `GET`  | `/api/v2/xeng/check-in/status`   | `getCheckInStatus`    | —                 |
| đọc  | `GET`  | `/api/v2/xeng/config`            | `getConfig`           | —                 |
| tiền | `POST` | `/api/v2/xeng/redeem/cash`       | `redeemCash`          | xengAmount        |
| đọc  | `GET`  | `/api/v2/xeng/redeem/history`    | `getRedeemHistory`    | query: page,limit |
| tiền | `POST` | `/api/v2/xeng/redeem/item`       | `redeemItem`          | itemId            |
| đọc  | `GET`  | `/api/v2/xeng/wallet`            | `getWallet`           | —                 |

## Người dùng

| Loại | Method | Path                                               | Hàm client                    | Tham số                        |
| ---- | ------ | -------------------------------------------------- | ----------------------------- | ------------------------------ |
| đọc  | `GET`  | `/api/v2/app-version`                              | `_getAppVersionInfo`          | query: platform,currentVersion |
| đọc  | `GET`  | `/api/v2/cashback-averages`                        | `_getCashbackAverage`         | query: days                    |
| đọc  | `GET`  | `/api/v2/invited-users`                            | `_requestInvitedUsers`        | query: page,limit              |
| ghi  | `POST` | `/api/v2/profile/info`                             | `_updateProfilePhone`         | phone                          |
| ghi  | `POST` | `/api/v2/profile/name`                             | `_updateProfileName`          | name                           |
| ghi  | `POST` | `/api/v2/profile/notification-settings`            | `_updateNotificationSettings` | —                              |
| đọc  | `GET`  | `/api/v2/profile/payment-method`                   | `_getPaymentMethod`           | —                              |
| tiền | `POST` | `/api/v2/profile/payment-method/request-otp`       | `_requestPaymentMethodOtp`    | —                              |
| tiền | `PUT`  | `/api/v2/profile/payment-method/secure`            | `_updatePaymentMethodSecure`  | —                              |
| đọc  | `GET`  | `/api/v2/profile/security`                         | `_getSecurityStatus`          | —                              |
| tiền | `PUT`  | `/api/v2/profile/security/2fa`                     | `_updateTwoFactor`            | —                              |
| tiền | `POST` | `/api/v2/profile/security/2fa/request-disable-otp` | `_requestDisableTwoFactorOtp` | —                              |
| tiền | `POST` | `/api/v2/profile/security/password`                | `_updateSecurityPassword`     | —                              |
| tiền | `POST` | `/api/v2/profile/security/password/request-otp`    | `_requestPasswordOtp`         | —                              |
| đọc  | `GET`  | `/api/v2/shareother`                               | `ReferralsScreen`             | —                              |
| đọc  | `GET`  | `/api/v2/user-rank`                                | `_getUserRank`                | —                              |
| ghi  | `POST` | `/api/v2/user/app-activity`                        | `_trackAppActivity`           | platform appVersion            |
| đọc  | `GET`  | `/api/v2/user/info`                                | `_getUserInfo`                | —                              |
| đọc  | `GET`  | `/api/v2/user/stats`                               | `_getUserStats`               | —                              |

## Đơn hàng & tiền

| Loại | Method | Path                       | Hàm client             | Tham số                  |
| ---- | ------ | -------------------------- | ---------------------- | ------------------------ |
| đọc  | `GET`  | `/api/v2/balance-timeline` | `_getBalanceTimeline`  | query: page,limit        |
| đọc  | `GET`  | `/api/v2/orders`           | `_getOrders`           | query: page,limit,status |
| đọc  | `GET`  | `/api/v2/orders/details`   | `_getOrderDetails`     | query: order_id          |
| đọc  | `GET`  | `/api/v2/orders/v2/{id}`   | `_getOrderItemsDetail` | —                        |
| đọc  | `GET`  | `/api/v2/withdrawals`      | `_getWithdrawals`      | query: page,limit        |
| tiền | `POST` | `/api/v2/withdrawals`      | `_createWithdrawal`    | —                        |

## Thông báo & thông báo đẩy

| Loại | Method   | Path                                                  | Hàm client                      | Tham số                    |
| ---- | -------- | ----------------------------------------------------- | ------------------------------- | -------------------------- |
| đọc  | `GET`    | `/api/v2/announcements`                               | `_getAnnouncements`             | query: page,limit,isActive |
| ghi  | `POST`   | `/api/v2/announcements/read-all`                      | `_markAllAnnouncementsRead`     | —                          |
| ghi  | `POST`   | `/api/v2/announcements/{id}/read`                     | `_markAnnouncementRead`         | —                          |
| ghi  | `POST`   | `/api/v2/notifications/read-all` _(fallback legacy)_  | `_markAllAnnouncementsRead`     | —                          |
| đọc  | `GET`    | `/api/v2/notifications/summary`                       | `_getNotificationSummary`       | —                          |
| đọc  | `GET`    | `/api/v2/notifications/unread-count`                  | `_getUnreadCount`               | —                          |
| đọc  | `GET`    | `/api/v2/notifications/user`                          | `_getUserNotifications`         | query: page,limit          |
| ghi  | `PUT`    | `/api/v2/notifications/user/read-all`                 | `_markAllUserNotificationsRead` | —                          |
| ghi  | `PUT`    | `/api/v2/notifications/user/{id}/read`                | `_markUserNotificationRead`     | —                          |
| ghi  | `POST`   | `/api/v2/notifications/{id}/read` _(fallback legacy)_ | `_markAnnouncementRead`         | —                          |
| ghi  | `DELETE` | `/api/v2/user/push-token`                             | `_deletePushToken`              | data                       |
| ghi  | `POST`   | `/api/v2/user/push-token`                             | `_registerPushToken`            | —                          |

## Deals / cộng đồng

| Loại | Method   | Path                                             | Hàm client                        | Tham số                  |
| ---- | -------- | ------------------------------------------------ | --------------------------------- | ------------------------ |
| đọc  | `GET`    | `/api/deals/post-references` _(fallback legacy)_ | `_getCommunityDealPostReferences` | —                        |
| đọc  | `GET`    | `/api/deals/settings` _(fallback legacy)_        | `_getCommunityDealSettings`       | —                        |
| đọc  | `GET`    | `/api/v2/deals`                                  | `_getDeals`                       | query: page,limit        |
| ghi  | `POST`   | `/api/v2/deals`                                  | `_createDeal`                     | —                        |
| ghi  | `DELETE` | `/api/v2/deals/comments/{id}`                    | `_deleteDealComment`              | —                        |
| ghi  | `PUT`    | `/api/v2/deals/comments/{id}`                    | `_updateDealComment`              | —                        |
| đọc  | `GET`    | `/api/v2/deals/community-status`                 | `_getCommunityStatus`             | —                        |
| đọc  | `GET`    | `/api/v2/deals/me`                               | `_getMyDeals`                     | query: page,limit,status |
| đọc  | `GET`    | `/api/v2/deals/metadata`                         | `_getDealMetadata`                | —                        |
| đọc  | `GET`    | `/api/v2/deals/post-references`                  | `_getCommunityDealPostReferences` | —                        |
| đọc  | `GET`    | `/api/v2/deals/settings`                         | `_getCommunityDealSettings`       | —                        |
| ghi  | `POST`   | `/api/v2/deals/tos/agree`                        | `_agreeToCommunityDealsTerms`     | —                        |
| ghi  | `POST`   | `/api/v2/deals/upload-image`                     | `_uploadDealImage`                | imageData                |
| ghi  | `DELETE` | `/api/v2/deals/{id}`                             | `_deleteDeal`                     | —                        |
| đọc  | `GET`    | `/api/v2/deals/{id}`                             | `_getDeal`                        | —                        |
| đọc  | `GET`    | `/api/v2/deals/{id}`                             | `_getMetadataList`                | —                        |
| ghi  | `PATCH`  | `/api/v2/deals/{id}`                             | `_updateDeal`                     | —                        |
| đọc  | `GET`    | `/api/v2/deals/{id}/click`                       | `_resolveDealClick`               | —                        |
| đọc  | `GET`    | `/api/v2/deals/{id}/comments`                    | `_getDealComments`                | —                        |
| ghi  | `POST`   | `/api/v2/deals/{id}/comments`                    | `_createDealComment`              | —                        |
| ghi  | `POST`   | `/api/v2/deals/{id}/report`                      | `_reportDeal`                     | —                        |
| ghi  | `DELETE` | `/api/v2/deals/{id}/vote`                        | `_removeDealVote`                 | —                        |
| ghi  | `POST`   | `/api/v2/deals/{id}/vote`                        | `_voteDeal`                       | —                        |

## Bookmark

| Loại | Method   | Path                        | Hàm client            | Tham số                              |
| ---- | -------- | --------------------------- | --------------------- | ------------------------------------ |
| đọc  | `GET`    | `/api/v2/bookmarks`         | `_getBookmarks`       | query: page,limit,search,provider_id |
| ghi  | `POST`   | `/api/v2/bookmarks`         | `_createBookmark`     | —                                    |
| ghi  | `DELETE` | `/api/v2/bookmarks/by-user` | `_deleteAllBookmarks` | —                                    |
| đọc  | `GET`    | `/api/v2/bookmarks/count`   | `_getBookmarkCount`   | —                                    |
| ghi  | `DELETE` | `/api/v2/bookmarks/{id}`    | `_deleteBookmark`     | —                                    |

## Nhắc mua & chuyển link

| Loại | Method   | Path                              | Hàm client                | Tham số                           |
| ---- | -------- | --------------------------------- | ------------------------- | --------------------------------- |
| đọc  | `GET`    | `/api/v2/purchase-reminders`      | `_getPurchaseReminders`   | params                            |
| ghi  | `POST`   | `/api/v2/purchase-reminders`      | `_createPurchaseReminder` | —                                 |
| ghi  | `DELETE` | `/api/v2/purchase-reminders/{id}` | `_cancelPurchaseReminder` | —                                 |
| ghi  | `POST`   | `/api/v2/router/convert`          | `_convertLink`            | provider_code originalLink direct |
| đọc  | `GET`    | `/api/v2/router/providers`        | `_getProviders`           | —                                 |

## Khác

| Loại | Method | Path                 | Hàm client      | Tham số |
| ---- | ------ | -------------------- | --------------- | ------- |
| đọc  | `GET`  | `/api/v2/chat/token` | `_getChatToken` | —       |

## Host khác ngoài API

| Host                              | Dùng cho                |
| --------------------------------- | ----------------------- |
| `cdn-public.caffiliate.vn`        | ảnh upload của app      |
| `i.caffi.vn`                      | avatar/ảnh              |
| `hotro.caffi.io.vn`               | trang hỗ trợ            |
| `api.qrserver.com`                | sinh QR                 |
| `qr.sepay.vn/banks.json`          | danh sách ngân hàng     |
| `caffi.vn`, `caffiliate.vn`       | trang chính sách/thể lệ |
| `t.me/caffiliate`, Facebook, Zalo | mạng xã hội             |

**Tổng: 76 đường dẫn riêng biệt, 88 điểm gọi.**
