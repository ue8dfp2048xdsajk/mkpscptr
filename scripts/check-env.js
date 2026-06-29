#!/usr/bin/env node
'use strict';

const REQUIRED = [
    {
        name: 'BASE_URL',
        description: 'Public root URL of the deployment (no trailing slash). ' +
            'Used by the Stripe webhook to call /api/set-plan. ' +
            'Missing → every webhook event returns 500 and no user is upgraded after payment.',
    },
    {
        name: 'STRIPE_WEBHOOK_SECRET',
        description: 'Stripe webhook signing secret (whsec_...). ' +
            'Missing → webhook refuses all incoming events with 500.',
    },
    {
        name: 'SET_PLAN_SECRET',
        description: 'Shared secret between the webhook handler and /api/set-plan. ' +
            'Missing → both endpoints return 500.',
    },
    {
        name: 'CLERK_SECRET_KEY',
        description: 'Clerk secret key (sk_live_... / sk_test_...). ' +
            'Missing → /api/set-plan cannot update user metadata.',
    },
];

const OPTIONAL = [
    {
        name: 'UPSTASH_REDIS_REST_URL',
        description: 'Upstash Redis REST URL. Without this the rate limiter uses an ' +
            'in-memory store that resets on every cold start.',
    },
    {
        name: 'UPSTASH_REDIS_REST_TOKEN',
        description: 'Upstash Redis REST token. Required together with UPSTASH_REDIS_REST_URL.',
    },
];

let missing = 0;

console.log('Checking required environment variables...\n');

for (const { name, description } of REQUIRED) {
    const value = process.env[name];
    if (!value || value.trim() === '') {
        console.error(`  MISSING  ${name}`);
        console.error(`           ${description}\n`);
        missing++;
    } else {
        console.log(`  OK       ${name}`);
    }
}

console.log('\nChecking optional environment variables...\n');

for (const { name, description } of OPTIONAL) {
    const value = process.env[name];
    if (!value || value.trim() === '') {
        console.warn(`  MISSING  ${name} (optional)`);
        console.warn(`           ${description}\n`);
    } else {
        console.log(`  OK       ${name}`);
    }
}

if (missing > 0) {
    console.error(`\n${missing} required variable(s) are not set. Deployment will not work correctly.\n`);
    process.exit(1);
} else {
    console.log('\nAll required environment variables are set.\n');
}
