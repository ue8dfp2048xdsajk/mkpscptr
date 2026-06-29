/**
 * @jest-environment jsdom
 *
 * Tests for the upgrade-toast sign-out/sign-in cycle in clerk-auth.js.
 *
 * Scenario: a user sees the upgrade toast, then signs out and a different
 * user signs back in and completes checkout. The toast must fire again for
 * the new user — it must NOT be suppressed by the previous session's
 * sessionStorage flag.
 */

'use strict';

function makeUser(id, plan) {
    return {
        id,
        publicMetadata: { plan },
        primaryEmailAddress: { emailAddress: id + '@test.com' },
        imageUrl: '',
        firstName: id,
    };
}

/**
 * Install a mock window.Clerk object and return a handle to the listener
 * that clerk-auth.js registers via Clerk.addListener().
 *
 * Call captureListener() *after* loadScript() to retrieve the registered fn.
 */
function makeMockClerk(user) {
    let _registered = null;

    const session = {
        reload: jest.fn().mockResolvedValue(undefined),
    };

    window.Clerk = {
        load: jest.fn().mockResolvedValue(undefined),
        user,
        session: user ? session : null,
        addListener: jest.fn(function (fn) { _registered = fn; }),
        openSignIn: jest.fn(),
        signOut: jest.fn(),
    };

    return {
        getListener: () => _registered,
        session,
    };
}

/** Re-execute the IIFE in clerk-auth.js from scratch (fresh module cache). */
function loadScript() {
    jest.resetModules();
    window.__clerkSdkReady = true;
    window._refreshAllProStarBadges = jest.fn();
    window.posthog = undefined;
    document.body.innerHTML = '<div id="clerkAuthContainer"></div>';
    require('../js/clerk-auth');
}

/** Flush the microtask queue plus one timer tick so async code settles. */
async function flushAsync() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------

describe('upgrade toast — sign-out / sign-in cycle', () => {
    beforeEach(() => {
        sessionStorage.clear();
        localStorage.clear();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // Unit: _onClerkSignedOut (via the Clerk listener) clears the toast flag
    // -----------------------------------------------------------------------

    test('Clerk sign-out listener clears ms_upgrade_toast_shown', async () => {
        // Precondition: toast was already shown in this session
        sessionStorage.setItem('ms_upgrade_toast_shown', '1');

        const { getListener } = makeMockClerk(null);
        loadScript();
        await flushAsync();

        const listener = getListener();
        expect(listener).toBeDefined();

        // Simulate Clerk firing the signed-out event
        listener({ user: null });

        expect(sessionStorage.getItem('ms_upgrade_toast_shown')).toBeNull();
    });

    // -----------------------------------------------------------------------
    // Integration: full sign-out / sign-in / checkout round-trip
    //
    // 1. User A lands on the page after payment → toast fires.
    // 2. User A signs out → listener fires _onClerkSignedOut → flag cleared.
    // 3. User B signs in and their payment-pending key is present → script
    //    reloads (simulated by a second loadScript call) → toast fires again.
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Unit: sign-out mid-poll clears ms_payment_pending
    //
    // The payment-pending poll (tryReload) is started for User A but the
    // session.reload promise is never resolved — simulating a slow network.
    // User A then signs out. _onClerkSignedOut must clear ms_payment_pending
    // so that a subsequent sign-in by any user does not inherit the stale flag.
    // -----------------------------------------------------------------------

    test('sign-out mid-poll clears ms_payment_pending and new user is unaffected', async () => {
        // ── Step 1: User A has a pending payment flag and starts the poll ──
        const userA = makeUser('userA', 'free');

        // Make session.reload return a promise that never resolves so the
        // poll stays in-flight for the entire duration of this test.
        let _rejectReload;
        const stallPromise = new Promise((_res, rej) => { _rejectReload = rej; });
        const clerkA = makeMockClerk(userA);
        clerkA.session.reload.mockReturnValue(stallPromise);

        localStorage.setItem('ms_payment_pending', '1');

        loadScript();
        await flushAsync();  // tryReload fires but session.reload never settles

        // Flag must still be present because the poll hasn't resolved yet
        expect(localStorage.getItem('ms_payment_pending')).toBe('1');

        // ── Step 2: User A signs out mid-poll ─────────────────────────────
        const listenerA = clerkA.getListener();
        expect(listenerA).toBeDefined();

        listenerA({ user: null });   // Clerk fires the signed-out event

        // _onClerkSignedOut must have cleared the pending flag immediately
        expect(localStorage.getItem('ms_payment_pending')).toBeNull();

        // ── Step 3: User B signs in fresh — no pending flag, no poll ──────
        const userB = makeUser('userB', 'free');
        makeMockClerk(userB);

        document.body.innerHTML = '<div id="clerkAuthContainer"></div>';
        loadScript();
        await flushAsync();

        // No payment_pending flag means the activating banner must NOT appear
        expect(document.getElementById('msActivatingBanner')).toBeNull();
        // And no toast either
        expect(document.body.querySelector('.ms-upgrade-toast')).toBeNull();

        // Clean up the stalled promise to avoid unhandled-rejection noise
        _rejectReload(new Error('test teardown'));
        await Promise.resolve().catch(() => {});
    });

    test('upgrade toast fires again for new user after sign-out/sign-in cycle', async () => {
        // ── Step 1: User A returns from payment page ──────────────────────
        const userA = makeUser('userA', 'pro');
        const clerkA = makeMockClerk(userA);

        // Payment was just completed; server set the pending flag via redirect
        localStorage.setItem('ms_payment_pending', '1');

        loadScript();
        await flushAsync();

        // The payment-success poller (tryReload) should have resolved and
        // shown the toast, leaving the sessionStorage flag set.
        expect(sessionStorage.getItem('ms_upgrade_toast_shown')).toBe('1');
        expect(document.body.querySelector('.ms-upgrade-toast')).not.toBeNull();

        // ── Step 2: User A signs out ──────────────────────────────────────
        const listenerA = clerkA.getListener();
        expect(listenerA).toBeDefined();

        listenerA({ user: null });   // Clerk fires the signed-out event

        // _onClerkSignedOut must have cleared the flag
        expect(sessionStorage.getItem('ms_upgrade_toast_shown')).toBeNull();

        // ── Step 3: User B signs in (new account) and payment is pending ──
        const userB = makeUser('userB', 'pro');
        makeMockClerk(userB);

        // User B's payment set a fresh pending flag
        localStorage.setItem('ms_payment_pending', '1');

        // Simulate navigating back to the app (new Clerk.load cycle in same tab)
        document.body.innerHTML = '<div id="clerkAuthContainer"></div>';
        loadScript();
        await flushAsync();

        // Toast must fire again — the old session flag must NOT suppress it
        expect(sessionStorage.getItem('ms_upgrade_toast_shown')).toBe('1');
        expect(document.body.querySelector('.ms-upgrade-toast')).not.toBeNull();
    });
});
