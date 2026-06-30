const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'mockupscripter';

if (!MONGODB_URI) {
    console.warn('api/db.js: MONGODB_URI is not set — MongoDB calls will fail');
}

let _client = null;
let _clientPromise = null;

async function getClient() {
    if (_client && _client.topology && _client.topology.isConnected()) {
        return _client;
    }
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

module.exports = { getDb };
