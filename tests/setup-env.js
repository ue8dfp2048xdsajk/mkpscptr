/**
 * Global Jest setup - runs before every test file (via setupFilesAfterEnv).
 *
 * Some tests exercise code paths that read these env vars directly from
 * process.env (rather than through a mock), and restore whatever ambient
 * value was present before the test ran. Without a baseline value set at
 * the OS/CI level, `npm test` would fail in a clean shell even though
 * nothing is actually broken. Provide safe dummy defaults here so the
 * suite is hermetic; any test that needs a specific value (or absence of
 * one) already sets/deletes it explicitly in its own setup/teardown, so
 * this only fills the gap for tests that don't otherwise care.
 */

'use strict';

if (!process.env.SET_PLAN_SECRET) {
    process.env.SET_PLAN_SECRET = 'test_dummy_set_plan_secret';
}

if (!process.env.CLERK_SECRET_KEY) {
    process.env.CLERK_SECRET_KEY = 'sk_test_dummy_clerk_secret';
}
