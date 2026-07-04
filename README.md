# Mockup Rabbit

Browser-based SaaS for bulk product mockup creation. Users upload backgrounds and designs, composite them in a multi-window editor, apply effects, and batch-export PNG/JPEG files.

**Production:** [mockuprabbit.com](https://mockuprabbit.com)

## Stack

| Layer | Technology |
|-------|------------|
| Frontend | Static HTML/JS/CSS, Fabric.js 5.3 (CDN) |
| Local dev server | Express (`server.js`, port 5000) |
| Production hosting | Vercel (static files + serverless API in `api/`) |
| Auth | Clerk |
| Payments | Stripe |
| Database | MongoDB (also backs webhook/set-plan replay-protection nonces) |
| Rate limiting | Upstash Redis or PostgreSQL, optional (in-memory fallback, fails open) |

There is **no frontend build step**. Static files are served as-is.

## Quick start (local development)

```bash
npm install
npm install --prefix api
node server.js
```

Open **http://localhost:5000**.

There is no `npm start` or `npm run dev` script - run `node server.js` directly.

Set environment variables before starting (see [`.env.example`](.env.example) and [docs/getting-started/environment-variables.md](docs/getting-started/environment-variables.md)). The project does not load `.env` automatically; export variables in your shell or use a tool like `direnv`.

## npm scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `test` | `npm test` | Run Jest tests |
| `build` | `npm run build` | Deployment hook (runs env check via `prebuild`; no actual build) |

## Project layout

```
├── index.html          Landing page
├── app.html            Main editor
├── settings.html       Account & billing settings
├── js/                 Client-side editor (app.js + feature modules)
├── css/                Stylesheets
├── api/                Vercel serverless API handlers
├── server.js           Local Express dev server (mirrors production API routes)
├── vercel.json         Production deployment config
├── scripts/            Ops & maintenance scripts
├── tests/              Jest tests
└── docs/               Documentation (see docs/README.md)
```

## Documentation

Full docs index: **[docs/README.md](docs/README.md)**

| Topic | Link |
|-------|------|
| Local development | [docs/getting-started/local-development.md](docs/getting-started/local-development.md) |
| Environment variables | [docs/getting-started/environment-variables.md](docs/getting-started/environment-variables.md) |
| Architecture overview | [docs/architecture/overview.md](docs/architecture/overview.md) |
| API reference | [docs/architecture/backend-api.md](docs/architecture/backend-api.md) |
| Plans & feature gating | [docs/features/plans-and-gating.md](docs/features/plans-and-gating.md) |
| Pre-deploy checklist | [docs/deployment/pre-deploy-checklist.md](docs/deployment/pre-deploy-checklist.md) |
| Set-plan security QA | [docs/set-plan-security-qa.md](docs/set-plan-security-qa.md) |

## Deployment

Production runs on **Vercel**. See [docs/deployment/pre-deploy-checklist.md](docs/deployment/pre-deploy-checklist.md) before deploying.

```bash
node scripts/check-env.js   # verify required env vars
npm test                      # run test suite
```
