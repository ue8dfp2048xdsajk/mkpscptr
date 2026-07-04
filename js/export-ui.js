// ── Export UI: popover, pattern PNG, canvas text ─────────────────────────────
// Depends on globals from app.js (canvasData, buildFullSnapshot, _autosaveDB, …),
// pro-gating.js (_syncProEffect, _windowIsProGated), and plans-modal.js
// (openPlansModal — called at click time, not load time).
// Load this script after js/app.js.

// ── Export Pattern PNG ────────────────────────────────────────────────────────
// Downloads the current pattern canvas (before or after baking) as a PNG file.

function _exportPatternPNG(data) {
    if (!data || !data.patternMode || !data.patternFabricObj) return;

    const src = data.patternFabricObj.getElement();
    if (!src) return;

    // designOriginal may be an HTMLImageElement; wrap it in a canvas for toBlob.
    if (!(src instanceof HTMLCanvasElement)) {
        const tmp = document.createElement('canvas');
        tmp.width  = src.naturalWidth  || src.width  || 1;
        tmp.height = src.naturalHeight || src.height || 1;
        tmp.getContext('2d').drawImage(src, 0, 0);
        src = tmp;
    }

    src.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = (data.filename || 'pattern') + '_sheet.png';
        a.click();
        URL.revokeObjectURL(url);
    }, 'image/png');
}

document.getElementById('exportPatternBtn').addEventListener('click', async () => {
    if (!activeIndices.length) return;
    const data = canvasData[activeIndices[0]];
    if (!data) return;

    if (window.Clerk && !window.Clerk.user) {
        sessionStorage.setItem('ms_redirect_after_auth', 'export');
        try { await _autosaveDB.set('session', buildFullSnapshot()).catch(() => {}); } catch (e) { console.error('[ExportPattern→SignIn] snapshot failed:', e); }
        try { window.Clerk.redirectToSignIn({ forceRedirectUrl: window.location.href }); } catch (e) { alert('Sign-in is temporarily unavailable \u2014 please refresh the page.'); }
        return;
    }

    if (_userPlan !== 'pro') {
        if (typeof openPlansModal === 'function') {
            openPlansModal({
                context: 'Export Pattern PNG requires Pro \u2014 pattern is a PRO effect.',
            });
        }
        return;
    }

    if (!data.patternMode || !data.patternFabricObj) {
        alert('Turn on Pattern mode with a tiled design before exporting.');
        return;
    }

    _exportPatternPNG(data);
});

// Render one canvas item to a full-resolution PNG blob
// ── Export: format + quality ───────────────────────────────────────────────────
var _exportFormat  = 'png';   // 'png' | 'jpeg'
var _exportQuality = 0.92;    // 0–1, only used for jpeg
var _exportOutput  = 'zip';   // 'file' | 'zip'

async function exportDataToBlob(data, fmt, quality){
    fmt     = fmt     ?? _exportFormat;
    quality = quality ?? _exportQuality;

    data.fabricCanvas.discardActiveObject();

    const hiddenOverlayObjects = [];
    data.fabricCanvas.getObjects().forEach(obj=>{
        if(obj.excludeFromExport){
            hiddenOverlayObjects.push(obj);
            obj.visible = false;
        }
    });
    data.fabricCanvas.requestRenderAll();

    const exportMultiplier = 1 / data.previewScale;
    const cropAspect = data.bgCrop?.aspect || 0;
    let cropLeft = 0, cropTop = 0, cropWidth = data.fabricCanvas.width, cropHeight = data.fabricCanvas.height;
    if(cropAspect){
        const W = data.fabricCanvas.width, H = data.fabricCanvas.height;
        if(W / H > cropAspect){
            cropWidth  = H * cropAspect;
            cropLeft   = (W - cropWidth) / 2;
        } else if(W / H < cropAspect){
            cropHeight = W / cropAspect;
            cropTop    = (H - cropHeight) / 2;
        }
    }
    const dataURL = data.fabricCanvas.toDataURL({
        format:    fmt,
        quality:   quality,
        multiplier: exportMultiplier,
        enableRetinaScaling: true,
        left:   cropLeft,
        top:    cropTop,
        width:  cropWidth,
        height: cropHeight
    });

    hiddenOverlayObjects.forEach(obj=>{ obj.visible = true; });
    data.fabricCanvas.requestRenderAll();

    return await (await fetch(dataURL)).blob();
}

// ── Export popover wiring ──────────────────────────────────────────────────────
(function(){
    const popover     = document.getElementById('exportPopover');
    const triggerBtn  = document.getElementById('exportBtn');
    const qualityRow  = document.getElementById('exportQualityRow');
    const qualSlider  = document.getElementById('exportQualitySlider');
    const qualVal     = document.getElementById('exportQualityVal');
    const goBtn       = document.getElementById('exportGoBtn');
    const signInBlock = document.getElementById('exportSignInBlock');
    const plansBlock  = document.getElementById('exportPlansBlock');
    const summaryEl   = document.getElementById('exportSummary');
    const proGateRow  = document.getElementById('exportProGateRow');
    const proGateText = document.getElementById('exportProGateText');

    var _exportExcludeProGated = false;

    function _isSignedIn() {
        return window.Clerk && window.Clerk.user;
    }

    function _resolveScopeIndices() {
        const scopeBtn = document.querySelector('#exportScopeToggle .seg-active');
        const scope    = scopeBtn ? scopeBtn.dataset.val : 'selected';
        let indices;
        if (scope === 'all') {
            indices = canvasData.map((_, i) => i);
        } else {
            if (!activeIndices.length) return null;
            indices = [...activeIndices];
        }
        return typeof _resolveExportIndices === 'function'
            ? _resolveExportIndices(indices)
            : indices;
    }

    function _formatSummaryLine() {
        const indices = _resolveScopeIndices();
        if (!indices || !indices.length) return '';
        const fmt = _exportFormat === 'jpeg' ? 'JPEG' : 'PNG';
        const out = _exportOutput === 'zip' ? 'ZIP download' : 'individual files';
        const scopeBtn = document.querySelector('#exportScopeToggle .seg-active');
        const scopeLabel = scopeBtn && scopeBtn.dataset.val === 'all' ? 'All mockups' : 'Selected mockups';
        return scopeLabel + ': ' + indices.length + ' mockup' + (indices.length !== 1 ? 's' : '') +
            ' · ' + fmt + ' · ' + out;
    }

    function refreshExportPopover(opts) {
        opts = opts || {};
        if (opts.resetProSkip) _exportExcludeProGated = false;
        const anon = window.Clerk && !_isSignedIn();
        const free = _isSignedIn() && _userPlan === 'free';
        const canExport = _isSignedIn() && _userPlan !== 'free';

        if (signInBlock) signInBlock.hidden = !anon;
        if (plansBlock) plansBlock.hidden = !free;

        const summary = _formatSummaryLine();
        if (summaryEl) {
            if (summary && canvasData.length) {
                summaryEl.hidden = false;
                summaryEl.textContent = summary;
            } else {
                summaryEl.hidden = true;
                summaryEl.textContent = '';
            }
        }

        let blocked = [];
        if (_userPlan === 'starter' && canExport) {
            const indices = _resolveScopeIndices();
            if (indices) {
                indices.forEach(i => _syncProEffect(canvasData[i]));
                blocked = indices.filter(i => _windowIsProGated(canvasData[i]));
            }
        }

        if (proGateRow && proGateText) {
            if (blocked.length && !_exportExcludeProGated) {
                proGateRow.hidden = false;
                const n = blocked.length;
                proGateText.textContent = n + ' mockup' + (n > 1 ? 's use' : ' uses') + ' PRO effects.';
            } else if (blocked.length && _exportExcludeProGated) {
                proGateRow.hidden = false;
                proGateText.textContent = 'Exporting without PRO mockups (' + blocked.length + ' skipped).';
            } else {
                proGateRow.hidden = true;
            }
        }

        if (goBtn) {
            goBtn.disabled = anon || !canvasData.length ||
                (!_resolveScopeIndices() || !_resolveScopeIndices().length);
        }
    }

    window.refreshExportPopover = refreshExportPopover;

    function _showExportStatus(msg) {
        const el = document.getElementById('loadingIndicator');
        if (!el) return;
        el.style.display = 'block';
        el.innerText = msg;
    }
    function _hideExportStatus() {
        const el = document.getElementById('loadingIndicator');
        if (el) el.style.display = 'none';
    }
    function _setExportProgress(msg) {
        goBtn.textContent = msg;
        _showExportStatus(msg);
    }

    // Quality row starts hidden (PNG is default)
    qualityRow.hidden = true;

    // Toggle popover (free signed-in users → plans modal, like Save)
    triggerBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (_isSignedIn() && _userPlan === 'free') {
            popover.hidden = true;
            if (typeof openPlansModal === 'function') openPlansModal();
            return;
        }
        const opening = popover.hidden;
        popover.hidden = !popover.hidden;
        if (opening) refreshExportPopover({ resetProSkip: true });
    });

    document.querySelectorAll('#exportOutputToggle .seg-btn, #exportScopeToggle .seg-btn, #exportFormatToggle .seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!popover.hidden) setTimeout(function () { refreshExportPopover({ resetProSkip: false }); }, 0);
        });
    });

    var exportSignInBtn = document.getElementById('exportSignInBtn');
    if (exportSignInBtn) {
        exportSignInBtn.addEventListener('click', async () => {
            sessionStorage.setItem('ms_redirect_after_auth', 'export');
            await _autosaveDB.set('session', buildFullSnapshot()).catch(() => {});
            try { window.Clerk.redirectToSignIn({ forceRedirectUrl: window.location.href }); } catch(e) { alert('Sign-in is temporarily unavailable \u2014 please refresh the page.'); }
        });
    }
    var exportPlansBtn = document.getElementById('exportPlansBtn');
    if (exportPlansBtn) {
        exportPlansBtn.addEventListener('click', () => {
            if (typeof openPlansModal === 'function') openPlansModal();
        });
    }
    var exportProUpgradeBtn = document.getElementById('exportProUpgradeBtn');
    if (exportProUpgradeBtn) {
        exportProUpgradeBtn.addEventListener('click', () => {
            if (typeof openPlansModal === 'function') openPlansModal();
        });
    }
    var exportProSkipBtn = document.getElementById('exportProSkipBtn');
    if (exportProSkipBtn) {
        exportProSkipBtn.addEventListener('click', () => {
            _exportExcludeProGated = true;
            refreshExportPopover({ resetProSkip: false });
        });
    }

    // Close on outside click
    document.addEventListener('click', e => {
        if(!popover.hidden && !popover.contains(e.target) && e.target !== triggerBtn){
            popover.hidden = true;
        }
    });

    // Segmented toggles
    function wireSegToggle(id, onChange){
        const seg = document.getElementById(id);
        seg.querySelectorAll('.seg-btn').forEach(btn => {
            btn.addEventListener('click', ()=>{
                seg.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('seg-active'));
                btn.classList.add('seg-active');
                onChange(btn.dataset.val);
            });
        });
    }

    wireSegToggle('exportOutputToggle', val => { _exportOutput = val; });
    wireSegToggle('exportScopeToggle', val => { /* stored via active class */ });
    wireSegToggle('exportFormatToggle', val => {
        _exportFormat = val;
        qualityRow.hidden = (val !== 'jpeg');
    });

    // Quality slider
    qualSlider.addEventListener('input', () => {
        _exportQuality = qualSlider.value / 100;
        qualVal.textContent = qualSlider.value + '%';
    });

    // Run the actual file export for a pre-computed list of window indices.
    // Caller is responsible for filtering out any PRO-blocked windows beforehand.
    async function _runExportWithIndices(indices) {
        const ext = _exportFormat === 'jpeg' ? 'jpg' : 'png';

        indices.forEach(i => _syncProEffect(canvasData[i]));

        // Safety net: Starter plan — silently drop any PRO-gated windows that slipped through
        if(_userPlan === 'starter'){
            indices = indices.filter(i => !_windowIsProGated(canvasData[i]));
            if(!indices.length){
                alert('All selected mockups use PRO-only features. Upgrade to PRO to export them.');
                return;
            }
        }

        goBtn.disabled = true;
        popover.hidden = true;

        let exportSucceeded = false;
        try {
            _setExportProgress('Exporting…');
            if(_exportOutput === 'zip'){
                // --- ZIP mode: collect all blobs → single .zip download ---
                const zip = new JSZip();
                const usedNames = {};
                for(let i = 0; i < indices.length; i++){
                    const data = canvasData[indices[i]];
                    _setExportProgress('Exporting ' + (i + 1) + ' of ' + indices.length + '…');
                    const blob = await exportDataToBlob(data, _exportFormat, _exportQuality);
                    let baseName = (data.filename || ('mockup_' + (i + 1)));
                    // Deduplicate filenames within the zip
                    let fileName = baseName + '.' + ext;
                    if(usedNames[fileName]){
                        usedNames[fileName]++;
                        fileName = baseName + '_' + usedNames[fileName] + '.' + ext;
                    } else {
                        usedNames[fileName] = 1;
                    }
                    zip.file(fileName, blob);
                }
                _setExportProgress('Zipping…');
                const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
                const url = URL.createObjectURL(zipBlob);
                const a   = document.createElement('a');
                a.href     = url;
                a.download = 'mockups.zip';
                a.click();
                await new Promise(r => setTimeout(r, 200));
                URL.revokeObjectURL(url);
            } else {
                // --- File mode ---
                // Path A: File System Access API (Chrome/Edge) — save to folder
                if(typeof window.showDirectoryPicker === 'function'){
                    let dirHandle;
                    try{ dirHandle = await window.showDirectoryPicker(); }
                    catch(err){ return; }  // user cancelled — finally re-enables button

                    for(let i = 0; i < indices.length; i++){
                        const data = canvasData[indices[i]];
                        _setExportProgress('Exporting ' + (i + 1) + ' of ' + indices.length + '…');
                        const blob = await exportDataToBlob(data, _exportFormat, _exportQuality);
                        const fh   = await dirHandle.getFileHandle((data.filename || ('mockup_' + (i + 1))) + '.' + ext, { create: true });
                        const wr   = await fh.createWritable();
                        await wr.write(blob);
                        await wr.close();
                    }
                    alert('Exported ' + indices.length + ' file(s)!');
                } else {
                    // Path B: fallback <a download> — one download per file
                    for(let i = 0; i < indices.length; i++){
                        const data = canvasData[indices[i]];
                        _setExportProgress('Exporting ' + (i + 1) + ' of ' + indices.length + '…');
                        const blob = await exportDataToBlob(data, _exportFormat, _exportQuality);
                        const url  = URL.createObjectURL(blob);
                        const a    = document.createElement('a');
                        a.href     = url;
                        a.download = (data.filename || ('mockup_' + (i + 1))) + '.' + ext;
                        a.click();
                        await new Promise(r => setTimeout(r, 150));
                        URL.revokeObjectURL(url);
                    }
                }
            }
            exportSucceeded = true;
            _setExportProgress('Export complete ✓');
            if (typeof window._onFirstExportSuccess === 'function') {
                window._onFirstExportSuccess();
            }
        } catch(err) {
            console.error('Export failed:', err);
            alert('Export failed — ' + (err.message || 'unknown error'));
        } finally {
            goBtn.textContent = 'Export';
            goBtn.disabled = false;
            if (exportSucceeded) {
                setTimeout(_hideExportStatus, 800);
            } else {
                _hideExportStatus();
            }
        }
    }

    goBtn.addEventListener('click', async () => {
        if(clipEditMode){ showClipModeNotice(); return; }
        if (typeof window._markExportAttempted === 'function') window._markExportAttempted();

        // Unauthenticated users must sign in before exporting
        if (window.Clerk && !window.Clerk.user) {
            sessionStorage.setItem('ms_redirect_after_auth', 'export');
            await _autosaveDB.set('session', buildFullSnapshot()).catch(()=>{});
            try { window.Clerk.redirectToSignIn({ forceRedirectUrl: window.location.href }); } catch(e) { alert('Sign-in is temporarily unavailable \u2014 please refresh the page.'); }
            return;
        }

        // FREE users cannot export — open plans modal
        if(_userPlan === 'free'){
            if(typeof openPlansModal === 'function') openPlansModal();
            return;
        }

        // Determine export scope
        const scopeBtn = document.querySelector('#exportScopeToggle .seg-active');
        const scope    = scopeBtn ? scopeBtn.dataset.val : 'selected';

        let indices;
        if(scope === 'all'){
            indices = canvasData.map((_, i) => i);
        } else {
            if(!activeIndices.length){
                alert('Select at least one mockup before exporting.');
                return;
            }
            indices = [...activeIndices];
        }
        indices = typeof _resolveExportIndices === 'function'
            ? _resolveExportIndices(indices)
            : indices;

        // STARTER users: PRO-gated mockups — popover skip or plans modal fallback
        if(_userPlan === 'starter'){
            indices.forEach(i => _syncProEffect(canvasData[i]));
            const blocked    = indices.filter(i => _windowIsProGated(canvasData[i]));
            if(blocked.length){
                const blockedSet = new Set(blocked);
                if (_exportExcludeProGated) {
                    indices = indices.filter(i => !blockedSet.has(i));
                    if (!indices.length) {
                        alert('All selected mockups use PRO-only features. Upgrade to PRO to export them.');
                        return;
                    }
                } else {
                    const n = blocked.length;
                    const msg = n + ' mockup' + (n > 1 ? 's' : '') + ' you\'re trying to export ' +
                        (n > 1 ? 'use' : 'uses') + ' PRO-only effects (\u2b50). ' +
                        'Upgrade to export them, or skip those mockups and continue with the rest.';
                    if(typeof openPlansModal === 'function'){
                        openPlansModal({
                            context: msg,
                            onSkip: () => _runExportWithIndices(indices.filter(i => !blockedSet.has(i)))
                        });
                    }
                    return;
                }
            }
        }

        // Server-side export gate — verifies plan server-side so the export
        // cannot be triggered by running the frontend code without the backend.
        _setExportProgress('Preparing export…');
        try {
            const _exportToken = window.Clerk?.session
                ? await window.Clerk.session.getToken().catch(() => null)
                : null;
            const exportAuth = await fetch('/api/export', {
                method: 'POST',
                headers: _exportToken
                    ? { 'Authorization': 'Bearer ' + _exportToken }
                    : {},
            });
            if (!exportAuth.ok) {
                const exportErr = await exportAuth.json().catch(() => ({}));
                _hideExportStatus();
                if (exportErr.error === 'upgrade_required') {
                    if (typeof openPlansModal === 'function') openPlansModal();
                } else {
                    alert('Export not available — please sign in and try again.');
                }
                return;
            }
        } catch {
            _hideExportStatus();
            alert('Export failed — could not reach the server. Please check your connection.');
            return;
        }

        await _runExportWithIndices(indices);
    });
})();

// ── Export canvas text ────────────────────────────────────────────────────────
document.getElementById('exportTextBtn').addEventListener('click', async () => {
    if(window.Clerk && !window.Clerk.user){
        sessionStorage.setItem('ms_redirect_after_auth', 'export');
        try { await _autosaveDB.set('session', buildFullSnapshot()).catch(()=>{}); } catch(e) { console.error('[Export→SignIn] snapshot failed:', e); }
        try { window.Clerk.redirectToSignIn({ forceRedirectUrl: window.location.href }); } catch(e) { alert('Sign-in is temporarily unavailable \u2014 please refresh the page.'); }
        return;
    }
    if(_userPlan === 'free'){
        if(typeof openPlansModal === 'function') openPlansModal();
        return;
    }
    const sorted = [..._textBoxes]
        .filter(b => b.textEl ? b.textEl.innerText.trim() : b.content.trim())
        .sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
    if (!sorted.length) {
        alert('No text on the canvas to export yet.');
        return;
    }
    const text = sorted.map(b => (b.textEl ? b.textEl.innerText : b.content).trim()).join('\n\n') + '\n';
    const blob = new Blob([text], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'canvas-text.txt';
    a.click();
    URL.revokeObjectURL(url);
});
