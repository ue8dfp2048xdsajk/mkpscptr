# Mockup Rabbit - Documentation

## Getting started

- [Local development](getting-started/local-development.md) - install, run, and open the app
- [Environment variables](getting-started/environment-variables.md) - full env var reference

## Architecture

- [Overview](architecture/overview.md) - how the pieces fit together
- [App.js map](architecture/app-js-map.md) - script load order, globals, danger zones
- [Backend API](architecture/backend-api.md) - all `/api/*` endpoints

## Features

- [Plans and gating](features/plans-and-gating.md) - free / starter / pro rules and enforcement

## Deployment

- [Pre-deploy checklist](deployment/pre-deploy-checklist.md) - verify before going live
- [Pre-launch testing checklist](deployment/prelaunch-testing-checklist.md) - manual end-to-end QA across auth, billing, and autosave

## Security

- [Set-plan security QA](../set-plan-security-qa.md) - manual curl tests for the plan-upgrade endpoint

## Related files (repo root)

| File | Purpose |
|------|---------|
| [README.md](../README.md) | Project entry point |
| [.env.example](../.env.example) | Environment variable template |
| [scripts/check-env.js](../scripts/check-env.js) | Automated env validation |
| [scripts/setup-mongo-indexes.js](../scripts/setup-mongo-indexes.js) | MongoDB index setup |
