# Backend API reference

All API routes are implemented as handlers in `api/`. In local dev, `server.js` mounts the same routes on Express (port 5000). In production, Vercel routes `/api/*` to serverless functions.

Authentication uses Clerk session JWTs in the `Authorization: Bearer <token>` header unless noted otherwise.

---

## Projects

### `GET /api/projects/list`

List cloud projects for the signed-in user.

| | |
|---|---|
| Auth | Required (Clerk JWT) |
| Response | `{ ok: true, projects: [{ uuid, name, updatedAt, ... }] }` |

### `POST /api/projects/save`

Save or update a project snapshot.

| | |
|---|---|
| Auth | Required |
| Body | `{ uuid?, snapshot, name? }` |
| Limits | Snapshot max 15 MB; plan-based project limits (see [plans-and-gating.md](../features/plans-and-gating.md)) |
| Errors | `403 upgrade_required` (free), `403 project_limit_reached` (pro, 50 max) |

- **With `uuid`:** overwrite existing project (must belong to user)
- **Without `uuid`:** create new project (subject to plan limits)

### `GET /api/projects/:id`

Load a project snapshot by UUID.

| | |
|---|---|
| Auth | Not required for GET |
| Response | `{ ok: true, snapshot }` |
| Errors | `404` if not found or expired |

### `PATCH /api/projects/:id`

Rename a project.

| | |
|---|---|
| Auth | Required |
| Body | `{ name: string }` |

### `DELETE /api/projects/:id`

Delete a project.

| | |
|---|---|
| Auth | Required (must own project) |

---

## Export

### `POST /api/export`

Server-side export gate. Verifies the user's plan before the client runs batch export.

| | |
|---|---|
| Auth | Required |
| Response | `{ ok: true, plan }` |
| Errors | `403 upgrade_required` if plan is `free` |

The actual image rendering happens client-side; this endpoint prevents bypassing the paywall by calling export logic directly.

---

## Checkout & billing

### `POST /api/checkout`

Create a Stripe Checkout Session.

| | |
|---|---|
| Auth | Required |
| Body | `{ plan: "starter"|"pro", period: "monthly"|"annual"|"lifetime" }` |
| Response | `{ ok: true, url }` — redirect user to Stripe |
| Rate limit | 5 requests / 60 s per user |
| Errors | `409` if user already on same plan **and billing period**; tier downgrades blocked; `503` if Clerk/Stripe not configured |

Checkout sets `client_reference_id` to the Clerk user ID, `metadata.plan`, and `metadata.period` for the webhook. Same-tier billing-period changes (e.g. Starter monthly → annual or lifetime) are allowed; the webhook stores `billingPeriod` in Clerk and cancels superseded subscriptions.

When the user already has an **active Stripe subscription** and the target price is a subscription (not lifetime), checkout routes to the Stripe Customer Portal **`subscription_update_confirm`** deep link instead of a new Checkout Session. That shows prorated “amount due today” and preserves existing subscription discounts. Free → paid and lifetime purchases still use Checkout.

### `GET /api/billing/invoices`

List paid Stripe invoices for the signed-in user.

| | |
|---|---|
| Auth | Required |
| Response | `{ ok: true, invoices: [...] }` |
| Rate limit | 10 requests / 60 s per user |

### `POST /api/billing/portal`

Create a Stripe Customer Portal session.

| | |
|---|---|
| Auth | Required |
| Response | `{ ok: true, url }` |
| Return URL | `{BASE_URL}/app.html` (server-side only; same destination as checkout cancel/success) |
| Errors | `404`-style message if no Stripe customer on file |

---

## Plan management (internal)

### `POST /api/set-plan`

Update a user's plan in Clerk `public_metadata`. **Not for direct client use.**

| | |
|---|---|
| Auth | `Authorization: Bearer <SET_PLAN_SECRET>` |
| Headers | `X-Timestamp` (unix, ±300 s), `X-Nonce` (Stripe event ID) |
| Body | `{ userId: "user_...", plan: "free"|"starter"|"pro" }` |
| Called by | Stripe webhook handler |

See [set-plan-security-qa.md](../set-plan-security-qa.md) for security test cases.

### `POST /api/webhooks/stripe`

Stripe webhook endpoint. Verifies HMAC signature on raw body.

| | |
|---|---|
| Auth | Stripe signature (`Stripe-Signature` header) |
| GET | Health/config check when `Authorization: Bearer <SET_PLAN_SECRET>` |

**Handled events:**

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Set plan from session metadata or price ID; store customer mapping |
| `customer.subscription.updated` | Update plan from subscription price; set/clear `subscriptionEndsAt` |
| `customer.subscription.deleted` | Reset plan to `free` |
| `invoice.payment_failed` | Revoke plan on final payment failure |

---

## Account

### `DELETE /api/account/delete`

Permanently delete the signed-in user's account.

| | |
|---|---|
| Auth | Required |
| Rate limit | 5 requests / 60 s per user |

Deletes: Clerk user, MongoDB projects, customer mapping, Stripe customer (if configured).

---

## Admin

Authenticated with `Authorization: Bearer <SET_PLAN_SECRET>`.

### `GET /api/admin/config-check`

Returns Stripe price configuration status and rate-limiter backend info. Used by the plans modal to show configured prices.

### `POST /api/admin/clear-nonce`

Clear a stuck webhook nonce (recovery tool when a user paid but plan wasn't set). The nonce store (`api/_nonce-store.js`) is MongoDB-backed (`nonce_seen` collection) — independent of the Redis/PostgreSQL rate limiters described below.

Body: `{ nonce }` or `{ userId, plan, reason? }`

---

## Shared behavior

### CORS

All handlers call `setCorsHeaders()` and respond to `OPTIONS` preflight.

### Error shape

Most errors return JSON:

```json
{ "ok": false, "error": "Human-readable message" }
```

### Rate limiting

Sensitive endpoints use sliding-window rate limits backed by Redis, PostgreSQL, or in-memory (local dev). See [environment-variables.md](../getting-started/environment-variables.md).

---

## Route mapping (local vs Vercel)

| Path | Handler file |
|------|--------------|
| `/api/projects/list` | `api/projects/list.js` |
| `/api/projects/save` | `api/projects/save.js` |
| `/api/projects/:id` | `api/projects/[id].js` |
| `/api/checkout` | `api/checkout.js` |
| `/api/export` | `api/export.js` |
| `/api/set-plan` | `api/set-plan.js` |
| `/api/webhooks/stripe` | `api/webhooks/stripe.js` |
| `/api/billing/:action` | `api/billing/[action].js` |
| `/api/account/delete` | `api/account/delete.js` |
| `/api/admin/:action` | `api/admin/[action].js` |
