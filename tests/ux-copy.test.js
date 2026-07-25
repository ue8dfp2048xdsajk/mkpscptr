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

    test('signed-out export gate mentions idle autosave under Sign in', () => {
        expect(appHtml).toContain(
            'Your work is autosaved here 5s after your last edit.'
        );
        const block = appHtml.match(
            /id="exportSignInBlock"[\s\S]*?<\/div>/
        )?.[0] || '';
        expect(block).toContain('Your work is autosaved here 5s after your last edit.');
        expect(block).not.toContain('Sign in to export.');
        expect(block.indexOf('id="exportSignInBtn"')).toBeLessThan(
            block.indexOf('Your work is autosaved here 5s after your last edit')
        );
    });

    test('onboarding elements present', () => {
        expect(appHtml).toContain('id="workflowBanner"');
        expect(appHtml).toContain('id="sidebarCoach"');
        expect(appHtml).toContain('id="shortcutsModal"');
        expect(appHtml).toContain('id="instructionsPanel"');
        expect(appHtml).toContain('data-help-tab="instructions"');
    });

    test('combo toast removed; large-session perf prompt present', () => {
        expect(appHtml).not.toContain('id="comboToast"');
        expect(appHtml).toContain('id="perfSessionPrompt"');
        expect(appHtml).toContain(
            'Large session - for smoother editing, close other browser tabs and heavy apps. Your work still autosaves.'
        );
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
