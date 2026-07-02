# Environment variables

The project reads configuration from `process.env`. Variables must be set in the shell environment (or in Vercel / your host's secrets panel). There is no automatic `.env` loader.

Validate production config with:

```bash
node scripts/check-env.js
```

This runs automatically as `prebuild` before `npm run build`.

## Quick reference

| Variable | Required for prod | Required for local dev | Notes |
|----------|-------------------|----------------------|-------|
| `CLERK_JWKS_URL` | Yes | Yes (for auth) | Clerk JWKS endpoint URL |
| `CLERK_SECRET_KEY` | Yes | Yes (for auth) | `sk_live_...` or `sk_test_...` |
| `CLERK_PUBLISHABLE_KEY` | Recommended | Recommended | Injected into HTML by `server.js` |
| `MONGODB_URI` | Yes | For cloud saves | Projects + customer mapping |
| `MONGODB_DB_NAME` | No | No | Default: `mockupscripter` |
| `STRIPE_SECRET_KEY` | Yes | For checkout | `sk_live_...` or `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | Yes | For webhooks | `whsec_...` |
| `STRIPE_PRICE_*` (6 vars) | Yes | For checkout | See Stripe section |
| `BASE_URL` | Yes | For webhooks | No trailing slash |
| `SET_PLAN_SECRET` | Yes | For webhooks | Shared webhook ↔ set-plan secret |
| `UPSTASH_REDIS_REST_URL` | Yes | No | Nonce store + rate limits |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | No | Pair with URL above |
| `DATABASE_URL` | Alternative | No | PG fallback if Redis unset |
| `ENABLE_WEBHOOK_TEST_HOOKS` | Never in prod | Test only | Simulates Clerk failures |

---

## Clerk

### `CLERK_JWKS_URL`

Clerk JWKS endpoint for verifying session JWTs.

Example: `https://clerk.mockupscripter.com/.well-known/jwks.json`

**If missing:** all authenticated API calls fail verification; checkout returns 503.

### `CLERK_SECRET_KEY`

Clerk secret API key. Used to read/update user metadata (plan, Stripe customer ID) and verify plans on export.

**If missing:** `/api/set-plan`, `/api/checkout`, `/api/export` (fallback path), and project save fail.

### `CLERK_PUBLISHABLE_KEY`

Clerk publishable key (`pk_test_...` or `pk_live_...`). `server.js` replaces the hardcoded key in HTML files at serve time.

**If missing locally:** the hardcoded production publishable key in HTML is used.

---

## MongoDB

### `MONGODB_URI`

Connection string for MongoDB Atlas or local MongoDB.

**If missing:** cloud project save/load fails; Stripe customer mapping and webhook idempotency degrade.

### `MONGODB_DB_NAME`

Database name. Default: `mockupscripter`.

Collections used:

- `projects` — saved editor snapshots
- `customers` — `stripeCustomerId` ↔ `clerkUserId` mapping
- `idempotency_keys` — Stripe webhook deduplication (TTL 4 days)

Run `node scripts/setup-mongo-indexes.js` after first setup.

---

## Stripe

### `STRIPE_SECRET_KEY`

Stripe secret key. Used for Checkout Sessions, invoice listing, billing portal, and webhook session expansion.

### `STRIPE_WEBHOOK_SECRET`

Signing secret for the webhook endpoint (`whsec_...`). Create endpoint at:

`{BASE_URL}/api/webhooks/stripe`

Handled events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.

### Stripe Price IDs

Map checkout plans to Stripe prices:

| Variable | Plan |
|----------|------|
| `STRIPE_PRICE_STARTER_MONTHLY` | Starter monthly |
| `STRIPE_PRICE_STARTER_ANNUAL` | Starter annual |
| `STRIPE_PRICE_STARTER_LIFETIME` | Starter lifetime (one-time) |
| `STRIPE_PRICE_PRO_MONTHLY` | Pro monthly |
| `STRIPE_PRICE_PRO_ANNUAL` | Pro annual |
| `STRIPE_PRICE_PRO_LIFETIME` | Pro lifetime (one-time) |

All values are Stripe Price IDs (`price_...`).

### `BASE_URL`

Public root URL of the deployment, **no trailing slash**.

Examples:

- Production: `https://mockupscripter.com`
- Local webhook testing: `http://localhost:5000` (requires Stripe CLI or tunnel)

Used by the Stripe webhook to call `/api/set-plan` and by checkout for success/cancel URLs.

**If missing:** webhooks return 500; no user is upgraded after payment.

### `SET_PLAN_SECRET`

Random shared secret between `/api/webhooks/stripe` and `/api/set-plan`. Also authenticates admin endpoints (`/api/admin/config-check`, `/api/admin/clear-nonce`).

Generate: `openssl rand -hex 32`

**If missing:** webhooks and set-plan return 500/503.

---

## Upstash Redis / PostgreSQL

### `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`

Durable store for nonce replay protection and rate-limit counters across serverless instances.

Create a free database at [console.upstash.com](https://console.upstash.com).

**If missing in production:** falls back to in-memory store — resets on cold start, not shared across instances. Acceptable for local dev only.

### `DATABASE_URL`

PostgreSQL connection string. Alternative durable backend for nonces and rate limits when Redis is not configured.

---

## Test-only

### `ENABLE_WEBHOOK_TEST_HOOKS`

Set to `true` only in test environments. Enables `X-Test-Force-Clerk-Error` header for webhook retry testing. **Never set in production.**

---

## Where to set variables

| Environment | Location |
|-------------|----------|
| Local | Export in shell, or `source .env` after copying `.env.example` |
| Vercel | Project → Settings → Environment Variables |
| Build validation | `node scripts/check-env.js` (also runs as `prebuild`) |

See also: [pre-deploy checklist](../deployment/pre-deploy-checklist.md).
