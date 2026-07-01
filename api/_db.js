const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'mockupscripter';

if (!MONGODB_URI) {
    console.warn('api/_db.js: MONGODB_URI is not set — MongoDB calls will fail');
}

let _client = null;
let _clientPromise = null;

async function getClient() {
    // Return a cached client if one exists. The MongoDB driver manages its
    // own connection pool and replaces broken connections automatically —
    // no manual ping is needed. If a query fails because the connection is
    // stale, callers should catch the error and call invalidateClient() so
    // the next request establishes a fresh connection.
    if (_client) return _client;
    if (!_clientPromise) {
        _clientPromise = MongoClient.connect(MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 10000,
        }).then(client => {
            _client = client;
            _clientPromise = null;
            return client;
        }).catch(err => {
            _clientPromise = null;
            throw err;
        });
    }
    return _clientPromise;
}

async function getDb() {
    const client = await getClient();
    return client.db(DB_NAME);
}

// Call after a fatal query error to force a fresh connection on the next request.
function invalidateClient() {
    _client = null;
    _clientPromise = null;
}

module.exports = { getDb, invalidateClient };
