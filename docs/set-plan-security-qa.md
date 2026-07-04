# POST /api/set-plan - Security QA Checklist

This document records the manual QA verification of the `set-plan` endpoint before going live.
Run each curl command against your deployed Vercel URL and confirm the expected HTTP status and response body.

```
BASE_URL=https://<your-vercel-deployment>.vercel.app
SECRET=<your SET_PLAN_SECRET value>
REAL_USER_ID=<a real Clerk userId from your dashboard>
```

### Required environment variables

All five variables below must be set in **Vercel → Project → Settings → Environment Variables** before going live.
A missing variable causes the webhook to return 500 on every event - payments will not be activated.

| Variable | Where to get it | Effect if missing |
|---|---|---|
| `BASE_URL` | Your production domain, e.g. `https://mockuprabbit.com` (no trailing slash) | Webhook returns 500 - no user is ever upgraded after payment |
| `STRIPE_WEBHOOK_SECRET` | Stripe dashboard → Developers → Webhooks → your endpoint → Signing secret | Webhook returns 500 - all events rejected |
| `SET_PLAN_SECRET` | A random string you generate, e.g. `openssl rand -hex 32` | Webhook returns 500; `set-plan` endpoint also refuses all calls |
| `CLERK_SECRET_KEY` | Clerk dashboard → API keys | `set-plan` endpoint cannot update user metadata |
| `MONGODB_URI` | MongoDB Atlas (or self-hosted) connection string | `set-plan`'s replay-protection nonce store (`api/_nonce-store.js`, MongoDB-backed) fails closed - every request returns 500 with `"Failed to record nonce; request not processed"`, even with a valid secret |

`UPSTASH_REDIS_REST_URL`/`TOKEN` and `DATABASE_URL` are **not** required for this endpoint - they only back the rate limiters (a separate, lower-stakes concern that fails open). The nonce store described in cases 13–14 and the clear-nonce endpoint below are entirely MongoDB-backed; see the "Consolidate nonce store onto MongoDB" change.

> **Quick validation:** after deploying, run `node scripts/check-env.js` locally (or as a Vercel build command) to confirm all required variables are present.

---

## 1. Wrong secret → 401

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer WRONG_SECRET" \
  -H "X-Timestamp: $(date +%s)" \
  -d '{"userId":"user_abc","plan":"pro"}'
```

**Expected:** `401`
**Expected body:** `{"ok":false,"error":"Unauthorized"}`

**Code path:** `api/set-plan.js` - `token !== setPlanSecret` triggers 401 before any Clerk call is made. `X-Timestamp` is required to get past the timestamp gate before auth is checked.

---

## 2. Missing Authorization header → 401

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "X-Timestamp: $(date +%s)" \
  -d '{"userId":"user_abc","plan":"pro"}'
```

**Expected:** `401`
**Expected body:** `{"ok":false,"error":"Unauthorized"}`

**Code path:** `!token` is truthy (empty string from missing header), same branch as wrong secret. `X-Timestamp` is required to get past the timestamp gate before auth is checked.

---

## 3. Missing userId → 400

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Nonce: $(openssl rand -hex 16)" \
  -d '{"plan":"pro"}'
```

**Expected:** `400`
**Expected body:** `{"ok":false,"error":"Missing or invalid userId"}`

**Code path:** `api/set-plan.js` - `!userId` check. `X-Timestamp` and `X-Nonce` are required to pass the timestamp and nonce gates before body validation runs.

---

## 4. Invalid plan name → 400

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Nonce: $(openssl rand -hex 16)" \
  -d '{"userId":"user_abc","plan":"enterprise"}'
```

**Expected:** `400`
**Expected body:** `{"ok":false,"error":"Invalid plan. Must be one of: free, starter, pro"}`

**Code path:** `api/set-plan.js` - `!VALID_PLANS.includes(plan)` check. `X-Timestamp` and `X-Nonce` are required to pass the timestamp and nonce gates before body validation runs.

---

## 5. Malformed JSON body → 400

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -H "X-Timestamp: $(date +%s)" \
  -d 'NOT_JSON'
```

**Expected:** `400`
**Expected body:** `{"ok":false,"error":"Invalid JSON body"}`

**Code path:** `api/set-plan.js` - JSON.parse catch block. JSON parsing runs before the auth and nonce checks, so only `X-Timestamp` is needed to reach it.

---

## 6. Wrong HTTP method → 405

```bash
curl -s -o /dev/null -w "%{http_code}" -X GET "$BASE_URL/api/set-plan"
```

**Expected:** `405`
**Expected body:** `{"ok":false,"error":"Method not allowed"}`

**Code path:** `api/set-plan.js` - method check.

---

## 7. Missing SET_PLAN_SECRET env var → 500

> **How to test:** In the Vercel dashboard, temporarily remove the `SET_PLAN_SECRET` environment variable, redeploy, and run:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer anything" \
  -H "X-Timestamp: $(date +%s)" \
  -d '{"userId":"user_abc","plan":"pro"}'
```

**Expected:** `500`
**Expected body:** `{"ok":false,"error":"Server misconfiguration"}`

**Code path:** `api/set-plan.js` - env var guard. This is NOT a silent pass-through; the endpoint refuses to process any request when the secret is absent.

> Restore the env var and redeploy after confirming.

---

## 8. Non-existent Clerk userId → 502 with clear error

```bash
curl -s -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Nonce: $(openssl rand -hex 16)" \
  -d '{"userId":"user_DOESNOTEXIST999","plan":"pro"}'
```

**Expected:** `502`
**Expected body:** Contains Clerk's own error message (e.g. `"Could not find user"` or similar). The response is never `{"ok":true}`.

**Code path:** `api/set-plan.js` - Clerk returns HTTP 404 for an unknown user; the endpoint reads Clerk's error text and returns 502 so the caller knows the operation failed. `X-Timestamp` and `X-Nonce` are required to reach the Clerk API call.

---

## 9. Valid request → 200 + Clerk metadata updated

```bash
curl -s -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Nonce: $(openssl rand -hex 16)" \
  -d "{\"userId\":\"$REAL_USER_ID\",\"plan\":\"pro\"}"
```

**Expected:** `200`
**Expected body:** `{"ok":true,"userId":"<REAL_USER_ID>","plan":"pro"}`

**Verify in Clerk:** Open the Clerk dashboard → Users → find `$REAL_USER_ID` → Public metadata should show `{"plan":"pro"}`.

---

## 10. Missing X-Timestamp header → 400

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -d '{"userId":"user_abc","plan":"pro"}'
```

**Expected:** `400`
**Expected body:** `{"ok":false,"error":"Missing X-Timestamp header"}`

**Code path:** `api/set-plan.js` - timestamp guard runs immediately after the method check, before auth, so a replayed request with no timestamp is rejected cheaply.

---

## 11. Stale timestamp (replay attack) → 400

```bash
# Timestamp from 10 minutes ago
STALE_TS=$(($(date +%s) - 600))

curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -H "X-Timestamp: $STALE_TS" \
  -d '{"userId":"user_abc","plan":"free"}'
```

**Expected:** `400`
**Expected body:** `{"ok":false,"error":"Request timestamp is too old or too far in the future (max 300 s)"}`

**Code path:** `api/set-plan.js` - `ageSeconds > 300` branch. A captured request replayed after the 5-minute window is always rejected, so a network capture cannot be used to downgrade a paid user back to `free`.

---

## 12. Future timestamp (clock-skew attack) → 400

```bash
# Timestamp 10 minutes in the future
FUTURE_TS=$(($(date +%s) + 600))

curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -H "X-Timestamp: $FUTURE_TS" \
  -d '{"userId":"user_abc","plan":"pro"}'
```

**Expected:** `400`
**Expected body:** `{"ok":false,"error":"Request timestamp is too old or too far in the future (max 300 s)"}`

**Code path:** `api/set-plan.js` - `Math.abs(...)` means the window is symmetric; a far-future timestamp is also rejected.

---

## 13. Missing X-Nonce header → 400

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -H "X-Timestamp: $(date +%s)" \
  -d '{"userId":"user_abc","plan":"pro"}'
```

**Expected:** `400`
**Expected body:** `{"ok":false,"error":"Missing X-Nonce header"}`

**Code path:** `api/set-plan.js` - nonce presence check runs after auth succeeds, before any Clerk call.

---

## 14. Duplicate nonce (within-window replay) → 400

```bash
NONCE=$(uuidgen)  # or: openssl rand -hex 16

# First request - succeeds (or fails for another reason, but the nonce is consumed)
curl -s -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Nonce: $NONCE" \
  -d "{\"userId\":\"$REAL_USER_ID\",\"plan\":\"pro\"}"

echo ""

# Second request - same nonce within 300 s → must be rejected
curl -s -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Nonce: $NONCE" \
  -d "{\"userId\":\"$REAL_USER_ID\",\"plan\":\"pro\"}"
```

**Expected (second request):** `400`
**Expected body:** `{"ok":false,"error":"Duplicate nonce - request already processed"}`

**Code path:** `api/set-plan.js` - after auth succeeds, `isNonceSeen(nonce)` checks the MongoDB-backed store (`api/_nonce-store.js`, `nonce_seen` collection). A nonce is recorded with a 900 s TTL on first use (via MongoDB's atomic unique `_id` index, not Redis/Postgres); any subsequent request carrying the same nonce within that window is rejected before the Clerk call is made. This closes the gap where a captured request could be replayed immediately (within the timestamp window).

---

## Security notes

| Concern | Status |
|---|---|
| `BASE_URL` missing → silent payment failure | ✅ Impossible - webhook returns 500 immediately (see case 15 below) |
| Secret missing → silent pass-through | ✅ Impossible - 500 returned |
| Secret compared before any work is done | ✅ Yes, auth check runs before Clerk call |
| Secret in request body (visible in body-level logs) | ✅ Fixed - secret is now in `Authorization: Bearer` header, out of body logs |
| Plain string `!==` comparison (not constant-time) | ⚠️ Timing attack risk is negligible for an internal webhook endpoint with no retry budget, but noted |
| CORS allowlist | ✅ Only allows `mockuprabbit.com`, `*.vercel.app`, `*.replit.dev` - Stripe's server-side calls are not CORS-gated (CORS only applies to browsers) |
| Clerk userId path-traversal | ✅ `encodeURIComponent` applied before constructing the Clerk URL |
| Replay attack (captured request re-sent later) | ✅ `X-Timestamp` header required; requests older than 300 s are rejected with 400 |
| Far-future timestamp bypassing the window | ✅ Window is symmetric (`Math.abs`); future timestamps beyond 300 s are also rejected |
| Within-window replay (immediate re-send of captured request) | ✅ `X-Nonce` header required; each nonce is one-time-use with a 900 s TTL, MongoDB-backed (`api/_nonce-store.js`) |

**Callers** must send the secret, a current Unix timestamp, and a per-request nonce:
```
Authorization: Bearer <SET_PLAN_SECRET>
X-Timestamp: <Unix seconds - must be within 300 s of server time>
X-Nonce: <random unique string, e.g. UUID or 16 hex bytes - single use within 300 s>
```
The request body should contain only `userId` and `plan` - no `secret` field.

---

## 15. Missing BASE_URL env var → Stripe webhook returns 500

> **How to test:** In the Vercel dashboard, temporarily remove the `BASE_URL` environment variable, redeploy, and send a simulated `checkout.session.completed` event from the Stripe CLI or dashboard:

```bash
stripe trigger checkout.session.completed
```

Or send a raw POST to the webhook endpoint:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/webhooks/stripe" \
  -H "Content-Type: application/json" \
  -H "Stripe-Signature: t=1,v1=invalid" \
  -d '{}'
```

**Expected:** `500`
**Expected body:** `{"ok":false,"error":"Base URL not configured"}`

**Code path:** `api/webhooks/stripe.js` - the handler checks `process.env.BASE_URL` immediately after verifying `STRIPE_WEBHOOK_SECRET` and `SET_PLAN_SECRET`. If `BASE_URL` is absent the handler returns 500 before touching the Stripe signature or the event body. Stripe will retry the event according to its retry schedule, giving you time to fix the configuration.

> Restore `BASE_URL` and redeploy after confirming.

---

## Checklist summary

- [ ] Case 1 - wrong secret → 401
- [ ] Case 2 - missing Authorization header → 401
- [ ] Case 3 - missing userId → 400
- [ ] Case 4 - invalid plan → 400
- [ ] Case 5 - malformed JSON → 400
- [ ] Case 6 - wrong method → 405
- [ ] Case 7 - missing SET_PLAN_SECRET env var → 500 (not silent)
- [ ] Case 8 - non-existent Clerk user → 502 with clear error
- [ ] Case 9 - valid request → 200 + Clerk metadata updated
- [ ] Case 10 - missing X-Timestamp header → 400
- [ ] Case 11 - stale timestamp (replay attack, >300 s old) → 400
- [ ] Case 12 - far-future timestamp (>300 s ahead) → 400
- [ ] Case 13 - missing X-Nonce header → 400
- [ ] Case 14 - duplicate nonce (within-window replay) → 400
- [ ] Case 15 - missing BASE_URL env var → Stripe webhook returns 500 (not silent)
- [ ] Case 16 - clear-nonce by value → 200 + nonce removed
- [ ] Case 17 - clear-nonce by userId+plan → 200 + nonce removed
- [ ] Case 18 - clear-nonce wrong secret → 401

---

## POST /api/admin/clear-nonce - Admin endpoint for stuck nonces

### Background

`set-plan.js` deletes the nonce from the store **after a successful Clerk update** so that Stripe's webhook retry is not blocked by a "Duplicate nonce" error.  The nonce store (`api/_nonce-store.js`) is MongoDB-backed (`nonce_seen` collection, same database as `customers`/`idempotency_keys` - not Redis/Postgres). If MongoDB is unreachable at that moment, `deleteNonce()` retries up to **3 times with exponential back-off** (100 ms → 200 ms → 400 ms).

If all retries fail the nonce remains recorded and every subsequent Stripe retry is rejected with `400 Duplicate nonce - request already processed`.  The user's Clerk metadata was already updated on the first successful call, but the webhook keeps retrying and the user could appear "stuck" in Stripe's retry dashboard.

`POST /api/admin/clear-nonce` is the manual escape hatch for this situation.

### Alert pattern - detecting a permanently stuck nonce

When `deleteNonce()` exhausts all retries it emits a structured log line at the `error` level that begins with `[ALERT]`:

```
[ALERT] nonce-store: deleteNonce failed permanently for nonce=<value> userId=<id or "unknown"> plan=<plan or "unknown"> - the nonce is still recorded; Stripe retries will be rejected with 400 until the nonce expires (900s) or is manually cleared via POST /api/admin/clear-nonce. Last error: <message>
```

**What to grep / alert on:** `[ALERT] nonce-store: deleteNonce failed permanently`

**Datadog / Logtail / Vercel log drains:** create a log-level alert that matches the pattern above and pages on-call.  The alert fires at most once per stuck nonce, so false-positive noise is low.

**Action when the alert fires:**
1. Note the `nonce=` and `userId=` / `plan=` values from the log line.
2. Call the clear-nonce admin endpoint to unblock future Stripe retries (see QA cases 16–17 below):
   ```bash
   # By nonce value (preferred - copy from the log line):
   curl -s -X POST "$BASE_URL/api/admin/clear-nonce" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $SECRET" \
     -d '{"nonce":"<value from log>","reason":"deleteNonce retries exhausted after MongoDB connectivity issue on <date>"}'

   # By userId + plan (use when the nonce value is not in the log):
   curl -s -X POST "$BASE_URL/api/admin/clear-nonce" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $SECRET" \
     -d '{"userId":"<id from log>","plan":"<plan from log>","reason":"deleteNonce retries exhausted after MongoDB connectivity issue on <date>"}'
   ```
3. Investigate why MongoDB was unreachable (check `MONGODB_URI` and Atlas/network status); fix the connectivity issue so `deleteNonce()` succeeds on subsequent events.

### ⚠️ Timing warning - race-condition window

**Only call this endpoint after you have confirmed that the Clerk metadata update succeeded.**

Here is the risk if you call it too early:

1. Stripe fires a `checkout.session.completed` event → `set-plan` receives it, records the nonce, and starts updating Clerk.
2. An admin calls `POST /api/admin/clear-nonce` while the Clerk update is still in-flight.
3. The nonce is wiped from the store.
4. The Clerk update fails (network blip, timeout, etc.) and the endpoint returns a non-200 - but the nonce is already gone.
5. Stripe retries. The retry arrives with the same nonce → the nonce store reports "not seen" → the request is treated as fresh → Clerk is updated a second time (usually a no-op) **and** any Stripe-side deduplication is bypassed.

In normal failure recovery the nonce remains recorded so Stripe retries are still deduplicated. Premature admin clearance defeats that protection.

**Safe procedure:**
1. Confirm in the Clerk dashboard (or via `GET /api/user-plan`) that `publicMetadata.plan` is already set to the expected value for the affected user.
2. Only then call `POST /api/admin/clear-nonce` to unblock future retries.

If Clerk shows the correct plan, clearing the nonce is safe - the upgrade already happened and a second Clerk write is idempotent. If Clerk does **not** yet show the correct plan, wait or investigate before clearing.

### Authentication

Same secret as `set-plan`:

```
Authorization: Bearer <SET_PLAN_SECRET>
```

No `X-Timestamp` or `X-Nonce` headers are required (this is an admin-only internal endpoint, not exposed to Stripe).

### Request body - two modes

**Mode 1 - clear by nonce value** (use when the nonce appears in your server logs):

```json
{ "nonce": "<exact nonce value from X-Nonce header in the webhook log>", "reason": "<short description>" }
```

**Mode 2 - clear by userId + plan** (use when the nonce value is unknown):

```json
{ "userId": "<clerk userId>", "plan": "pro", "reason": "<short description>" }
```

The nonce store records `userId` and `plan` alongside each nonce so this lookup is possible without knowing the nonce value itself.

The `reason` field is optional but strongly recommended - it is written to the structured audit log so you can reconstruct who cleared a nonce and why.

### Response

```json
{ "ok": true, "deleted": 1 }
```

`deleted` is the count of nonces removed (0 means nothing was found for that key, which is harmless - the TTL may have already expired).

### QA cases

---

#### Case 16. Clear a stuck nonce by value → 200

```bash
# Simulate a stuck nonce by recording one directly, then clear it.
STUCK_NONCE=$(openssl rand -hex 16)

# First, "stick" it by making a valid set-plan call (the nonce is now recorded).
curl -s -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Nonce: $STUCK_NONCE" \
  -d "{\"userId\":\"$REAL_USER_ID\",\"plan\":\"pro\"}"

echo ""

# Now clear it via the admin endpoint.
curl -s -X POST "$BASE_URL/api/admin/clear-nonce" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -d "{\"nonce\":\"$STUCK_NONCE\",\"reason\":\"QA test - clearing simulated stuck nonce\"}"
```

**Expected:** `200`
**Expected body:** `{"ok":true,"deleted":1}`

**Verify:** Immediately re-send the original `set-plan` call with `$STUCK_NONCE` - it should succeed (200) rather than being rejected as a duplicate, because the nonce was cleared.

---

#### Case 17. Clear a stuck nonce by userId + plan → 200

```bash
curl -s -X POST "$BASE_URL/api/admin/clear-nonce" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -d "{\"userId\":\"$REAL_USER_ID\",\"plan\":\"pro\",\"reason\":\"QA test - clearing by userId+plan\"}"
```

**Expected:** `200`
**Expected body:** `{"ok":true,"deleted":1}` (or `"deleted":0` if no unexpired nonce exists for that user+plan - also fine).

**Code path:** `api/_nonce-store.js` - `deleteNonceByUserPlan()` looks up the nonce via the secondary index stored when `recordNonce()` was called in `set-plan.js`.

---

#### Case 18. Wrong secret → 401

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/admin/clear-nonce" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer WRONG_SECRET" \
  -d '{"nonce":"anything"}'
```

**Expected:** `401`
**Expected body:** `{"ok":false,"error":"Unauthorized"}`

---

#### Case 19. Missing body fields → 400

```bash
curl -s -X POST "$BASE_URL/api/admin/clear-nonce" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -d '{}'
```

**Expected:** `400`
**Expected body:** `{"ok":false,"error":"Provide either {\"nonce\": \"...\"} or {\"userId\": \"...\", \"plan\": \"...\"}"}`
