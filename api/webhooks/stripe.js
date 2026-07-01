const crypto = require('crypto');
const { getDb } = require('../_db');

// TTL index is created once per process lifetime.
let _idempotencyIndexEnsured = false;

// Atomically claim a Stripe event ID. Returns true if this instance is the
// first to process it, false if another invocation already handled it.
// Uses MongoDB _id uniqueness (duplicate-key error = already processed).
// A TTL index on processedAt auto-expires records after 4 days, which covers
// Stripe's full retry window (up to ~3 days of retries).
async function tryClaimStripeEvent(eventId) {
    let db;
    try {
        db = await getDb();
    } catch {
        // If DB is unavailable, allow processing — better than silently dropping events.
        console.warn('stripe-webhook: DB unavailable for idempotency check — processing event anyway');
        return true;
    }

    // Lazily ensure TTL index (fire-and-forget; failure is non-fatal).
    if (!_idempotencyIndexEnsured) {
        _idempotencyIndexEnsured = true;
        db.collection('idempotency_keys')
            .createIndex({ processedAt: 1 }, { expireAfterSeconds: 345600 }) // 4 days
            .catch(err => console.warn('stripe-webhook: TTL index creation failed (non-fatal):', err.message));
    }

    try {
        await db.collection('idempotency_keys').insertOne({
            _id: eventId,
            processedAt: new Date(),
        });
        return true; // first time processing this event
    } catch (err) {
        if (err.code === 11000) {
            return false; // duplicate — already processed
        }
        // Unexpected error — allow processing rather than silently dropping.
        console.error('stripe-webhook: idempotency check error — processing event anyway:', err.message);
        return true;
    }
}

// Built at call time so env-var changes and test overrides (jest.resetModules)
// are always reflected. A module-level map would bake in undefined values for
// any price env var that wasn't set at first require(), causing subscription
// events to silently map to the wrong plan or be dropped entirely.
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

const HANDLED_EVENTS = new Set([
    'checkout.session.completed',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.payment_failed',
]);

async function getRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            console.log(`stripe-webhook: raw body bytes=${raw.length}`);
            resolve(raw);
        });
        req.on('error', reject);
    });
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
    const parts = sigHeader.split(',');
    let timestamp = null;
    const v1Sigs = [];
    for (const part of parts) {
        const [k, v] = part.split('=');
        if (k === 't') timestamp = v;
        if (k === 'v1') v1Sigs.push(v);
    }
    if (!timestamp || v1Sigs.length === 0) {
        throw new Error('Invalid Stripe-Signature header format');
    }
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (ageSeconds > 300) {
        throw new Error('Stripe webhook timestamp is too old');
    }
    const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
    const expected = crypto
        .createHmac('sha256', secret)
        .update(signedPayload, 'utf8')
        .digest('hex');
    const match = v1Sigs.some((sig) => {
        try {
            return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
        } catch {
            return false;
        }
    });
    if (!match) throw new Error('Stripe webhook signature verification failed');
    return Number(timestamp);
}

// Store stripeCustomerId → clerkUserId in MongoDB (upsert).
// IMPORTANT: this now throws on failure so the caller can return 500 and let
// Stripe retry — a silently-dropped mapping means future subscription events
// (updates, cancellations) cannot look up the Clerk user.
async function storeCustomerMapping(stripeCustomerId, clerkUserId) {
    const db = await getDb();
    await db.collection('customers').updateOne(
        { stripeCustomerId },
        { $set: { stripeCustomerId, clerkUserId, updatedAt: new Date() } },
        { upsert: true }
    );
}

// Look up clerkUserId from stripeCustomerId via MongoDB
async function getClerkUserIdByCustomer(stripeCustomerId) {
    try {
        const db = await getDb();
        const doc = await db.collection('customers').findOne({ stripeCustomerId });
        return doc ? doc.clerkUserId : null;
    } catch (err) {
        console.error('stripe-webhook: customer mapping lookup failed', err);
        return null;
    }
}

// Patch arbitrary fields into Clerk public_metadata (non-fatal)
async function patchClerkPublicMetadata(clerkUserId, fields, clerkSecretKey) {
    if (!clerkSecretKey) return;
    try {
        await fetch(
            `https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}/metadata`,
            {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${clerkSecretKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ public_metadata: fields }),
                signal: AbortSignal.timeout(8000),
            }
        );
    } catch (err) {
        console.error('stripe-webhook: failed to patch Clerk metadata', err);
    }
}

// Store stripeCustomerId in Clerk public_metadata (non-fatal)
function storeStripeCustomerInClerk(clerkUserId, stripeCustomerId, clerkSecretKey) {
    return patchClerkPublicMetadata(clerkUserId, { stripeCustomerId }, clerkSecretKey);
}

// Call the internal set-plan endpoint.
// `nonce` should be the Stripe event ID (event.id) so that two concurrent
// deliveries of the same event are deduplicated atomically by the nonce store
// (Redis SET NX / PG INSERT ON CONFLICT DO NOTHING), even if the MongoDB
// idempotency check in tryClaimStripeEvent is temporarily unavailable.
async function callSetPlan(baseUrl, setPlanSecret, userId, plan, nonce, extraHeaders = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    return fetch(`${baseUrl}/api/set-plan`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${setPlanSecret}`,
            'X-Timestamp': String(timestamp),
            'X-Nonce': nonce,
            ...extraHeaders,
        },
        body: JSON.stringify({ userId, plan }),
        signal: AbortSignal.timeout(15000),
    });
}

module.exports = async function handler(req, res) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const setPlanSecret = process.env.SET_PLAN_SECRET;
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');

    // Diagnostic endpoint — requires Bearer <SET_PLAN_SECRET> auth.
    // Previously this was open, leaking configuration state to anyone.
    if (req.method === 'GET') {
        if (!setPlanSecret) {
            return res.status(500).json({ ok: false, error: 'Server misconfigured — SET_PLAN_SECRET is not set' });
        }
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!token || token !== setPlanSecret) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
        const configured = {
            STRIPE_WEBHOOK_SECRET: Boolean(webhookSecret && webhookSecret.startsWith('whsec_')),
            STRIPE_SECRET_KEY: Boolean(process.env.STRIPE_SECRET_KEY),
            SET_PLAN_SECRET: Boolean(setPlanSecret),
            BASE_URL: Boolean(baseUrl),
        };
        const allOk = Object.values(configured).every(Boolean);
        return res.status(allOk ? 200 : 503).json({ ok: allOk, configured });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!webhookSecret) {
        console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET is not set');
        return res.status(500).json({ ok: false, error: 'Webhook secret not configured' });
    }
    if (!setPlanSecret) {
        console.error('stripe-webhook: SET_PLAN_SECRET is not set');
        return res.status(500).json({ ok: false, error: 'Set-plan secret not configured' });
    }
    if (!baseUrl) {
        console.error('stripe-webhook: BASE_URL is not set');
        return res.status(500).json({ ok: false, error: 'Base URL not configured' });
    }

    const sigHeader = req.headers['stripe-signature'];
    if (!sigHeader) {
        return res.status(400).json({ ok: false, error: 'Missing Stripe-Signature header' });
    }

    let rawBody;
    try {
        rawBody = await getRawBody(req);
    } catch (err) {
        console.error('stripe-webhook: failed to read body', err);
        return res.status(400).json({ ok: false, error: 'Failed to read request body' });
    }

    try {
        verifyStripeSignature(rawBody, sigHeader, webhookSecret);
    } catch (err) {
        console.error('stripe-webhook: signature error:', err.message);
        return res.status(400).json({ ok: false, error: err.message });
    }

    let event;
    try {
        event = JSON.parse(rawBody.toString('utf8'));
    } catch {
        return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }

    if (!HANDLED_EVENTS.has(event.type)) {
        return res.status(200).json({ ok: true, ignored: true });
    }

    // Idempotency guard — Stripe delivers events at-least-once.
    // tryClaimStripeEvent atomically marks this event ID as in-progress using
    // MongoDB's _id uniqueness. A duplicate delivery returns false and is
    // acknowledged with 200 so Stripe stops retrying.
    const claimed = await tryClaimStripeEvent(event.id);
    if (!claimed) {
        console.log(`stripe-webhook: duplicate event ${event.id} (${event.type}) — already processed`);
        return res.status(200).json({ ok: true, ignored: true, reason: 'duplicate_event' });
    }

    // ── checkout.session.completed ───────────────────────────────────────────
    if (event.type === 'checkout.session.completed') {
        const session = event.data && event.data.object;
        if (!session) {
            return res.status(400).json({ ok: false, error: 'Missing event data object' });
        }

        const userId = session.client_reference_id;
        if (!userId) {
            console.error('stripe-webhook: checkout.session.completed has no client_reference_id');
            return res.status(400).json({ ok: false, error: 'Missing client_reference_id on session' });
        }

        const VALID_PLANS = ['starter', 'pro'];
        let plan = session.metadata && session.metadata.plan;

        if (!plan || !VALID_PLANS.includes(plan)) {
            console.warn(
                `stripe-webhook: session.metadata.plan="${plan}" is missing or invalid; ` +
                `fetching session with line_items expansion for userId ${userId}`
            );
            const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
            if (stripeSecretKey) {
                try {
                    const expandRes = await fetch(
                        `https://api.stripe.com/v1/checkout/sessions/${session.id}?expand[]=line_items`,
                        {
                            headers: { Authorization: `Bearer ${stripeSecretKey}` },
                            signal: AbortSignal.timeout(8000),
                        }
                    );
                    if (expandRes.ok) {
                        const expandedSession = await expandRes.json();
                        const lineItem = expandedSession.line_items?.data?.[0];
                        const priceId = lineItem?.price?.id;
                        plan = priceId ? getPriceMap()[priceId] : undefined;
                        if (plan) console.log(`stripe-webhook: resolved plan="${plan}" via line_items expand`);
                    }
                } catch (err) {
                    console.error('stripe-webhook: failed to expand session line_items', err);
                }
            }
        }

        if (!plan || !VALID_PLANS.includes(plan)) {
            console.error(
                `stripe-webhook: could not determine plan for userId=${userId}; ` +
                `metadata.plan="${session.metadata && session.metadata.plan}"`
            );
            return res.status(400).json({ ok: false, error: 'Could not determine plan from Stripe session' });
        }

        // Store customer ID mapping so subscription events can look up the Clerk user.
        // If this write fails, return 500 so Stripe retries — a dropped mapping means
        // future subscription.updated / subscription.deleted events cannot find the user.
        if (session.customer) {
            try {
                await storeCustomerMapping(session.customer, userId);
            } catch (err) {
                console.error('stripe-webhook: failed to store customer mapping — returning 500 so Stripe retries:', err);
                return res.status(500).json({ ok: false, error: 'Failed to store customer mapping' });
            }
            // Clerk metadata update is best-effort — non-fatal if it fails.
            await storeStripeCustomerInClerk(userId, session.customer, clerkSecretKey);
        }

        // Forward test hooks from the incoming request to set-plan (test mode only)
        const testHookHeaders = {};
        if (process.env.ENABLE_WEBHOOK_TEST_HOOKS === 'true' &&
                req.headers['x-test-force-clerk-error'] === '1') {
            testHookHeaders['X-Test-Force-Clerk-Error'] = '1';
            console.log('stripe-webhook: [TEST HOOK] forwarding X-Test-Force-Clerk-Error to set-plan');
        }

        let setPlanRes;
        try {
            setPlanRes = await callSetPlan(baseUrl, setPlanSecret, userId, plan, event.id, testHookHeaders);
        } catch (err) {
            console.error('stripe-webhook: set-plan fetch error', err);
            return res.status(502).json({ ok: false, error: 'Failed to reach set-plan endpoint' });
        }

        if (!setPlanRes.ok) {
            let setPlanError = 'set-plan API error';
            try {
                const setPlanBody = await setPlanRes.json();
                setPlanError = setPlanBody?.error || setPlanError;
            } catch {}
            console.error('stripe-webhook: set-plan returned', setPlanRes.status, setPlanError);
            return res.status(502).json({ ok: false, error: setPlanError });
        }

        console.log(`stripe-webhook: set plan="${plan}" for userId="${userId}"`);
        return res.status(200).json({ ok: true, userId, plan });
    }

    // ── customer.subscription.updated ───────────────────────────────────────
    if (event.type === 'customer.subscription.updated') {
        const sub = event.data && event.data.object;
        if (!sub) return res.status(400).json({ ok: false, error: 'Missing subscription object' });

        const stripeCustomerId = sub.customer;
        const status = sub.status;

        const clerkUserId = await getClerkUserIdByCustomer(stripeCustomerId);
        if (!clerkUserId) {
            console.warn(`stripe-webhook: no Clerk user found for customer=${stripeCustomerId}`);
            return res.status(200).json({ ok: true, ignored: true, reason: 'unknown customer' });
        }

        let newPlan;
        if (status === 'active') {
            const priceId = sub.items?.data?.[0]?.price?.id;
            newPlan = priceId ? getPriceMap()[priceId] : null;
            if (!newPlan) {
                console.warn(`stripe-webhook: unknown priceId=${priceId} on subscription update`);
                return res.status(200).json({ ok: true, ignored: true, reason: 'unknown price' });
            }
        } else if (status === 'canceled' || status === 'unpaid') {
            newPlan = 'free';
        } else {
            // past_due, paused — leave plan unchanged; subscription.deleted fires on full cancellation
            console.log(`stripe-webhook: subscription status="${status}" — no plan change`);
            return res.status(200).json({ ok: true, ignored: true, reason: `status=${status}` });
        }

        let setPlanRes;
        try {
            setPlanRes = await callSetPlan(baseUrl, setPlanSecret, clerkUserId, newPlan, event.id);
        } catch (err) {
            console.error('stripe-webhook: set-plan fetch error on subscription update', err);
            return res.status(502).json({ ok: false, error: 'Failed to reach set-plan endpoint' });
        }

        if (!setPlanRes.ok) {
            const b = await setPlanRes.json().catch(() => ({}));
            console.error('stripe-webhook: set-plan error on subscription update', b?.error);
            return res.status(502).json({ ok: false, error: b?.error || 'set-plan error' });
        }

        // Store or clear the cancellation date so the UI can show "Cancels on …"
        if (clerkSecretKey) {
            const endsAt = sub.cancel_at_period_end ? (sub.cancel_at || null) : null;
            await patchClerkPublicMetadata(clerkUserId, { subscriptionEndsAt: endsAt }, clerkSecretKey);
        }

        console.log(`stripe-webhook: subscription updated — plan="${newPlan}" for userId="${clerkUserId}"`);
        return res.status(200).json({ ok: true, clerkUserId, plan: newPlan });
    }

    // ── customer.subscription.deleted ───────────────────────────────────────
    if (event.type === 'customer.subscription.deleted') {
        const sub = event.data && event.data.object;
        if (!sub) return res.status(400).json({ ok: false, error: 'Missing subscription object' });

        const stripeCustomerId = sub.customer;
        const clerkUserId = await getClerkUserIdByCustomer(stripeCustomerId);
        if (!clerkUserId) {
            console.warn(`stripe-webhook: no Clerk user found for customer=${stripeCustomerId} on deletion`);
            return res.status(200).json({ ok: true, ignored: true, reason: 'unknown customer' });
        }

        let setPlanRes;
        try {
            setPlanRes = await callSetPlan(baseUrl, setPlanSecret, clerkUserId, 'free', event.id);
        } catch (err) {
            console.error('stripe-webhook: set-plan fetch error on subscription deletion', err);
            return res.status(502).json({ ok: false, error: 'Failed to reach set-plan endpoint' });
        }

        if (!setPlanRes.ok) {
            const b = await setPlanRes.json().catch(() => ({}));
            console.error('stripe-webhook: set-plan error on subscription deletion', b?.error);
            return res.status(502).json({ ok: false, error: b?.error || 'set-plan error' });
        }

        // Clear cancellation date on deletion
        if (clerkSecretKey) {
            await patchClerkPublicMetadata(clerkUserId, { subscriptionEndsAt: null }, clerkSecretKey);
        }

        console.log(`stripe-webhook: subscription deleted — reset to free for userId="${clerkUserId}"`);
        return res.status(200).json({ ok: true, clerkUserId, plan: 'free' });
    }

    // ── invoice.payment_failed ───────────────────────────────────────────────
    // Stripe retries failed payments on its dunning schedule. We only act on
    // the final failure (next_payment_attempt === null), which means Stripe has
    // exhausted all retries and is about to cancel the subscription. The
    // subscription.deleted event will fire shortly after, but revoking here
    // ensures access is removed even if that event is delayed or missed.
    if (event.type === 'invoice.payment_failed') {
        const invoice = event.data && event.data.object;
        if (!invoice) return res.status(400).json({ ok: false, error: 'Missing invoice object' });

        const attemptCount = invoice.attempt_count || 0;
        const isFinalFailure = invoice.next_payment_attempt === null;

        console.log(`stripe-webhook: invoice.payment_failed customer=${invoice.customer} attempt=${attemptCount} final=${isFinalFailure}`);

        if (!isFinalFailure) {
            // Stripe will retry — leave the plan intact during the dunning period.
            return res.status(200).json({ ok: true, noted: true, reason: 'dunning_retry' });
        }

        const stripeCustomerId = invoice.customer;
        const clerkUserId = await getClerkUserIdByCustomer(stripeCustomerId);
        if (!clerkUserId) {
            console.warn(`stripe-webhook: no Clerk user found for customer=${stripeCustomerId} on final payment failure`);
            return res.status(200).json({ ok: true, ignored: true, reason: 'unknown customer' });
        }

        let setPlanRes;
        try {
            setPlanRes = await callSetPlan(baseUrl, setPlanSecret, clerkUserId, 'free', event.id);
        } catch (err) {
            console.error('stripe-webhook: set-plan fetch error on final payment failure', err);
            return res.status(502).json({ ok: false, error: 'Failed to reach set-plan endpoint' });
        }

        if (!setPlanRes.ok) {
            const b = await setPlanRes.json().catch(() => ({}));
            console.error('stripe-webhook: set-plan error on final payment failure', b?.error);
            return res.status(502).json({ ok: false, error: b?.error || 'set-plan error' });
        }

        console.log(`stripe-webhook: final payment failure — reset to free for userId="${clerkUserId}"`);
        return res.status(200).json({ ok: true, clerkUserId, plan: 'free' });
    }

    return res.status(200).json({ ok: true, ignored: true });
};
