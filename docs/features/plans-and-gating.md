# Plans and feature gating

Mockup Scripter has three plan tiers: **free**, **starter**, and **pro**. The canonical source of truth is Clerk `public_metadata.plan` on each user, set by the Stripe webhook → `/api/set-plan` flow after payment.

The frontend reads plan on sign-in (`js/clerk-auth.js` → `window._userPlan`). The backend re-verifies on sensitive API routes.

---

## Plan summary

| Feature | Free | Starter | Pro |
|---------|------|---------|-----|
| Editor access | ✓ | ✓ | ✓ |
| Basic effects (opacity, blur, noise; layer mode = Normal) | ✓ | ✓ | ✓ |
| Canvas watermark | ✓ (on windows with designs) | On PRO-effect windows only | ✗ |
| Export (PNG/JPEG/ZIP) | ✗ | Non-PRO windows | All windows |
| Export text | ✗ | ✓ | ✓ |
| PRO effects (see below) | Can use in editor | Can use; **blocked at export** | ✓ |
| Cloud project save | ✗ | 1 project (upsert) | Up to 50 projects |
| "Save as New" | ✗ | ✗ | ✓ |
| Email / priority support | — | Email | Priority |

Pricing and marketing copy live on `index.html`. This document describes **enforced behavior** in code.

---

## Sidebar layout (editor)

| Section | Contents |
|---------|----------|
| **Appearance** | Opacity, blur, noise (basic); **Layer Mode** (Normal = basic, else PRO); flip H/V |
| **Effects** ⭐ PRO | Cylinder warp, arc, fisheye, perspective, mesh warp; **Copy Effects / Paste Effects**; **Invert Colors** |
| Other PRO sections | Clipping, Painting, Pattern, Framing, Background Adjustments |

---

## Where plan is stored

```
Stripe payment
    → webhook (api/webhooks/stripe.js)
    → POST /api/set-plan
    → Clerk PATCH /v1/users/{id}/metadata
    → public_metadata: { plan, stripeCustomerId?, subscriptionEndsAt? }
```

Valid plan values: `free`, `starter`, `pro`.

Subscription lifecycle:

- **Monthly/annual:** `customer.subscription.updated` / `deleted` webhooks sync plan
- **Lifetime:** one-time `checkout.session.completed` sets plan permanently (no recurring subscription)
- **Cancellation pending:** `subscriptionEndsAt` unix timestamp shown in UI until period ends

---

## Client-side gating

### Watermarks (`js/app.js`)

Drawn on `after:render` for:

- **Free:** all windows that have a design loaded (not background-only)
- **Starter:** windows with `hasProEffect === true`

Pro users: no watermarks.

### Export (`js/app.js` + `POST /api/export`)

1. User must be signed in
2. **Free:** plans modal opens; export blocked
3. **Starter:** if any selected window has PRO effects, plans modal offers skip or upgrade
4. **All paid:** client calls `POST /api/export` — server returns `403 upgrade_required` for free plans (cannot bypass in devtools)

Export formats: individual files, folder (File System Access API), or ZIP (JSZip).

### PRO effect detection

A window is marked `hasProEffect` when any of these are active (`_recomputeProEffect` in `app.js`):

| Effect | PRO? |
|--------|------|
| Warp (cylinder), arc, fisheye, perspective | ✓ |
| Mesh warp (after Apply) | ✓ |
| Pattern mode | ✓ |
| Clipping mask enabled | ✓ |
| Color layer | ✓ |
| Design eraser (modified pixels) | ✓ |
| Background adjust / crop | ✓ |
| Layer mode ≠ Normal (main or any extra layer) | ✓ |
| Invert colors (main or any extra layer) | ✓ |
| Opacity, blur, noise | ✗ (basic) |
| Layer mode = Normal | ✗ (basic) |

**Copy / Paste Effects:** PRO-labeled tools in the Effects section. Copy alone does not mark a window. **Paste** marking:

| Plan | On Paste Effects |
|------|------------------|
| Free / Starter | Target window **always** gets PRO badge |
| Pro | PRO badge only if pasted payload contains PRO values (`_transformsContainProEffect`) |

PRO windows show a ⭐ badge. Green badge on Pro plan; yellow on Free/Starter. Sidebar ⭐ PRO labels turn green on Pro plan.

### Load / save

- **Local JSON:** all tiers; no plan gate
- **After JSON or cloud load:** `_recomputeProEffect` runs per window (badges derived from live state, not stale `hasProEffect` alone)
- Snapshot fields: `meshWarpApplied`, `invertedMain`, `invertedExtras`, `hasProEffect`

### Reset

Reset Selected or zeroing PRO levers clears badge/watermark when no PRO effects remain.

### Downgrade (Pro → Starter / Free)

- All cloud projects **remain in the database** (not auto-deleted)
- Users are warned to **open each project → Save Local (JSON)** before downgrading
- Starter: only **one** cloud slot editable (upsert); extra projects listable but effectively read-only for editing
- Export/watermark rules revert to the lower tier immediately

### Save / projects UI

| Action | Free | Starter | Pro |
|--------|------|---------|-----|
| Save (overwrite) | Local only | Cloud (1 slot) | Cloud |
| Save as New | Locked | Locked | ✓ |
| Open cloud project | Sign-in required | ✓ | ✓ |

---

## Server-side gating

### `POST /api/export`

Returns `403 { error: "upgrade_required" }` if Clerk plan is `free`.

Verifies JWT; may fall back to Clerk REST API if JWT lacks `public_metadata`.

### `POST /api/projects/save`

| Plan | Behavior |
|------|----------|
| `free` | `403 upgrade_required` |
| `starter` | Upsert single project per user (atomic find-or-create) |
| `pro` | Insert new project; max **50** per user (`403 project_limit_reached`) |

Snapshot limit: **15 MB** per save.

### `POST /api/checkout`

- Requires authenticated Clerk user
- Blocks checkout if user already on same or higher plan (`409`)
- Sets `client_reference_id` = Clerk user ID for webhook attribution

---

## Stripe price → plan mapping

Webhook maps Stripe Price IDs to plans via environment variables:

```
STRIPE_PRICE_STARTER_MONTHLY  → starter
STRIPE_PRICE_STARTER_ANNUAL   → starter
STRIPE_PRICE_STARTER_LIFETIME → starter
STRIPE_PRICE_PRO_MONTHLY      → pro
STRIPE_PRICE_PRO_ANNUAL       → pro
STRIPE_PRICE_PRO_LIFETIME     → pro
```

Defined in `api/webhooks/stripe.js` (`getPriceMap()`).

---

## Changing tiers safely

If you change gating rules or add a new tier:

1. Update client gates in `js/app.js` and `js/clerk-auth.js`
2. Update server gates in `api/export.js`, `api/projects/save.js`, `api/checkout.js`
3. Update `VALID_PLANS` in `api/set-plan.js` and webhook handlers
4. Update landing page copy in `index.html` if user-facing limits change
5. Run tests: `npm test` (especially `pro-effect-gating.test.js`, `export.test.js`, watermark tests)

Existing Stripe subscribers keep access as long as Clerk `public_metadata.plan` remains correct — billing is independent of the editor stack.

---

## Related docs

- [Backend API — export & checkout](../architecture/backend-api.md)
- [Environment variables — Stripe prices](../getting-started/environment-variables.md)
- [Set-plan security QA](../set-plan-security-qa.md)
