# Local development

## Prerequisites

- **Node.js** 18+ (project tested on v24)
- **npm** 9+
- Accounts / credentials for services you want to exercise locally:
  - [Clerk](https://clerk.com) - sign-in (required for auth-gated features)
  - [MongoDB Atlas](https://www.mongodb.com/atlas) - cloud project save/load (optional but recommended)
  - [Stripe](https://stripe.com) - checkout and billing (optional for editor-only work)

Native dependencies (`canvas`, `sharp`, `onnxruntime-node`) may require build tools on some platforms. If `npm install` fails on native modules, install Xcode Command Line Tools (macOS) or equivalent.

## Install

Two separate `node_modules` trees are required:

```bash
# Root: Express, canvas, sharp, jest, etc.
npm install

# API subfolder: jose, mongodb, pg (used by serverless handlers)
npm install --prefix api
```

This mirrors Vercel's `installCommand`: `npm install --prefix api`.

## Configure environment variables

1. Copy the template:

   ```bash
   cp .env.example .env
   ```

2. Fill in values (see [environment-variables.md](environment-variables.md)).

3. Export them before starting the server. This project has **no dotenv loader**:

   ```bash
   set -a && source .env && set +a
   ```

   Or export individual variables manually.

### Minimum for basic local editing

| Variable | Why |
|----------|-----|
| `CLERK_JWKS_URL` | JWT verification for API routes |
| `CLERK_SECRET_KEY` | Checkout, export gate, project save |
| `CLERK_PUBLISHABLE_KEY` | Recommended - use `pk_test_...` locally instead of the hardcoded live key |

Without Clerk vars, `server.js` starts but logs a config error and auth/checkout return 503.

### Minimum for cloud project save/load

Add `MONGODB_URI` (and optionally `MONGODB_DB_NAME`, default `mockupscripter`).

Run indexes once:

```bash
MONGODB_URI=... node scripts/setup-mongo-indexes.js
```

## Start the dev server

There is **no** `npm start` or `npm run dev` script.

```bash
node server.js
```

Expected output:

```
Dev server running on http://0.0.0.0:5000
```

Open **http://localhost:5000** in a desktop browser. The app shows a mobile overlay on touch-only devices.

## What the dev server does

`server.js` is an Express app that:

1. Mounts all `/api/*` routes by requiring handlers from `api/`
2. Injects `CLERK_PUBLISHABLE_KEY` into HTML pages
3. Serves static files from the repo root
4. Listens on **port 5000** (hardcoded)

In production, Vercel serves static files and routes `/api/*` to serverless functions instead. The dev server exists to mirror that behavior locally in a single process.

## Pages

| URL | File | Purpose |
|-----|------|---------|
| `/` | `index.html` | Landing / marketing |
| `/app.html` | `app.html` | Main editor |
| `/settings.html` | `settings.html` | Account & billing |

## Testing

```bash
npm test
```

Jest runs tests in `tests/` with jsdom for client-side tests.

## Common issues

### `npm run dev` / `npm start` not found

Use `node server.js` directly. See [README.md](../../README.md).

### Replit registry in `package-lock.json`

If `npm install` tries to fetch from `package-firewall.replit.local`, delete `package-lock.json` and `node_modules`, then run `npm install` again with a clean npm registry (`registry=https://registry.npmjs.org/` in `.npmrc`).

### Auth works but checkout/export fails

Set the full Stripe + `BASE_URL` + `SET_PLAN_SECRET` vars. See [environment-variables.md](environment-variables.md).

### Native module install warnings

Packages like `canvas` and `sharp` run install scripts. On macOS with npm 11+, you may see `allow-scripts` warnings - approve scripts if those packages fail at runtime.

## No hot reload

There is no file watcher or HMR. Restart `node server.js` after changing server-side code. Refresh the browser after changing client-side files.
