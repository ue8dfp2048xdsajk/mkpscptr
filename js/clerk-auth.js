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
            window.Clerk.openSignIn();
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

        var dropdown = document.createElement('div');
        dropdown.className = 'ms-avatar-dropdown';
        dropdown.innerHTML =
            '<div class="ms-avatar-email">' + email + '</div>' +
            '<div class="ms-avatar-plan">Plan: <strong>' + planLabel + '</strong></div>' +
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

    if (window.__clerkSdkReady) {
        _clerkAuthMain();
    } else {
        window.__clerkInit = _clerkAuthMain;
    }

})();
