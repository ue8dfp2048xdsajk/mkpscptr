/**
 * @jest-environment node
 *
 * Project title must survive page reload and cloud autosave without clobbering.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '../js/app.js');
const SAVE_JS_PATH = path.join(__dirname, '../api/projects/save.js');
const PROJECT_ID_PATH = path.join(__dirname, '../api/projects/[id].js');

describe('project name persistence', () => {
    test('_cloudSave omits name on overwrite when _projectName is empty', () => {
        const src = fs.readFileSync(APP_JS_PATH, 'utf8');
        const fn = src.match(/async function _cloudSave[\s\S]*?\n}\n/);
        expect(fn).toBeTruthy();
        expect(fn[0]).toMatch(/const body = \{ snapshot \}/);
        expect(fn[0]).toMatch(/if \(trimmedName\) \{\s*body\.name = trimmedName;/);
        expect(fn[0]).toMatch(/else if \(!currentUuid\) \{\s*body\.name = 'Untitled project';/);
        expect(fn[0]).not.toMatch(/name: _projectName \|\| 'Untitled project'/);
    });

    test('DOMContentLoaded IDB restore sets _projectName from snapshot.name', () => {
        const src = fs.readFileSync(APP_JS_PATH, 'utf8');
        expect(src).toMatch(/typeof snapshot\.name === 'string'/);
        expect(src).toMatch(/if \(restored\) _projectName = restored;/);
    });

    test('DOMContentLoaded loads cloud project when ms_open_cloud_uuid is set', () => {
        const src = fs.readFileSync(APP_JS_PATH, 'utf8');
        expect(src).toMatch(/ms_open_cloud_uuid/);
        expect(src).toMatch(/await _loadProjectByUuid\(pendingCloudUuid\)/);
    });

    test('_loadProjectByUuid prefers document name over snapshot.name', () => {
        const src = fs.readFileSync(APP_JS_PATH, 'utf8');
        expect(src).toMatch(/_projectName = \(data\.name \|\| raw\.name \|\| ''\)\.trim\(\) \|\| '';/);
    });

    test('Starter upsert updates name in $set when provided', () => {
        const src = fs.readFileSync(SAVE_JS_PATH, 'utf8');
        expect(src).toMatch(/if \(trimmedName\) starterSet\.name = trimmedName;/);
        expect(src).toMatch(/\$set: starterSet/);
    });

    test('GET /api/projects/[id] returns document name', () => {
        const src = fs.readFileSync(PROJECT_ID_PATH, 'utf8');
        expect(src).toMatch(/name: project\.name \|\| null/);
        expect(src).toMatch(/snapshot: 1, name: 1/);
    });
});
