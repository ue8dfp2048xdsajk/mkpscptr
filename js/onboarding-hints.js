// Onboarding banners, coach marks, shortcuts modal, large-session perf hint.
// Non-blocking: tip is a thin header bar only (no modal / no workflow gate).

(function () {
    var LS_BANNER = 'ms_banner_dismissed';
    var LS_COACH = 'ms_coach_sidebar_seen';
    var LS_BATCH_HINT = 'ms_batch_hint_dismissed';
    // Perf tip storage (fail-open if storage throws):
    // - ms_perf_hint_opt_out: never show again (Don't show again)
    // - ms_perf_hint_session_dismissed: hide for this tab (X)
    // - ms_perf_hint_select_seen: selection trigger already used once
    // - ms_perf_hint_dismissed: legacy forever-dismiss -> migrated to opt-out
    var LS_PERF_OPT_OUT = 'ms_perf_hint_opt_out';
    var LS_PERF_LEGACY = 'ms_perf_hint_dismissed';
    var LS_PERF_SELECT_SEEN = 'ms_perf_hint_select_seen';
    var SS_PERF_SESSION = 'ms_perf_hint_session_dismissed';
    // Keeps the one-shot selection tip visible until dismiss or deselect.
    var _selectTipActive = false;

    function _isTypingTarget(el) {
        if (!el) return false;
        var tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    }

    function _lsGet(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    }

    function _lsSet(key, val) {
        try { localStorage.setItem(key, val); } catch (_) {}
    }

    function _ssGet(key) {
        try { return sessionStorage.getItem(key); } catch (_) { return null; }
    }

    function _ssSet(key, val) {
        try { sessionStorage.setItem(key, val); } catch (_) {}
    }

    function _migratePerfOptOut() {
        if (_lsGet(LS_PERF_OPT_OUT)) return;
        if (_lsGet(LS_PERF_LEGACY)) {
            _lsSet(LS_PERF_OPT_OUT, '1');
        }
    }

    function _perfOptedOut() {
        _migratePerfOptOut();
        return !!_lsGet(LS_PERF_OPT_OUT);
    }

    window._onGridReady = function (mockupCount, bgCount, designCount) {
        if (!mockupCount || !bgCount || !designCount) return;
        _updateWorkflowBanner();
        if (typeof window._updatePerfSessionPrompt === 'function') {
            window._updatePerfSessionPrompt();
        }
    };

    function _updateWorkflowBanner() {
        var banner = document.getElementById('workflowBanner');
        if (!banner) return;
        if (_lsGet(LS_BANNER)) {
            banner.hidden = true;
            return;
        }
        if (_lsGet('ms_export_attempted')) {
            banner.hidden = true;
            return;
        }
        var hasMockups = typeof canvasData !== 'undefined' && canvasData.length > 0;
        banner.hidden = !hasMockups;
    }

    function _markExportAttempted() {
        _lsSet('ms_export_attempted', '1');
        _updateWorkflowBanner();
    }

    window._markExportAttempted = _markExportAttempted;

    function _showComboToast(msg) {
        var el = document.getElementById('comboToast');
        if (!el) return;
        el.textContent = msg;
        el.hidden = false;
        clearTimeout(el._hideTimer);
        el._hideTimer = setTimeout(function () { el.hidden = true; }, 5000);
    }

    // After every successful export (hook name kept for export-ui.js).
    // Lightweight toast only - runs after export finishes, not during edit.
    window._onFirstExportSuccess = function () {
        _showComboToast(
            'Nice - your mockups are ready for your store listings. Tip: select multiple mockups to edit them all at once.'
        );
    };

    window._showSidebarCoachIfNeeded = function () {
        if (_lsGet(LS_COACH)) return;
        var coach = document.getElementById('sidebarCoach');
        if (coach) coach.hidden = false;
    };

    window._dismissSidebarCoach = function () {
        _lsSet(LS_COACH, '1');
        var coach = document.getElementById('sidebarCoach');
        if (coach) coach.hidden = true;
    };

    // Large grid (>=201): re-show every time unless session/opt-out.
    // Large selection (>=31): once ever, then never for selection-only.
    window._updatePerfSessionPrompt = function () {
        var el = document.getElementById('perfSessionPrompt');
        if (!el) return;

        if (_perfOptedOut() || _ssGet(SS_PERF_SESSION)) {
            el.hidden = true;
            _selectTipActive = false;
            return;
        }

        var manyWindows = typeof canvasData !== 'undefined' && canvasData.length >= 201;
        var manySelected = typeof activeIndices !== 'undefined' && activeIndices.length >= 31;

        if (manyWindows) {
            el.hidden = false;
            return;
        }

        if (manySelected) {
            if (!_lsGet(LS_PERF_SELECT_SEEN)) {
                _lsSet(LS_PERF_SELECT_SEEN, '1');
                _selectTipActive = true;
            }
            if (_selectTipActive) {
                el.hidden = false;
                return;
            }
            el.hidden = true;
            return;
        }

        _selectTipActive = false;
        el.hidden = true;
    };

    function _hidePerfPrompt() {
        _selectTipActive = false;
        var prompt = document.getElementById('perfSessionPrompt');
        if (prompt) prompt.hidden = true;
    }

    function _setHelpTab(tab) {
        var shortcutsBtn = document.getElementById('shortcutsTabBtn');
        var instructionsBtn = document.getElementById('instructionsTabBtn');
        var shortcutsPanel = document.getElementById('shortcutsPanel');
        var instructionsPanel = document.getElementById('instructionsPanel');
        if (!shortcutsBtn || !instructionsBtn || !shortcutsPanel || !instructionsPanel) return;
        var showInstructions = tab === 'instructions';
        shortcutsBtn.classList.toggle('shortcuts-tab--active', !showInstructions);
        instructionsBtn.classList.toggle('shortcuts-tab--active', showInstructions);
        shortcutsBtn.setAttribute('aria-selected', showInstructions ? 'false' : 'true');
        instructionsBtn.setAttribute('aria-selected', showInstructions ? 'true' : 'false');
        shortcutsPanel.hidden = showInstructions;
        instructionsPanel.hidden = !showInstructions;
    }

    function _openShortcuts() {
        var modal = document.getElementById('shortcutsModal');
        if (!modal) return;
        _setHelpTab('shortcuts');
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
    }

    function _closeShortcuts() {
        var modal = document.getElementById('shortcutsModal');
        if (!modal) return;
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
    }

    window.openShortcutsModal = _openShortcuts;

    document.addEventListener('DOMContentLoaded', function () {
        var bannerClose = document.getElementById('workflowBannerClose');
        if (bannerClose) {
            bannerClose.addEventListener('click', function () {
                _lsSet(LS_BANNER, '1');
                var banner = document.getElementById('workflowBanner');
                if (banner) banner.hidden = true;
            });
        }

        var coachClose = document.getElementById('sidebarCoachClose');
        if (coachClose) {
            coachClose.addEventListener('click', function () {
                window._dismissSidebarCoach();
            });
        }

        var shortcutsBtn = document.getElementById('shortcutsHelpBtn');
        if (shortcutsBtn) shortcutsBtn.addEventListener('click', _openShortcuts);

        var shortcutsTopBtn = document.getElementById('shortcutsTopBtn');
        if (shortcutsTopBtn) shortcutsTopBtn.addEventListener('click', _openShortcuts);

        var batchHintClose = document.getElementById('batchEditHintClose');
        if (batchHintClose) {
            batchHintClose.addEventListener('click', function () {
                _lsSet(LS_BATCH_HINT, '1');
                var hint = document.getElementById('batchEditHint');
                if (hint) hint.hidden = true;
            });
        }

        // X = hide for this tab only (can return next session on 201+).
        var perfClose = document.getElementById('perfSessionPromptClose');
        if (perfClose) {
            perfClose.addEventListener('click', function () {
                _ssSet(SS_PERF_SESSION, '1');
                _hidePerfPrompt();
            });
        }

        // Explicit permanent silence.
        var perfOptOut = document.getElementById('perfSessionPromptOptOut');
        if (perfOptOut) {
            perfOptOut.addEventListener('click', function () {
                _lsSet(LS_PERF_OPT_OUT, '1');
                _hidePerfPrompt();
            });
        }

        var shortcutsClose = document.getElementById('shortcutsModalClose');
        if (shortcutsClose) shortcutsClose.addEventListener('click', _closeShortcuts);

        var shortcutsModal = document.getElementById('shortcutsModal');
        if (shortcutsModal) {
            shortcutsModal.addEventListener('click', function (e) {
                if (e.target === shortcutsModal) _closeShortcuts();
            });
        }

        document.querySelectorAll('[data-help-tab]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                _setHelpTab(btn.getAttribute('data-help-tab'));
            });
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                _closeShortcuts();
                return;
            }
            if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !_isTypingTarget(document.activeElement)) {
                e.preventDefault();
                var modal = document.getElementById('shortcutsModal');
                if (modal && modal.hidden) _openShortcuts();
                else _closeShortcuts();
            }
        });

        var exportBtn = document.getElementById('exportBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', function () {
                _markExportAttempted();
            });
        }

        _updateWorkflowBanner();
        window._updatePerfSessionPrompt();
    });
})();
