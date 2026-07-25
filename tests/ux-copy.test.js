const fs = require('fs');
const path = require('path');

const appHtml = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');

describe('UX copy contracts (app.html)', () => {
    test('uses POD terminology for upload buttons', () => {
        expect(appHtml).toContain('Upload mockup photos');
        expect(appHtml).toContain('Upload designs');
        expect(appHtml).not.toContain('Upload Backgrounds');
    });

    test('reset is left-panel only - no top-bar reset', () => {
        expect(appHtml).not.toContain('id="resetBtnTop"');
        expect(appHtml).toMatch(/Reset Selected[\s\S]*\(R\)/);
    });

    test('export popover has summary and gate blocks', () => {
        expect(appHtml).toContain('id="exportSummary"');
        expect(appHtml).toContain('id="exportSignInBlock"');
        expect(appHtml).toContain('id="exportProSkipBtn"');
        expect(appHtml).toContain('export-go-btn-full');
    });

    test('signed-out export gate mentions local autosave', () => {
        expect(appHtml).toContain('Your work is autosaved in this browser');
    });

    test('onboarding elements present', () => {
        expect(appHtml).toContain('id="workflowBanner"');
        expect(appHtml).toContain('id="sidebarCoach"');
        expect(appHtml).toContain('id="shortcutsModal"');
        expect(appHtml).toContain('id="instructionsPanel"');
        expect(appHtml).toContain('data-help-tab="instructions"');
    });

    test('save button is visible in header top row (file nav)', () => {
        expect(appHtml).toMatch(/header-file-nav[\s\S]*id="saveProgressBtn"/);
        expect(appHtml).toContain('id="shortcutsTopBtn"');
        expect(appHtml).toContain('More ▾');
    });

    test('batch hint has dismiss control', () => {
        expect(appHtml).toContain('id="batchEditHintClose"');
    });

    test('shortcuts list uses select multiple wording', () => {
        expect(appHtml).toContain('<dt>Select multiple</dt><dd>Ctrl/Cmd+click</dd>');
        expect(appHtml).not.toContain('Toggle selection');
    });
});
