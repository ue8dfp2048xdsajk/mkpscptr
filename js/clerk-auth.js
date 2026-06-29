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
    }

    function _onClerkSignedOut() {
        window._userPlan = 'free';
        sessionStorage.removeItem('ms_upgrade_toast_shown');
        localStorage.removeItem('ms_payment_pending');
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
            '<button id="clerkSignOutBtn">Log Out</button>';

        avatar.addEventListener('click', function (e) {
            e.stopPropagation();
            dropdown.classList.toggle('open');
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

        var pendingUserId = storedValue !== '1' ? storedValue : null;
        if (pendingUserId && pendingUserId !== window.Clerk.user.id) {
            localStorage.removeItem(PAYMENT_PENDING_KEY);
            return;
        }

        _showActivatingBanner();

        var planBefore = (window.Clerk.user.publicMetadata && window.Clerk.user.publicMetadata.plan) || 'free';
        var maxAttempts = 22;
        var attemptDelay = 2000;
        var attempt = 0;

        function tryReload() {
            attempt++;
            var session = window.Clerk.session;
            if (!session) return;

            session.reload().then(function () {
                var freshUser = window.Clerk.user;
                if (!freshUser) return;

                var newPlan = (freshUser.publicMetadata && freshUser.publicMetadata.plan) || 'free';
                var planUpgraded = newPlan !== planBefore;
                var alreadyUpgraded = newPlan !== 'free';

                if (planUpgraded || alreadyUpgraded) {
                    localStorage.removeItem(PAYMENT_PENDING_KEY);
                    _dismissActivatingBanner();
                    _onClerkSignedIn(freshUser);
                    _showUpgradeToast(newPlan);
                } else if (attempt >= maxAttempts) {
                    _dismissActivatingBanner();
                    _showPaymentPendingToast();
                } else {
                    setTimeout(tryReload, attemptDelay);
                }
            }).catch(function () {
                if (attempt < maxAttempts) {
                    setTimeout(tryReload, attemptDelay);
                } else {
                    _dismissActivatingBanner();
                    _showPaymentPendingToast();
                }
            });
        }

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
