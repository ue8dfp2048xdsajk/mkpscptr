// Onboarding banners, coach marks, shortcuts modal, large-session perf hint.
// Non-blocking: overlays use pointer-events:none except dismiss buttons.

(function () {
    var LS_BANNER = 'ms_banner_dismissed';
    var LS_COACH = 'ms_coach_sidebar_seen';
    var LS_FIRST_EXPORT = 'ms_first_export_done';
    var LS_BATCH_HINT = 'ms_batch_hint_dismissed';
    var LS_PERF_HINT = 'ms_perf_hint_dismissed';

    function _isTypingTarget(el) {
        if (!el) return false;
        var tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
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
        if (localStorage.getItem(LS_BANNER)) {
            banner.hidden = true;
            return;
        }
        if (localStorage.getItem('ms_export_attempted')) {
            banner.hidden = true;
            return;
        }
        var hasMockups = typeof canvasData !== 'undefined' && canvasData.length > 0;
        banner.hidden = !hasMockups;
    }

    function _markExportAttempted() {
        try { localStorage.setItem('ms_export_attempted', '1'); } catch (_) {}
        _updateWorkflowBanner();
    }

    window._markExportAttempted = _markExportAttempted;

    // Kept as a no-op hook for export-ui.js (marks first export done; no toast).
    window._onFirstExportSuccess = function () {
        if (localStorage.getItem(LS_FIRST_EXPORT)) return;
        try { localStorage.setItem(LS_FIRST_EXPORT, '1'); } catch (_) {}
    };

    window._showSidebarCoachIfNeeded = function () {
        if (localStorage.getItem(LS_COACH)) return;
        var coach = document.getElementById('sidebarCoach');
        if (coach) coach.hidden = false;
    };

    window._dismissSidebarCoach = function () {
        try { localStorage.setItem(LS_COACH, '1'); } catch (_) {}
        var coach = document.getElementById('sidebarCoach');
        if (coach) coach.hidden = true;
    };

    window._updatePerfSessionPrompt = function () {
        var el = document.getElementById('perfSessionPrompt');
        if (!el) return;
        if (localStorage.getItem(LS_PERF_HINT)) {
            el.hidden = true;
            return;
        }
        var manyWindows = typeof canvasData !== 'undefined' && canvasData.length >= 201;
        var manySelected = typeof activeIndices !== 'undefined' && activeIndices.length >= 31;
        el.hidden = !(manyWindows || manySelected);
    };

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
                try { localStorage.setItem(LS_BANNER, '1'); } catch (_) {}
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
                try { localStorage.setItem(LS_BATCH_HINT, '1'); } catch (_) {}
                var hint = document.getElementById('batchEditHint');
                if (hint) hint.hidden = true;
            });
        }

        var perfClose = document.getElementById('perfSessionPromptClose');
        if (perfClose) {
            perfClose.addEventListener('click', function () {
                try { localStorage.setItem(LS_PERF_HINT, '1'); } catch (_) {}
                var prompt = document.getElementById('perfSessionPrompt');
                if (prompt) prompt.hidden = true;
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
