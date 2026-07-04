#!/usr/bin/env node
'use strict';

/**
 * Find customers whose Stripe payment succeeded but whose Clerk plan was
 * never updated to match - the exact failure mode caused by the webhook
 * idempotency bug fixed in api/webhooks/stripe.js (a transient failure in
 * callSetPlan() left the Stripe event permanently marked "claimed", so every
 * retry - automatic or manual "Resend" - was silently swallowed as a
 * duplicate before ever reaching Clerk again).
 *
 * For every stripeCustomerId -> clerkUserId mapping in MongoDB's `customers`
 * collection (the authoritative record of everyone who has ever completed a
 * checkout), this script asks Stripe what plan that customer *should* have
 * (active subscription, or a paid one-time lifetime checkout session) and
 * compares it against what Clerk's public_metadata.plan actually says.
 *
 * Usage (run with the SAME env vars your deployment uses):
 *   node scripts/audit-stuck-plans.js            # report only, no writes
 *   node scripts/audit-stuck-plans.js --apply     # also fix mismatches in Clerk
 *
 * Or against real Vercel production values:
 *   vercel env pull .env.production.local --environment=production
 *   set -a && source .env.production.local && set +a
 *   node scripts/audit-stuck-plans.js
 */

const path = require('path');
const { getDb } = require(path.join('..', 'api', '_db'));

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const APPLY = process.argv.includes('--apply');

if (!STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not set - nothing to check.');
    process.exit(1);
}
if (!CLERK_SECRET_KEY) {
    console.error('CLERK_SECRET_KEY is not set - nothing to check.');
    process.exit(1);
}
if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set - nothing to check.');
    process.exit(1);
}

function getPriceMap() {
    return {
        [process.env.STRIPE_PRICE_STARTER_MONTHLY]:  'starter',
        [process.env.STRIPE_PRICE_STARTER_ANNUAL]:   'starter',
        [process.env.STRIPE_PRICE_STARTER_LIFETIME]: 'starter',
        [process.env.STRIPE_PRICE_PRO_MONTHLY]:      'pro',
        [process.env.STRIPE_PRICE_PRO_ANNUAL]:       'pro',
        [process.env.STRIPE_PRICE_PRO_LIFETIME]:     'pro',
    };
}

async function stripeGet(url) {
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `Stripe HTTP ${res.status}`);
    }
    return res.json();
}

// What plan *should* this customer have, according to Stripe itself?
// Checks active subscriptions first (monthly/annual), then falls back to any
// paid one-time checkout session (lifetime plans never create a subscription).
async function resolveExpectedPlan(stripeCustomerId) {
    const priceMap = getPriceMap();

    const subs = await stripeGet(
        `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(stripeCustomerId)}&status=active&limit=10`
    );
    for (const sub of subs.data || []) {
        const priceId = sub.items?.data?.[0]?.price?.id;
        if (priceId && priceMap[priceId]) {
            return { plan: priceMap[priceId], source: `active subscription ${sub.id}` };
        }
    }

    const sessions = await stripeGet(
        `https://api.stripe.com/v1/checkout/sessions?customer=${encodeURIComponent(stripeCustomerId)}&limit=100`
    );
    for (const session of sessions.data || []) {
        if (session.payment_status === 'paid' && session.mode === 'payment') {
            const plan = session.metadata && session.metadata.plan;
            if (plan) return { plan, source: `paid checkout session ${session.id}` };
        }
    }

    return { plan: null, source: null };
}

async function getClerkPlan(clerkUserId) {
    const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`, {
        headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}` },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        throw new Error(`Clerk HTTP ${res.status}`);
    }
    const user = await res.json();
    return user?.public_metadata?.plan || null;
}

async function fixClerkPlan(clerkUserId, plan) {
    const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}/metadata`, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${CLERK_SECRET_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ public_metadata: { plan } }),
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.errors?.[0]?.message || `Clerk HTTP ${res.status}`);
    }
}

async function main() {
    const db = await getDb();
    const customers = await db.collection('customers').find({}).toArray();

    console.log(`Auditing ${customers.length} customer record(s)...${APPLY ? ' (--apply: mismatches WILL be fixed)' : ' (report only - pass --apply to fix)'}\n`);

    let mismatches = 0;
    let errors = 0;

    for (const { stripeCustomerId, clerkUserId } of customers) {
        if (!stripeCustomerId || !clerkUserId) continue;

        let expectedPlan, expectedSource, actual;
        try {
            const [expectedResult, clerkPlan] = await Promise.all([
                resolveExpectedPlan(stripeCustomerId),
                getClerkPlan(clerkUserId),
            ]);
            expectedPlan = expectedResult.plan;
            expectedSource = expectedResult.source;
            actual = clerkPlan;
        } catch (err) {
            console.log(`ERROR    clerkUserId=${clerkUserId} stripeCustomerId=${stripeCustomerId} - ${err.message}`);
            errors++;
            continue;
        }

        if (!expectedPlan) {
            // No active subscription and no paid lifetime session found per Stripe.
            // If Clerk still shows a paid plan, this could be a cancellation/downgrade
            // whose set-plan call was swallowed by the same bug - flag it, but never
            // auto-revoke access via --apply (a false positive here would wrongly
            // downgrade a paying customer, which is worse than a manual review delay).
            if (actual && actual !== 'free') {
                console.log(`REVIEW   clerkUserId=${clerkUserId} stripeCustomerId=${stripeCustomerId}`);
                console.log(`         Stripe shows no active subscription/paid lifetime session for this customer`);
                console.log(`         Clerk public_metadata.plan is "${actual}" - verify manually before downgrading`);
                mismatches++;
            }
            continue;
        }

        if (expectedPlan === actual) {
            console.log(`OK       clerkUserId=${clerkUserId} - plan="${actual}" matches Stripe`);
            continue;
        }

        mismatches++;
        console.log(`MISMATCH clerkUserId=${clerkUserId} stripeCustomerId=${stripeCustomerId}`);
        console.log(`         Stripe says plan should be "${expectedPlan}" (via ${expectedSource})`);
        console.log(`         Clerk public_metadata.plan is "${actual || '(missing)'}"`);

        if (APPLY) {
            try {
                await fixClerkPlan(clerkUserId, expectedPlan);
                console.log(`         FIXED - Clerk plan set to "${expectedPlan}"`);
            } catch (err) {
                console.log(`         FAILED to fix - ${err.message}`);
                errors++;
            }
        }
    }

    console.log(`\nDone. ${mismatches} mismatch(es) found${APPLY ? ', fix attempted for each' : ''}. ${errors} error(s).`);
    if (mismatches > 0 && !APPLY) {
        console.log('Re-run with --apply to correct Clerk metadata for the customers listed above.');
    }
    process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('audit-stuck-plans failed:', err.message);
    process.exit(1);
});
