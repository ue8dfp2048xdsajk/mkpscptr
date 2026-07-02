#!/usr/bin/env node
'use strict';

const REQUIRED = [
    {
        name: 'STRIPE_SECRET_KEY',
        description: 'Stripe secret key (sk_live_... / sk_test_...). ' +
            'Missing → /api/checkout cannot create Checkout Sessions.',
        validate: (v) => v.startsWith('sk_') || 'value should start with sk_',
    },
    {
        name: 'STRIPE_PRICE_STARTER_MONTHLY',
        description: 'Stripe price ID for Starter monthly plan (price_...). ' +
            'Missing → Starter monthly checkout will fail.',
        validate: (v) => v.startsWith('price_') || 'value should start with price_',
    },
    {
        name: 'STRIPE_PRICE_STARTER_ANNUAL',
        description: 'Stripe price ID for Starter annual plan (price_...). ' +
            'Missing → Starter annual checkout will fail.',
        validate: (v) => v.startsWith('price_') || 'value should start with price_',
    },
    {
        name: 'STRIPE_PRICE_STARTER_LIFETIME',
        description: 'Stripe price ID for Starter lifetime plan (price_...). ' +
            'Missing → Starter lifetime checkout will fail.',
        validate: (v) => v.startsWith('price_') || 'value should start with price_',
    },
    {
        name: 'STRIPE_PRICE_PRO_MONTHLY',
        description: 'Stripe price ID for Pro monthly plan (price_...). ' +
            'Missing → Pro monthly checkout will fail.',
        validate: (v) => v.startsWith('price_') || 'value should start with price_',
    },
    {
        name: 'STRIPE_PRICE_PRO_ANNUAL',
        description: 'Stripe price ID for Pro annual plan (price_...). ' +
            'Missing → Pro annual checkout will fail.',
        validate: (v) => v.startsWith('price_') || 'value should start with price_',
    },
    {
        name: 'STRIPE_PRICE_PRO_LIFETIME',
        description: 'Stripe price ID for Pro lifetime plan (price_...). ' +
            'Missing → Pro lifetime checkout will fail.',
        validate: (v) => v.startsWith('price_') || 'value should start with price_',
    },
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
        name: 'CLERK_JWKS_URL',
        description: 'Clerk JWKS endpoint (e.g. https://clerk.mockupscripter.com/.well-known/jwks.json). ' +
            'Missing → all token verification returns null — every authenticated endpoint ' +
            '(checkout, export, save, billing) rejects requests with 401, and checkout blocks all purchases.',
        validate: (v) => v.startsWith('https://') || 'value should start with https://',
    },
    {
        name: 'MONGODB_URI',
        description: 'MongoDB connection string (mongodb://... or mongodb+srv://...). ' +
            'Missing → the checkout.session.completed webhook cannot store the Stripe customer ' +
            'mapping and returns 500 before the user\'s plan is activated — the user pays but ' +
            'has to wait for Stripe\'s automatic webhook retries.',
        validate: (v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://') ||
            'value should start with mongodb:// or mongodb+srv://',
    },
    {
        name: 'UPSTASH_REDIS_REST_URL',
        description: 'Upstash Redis REST URL for the nonce store. ' +
            'Missing → nonce replay protection falls back to in-memory, resets on every cold start, ' +
            'allowing webhook replay attacks across serverless restarts. ' +
            'Create a free database at https://console.upstash.com.',
        validate: (v) => v.startsWith('https://') || 'value should start with https://',
    },
    {
        name: 'UPSTASH_REDIS_REST_TOKEN',
        description: 'Upstash Redis REST token for the nonce store. ' +
            'Missing → nonce store falls back to in-memory, replay protection resets on cold starts. ' +
            'Copy the token from the REST API section of your Upstash database.',
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
