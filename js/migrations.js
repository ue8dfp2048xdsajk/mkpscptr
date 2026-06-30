'use strict';

function migrateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    const version = snapshot.schemaVersion || 1;

    // v1 → future versions: add migration logic here when schema changes
    if (version === 1) {
        return snapshot;
    }

    return snapshot;
}

window.migrateSnapshot = migrateSnapshot;
