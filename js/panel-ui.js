// Collapsible left-panel sections (open by default). Cosmetic only - no edit logic changes.

(function () {
    function _sectionBlocked(section) {
        var block = section.getAttribute('data-block-collapse');
        if (block === 'clip' && typeof clipEditMode !== 'undefined' && clipEditMode) return true;
        if (block === 'paint') {
            if (typeof designEraserMode !== 'undefined' && designEraserMode) return true;
            if (typeof colorLayerMode !== 'undefined' && colorLayerMode) return true;
        }
        return false;
    }

    function _toggleSection(section, title) {
        if (_sectionBlocked(section)) return;
        section.classList.toggle('collapsed');
        var expanded = !section.classList.contains('collapsed');
        title.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    document.addEventListener('DOMContentLoaded', function () {
        document.querySelectorAll('#contextPanelBody .cp-section').forEach(function (section) {
            var title = section.querySelector('.cp-section-title--toggle');
            if (!title) return;

            function onActivate(e) {
                if (e.target.closest('.cp-toggle-switch') || e.target.closest('input') || e.target.closest('button')) {
                    return;
                }
                _toggleSection(section, title);
            }

            title.addEventListener('click', onActivate);
            title.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onActivate(e);
                }
            });
        });
    });
})();
