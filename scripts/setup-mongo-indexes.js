#!/usr/bin/env node
'use strict';

/**
 * Run once (or on deploy) to create MongoDB indexes.
 * Usage: MONGODB_URI=... node scripts/setup-mongo-indexes.js
 */

const { MongoClient } = require('mongodb');

const uri    = process.env.MONGODB_URI;
const dbName = 'mockupscripter';

if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
}

async function main() {
    const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 8000 });
    const db     = client.db(dbName);
    const col    = db.collection('projects');

    // Unique lookup by UUID
    await col.createIndex({ uuid: 1 }, { unique: true, name: 'uuid_unique' });

    // Fast look-up of projects by user
    await col.createIndex({ userId: 1 }, { name: 'userId' });

    // TTL index — MongoDB auto-deletes documents once expiresAt is reached
    await col.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: 'ttl_expires', sparse: true }
    );

    // Anon rate-limit check (ip + createdAt)
    await col.createIndex({ ip: 1, createdAt: -1 }, { sparse: true, name: 'ip_created' });

    console.log('Indexes created successfully on', dbName, '.projects');
    await client.close();
}

main().catch(err => {
    console.error('setup-mongo-indexes failed:', err.message);
    process.exit(1);
});
