# POST /api/set-plan — Security QA Checklist

This document records the manual QA verification of the `set-plan` endpoint before going live.
Run each curl command against your deployed Vercel URL and confirm the expected HTTP status and response body.

```
BASE_URL=https://<your-vercel-deployment>.vercel.app
SECRET=<your SET_PLAN_SECRET value>
REAL_USER_ID=<a real Clerk userId from your dashboard>
```

---

## 1. Wrong secret → 401

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -d '{"userId":"user_abc","plan":"pro","secret":"WRONG_SECRET"}'
```

**Expected:** `401`
**Expected body:** `{"ok":false,"error":"Unauthorized"}`

**Code path:** `api/set-plan.js` lines 31–33 — `secret !== setPlanSecret` triggers 401 before any Clerk call is made.

---

## 2. Missing secret → 401

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -d '{"userId":"user_abc","plan":"pro"}'
```

**Expected:** `401`
**Expected body:** `{"ok":false,"error":"Unauthorized"}`

**Code path:** `!secret` is truthy, same branch as wrong secret.

---

## 3. Missing userId → 400

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -d "{\"plan\":\"pro\",\"secret\":\"$SECRET\"}"
```

**Expected:** `400`
**Expected body:** `{"ok":false,"error":"Missing or invalid userId"}`

**Code path:** `api/set-plan.js` lines 35–37 — `!userId` check.

---

## 4. Invalid plan name → 400

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"user_abc\",\"plan\":\"enterprise\",\"secret\":\"$SECRET\"}"
```

**Expected:** `400`
**Expected body:** `{"ok":false,"error":"Invalid plan. Must be one of: free, starter, pro"}`

**Code path:** `api/set-plan.js` lines 39–44 — `!VALID_PLANS.includes(plan)` check.

---

## 5. Malformed JSON body → 400

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -d 'NOT_JSON'
```

**Expected:** `400`
**Expected body:** `{"ok":false,"error":"Invalid JSON body"}`

**Code path:** `api/set-plan.js` lines 23–27 — JSON.parse catch block.

---

## 6. Wrong HTTP method → 405

```bash
curl -s -o /dev/null -w "%{http_code}" -X GET "$BASE_URL/api/set-plan"
```

**Expected:** `405`
**Expected body:** `{"ok":false,"error":"Method not allowed"}`

**Code path:** `api/set-plan.js` lines 10–12 — method check.

---

## 7. Missing SET_PLAN_SECRET env var → 500

> **How to test:** In the Vercel dashboard, temporarily remove the `SET_PLAN_SECRET` environment variable, redeploy, and run:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -d '{"userId":"user_abc","plan":"pro","secret":"anything"}'
```

**Expected:** `500`
**Expected body:** `{"ok":false,"error":"Server misconfiguration"}`

**Code path:** `api/set-plan.js` lines 17–20 — env var guard. This is NOT a silent pass-through; the endpoint refuses to process any request when the secret is absent.

> Restore the env var and redeploy after confirming.

---

## 8. Non-existent Clerk userId → 502 with clear error

```bash
curl -s -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"user_DOESNOTEXIST999\",\"plan\":\"pro\",\"secret\":\"$SECRET\"}"
```

**Expected:** `502`
**Expected body:** Contains Clerk's own error message (e.g. `"Could not find user"` or similar). The response is never `{"ok":true}`.

**Code path:** `api/set-plan.js` lines 63–71 — Clerk returns HTTP 404 for an unknown user; the endpoint reads Clerk's error text and returns 502 so the caller knows the operation failed.

---

## 9. Valid request → 200 + Clerk metadata updated

```bash
curl -s -X POST "$BASE_URL/api/set-plan" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$REAL_USER_ID\",\"plan\":\"pro\",\"secret\":\"$SECRET\"}"
```

**Expected:** `200`
**Expected body:** `{"ok":true,"userId":"<REAL_USER_ID>","plan":"pro"}`

**Verify in Clerk:** Open the Clerk dashboard → Users → find `$REAL_USER_ID` → Public metadata should show `{"plan":"pro"}`.

---

## Security notes

| Concern | Status |
|---|---|
| Secret missing → silent pass-through | ✅ Impossible — 500 returned |
| Secret compared before any work is done | ✅ Yes, auth check runs before Clerk call |
| Secret stored in request body (not header) | ⚠️ Acceptable for server-to-server; ensure Vercel function logs are not public |
| Plain string `!==` comparison (not constant-time) | ⚠️ Timing attack risk is negligible for an internal webhook endpoint with no retry budget, but noted |
| CORS allowlist | ✅ Only allows `mockupscripter.com`, `*.vercel.app`, `*.replit.dev` — Stripe's server-side calls are not CORS-gated (CORS only applies to browsers) |
| Clerk userId path-traversal | ✅ `encodeURIComponent` applied before constructing the Clerk URL |

---

## Checklist summary

- [ ] Case 1 — wrong secret → 401
- [ ] Case 2 — missing secret → 401
- [ ] Case 3 — missing userId → 400
- [ ] Case 4 — invalid plan → 400
- [ ] Case 5 — malformed JSON → 400
- [ ] Case 6 — wrong method → 405
- [ ] Case 7 — missing SET_PLAN_SECRET env var → 500 (not silent)
- [ ] Case 8 — non-existent Clerk user → 502 with clear error
- [ ] Case 9 — valid request → 200 + Clerk metadata updated
