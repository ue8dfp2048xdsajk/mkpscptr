// Onboarding banners, coach marks, combo toast, shortcuts modal.
// Non-blocking: overlays use pointer-events:none except dismiss buttons.

(function () {
    var LS_BANNER = 'ms_banner_dismissed';
    var LS_COACH = 'ms_coach_sidebar_seen';
    var LS_FIRST_EXPORT = 'ms_first_export_done';
    var _lastComboKey = '';

    function _isTypingTarget(el) {
        if (!el) return false;
        var tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    }

    function _showComboToast(msg) {
        var el = document.getElementById('comboToast');
        if (!el) return;
        el.textContent = msg;
        el.hidden = false;
        clearTimeout(el._hideTimer);
        el._hideTimer = setTimeout(function () { el.hidden = true; }, 5000);
    }

    window._onGridReady = function (mockupCount, bgCount, designCount) {
        if (!mockupCount || !bgCount || !designCount) return;
        var key = bgCount + 'x' + designCount + '=' + mockupCount;
        if (key === _lastComboKey) return;
        _lastComboKey = key;
        var pluralM = mockupCount !== 1 ? 's' : '';
        var pluralBg = bgCount !== 1 ? 's' : '';
        var pluralDs = designCount !== 1 ? 's' : '';
        _showComboToast(
            mockupCount + ' mockup' + pluralM + ' ready — ' +
            bgCount + ' mockup photo' + pluralBg + ' × ' +
            designCount + ' design' + pluralDs
        );
        _updateWorkflowBanner();
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

    window._onFirstExportSuccess = function () {
        if (localStorage.getItem(LS_FIRST_EXPORT)) return;
        try { localStorage.setItem(LS_FIRST_EXPORT, '1'); } catch (_) {}
        _showComboToast('Nice — your mockups are ready for your store listings. Tip: select multiple mockups to edit them all at once.');
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

    function _openShortcuts() {
        var modal = document.getElementById('shortcutsModal');
        if (!modal) return;
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

        var shortcutsClose = document.getElementById('shortcutsModalClose');
        if (shortcutsClose) shortcutsClose.addEventListener('click', _closeShortcuts);

        var shortcutsModal = document.getElementById('shortcutsModal');
        if (shortcutsModal) {
            shortcutsModal.addEventListener('click', function (e) {
                if (e.target === shortcutsModal) _closeShortcuts();
            });
        }

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
    });
})();
