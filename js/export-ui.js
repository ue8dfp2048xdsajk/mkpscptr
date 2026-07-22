// ── Export UI: popover, pattern PNG, canvas text ─────────────────────────────
// Depends on globals from app.js (canvasData, buildFullSnapshot, _autosaveDB, …),
// pro-gating.js (_syncProEffect, _windowIsProGated, _beginExportCapture), and
// plans-modal.js (openPlansModal - called at click time, not load time).
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

// ── Export: format + quality + popover (closure - no unguarded global export API) ─
(function(){
    var _exportFormat  = 'png';   // 'png' | 'jpeg'
    var _exportQuality = 0.92;    // 0–1, only used for jpeg
    var _exportOutput  = 'zip';   // 'file' | 'zip'
    var _exportSession = null;    // { plan, expiresAt } after POST /api/export succeeds
    var _EXPORT_SESSION_MS = 5 * 60 * 1000;

    function _exportSessionValid() {
        return _exportSession && Date.now() < _exportSession.expiresAt;
    }

    async function _authorizeExport() {
        const _exportToken = window.Clerk?.session
            ? await window.Clerk.session.getToken().catch(() => null)
            : null;
        let exportAuth;
        try {
            exportAuth = await fetch('/api/export', {
                method: 'POST',
                headers: _exportToken
                    ? { 'Authorization': 'Bearer ' + _exportToken }
                    : {},
            });
        } catch {
            alert('Export failed - could not reach the server. Please check your connection.');
            return null;
        }
        if (!exportAuth.ok) {
            const exportErr = await exportAuth.json().catch(() => ({}));
            if (exportErr.error === 'upgrade_required') {
                if (typeof openPlansModal === 'function') openPlansModal();
            } else {
                alert('Export not available - please sign in and try again.');
            }
            return null;
        }
        const body = await exportAuth.json().catch(() => ({}));
        if (!body.ok || !body.plan) {
            alert('Export not available - please try again.');
            return null;
        }
        _exportSession = { plan: body.plan, expiresAt: Date.now() + _EXPORT_SESSION_MS };
        return body.plan;
    }

    async function exportDataToBlob(data, fmt, quality){
        if (!_exportSessionValid()) {
            throw new Error('Export not authorized');
        }
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

        if (typeof _beginExportCapture === 'function') {
            _beginExportCapture(_exportSession.plan);
        }
        try {
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
        } finally {
            if (typeof _endExportCapture === 'function') {
                _endExportCapture();
            }
        }
    }

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
    const outputHintEl = document.getElementById('exportOutputHint');
    const largeWarnEl  = document.getElementById('exportLargeWarn');
    const successPanel = document.getElementById('exportSuccessPanel');
    const successMsgEl = document.getElementById('exportSuccessMsg');
    const successDismissBtn = document.getElementById('exportSuccessDismiss');
    const optionsBody  = document.getElementById('exportOptionsBody');

    var _exportExcludeProGated = false;
    var _folderPickerAvailable = typeof window.showDirectoryPicker === 'function';
    var _lastExportSuccessKind = null; // 'zip' | 'folder' | 'files'

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
        const out = _exportOutput === 'zip' ? 'ZIP download' : 'folder / files';
        const scopeBtn = document.querySelector('#exportScopeToggle .seg-active');
        const scopeLabel = scopeBtn && scopeBtn.dataset.val === 'all' ? 'All mockups' : 'Selected mockups';
        return scopeLabel + ': ' + indices.length + ' mockup' + (indices.length !== 1 ? 's' : '') +
            ' · ' + fmt + ' · ' + out;
    }

    function _updateOutputHint() {
        if (!outputHintEl) return;
        if (_exportOutput === 'zip') {
            outputHintEl.innerHTML = 'ZIP downloads to your <strong>Downloads folder</strong> (or wherever your browser saves files).';
        } else if (_folderPickerAvailable) {
            outputHintEl.textContent = 'Pick a folder (Chrome/Edge). Other browsers download files one-by-one to Downloads.';
        } else {
            outputHintEl.textContent = 'Folder picker needs Chrome/Edge. Here, images download one-by-one to your Downloads folder.';
        }
    }

    function _updateLargeWarn() {
        if (!largeWarnEl) return;
        const titleEl = document.getElementById('exportLargeWarnTitle');
        const subEl = document.getElementById('exportLargeWarnSub');
        const indices = _resolveScopeIndices();
        const count = indices ? indices.length : 0;
        if (_exportOutput !== 'zip' || count < 50) {
            largeWarnEl.hidden = true;
            if (titleEl) titleEl.textContent = '';
            if (subEl) subEl.textContent = '';
            return;
        }
        largeWarnEl.hidden = false;
        if (titleEl) titleEl.textContent = "Large ZIP (" + count + " mockups). Don't close this tab.";
        if (subEl) subEl.textContent = 'To export less at once: select fewer mockups → Scope: Selected → Export.';
    }

    function _showExportSuccess(kind) {
        _lastExportSuccessKind = kind;
        if (optionsBody) optionsBody.hidden = true;
        if (successPanel) successPanel.hidden = false;
        if (successMsgEl) {
            if (kind === 'zip') {
                successMsgEl.textContent = 'Exported! Check your Downloads folder for mockups.zip (or wherever your browser saves files).';
            } else if (kind === 'folder') {
                successMsgEl.textContent = 'Exported! Saved to the folder you chose.';
            } else {
                successMsgEl.textContent = 'Exported! Check your Downloads folder (or wherever your browser saves files).';
            }
        }
        if (popover) popover.hidden = false;
    }

    function _hideExportSuccess() {
        if (successPanel) successPanel.hidden = true;
        if (optionsBody) optionsBody.hidden = false;
        _lastExportSuccessKind = null;
    }

    function refreshExportPopover(opts) {
        opts = opts || {};
        if (opts.resetProSkip) _exportExcludeProGated = false;
        if (opts.clearSuccess) _hideExportSuccess();
        const anon = window.Clerk && !_isSignedIn();
        const free = _isSignedIn() && _userPlan === 'free';
        const canExport = _isSignedIn() && _userPlan !== 'free';

        if (signInBlock) signInBlock.hidden = !anon;
        if (plansBlock) plansBlock.hidden = !free;

        // Anon: only show Sign in — hide all export settings (UI only; auth gates unchanged)
        var settingsPanel = document.getElementById('exportSettingsPanel');
        if (settingsPanel) settingsPanel.hidden = !_isSignedIn();

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

        _updateOutputHint();
        _updateLargeWarn();

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
    if (qualityRow) qualityRow.hidden = true;

    if (triggerBtn) {
        triggerBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (_isSignedIn() && _userPlan === 'free') {
                popover.hidden = true;
                if (typeof openPlansModal === 'function') openPlansModal();
                return;
            }
            // Success panel stays until × — Export toggle returns to options instead of discarding it silently
            if (successPanel && !successPanel.hidden) {
                _hideExportSuccess();
                popover.hidden = false;
                refreshExportPopover({ resetProSkip: false });
                return;
            }
            const opening = popover.hidden;
            popover.hidden = !popover.hidden;
            if (opening) refreshExportPopover({ resetProSkip: true, clearSuccess: true });
        });
    }

    document.querySelectorAll('#exportOutputToggle .seg-btn, #exportScopeToggle .seg-btn, #exportFormatToggle .seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!popover.hidden) setTimeout(function () { refreshExportPopover({ resetProSkip: false }); }, 0);
        });
    });

    if (successDismissBtn) {
        successDismissBtn.addEventListener('click', e => {
            e.stopPropagation();
            _hideExportSuccess();
            refreshExportPopover({ resetProSkip: false });
        });
    }

    var exportSignInBtn = document.getElementById('exportSignInBtn');
    if (exportSignInBtn) {
        exportSignInBtn.addEventListener('click', async () => {
            sessionStorage.setItem('ms_redirect_after_auth', 'export');
            await _autosaveDB.set('session', buildFullSnapshot()).catch(() => {});
            try { window.Clerk.redirectToSignIn({ forceRedirectUrl: window.location.href }); } catch(e) { alert('Sign-in is temporarily unavailable - please refresh the page.'); }
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

    document.addEventListener('click', e => {
        // Keep success confirmation until × — ignore outside clicks while it is showing
        if (successPanel && !successPanel.hidden) return;
        if(!popover.hidden && !popover.contains(e.target) && e.target !== triggerBtn){
            popover.hidden = true;
        }
    });

    function wireSegToggle(id, onChange){
        const seg = document.getElementById(id);
        if (!seg) return;
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
        if (qualityRow) qualityRow.hidden = (val !== 'jpeg');
    });

    if (qualSlider) {
        qualSlider.addEventListener('input', () => {
            _exportQuality = qualSlider.value / 100;
            if (qualVal) qualVal.textContent = qualSlider.value + '%';
        });
    }

    async function _runExportWithIndices(indices) {
        const ext = _exportFormat === 'jpeg' ? 'jpg' : 'png';
        const verifiedPlan = _exportSessionValid() ? _exportSession.plan : null;

        indices.forEach(i => _syncProEffect(canvasData[i]));

        // Safety net: use server-verified plan so tampering _userPlan cannot export PRO windows on Starter.
        if (verifiedPlan === 'starter') {
            indices = indices.filter(i => !_windowIsProGated(canvasData[i]));
            if (!indices.length) {
                alert('All selected mockups use PRO-only features. Upgrade to PRO to export them.');
                return;
            }
        }

        goBtn.disabled = true;
        popover.hidden = true;
        _hideExportSuccess();

        let exportSucceeded = false;
        let successKind = 'files';
        try {
            _setExportProgress('Exporting…');
            if(_exportOutput === 'zip'){
                successKind = 'zip';
                const zip = new JSZip();
                const usedNames = {};
                for(let i = 0; i < indices.length; i++){
                    const data = canvasData[indices[i]];
                    _setExportProgress('Exporting ' + (i + 1) + ' of ' + indices.length + '…');
                    const blob = await exportDataToBlob(data, _exportFormat, _exportQuality);
                    let baseName = (data.filename || ('mockup_' + (i + 1)));
                    let fileName = baseName + '.' + ext;
                    if(usedNames[fileName]){
                        usedNames[fileName]++;
                        fileName = baseName + '_' + usedNames[fileName] + '.' + ext;
                    } else {
                        usedNames[fileName] = 1;
                    }
                    zip.file(fileName, blob);
                }
                const zipStarted = Date.now();
                const zipTick = function () {
                    const s = Math.max(0, Math.round((Date.now() - zipStarted) / 1000));
                    _setExportProgress(
                        s > 0
                            ? ("Building ZIP… " + s + "s - don't close this tab")
                            : "Building ZIP… don't close this tab"
                    );
                };
                zipTick();
                const zipTimer = setInterval(zipTick, 1000);
                let zipBlob;
                try {
                    // STORE: PNGs/JPEGs are already compressed; DEFLATE burns CPU for ~0% size win
                    zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
                } finally {
                    clearInterval(zipTimer);
                }
                const url = URL.createObjectURL(zipBlob);
                const a   = document.createElement('a');
                a.href     = url;
                a.download = 'mockups.zip';
                a.click();
                await new Promise(r => setTimeout(r, 200));
                URL.revokeObjectURL(url);
            } else {
                if(_folderPickerAvailable){
                    let dirHandle;
                    try{ dirHandle = await window.showDirectoryPicker(); }
                    catch(err){
                        // User cancelled folder picker — not a failure; reopen options.
                        popover.hidden = false;
                        refreshExportPopover({ resetProSkip: false });
                        return;
                    }

                    successKind = 'folder';
                    for(let i = 0; i < indices.length; i++){
                        const data = canvasData[indices[i]];
                        _setExportProgress('Exporting ' + (i + 1) + ' of ' + indices.length + '…');
                        const blob = await exportDataToBlob(data, _exportFormat, _exportQuality);
                        const fh   = await dirHandle.getFileHandle((data.filename || ('mockup_' + (i + 1))) + '.' + ext, { create: true });
                        const wr   = await fh.createWritable();
                        await wr.write(blob);
                        await wr.close();
                    }
                } else {
                    successKind = 'files';
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
            const raw = (err && err.message) ? String(err.message) : 'unknown error';
            const isMem = /array buffer|allocation failed|out of memory|oom/i.test(raw);
            if (isMem) {
                alert('Export failed - this batch is too large for one ZIP. Try Folder (Chrome/Edge), or export fewer mockups at a time.');
            } else {
                alert('Export failed - ' + raw);
            }
        } finally {
            goBtn.textContent = 'Export';
            goBtn.disabled = false;
            _hideExportStatus();
            if (exportSucceeded) {
                _showExportSuccess(successKind);
            } else if (popover.hidden) {
                popover.hidden = false;
                refreshExportPopover({ resetProSkip: false });
            }
        }
    }

    async function _startAuthorizedExport(indices) {
        _setExportProgress('Preparing export…');
        const plan = await _authorizeExport();
        if (!plan) {
            _hideExportStatus();
            return;
        }
        await _runExportWithIndices(indices);
    }

    function _resolveExportIndicesFromGoClick() {
        const scopeBtn = document.querySelector('#exportScopeToggle .seg-active');
        const scope    = scopeBtn ? scopeBtn.dataset.val : 'selected';

        let indices;
        if(scope === 'all'){
            indices = canvasData.map((_, i) => i);
        } else {
            if(!activeIndices.length){
                alert('Select at least one mockup before exporting.');
                return null;
            }
            indices = [...activeIndices];
        }
        return typeof _resolveExportIndices === 'function'
            ? _resolveExportIndices(indices)
            : indices;
    }

    if (goBtn) {
        goBtn.addEventListener('click', async () => {
            if(clipEditMode){ showClipModeNotice(); return; }
            if (typeof window._markExportAttempted === 'function') window._markExportAttempted();

            if (window.Clerk && !window.Clerk.user) {
                sessionStorage.setItem('ms_redirect_after_auth', 'export');
                await _autosaveDB.set('session', buildFullSnapshot()).catch(()=>{});
                try { window.Clerk.redirectToSignIn({ forceRedirectUrl: window.location.href }); } catch(e) { alert('Sign-in is temporarily unavailable - please refresh the page.'); }
                return;
            }

            if(_userPlan === 'free'){
                if(typeof openPlansModal === 'function') openPlansModal();
                return;
            }

            let indices = _resolveExportIndicesFromGoClick();
            if (!indices) return;

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
                                onSkip: async () => {
                                    await _startAuthorizedExport(indices.filter(i => !blockedSet.has(i)));
                                }
                            });
                        }
                        return;
                    }
                }
            }

            await _startAuthorizedExport(indices);
        });
    }

    var exportPatternBtn = document.getElementById('exportPatternBtn');
    if (exportPatternBtn) {
        exportPatternBtn.addEventListener('click', async () => {
            if (!activeIndices.length) return;
            const data = canvasData[activeIndices[0]];
            if (!data) return;

            if (window.Clerk && !window.Clerk.user) {
                sessionStorage.setItem('ms_redirect_after_auth', 'export');
                try { await _autosaveDB.set('session', buildFullSnapshot()).catch(() => {}); } catch (e) { console.error('[ExportPattern→SignIn] snapshot failed:', e); }
                try { window.Clerk.redirectToSignIn({ forceRedirectUrl: window.location.href }); } catch (e) { alert('Sign-in is temporarily unavailable - please refresh the page.'); }
                return;
            }

            if (_userPlan !== 'pro') {
                if (typeof openPlansModal === 'function') {
                    openPlansModal({
                        context: 'Export Pattern PNG requires Pro - pattern is a PRO effect.',
                    });
                }
                return;
            }

            if (!data.patternMode || !data.patternFabricObj) {
                alert('Turn on Pattern mode with a tiled design before exporting.');
                return;
            }

            const verifiedPlan = await _authorizeExport();
            if (!verifiedPlan) return;
            if (verifiedPlan !== 'pro') {
                if (typeof openPlansModal === 'function') {
                    openPlansModal({
                        context: 'Export Pattern PNG requires Pro - pattern is a PRO effect.',
                    });
                }
                return;
            }

            _exportPatternPNG(data);
        });
    }
})();

// ── Export canvas text ────────────────────────────────────────────────────────
document.getElementById('exportTextBtn').addEventListener('click', async () => {
    if(window.Clerk && !window.Clerk.user){
        sessionStorage.setItem('ms_redirect_after_auth', 'export');
        try { await _autosaveDB.set('session', buildFullSnapshot()).catch(()=>{}); } catch(e) { console.error('[Export→SignIn] snapshot failed:', e); }
        try { window.Clerk.redirectToSignIn({ forceRedirectUrl: window.location.href }); } catch(e) { alert('Sign-in is temporarily unavailable - please refresh the page.'); }
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
