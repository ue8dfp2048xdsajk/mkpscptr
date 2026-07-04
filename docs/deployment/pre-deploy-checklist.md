# Pre-deploy checklist

Run through this list before deploying to production or after changing billing/auth infrastructure.

---

## 1. Environment variables

```bash
node scripts/check-env.js
```

All checks must pass. This script validates:

- [ ] `STRIPE_SECRET_KEY`
- [ ] All six `STRIPE_PRICE_*` variables
- [ ] `BASE_URL` (no trailing slash)
- [ ] `STRIPE_WEBHOOK_SECRET`
- [ ] `SET_PLAN_SECRET`
- [ ] `CLERK_SECRET_KEY`
- [ ] `CLERK_JWKS_URL`
- [ ] `MONGODB_URI` - required. Backs projects, customer mapping, webhook idempotency, **and** the `/api/set-plan` replay-protection nonce store (`nonce_seen` collection). This is the only durable dependency in the payment-to-plan pipeline besides Stripe and Clerk.

`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are optional (rate-limiter durability only - see section 5) and will show as warnings, not failures, if unset.

Also confirm in Vercel (not covered by `check-env.js`):

- [ ] `CLERK_PUBLISHABLE_KEY` (if injecting via env rather than hardcoded HTML)
- [ ] `MONGODB_DB_NAME` (if not using default `mockupscripter`)

See [environment-variables.md](../getting-started/environment-variables.md) for details.

---

## 2. MongoDB indexes

Run once per database (or after schema changes):

```bash
MONGODB_URI=... node scripts/setup-mongo-indexes.js
```

Expected output: indexes created on `projects` and `customers` collections.

---

## 3. Stripe webhook

- [ ] Webhook endpoint registered in Stripe dashboard:
  ```
  https://mockupscripter.com/api/webhooks/stripe
  ```
  (or your `BASE_URL` + `/api/webhooks/stripe`)

- [ ] Listening for events:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`

- [ ] Signing secret copied to `STRIPE_WEBHOOK_SECRET` in Vercel

- [ ] Test webhook delivery from Stripe dashboard returns `200`

Optional: use repo scripts for deeper testing:

```bash
node scripts/test-webhook.js --help
node scripts/test-webhook-retry.js --help
```

---

## 4. Clerk

- [ ] Production Clerk instance configured with correct domain
- [ ] `CLERK_JWKS_URL` points to production JWKS endpoint
- [ ] JWT template includes `public_metadata` if relying on embedded plan claims (export has REST fallback)
- [ ] Sign-in redirect URLs include production domain

---

## 5. Rate limiting (nonce store no longer applies here)

Webhook/set-plan replay protection is MongoDB-backed (`nonce_seen` collection)
and is already covered by the `MONGODB_URI` check in section 1 - it does not
depend on Redis/Postgres at all, so there is nothing further to verify here
for payment correctness.

The check below covers **rate limiting only** (`/api/checkout`, `/api/billing`,
`/api/account-delete` throttling and `/api/set-plan` auth-failure lockout).
This subsystem fails **open**, so an in-memory backend is a durability/abuse-
protection concern, not a payment-correctness one - safe to defer pre-launch:

```bash
curl -s -H "Authorization: Bearer $SET_PLAN_SECRET" \
  "$BASE_URL/api/admin/config-check" | jq .rate_limiter
```

- [ ] `backend` is `"redis"` or `"postgresql"` (recommended before high-traffic launch)
- [ ] `durable` is `true`
- [ ] `warning` is `null`

If `backend` is `"in-memory"`, rate-limit counters reset on cold start and are
not shared across serverless instances - abuse protection is weaker, but
payments and plan activation are unaffected.

---

## 6. Stripe price configuration

```bash
curl -s -H "Authorization: Bearer $SET_PLAN_SECRET" \
  "$BASE_URL/api/admin/config-check" | jq '{ all_configured, missing }'
```

- [ ] `all_configured: true`
- [ ] `missing: []`

---

## 7. Set-plan security

Run the manual QA checklist:

**[docs/set-plan-security-qa.md](../set-plan-security-qa.md)**

At minimum, verify against production `BASE_URL`:

- [ ] Wrong secret → `401`
- [ ] Missing auth → `401`
- [ ] Valid request with real user → `200` and plan updated in Clerk

---

## 8. Test suite

```bash
npm test
```

- [ ] All tests pass before deploy

---

## 9. Smoke test (production)

After deploy:

- [ ] Landing page loads (`/`)
- [ ] App loads and Clerk sign-in works (`/app.html`)
- [ ] Settings page loads for signed-in user (`/settings.html`)
- [ ] Plans modal shows prices (fetches `/api/admin/config-check` internally via frontend)
- [ ] Test checkout with Stripe test mode (if validating on staging)
- [ ] Export works for a paid test account
- [ ] Cloud save/load works for a paid test account

---

## 10. Security headers

`vercel.json` sets CSP, HSTS, X-Frame-Options, etc. After deploy:

- [ ] Confirm headers present (browser devtools → Network → document response headers)
- [ ] Clerk and PostHog domains allowed in CSP (sign-in and analytics work)

---

## Quick reference: deploy flow

```
1. Set all env vars in Vercel
2. node scripts/check-env.js          (locally with prod vars, or rely on prebuild)
3. node scripts/setup-mongo-indexes.js (if new DB)
4. Configure Stripe webhook → BASE_URL
5. git push → Vercel deploy
6. Run set-plan security QA curls
7. Manual smoke test
```

There is no frontend build artifact - Vercel serves static files from the repo root after `npm run build` (env check only).
