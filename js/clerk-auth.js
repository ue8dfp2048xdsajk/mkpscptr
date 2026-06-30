(function () {

    async function _clerkAuthMain() {
        if (!window.Clerk) return;

        await window.Clerk.load();

        const user = window.Clerk.user;
        if (user) {
            _onClerkSignedIn(user);
        } else {
            _renderSignInButton();
        }

        window.Clerk.addListener(function ({ user }) {
            if (user) {
                _onClerkSignedIn(user);
                _handlePaymentSuccess();
            } else {
                _onClerkSignedOut();
            }
        });

        _handleAuthRedirect();
        _handlePaymentSuccess();
    }

    function _onClerkSignedIn(user) {
        window._userPlan = (user.publicMetadata && user.publicMetadata.plan) || 'free';
        if (typeof _refreshAllProStarBadges === 'function') _refreshAllProStarBadges();
        _renderUserAvatar(user);
        if (window.posthog) {
            posthog.identify(user.id, {
                email: user.primaryEmailAddress && user.primaryEmailAddress.emailAddress,
                plan: window._userPlan
            });
        }
        _claimAnonProject();
    }

    function _claimAnonProject() {
        var uuid = localStorage.getItem('ms_project_uuid');
        if (!uuid) return;
        var session = window.Clerk && window.Clerk.session;
        if (!session) return;
        session.getToken().then(function (token) {
            if (!token) return;
            fetch('/api/projects/claim', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token,
                },
                body: JSON.stringify({ uuid: uuid }),
            }).catch(function () {});
        }).catch(function () {});
    }

    function _onClerkSignedOut() {
        window._userPlan = 'free';
        sessionStorage.removeItem('ms_upgrade_toast_shown');
        localStorage.removeItem('ms_payment_pending');
        _cleanupPoll();
        _dismissActivatingBanner();
        if (typeof _refreshAllProStarBadges === 'function') _refreshAllProStarBadges();
        _renderSignInButton();
    }

    function _renderSignInButton() {
        var container = document.getElementById('clerkAuthContainer');
        if (!container) return;
        container.innerHTML = '';
        var btn = document.createElement('button');
        btn.id = 'clerkSignInBtn';
        btn.textContent = 'Sign In';
        btn.addEventListener('click', function () {
            sessionStorage.setItem('ms_redirect_after_auth', 'home');
            _autosaveDB.set('session', buildFullSnapshot()).catch(()=>{}).then(() => window.Clerk.openSignIn());
        });
        container.appendChild(btn);
    }

    function _renderUserAvatar(user) {
        var container = document.getElementById('clerkAuthContainer');
        if (!container) return;
        container.innerHTML = '';

        var wrap = document.createElement('div');
        wrap.className = 'ms-user-wrap';

        var avatar = document.createElement('img');
        avatar.className = 'ms-avatar';
        avatar.src = user.imageUrl || '';
        avatar.alt = user.firstName || 'Account';
        avatar.title = (user.primaryEmailAddress && user.primaryEmailAddress.emailAddress) || '';

        var email = (user.primaryEmailAddress && user.primaryEmailAddress.emailAddress) || '';
        var planLabel = window._userPlan.charAt(0).toUpperCase() + window._userPlan.slice(1);
        var showUpgradeBtn = window._userPlan === 'free' || window._userPlan === 'starter';

        var dropdown = document.createElement('div');
        dropdown.className = 'ms-avatar-dropdown';

        dropdown.innerHTML =
            '<div class="ms-avatar-email">' + email + '</div>' +
            '<div class="ms-avatar-plan">Plan: <strong>' + planLabel + '</strong></div>' +
            (showUpgradeBtn ? '<button class="ms-avatar-upgrade-btn" id="clerkUpgradeBtn">⚡ Upgrade plan</button>' : '') +
            '<div class="ms-projects-section">' +
              '<div class="ms-projects-label">My Projects</div>' +
              '<div class="ms-projects-list" id="msProjectsList"><span class="ms-projects-loading">Loading…</span></div>' +
              '<div class="ms-open-uuid-row">' +
                '<input class="ms-open-uuid-input" id="msOpenUuidInput" type="text" placeholder="Open by UUID…" autocomplete="off" spellcheck="false"/>' +
                '<button class="ms-open-uuid-btn" id="msOpenUuidBtn">Open</button>' +
              '</div>' +
            '</div>' +
            '<button id="clerkSignOutBtn">Log Out</button>';

        var _projectsLoaded = false;

        function _loadProjects() {
            if (_projectsLoaded) return;
            _projectsLoaded = true;
            var list = dropdown.querySelector('#msProjectsList');
            var session = window.Clerk && window.Clerk.session;
            var tokenPromise = session ? session.getToken() : Promise.resolve(null);
            tokenPromise.catch(function () { return null; }).then(function (token) {
                return fetch('/api/projects/list', {
                    headers: token ? { 'Authorization': 'Bearer ' + token } : {}
                });
            })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (!data.ok || !data.projects || !data.projects.length) {
                        list.innerHTML = '<span class="ms-projects-empty">No saved projects yet.</span>';
                        return;
                    }
                    list.innerHTML = '';
                    data.projects.forEach(function (p) {
                        var date = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                        var row = document.createElement('div');
                        row.className = 'ms-project-row';
                        row.innerHTML =
                            '<span class="ms-project-date">' + date + '</span>' +
                            '<button class="ms-project-open-btn" data-uuid="' + p.uuid + '">Open</button>';
                        row.querySelector('.ms-project-open-btn').addEventListener('click', function () {
                            dropdown.classList.remove('open');
                            if (typeof _loadProjectByUuid === 'function') _loadProjectByUuid(p.uuid);
                        });
                        list.appendChild(row);
                    });
                })
                .catch(function () {
                    list.innerHTML = '<span class="ms-projects-empty">Could not load projects.</span>';
                });
        }

        avatar.addEventListener('click', function (e) {
            e.stopPropagation();
            var opening = !dropdown.classList.contains('open');
            dropdown.classList.toggle('open');
            if (opening) _loadProjects();
        });

        document.addEventListener('click', function () {
            dropdown.classList.remove('open');
        });

        wrap.appendChild(avatar);
        wrap.appendChild(dropdown);
        container.appendChild(wrap);

        var upgradeBtn = dropdown.querySelector('#clerkUpgradeBtn');
        if (upgradeBtn) {
            upgradeBtn.addEventListener('click', function () {
                dropdown.classList.remove('open');
                if (typeof openPlansModal === 'function') openPlansModal();
            });
        }

        var openUuidBtn = dropdown.querySelector('#msOpenUuidBtn');
        var openUuidInput = dropdown.querySelector('#msOpenUuidInput');
        if (openUuidBtn && openUuidInput) {
            openUuidBtn.addEventListener('click', function () {
                var uuid = openUuidInput.value.trim();
                if (!uuid) return;
                dropdown.classList.remove('open');
                if (typeof _loadProjectByUuid === 'function') _loadProjectByUuid(uuid);
            });
            openUuidInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') openUuidBtn.click();
            });
            openUuidInput.addEventListener('click', function (e) { e.stopPropagation(); });
        }

        var signOutBtn = dropdown.querySelector('#clerkSignOutBtn');
        if (signOutBtn) {
            signOutBtn.addEventListener('click', function () {
                window.Clerk.signOut();
            });
        }
    }

    function _handleAuthRedirect() {
        var redirect = sessionStorage.getItem('ms_redirect_after_auth');
        if (!redirect) return;
        sessionStorage.removeItem('ms_redirect_after_auth');
        if (redirect === 'export' && window.Clerk && window.Clerk.user) {
            setTimeout(function () {
                var btn = document.getElementById('exportBtn');
                if (btn) btn.click();
            }, 400);
        }
    }

    var PAYMENT_PENDING_KEY = 'ms_payment_pending';
    var _paymentPollingActive = false;
    var _pollTimerId = null;
    var _pollStartTime = null;
    var _pollDeadlineMs = 90000;
    var _pollVisibilityHandler = null;

    function _cleanupPoll() {
        _paymentPollingActive = false;
        if (_pollTimerId) { clearTimeout(_pollTimerId); _pollTimerId = null; }
        if (_pollVisibilityHandler) {
            document.removeEventListener('visibilitychange', _pollVisibilityHandler);
            _pollVisibilityHandler = null;
        }
    }

    function _showActivatingBanner() {
        var existing = document.getElementById('msActivatingBanner');
        if (existing) return existing;

        var banner = document.createElement('div');
        banner.id = 'msActivatingBanner';
        banner.className = 'ms-activating-banner';

        var spinner = document.createElement('span');
        spinner.className = 'ms-activating-spinner';
        banner.appendChild(spinner);

        var text = document.createElement('span');
        text.textContent = 'Confirming your upgrade\u2026';
        banner.appendChild(text);

        document.body.appendChild(banner);
        setTimeout(function () { banner.classList.add('ms-activating-banner--visible'); }, 30);
        return banner;
    }

    function _dismissActivatingBanner() {
        var banner = document.getElementById('msActivatingBanner');
        if (!banner) return;
        banner.classList.remove('ms-activating-banner--visible');
        setTimeout(function () { banner.parentNode && banner.parentNode.removeChild(banner); }, 350);
    }

    function _handlePaymentSuccess() {
        if (_paymentPollingActive) return;

        var params = new URLSearchParams(window.location.search);
        var isDirectReturn = params.get('payment') === 'success';

        if (isDirectReturn) {
            var cleanUrl = window.location.pathname +
                (params.toString().replace(/payment=success&?/, '').replace(/&$/, '') ? '?' + params.toString().replace(/payment=success&?/, '').replace(/&$/, '') : '') +
                window.location.hash;
            history.replaceState(null, '', cleanUrl);

            var currentUserId = window.Clerk && window.Clerk.user && window.Clerk.user.id;
            localStorage.setItem(PAYMENT_PENDING_KEY, currentUserId || '1');
        }

        var storedValue = localStorage.getItem(PAYMENT_PENDING_KEY);
        if (!isDirectReturn && !storedValue) return;

        if (!window.Clerk || !window.Clerk.user) return;

        _paymentPollingActive = true;

        var pendingUserId = storedValue !== '1' ? storedValue : null;
        if (pendingUserId && pendingUserId !== window.Clerk.user.id) {
            localStorage.removeItem(PAYMENT_PENDING_KEY);
            _paymentPollingActive = false;
            return;
        }

        _showActivatingBanner();

        var planBefore = (window.Clerk.user.publicMetadata && window.Clerk.user.publicMetadata.plan) || 'free';
        var attemptDelay = 2000;
        _pollStartTime = Date.now();

        function tryReload() {
            if (!_paymentPollingActive) return;

            if (!window.Clerk || !window.Clerk.user) {
                _cleanupPoll();
                _dismissActivatingBanner();
                return;
            }

            if (Date.now() - _pollStartTime >= _pollDeadlineMs) {
                _cleanupPoll();
                _dismissActivatingBanner();
                _showPaymentPendingToast();
                return;
            }

            if (document.visibilityState === 'hidden') {
                return;
            }

            var session = window.Clerk.session;
            if (!session) {
                _pollTimerId = setTimeout(tryReload, attemptDelay);
                return;
            }

            session.reload().then(function () {
                var freshUser = window.Clerk.user;
                if (!freshUser) {
                    _cleanupPoll();
                    _dismissActivatingBanner();
                    return;
                }

                var newPlan = (freshUser.publicMetadata && freshUser.publicMetadata.plan) || 'free';
                var planUpgraded = newPlan !== planBefore;
                var alreadyUpgraded = newPlan !== 'free';

                if (planUpgraded || alreadyUpgraded) {
                    localStorage.removeItem(PAYMENT_PENDING_KEY);
                    _cleanupPoll();
                    _dismissActivatingBanner();
                    _onClerkSignedIn(freshUser);
                    _showUpgradeToast(newPlan);
                } else if (Date.now() - _pollStartTime >= _pollDeadlineMs) {
                    _cleanupPoll();
                    _dismissActivatingBanner();
                    _showPaymentPendingToast();
                } else {
                    _pollTimerId = setTimeout(tryReload, attemptDelay);
                }
            }).catch(function () {
                if (Date.now() - _pollStartTime < _pollDeadlineMs) {
                    _pollTimerId = setTimeout(tryReload, attemptDelay);
                } else {
                    _cleanupPoll();
                    _dismissActivatingBanner();
                    _showPaymentPendingToast();
                }
            });
        }

        _pollVisibilityHandler = function () {
            if (document.visibilityState === 'visible' && _paymentPollingActive) {
                if (Date.now() - _pollStartTime >= _pollDeadlineMs) {
                    _cleanupPoll();
                    _dismissActivatingBanner();
                    _showPaymentPendingToast();
                    return;
                }
                tryReload();
            }
        };
        document.addEventListener('visibilitychange', _pollVisibilityHandler);

        tryReload();
    }

    function _showPaymentPendingToast() {
        var toast = document.createElement('div');
        toast.className = 'ms-upgrade-toast ms-upgrade-toast--pending';
        toast.textContent = 'Payment received — still activating your plan. Refresh in a moment if nothing changes.';
        document.body.appendChild(toast);

        setTimeout(function () { toast.classList.add('ms-upgrade-toast--visible'); }, 50);
        setTimeout(function () {
            toast.classList.remove('ms-upgrade-toast--visible');
            setTimeout(function () { toast.parentNode && toast.parentNode.removeChild(toast); }, 400);
        }, 8000);
    }

    function _showUpgradeToast(plan) {
        var storageKey = 'ms_upgrade_toast_shown';
        if (sessionStorage.getItem(storageKey)) return;
        sessionStorage.setItem(storageKey, '1');

        var label = plan.charAt(0).toUpperCase() + plan.slice(1);
        var toast = document.createElement('div');
        toast.className = 'ms-upgrade-toast';
        toast.textContent = 'You\'re now on the ' + label + ' plan — enjoy your new features!';
        document.body.appendChild(toast);

        setTimeout(function () { toast.classList.add('ms-upgrade-toast--visible'); }, 50);
        setTimeout(function () {
            toast.classList.remove('ms-upgrade-toast--visible');
            setTimeout(function () { toast.parentNode && toast.parentNode.removeChild(toast); }, 400);
        }, 5000);
    }

    if (window.__clerkSdkReady) {
        _clerkAuthMain();
    } else {
        window.__clerkInit = _clerkAuthMain;
    }

})();
