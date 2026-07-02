# Architecture overview

Mockup Scripter is a static-first web app with a serverless API backend. There is no frontend bundler or build step.

## High-level diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser                                  │
│  index.html │ app.html │ settings.html                          │
│  js/app.js + Fabric.js + feature modules (clip, warp, export…)  │
│  Clerk JS SDK (auth) │ PostHog (analytics, consent-gated)       │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTPS
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Vercel (production)                           │
│  Static files from repo root                                     │
│  /api/* → serverless functions in api/                           │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   ┌─────────┐        ┌──────────┐       ┌───────────┐
   │  Clerk  │        │  Stripe  │       │  MongoDB  │
   │  (auth) │        │ (billing)│       │ (projects)│
   └─────────┘        └──────────┘       └───────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │ Upstash Redis   │
                   │ or PostgreSQL   │
                   │ (nonces, limits)│
                   └─────────────────┘
```

## Production vs local development

| | Production (Vercel) | Local (`node server.js`) |
|---|---|---|
| Frontend | Static HTML/JS/CSS from `.` | Same, via Express |
| API | Serverless functions in `api/` | Express routes → `require('./api/...')` |
| Port | Vercel-assigned | **5000** (hardcoded) |
| Clerk key in HTML | Injected by build/host or hardcoded | Injected by `server.js` from `CLERK_PUBLISHABLE_KEY` |
| Install | `npm install --prefix api` (Vercel) | Root `npm install` + `npm install --prefix api` |

`server.js` exists solely to mirror production API routing locally. It is not used in Vercel production.

## Frontend architecture

### Pages

| Page | Role |
|------|------|
| `index.html` | Marketing landing (features, pricing, FAQ) |
| `app.html` | Main editor — multi-window mockup grid |
| `settings.html` | Profile, billing portal, account deletion |
| `privacy.html`, `terms.html`, etc. | Legal / policy pages |

### Editor (`js/`)

The editor is vanilla JavaScript (no React/Vue). Key modules:

| Module | Responsibility |
|--------|----------------|
| `app.js` | Main editor: window grid, selection, export, UI wiring |
| `clerk-auth.js` | Sign-in, plan from Clerk metadata, checkout flow |
| `plans-modal.js` | Pricing modal and Stripe checkout trigger |
| `clip.js` | Bezier/polygon clipping masks |
| `warp-engine.js` | Cylinder, arc, perspective distortion |
| `mesh-warp.js` | Bicubic mesh warp |
| `pattern.js` | Repeating pattern fills |
| `color-layer.js` | Paint tint layer over scene |
| `eraser.js` | Design-layer eraser |
| `background.js` | Background crop and color adjust |
| `image-utils.js` | Blur, noise, blend modes, mip chains |
| `undo.js` | Global undo/redo snapshots |
| `migrations.js` | Snapshot schema versioning |

**Fabric.js 5.3** (CDN) provides the per-window canvas: layered images, transforms, `clipPath`, and `toDataURL` export. Heavy image processing is done in raw Canvas 2D and baked back into `fabric.Image` objects.

### Client data model

Each mockup "window" is an entry in the `canvasData[]` array with:

- Background and design images
- A dedicated `fabric.Canvas` instance
- Effect parameters (warp, blur, masks, etc.)
- `hasProEffect` flag for plan gating

Full workspace state is serialized as a **snapshot** (JSON with `schemaVersion`) for local save, cloud save, and undo.

## Backend architecture

API handlers live in `api/` as Vercel serverless functions. Shared utilities:

| Module | Role |
|--------|------|
| `_verify-clerk-token.js` | JWT verification via Clerk JWKS |
| `_db.js` | MongoDB connection pool |
| `_cors.js` | CORS headers |
| `_nonce-store.js` | Webhook replay protection |
| `_rate-limiter.js` / `_sliding-window.js` | IP and per-user rate limits |

See [backend-api.md](backend-api.md) for the full endpoint catalog.

## Auth and billing flow

```
User signs in (Clerk)
        ↓
Frontend reads user.publicMetadata.plan  →  'free' | 'starter' | 'pro'
        ↓
Feature gates in js/app.js (watermarks, export, PRO effects)
        ↓
Server verifies JWT + plan on sensitive routes (/api/export, /api/projects/save)

Payment:
User → POST /api/checkout → Stripe Checkout Session
        ↓
Stripe webhook → POST /api/webhooks/stripe
        ↓
Internal call → POST /api/set-plan → Clerk public_metadata.plan updated
```

Stripe customer ID is stored in MongoDB `customers` collection and optionally in Clerk `public_metadata.stripeCustomerId`.

## Deployment config

`vercel.json` defines:

- `installCommand`: `npm install --prefix api`
- `buildCommand`: `npm run build` (env check only)
- `outputDirectory`: `.` (static root)
- Security headers (CSP, HSTS, etc.)
- Route rewrites for `/api/projects/:id`

## Related docs

- [Backend API reference](backend-api.md)
- [Plans and gating](../features/plans-and-gating.md)
- [Environment variables](../getting-started/environment-variables.md)
- [Pre-deploy checklist](../deployment/pre-deploy-checklist.md)
