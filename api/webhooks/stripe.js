const crypto = require('crypto');

const PRICE_TO_PLAN = {
    [process.env.STRIPE_PRICE_STARTER_MONTHLY]:  'starter',
    [process.env.STRIPE_PRICE_STARTER_ANNUAL]:   'starter',
    [process.env.STRIPE_PRICE_STARTER_LIFETIME]: 'starter',
    [process.env.STRIPE_PRICE_PRO_MONTHLY]:      'pro',
    [process.env.STRIPE_PRICE_PRO_ANNUAL]:       'pro',
    [process.env.STRIPE_PRICE_PRO_LIFETIME]:     'pro',
};

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

    if (!match) {
        throw new Error('Stripe webhook signature verification failed');
    }

    return Number(timestamp);
}

module.exports = async function handler(req, res) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const setPlanSecret = process.env.SET_PLAN_SECRET;
    const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');

    if (req.method === 'GET') {
        const configured = {
            STRIPE_WEBHOOK_SECRET: Boolean(webhookSecret && webhookSecret.startsWith('whsec_')),
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
    } catch (err) {
        return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }

    if (event.type !== 'checkout.session.completed') {
        return res.status(200).json({ ok: true, ignored: true });
    }

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
        if (!stripeSecretKey) {
            console.error('stripe-webhook: STRIPE_SECRET_KEY is not set; cannot expand line_items');
        } else {
            try {
                const expandRes = await fetch(
                    `https://api.stripe.com/v1/checkout/sessions/${session.id}?expand[]=line_items`,
                    { headers: { Authorization: `Bearer ${stripeSecretKey}` } }
                );
                if (!expandRes.ok) {
                    console.error(`stripe-webhook: Stripe session expand returned ${expandRes.status}`);
                } else {
                    const expandedSession = await expandRes.json();
                    const lineItem =
                        expandedSession.line_items &&
                        expandedSession.line_items.data &&
                        expandedSession.line_items.data[0];
                    const priceId = lineItem ? (lineItem.price && lineItem.price.id) : undefined;
                    plan = priceId ? PRICE_TO_PLAN[priceId] : undefined;
                    if (plan) {
                        console.log(`stripe-webhook: resolved plan="${plan}" via line_items expand`);
                    }
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

    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();

    let setPlanRes;
    try {
        setPlanRes = await fetch(`${baseUrl}/api/set-plan`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${setPlanSecret}`,
                'X-Timestamp': String(timestamp),
                'X-Nonce': nonce,
            },
            body: JSON.stringify({ userId, plan }),
        });
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
};
