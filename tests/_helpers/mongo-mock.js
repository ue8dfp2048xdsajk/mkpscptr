'use strict';

/**
 * Shared MongoDB test helpers.
 *
 * Centralises a fake collection/db implementation so that every test suite
 * exercising Mongo-backed code (api/_nonce-store.js, api/webhooks/stripe.js
 * idempotency claiming, etc.) imports from here instead of defining its own
 * copy. The fake faithfully reproduces the one behavior these modules
 * actually depend on: unique _id enforcement, where a second insertOne() for
 * an existing _id throws a duplicate-key error with `code: 11000`, exactly
 * like the real MongoDB driver.
 */

function matchesFilter(doc, filter) {
    if (!filter) return true;
    return Object.entries(filter).every(([key, value]) => doc[key] === value);
}

/**
 * Build a fake MongoDB collection backed by an in-memory Map.
 *
 * @param {Map} [store] - Optional pre-populated Map (_id -> doc) so callers
 *   can inspect or seed state across multiple fake collections/instances.
 */
function makeFakeCollection(store = new Map()) {
    return {
        _store: store,

        async findOne(filter) {
            if (filter && Object.prototype.hasOwnProperty.call(filter, '_id')) {
                return store.has(filter._id) ? store.get(filter._id) : null;
            }
            for (const doc of store.values()) {
                if (matchesFilter(doc, filter)) return doc;
            }
            return null;
        },

        async insertOne(doc) {
            if (doc && Object.prototype.hasOwnProperty.call(doc, '_id') && store.has(doc._id)) {
                const err = new Error('E11000 duplicate key error collection');
                err.code = 11000;
                throw err;
            }
            store.set(doc._id, { ...doc });
            return { acknowledged: true, insertedId: doc._id };
        },

        // Supports the subset used by this codebase: $set updates with upsert,
        // matched either by _id or by an arbitrary equality filter (mirrors
        // storeCustomerMapping's `updateOne({ stripeCustomerId }, { $set }, { upsert })`).
        async updateOne(filter, update, options = {}) {
            const setFields = (update && update.$set) || {};
            let key = Object.prototype.hasOwnProperty.call(filter || {}, '_id') ? filter._id : undefined;

            if (key === undefined) {
                for (const [k, doc] of store.entries()) {
                    if (matchesFilter(doc, filter)) { key = k; break; }
                }
            }

            if (key !== undefined && store.has(key)) {
                store.set(key, { ...store.get(key), ...setFields });
                return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
            }

            if (options.upsert) {
                const newKey = key !== undefined ? key : (filter && filter._id) || `generated_${store.size}_${Date.now()}`;
                store.set(newKey, { _id: newKey, ...filter, ...setFields });
                return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: newKey };
            }

            return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
        },

        async deleteOne(filter) {
            if (filter && Object.prototype.hasOwnProperty.call(filter, '_id')) {
                const existed = store.delete(filter._id);
                return { deletedCount: existed ? 1 : 0 };
            }
            for (const [key, doc] of store.entries()) {
                if (matchesFilter(doc, filter)) {
                    store.delete(key);
                    return { deletedCount: 1 };
                }
            }
            return { deletedCount: 0 };
        },

        async deleteMany(filter) {
            let count = 0;
            for (const [key, doc] of [...store.entries()]) {
                if (matchesFilter(doc, filter)) {
                    store.delete(key);
                    count++;
                }
            }
            return { deletedCount: count };
        },

        async createIndex() {
            return 'mock-index';
        },
    };
}

/**
 * Build a fake db object exposing .collection(name), lazily creating a fake
 * collection per name (each backed by its own Map unless one is provided).
 */
function makeFakeDb(collections = {}) {
    const fakes = {};
    return {
        collection(name) {
            if (!fakes[name]) {
                fakes[name] = collections[name]
                    ? makeFakeCollection(collections[name])
                    : makeFakeCollection();
            }
            return fakes[name];
        },
        _fakes: fakes,
    };
}

/** Build a getDb() that always rejects, simulating Mongo being unreachable. */
function makeUnreachableDb(message = 'Mongo unreachable in test') {
    return () => Promise.reject(new Error(message));
}

module.exports = { makeFakeCollection, makeFakeDb, makeUnreachableDb };
