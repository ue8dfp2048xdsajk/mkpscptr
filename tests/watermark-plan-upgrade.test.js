/**
 * @jest-environment jsdom
 *
 * End-to-end simulation: watermarks disappear instantly after a plan upgrade.
 *
 * How real production code is loaded
 * ───────────────────────────────────
 * In a browser, js/app.js is loaded as a <script> tag so every top-level `var`
 * becomes window.xxx.  js/clerk-auth.js then writes window._userPlan when the
 * Clerk session refreshes and calls _refreshAllProStarBadges() — resolving via
 * the shared global scope.
 *
 * app.js is ~9 800 lines and registers DOM event listeners, accesses sliders,
 * and calls IntersectionObserver at module initialisation — none of which are
 * available in jsdom.  We therefore extract only the plan/watermark section
 * (lines 34-177) and eval it via window.eval(), which runs code in the jsdom
 * window global scope exactly as a <script> tag would.  After the eval:
 *
 *   window._userPlan               — the real module-level plan variable
 *   window._drawWatermarkOnCanvas  — the real production function
 *   window._refreshAllProStarBadges — the real production function
 *
 * External identifiers referenced by those lines and not present in the snippet
 * are pre-defined as mocks before the eval:
 *   canvasData       (array, line 154 of app.js)
 *   _markDirty       (called by _markProEffect — not under test, but declared)
 *   _updateSaveNewBtn (called at line 169 of app.js)
 *
 * ── What is tested ───────────────────────────────────────────────────────────
 *  1. _drawWatermarkOnCanvas draws on a free plan (fillText called).
 *  2. After upgrade to 'starter' (no PRO effect), drawing is skipped.
 *  3. Starter plan + PRO-effect canvas: drawing still happens.
 *  4. After upgrade to 'pro', drawing is skipped even for PRO-effect canvases.
 *  5. _refreshAllProStarBadges hides #upgradePrompt when plan is 'starter'.
 *  6. _refreshAllProStarBadges hides #upgradePrompt when plan is 'pro'.
 *  7. _refreshAllProStarBadges leaves #upgradePrompt visible on 'free'.
 *  8. _refreshAllProStarBadges calls requestRenderAll() on every fabric canvas.
 *  9. Full upgrade simulation: free → pro → prompt hidden, canvas no watermark.
 * 10. Full upgrade simulation: free → starter (no PRO effect) → same outcome.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Load the REAL production functions from js/app.js into the jsdom global.
//
// We extract lines 34-177 (1-indexed) — the plan/watermark block — and eval
// them via window.eval() so `var` declarations and function declarations land
// on window, matching the browser <script> loading model.
// ---------------------------------------------------------------------------

const APP_JS_PATH = path.join(__dirname, '../js/app.js');

function loadWatermarkFunctions() {
    const src   = fs.readFileSync(APP_JS_PATH, 'utf8');
    const lines = src.split('\n');
    // Lines 41-204 (1-indexed): watermark + PRO helpers through _refreshAllProStarBadges
    const snippet = lines.slice(40, 204).join('\n');

    // Pre-define external identifiers the snippet references
    global.canvasData        = [];
    global._markDirty        = jest.fn();
    global._updateSaveNewBtn = jest.fn();
    global.getAllDesignObjects = function (data) {
        const objs = [];
        if (data && data.designObject) objs.push(data.designObject);
        if (data && data.extraDesignObjects) data.extraDesignObjects.forEach(o => objs.push(o));
        return objs;
    };

    // Eval in the window/global scope — equivalent to a <script> tag
    // eslint-disable-next-line no-eval
    window.eval(snippet);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeCanvas(width, height) {
    return {
        width,
        height,
        contextContainer: {
            save:        jest.fn(),
            restore:     jest.fn(),
            translate:   jest.fn(),
            rotate:      jest.fn(),
            fillText:    jest.fn(),
            set font(_) {},
            set textAlign(_) {},
            set textBaseline(_) {},
            set shadowColor(_) {},
            set shadowBlur(_) {},
            set shadowOffsetX(_) {},
            set shadowOffsetY(_) {},
            set fillStyle(_) {},
        },
        requestRenderAll: jest.fn(),
    };
}

function makeCanvasData(fc, { hasProEffect = false } = {}) {
    return { fabricCanvas: fc, designObject: {}, hasProEffect };
}

function buildDOM() {
    document.body.innerHTML = `
      <div id="upgradePrompt" style="display:flex;">
        Free plan — watermarks appear on canvas.
        <button id="upgradePromptClose">✕</button>
      </div>
      <span class="pro-badge">PRO</span>
    `;
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(() => {
    loadWatermarkFunctions();
});

beforeEach(() => {
    // Reset plan to free before each test (mirrors app.js default)
    window._userPlan = 'free';
    // Reset canvasData
    global.canvasData = [];
    buildDOM();
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// _drawWatermarkOnCanvas — watermark visibility by plan
// ---------------------------------------------------------------------------

describe('_drawWatermarkOnCanvas (real app.js code) — watermark by plan', () => {
    test('free plan: canvas context fillText is called with watermark text', () => {
        window._userPlan = 'free';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc);

        window._drawWatermarkOnCanvas(data);

        expect(fc.contextContainer.fillText).toHaveBeenCalled();
        const texts = fc.contextContainer.fillText.mock.calls.map(([t]) => t);
        expect(texts).toContain('MOCKUP SCRIPTER');
        expect(texts).toContain('mockupscripter.com');
    });

    test('after upgrade to starter (no PRO effect): fillText is NOT called', () => {
        window._userPlan = 'starter';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc, { hasProEffect: false });

        window._drawWatermarkOnCanvas(data);

        expect(fc.contextContainer.fillText).not.toHaveBeenCalled();
    });

    test('starter plan + PRO-effect canvas: fillText IS still called', () => {
        window._userPlan = 'starter';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc, { hasProEffect: true });

        window._drawWatermarkOnCanvas(data);

        expect(fc.contextContainer.fillText).toHaveBeenCalled();
    });

    test('after upgrade to pro: fillText is NOT called even for PRO-effect canvas', () => {
        window._userPlan = 'pro';
        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc, { hasProEffect: true });

        window._drawWatermarkOnCanvas(data);

        expect(fc.contextContainer.fillText).not.toHaveBeenCalled();
    });

    test('bails silently when fabricCanvas is absent', () => {
        window._userPlan = 'free';
        expect(() => window._drawWatermarkOnCanvas(
            { fabricCanvas: null, designObject: {} }
        )).not.toThrow();
    });

    test('bails silently when designObject is absent', () => {
        window._userPlan = 'free';
        const fc = makeFakeCanvas(200, 200);
        window._drawWatermarkOnCanvas({ fabricCanvas: fc, designObject: null });
        expect(fc.contextContainer.fillText).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// _refreshAllProStarBadges — #upgradePrompt visibility
// ---------------------------------------------------------------------------

describe('_refreshAllProStarBadges (real app.js code) — #upgradePrompt bar', () => {
    test('free plan: #upgradePrompt remains visible', () => {
        window._userPlan = 'free';

        window._refreshAllProStarBadges();

        const bar = document.getElementById('upgradePrompt');
        expect(bar).not.toBeNull();
        expect(bar.style.display).not.toBe('none');
    });

    test('upgrade to starter: #upgradePrompt is hidden immediately', () => {
        window._userPlan = 'starter';

        window._refreshAllProStarBadges();

        expect(document.getElementById('upgradePrompt').style.display).toBe('none');
    });

    test('upgrade to pro: #upgradePrompt is hidden immediately', () => {
        window._userPlan = 'pro';

        window._refreshAllProStarBadges();

        expect(document.getElementById('upgradePrompt').style.display).toBe('none');
    });

    test('absent #upgradePrompt does not throw when plan is paid', () => {
        document.getElementById('upgradePrompt').remove();
        window._userPlan = 'pro';
        expect(() => window._refreshAllProStarBadges()).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// _refreshAllProStarBadges — requestRenderAll on all canvases
// ---------------------------------------------------------------------------

describe('_refreshAllProStarBadges (real app.js code) — requestRenderAll', () => {
    test('calls requestRenderAll on every fabric canvas', () => {
        window._userPlan = 'pro';
        const fc1 = makeFakeCanvas(400, 300);
        const fc2 = makeFakeCanvas(400, 300);
        global.canvasData = [makeCanvasData(fc1), makeCanvasData(fc2)];

        window._refreshAllProStarBadges();

        expect(fc1.requestRenderAll).toHaveBeenCalledTimes(1);
        expect(fc2.requestRenderAll).toHaveBeenCalledTimes(1);
    });

    test('entry with no fabricCanvas skips requestRenderAll gracefully', () => {
        window._userPlan = 'pro';
        // wrapperEl must be present so _updateProStarBadge does not throw
        global.canvasData = [{ fabricCanvas: null, designObject: {}, wrapperEl: null, hasProEffect: false }];
        expect(() => window._refreshAllProStarBadges()).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Full upgrade simulation
// ---------------------------------------------------------------------------

describe('full upgrade simulation (real app.js code)', () => {
    test('free → pro: upgradePrompt hidden AND canvas no longer draws watermark', () => {
        // ── Step 1: user is on free plan ─────────────────────────────────
        window._userPlan = 'free';

        const fc   = makeFakeCanvas(800, 600);
        const data = makeCanvasData(fc);
        global.canvasData = [data];

        // Simulate after:render on free plan — watermark IS drawn
        window._drawWatermarkOnCanvas(data);
        expect(fc.contextContainer.fillText).toHaveBeenCalled();
        expect(
            fc.contextContainer.fillText.mock.calls.some(([t]) => t === 'MOCKUP SCRIPTER')
        ).toBe(true);

        // upgradePrompt should be visible
        expect(document.getElementById('upgradePrompt').style.display).not.toBe('none');

        // ── Step 2: Clerk session refreshes; clerk-auth.js writes window._userPlan
        window._userPlan = 'pro';

        // ── Step 3: clerk-auth.js calls _refreshAllProStarBadges() ───────
        window._refreshAllProStarBadges();

        // upgradePrompt must be hidden now
        expect(document.getElementById('upgradePrompt').style.display).toBe('none');

        // requestRenderAll must have been called (triggers the re-render)
        expect(fc.requestRenderAll).toHaveBeenCalledTimes(1);

        // ── Step 4: after:render fires again — watermark must NOT appear ─
        fc.contextContainer.fillText.mockClear();
        window._drawWatermarkOnCanvas(data);
        expect(fc.contextContainer.fillText).not.toHaveBeenCalled();
    });

    test('free → starter (no PRO effect): upgradePrompt hidden AND no watermark', () => {
        window._userPlan = 'free';
        const fc   = makeFakeCanvas(400, 300);
        const data = makeCanvasData(fc, { hasProEffect: false });
        global.canvasData = [data];

        // Watermark drawn on free plan
        window._drawWatermarkOnCanvas(data);
        expect(fc.contextContainer.fillText).toHaveBeenCalled();

        // Plan upgraded to starter
        window._userPlan = 'starter';
        window._refreshAllProStarBadges();

        expect(document.getElementById('upgradePrompt').style.display).toBe('none');

        fc.contextContainer.fillText.mockClear();
        window._drawWatermarkOnCanvas(data);
        expect(fc.contextContainer.fillText).not.toHaveBeenCalled();
    });
});
