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
            'Create an endpoint at https://mkpscptr.vercel.app/api/webhooks/stripe in ' +
            'Stripe dashboard → Developers → Webhooks listening for checkout.session.completed. ' +
            'Missing → webhook refuses all incoming events with 500.',
        validate: (v) => v.startsWith('whsec_') || 'value should start with whsec_',
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
    {
        name: 'UPSTASH_REDIS_REST_URL',
        description: 'Upstash Redis REST URL for the nonce store. ' +
            'Missing → nonce replay protection resets on every cold start, ' +
            'allowing webhook replay attacks across serverless restarts.',
    },
    {
        name: 'UPSTASH_REDIS_REST_TOKEN',
        description: 'Upstash Redis REST token for the nonce store (required with UPSTASH_REDIS_REST_URL). ' +
            'Missing → nonce store falls back to in-memory, replay protection resets on cold starts.',
    },
];

const OPTIONAL = [];

let missing = 0;

console.log('Checking required environment variables...\n');

for (const { name, description, validate } of REQUIRED) {
    const value = process.env[name];
    if (!value || value.trim() === '') {
        console.error(`  MISSING  ${name}`);
        console.error(`           ${description}\n`);
        missing++;
    } else if (validate) {
        const result = validate(value.trim());
        if (result !== true) {
            console.error(`  INVALID  ${name}`);
            console.error(`           ${result}\n`);
            missing++;
        } else {
            console.log(`  OK       ${name}`);
        }
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
