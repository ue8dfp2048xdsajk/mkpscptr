(function () {

    var _activeSession = null;

    window._clerkGetToken = function () {
        var session = _activeSession || (window.Clerk && window.Clerk.session);
        if (!session) return Promise.resolve(null);
        return session.getToken().catch(function () { return null; });
    };

    async function _clerkAuthMain() {
        if (!window.Clerk) return;

        await window.Clerk.load();

        _activeSession = window.Clerk.session || null;

        const user = window.Clerk.user;
        if (user) {
            _onClerkSignedIn(user);
        } else {
            _renderSignInButton();
        }

        window.Clerk.addListener(function ({ user, session }) {
            _activeSession = session || null;
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
        window._subscriptionEndsAt = (user.publicMetadata && user.publicMetadata.subscriptionEndsAt) || null;
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
        window._clerkGetToken().then(function (token) {
            if (!token) return;
            fetch('/api/projects/claim', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token,
                },
                body: JSON.stringify({ uuid: uuid }),
            }).catch(function () {});
        });
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

        var plan = window._userPlan || 'free';
        var projectLimitHint =
            plan === 'pro'     ? '50 projects · backgrounds compressed on save · ~40 unique images per project' :
            plan === 'starter' ? '1 project · backgrounds compressed · ~40 unique images' :
                                 'Cloud save requires a paid plan';

        var cancelLine = '';
        if (window._subscriptionEndsAt && window._userPlan !== 'free') {
            var endsDate = new Date(window._subscriptionEndsAt * 1000).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'short', year: 'numeric'
            });
            cancelLine = '<div class="ms-avatar-cancels">Cancels ' + endsDate + '</div>';
        }

        dropdown.innerHTML =
            '<div class="ms-avatar-email">' + email + '</div>' +
            '<div class="ms-avatar-plan">Plan: <strong>' + planLabel + '</strong></div>' +
            cancelLine +
            (showUpgradeBtn ? '<button class="ms-avatar-upgrade-btn" id="clerkUpgradeBtn">⚡ Upgrade plan</button>' : '') +
            (!showUpgradeBtn ? '<button class="ms-avatar-billing-btn" id="clerkBillingBtn">Manage Billing</button>' : '') +
            '<div class="ms-invoice-panel" id="msInvoicePanel"><span class="ms-invoice-loading">Loading invoices…</span></div>' +
            '<button class="ms-avatar-settings-btn" id="clerkSettingsBtn">⚙ Settings</button>' +
            '<div class="ms-projects-section">' +
              '<div class="ms-projects-label">My Projects</div>' +
              '<div class="ms-projects-limit">' + projectLimitHint + '</div>' +
              '<div class="ms-projects-list" id="msProjectsList"><span class="ms-projects-loading">Loading…</span></div>' +
            '</div>' +
            '<button id="clerkSignOutBtn">Log Out</button>';

        function _apiWithToken(url, opts) {
            return window._clerkGetToken().then(function (token) {
                var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
                if (token) headers['Authorization'] = 'Bearer ' + token;
                return fetch(url, Object.assign({}, opts, { headers: headers }));
            });
        }

        function _deleteProject(uuid) {
            _apiWithToken('/api/projects/' + uuid, { method: 'DELETE' })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    if (d.ok) {
                        if (localStorage.getItem('ms_project_uuid') === uuid) {
                            localStorage.removeItem('ms_project_uuid');
                        }
                        _loadProjects();
                    }
                })
                .catch(function () {});
        }

        function _renameProject(uuid, newName) {
            _apiWithToken('/api/projects/' + uuid, {
                method: 'PATCH',
                body: JSON.stringify({ name: newName })
            })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    if (d.ok) {
                        if (localStorage.getItem('ms_project_uuid') === uuid) {
                            window._projectName = newName;
                        }
                        _loadProjects();
                    }
                })
                .catch(function () {});
        }

        function _loadProjects() {
            var list = dropdown.querySelector('#msProjectsList');
            if (!list) return;
            list.innerHTML = '<span class="ms-projects-empty">Loading…</span>';
            window._clerkGetToken().then(function (token) {
                return fetch('/api/projects/list', {
                    headers: token ? { 'Authorization': 'Bearer ' + token } : {}
                });
            })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (!data.ok) {
                        list.innerHTML = '<span class="ms-projects-empty">' +
                            (data.error === 'Not authenticated' ? 'Sign in to see projects.' : 'Could not load projects.') +
                            '</span>';
                        return;
                    }
                    if (!data.projects || !data.projects.length) {
                        list.innerHTML = '<span class="ms-projects-empty">No saved projects yet.</span>';
                        return;
                    }
                    list.innerHTML = '';
                    data.projects.forEach(function (p) {
                        var name = p.name || 'Untitled';
                        var date = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

                        var row = document.createElement('div');
                        row.className = 'ms-project-row';

                        var info = document.createElement('div');
                        info.className = 'ms-project-info';

                        var nameSpan = document.createElement('span');
                        nameSpan.className = 'ms-project-name ms-project-name--editable';
                        nameSpan.textContent = name;
                        nameSpan.title = 'Click to rename';

                        var dateSpan = document.createElement('span');
                        dateSpan.className = 'ms-project-date';
                        dateSpan.textContent = date;

                        info.appendChild(nameSpan);
                        info.appendChild(dateSpan);

                        var openBtn = document.createElement('button');
                        openBtn.className = 'ms-project-open-btn';
                        openBtn.textContent = 'Open';

                        var deleteBtn = document.createElement('button');
                        deleteBtn.className = 'ms-project-icon-btn ms-project-delete-btn';
                        deleteBtn.title = 'Delete project';
                        deleteBtn.textContent = '🗑';

                        openBtn.addEventListener('click', function () {
                            dropdown.classList.remove('open');
                            if (typeof _loadProjectByUuid === 'function') _loadProjectByUuid(p.uuid);
                        });

                        nameSpan.addEventListener('click', function (e) {
                            e.stopPropagation();
                            var input = document.createElement('input');
                            input.className = 'ms-project-rename-input';
                            input.value = nameSpan.textContent;
                            info.replaceChild(input, nameSpan);
                            input.focus();
                            input.select();

                            function commitRename() {
                                var newName = input.value.trim() || 'Untitled';
                                nameSpan.textContent = newName;
                                info.replaceChild(nameSpan, input);
                                _renameProject(p.uuid, newName);
                            }
                            input.addEventListener('blur', commitRename);
                            input.addEventListener('keydown', function (ev) {
                                if (ev.key === 'Enter') { ev.preventDefault(); commitRename(); }
                                if (ev.key === 'Escape') {
                                    input.removeEventListener('blur', commitRename);
                                    info.replaceChild(nameSpan, input);
                                }
                            });
                            input.addEventListener('click', function (ev) { ev.stopPropagation(); });
                        });

                        deleteBtn.addEventListener('click', function (e) {
                            e.stopPropagation();
                            if (!confirm('Delete "' + nameSpan.textContent + '"? This cannot be undone.')) return;
                            _deleteProject(p.uuid);
                        });

                        row.appendChild(info);
                        row.appendChild(openBtn);
                        row.appendChild(deleteBtn);
                        list.appendChild(row);
                    });
                })
                .catch(function () {
                    list.innerHTML = '<span class="ms-projects-empty">Could not load projects.</span>';
                });
        }

        window._reloadCloudProjects = _loadProjects;
        window._openCloudProjectsUI = function () {
            dropdown.classList.add('open');
            _loadProjects();
            _loadInvoices();
        };

        function _loadInvoices() {
            var panel = dropdown.querySelector('#msInvoicePanel');
            if (!panel) return;
            window._clerkGetToken().then(function (token) {
                return fetch('/api/billing/invoices', {
                    headers: token ? { 'Authorization': 'Bearer ' + token } : {}
                });
            })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data.ok || !data.invoices || !data.invoices.length) {
                    panel.innerHTML = '<span class="ms-invoice-none">No invoices yet.</span>';
                    return;
                }
                var html = '<div class="ms-invoice-label">Recent Invoices</div>';
                data.invoices.slice(0, 3).forEach(function (inv) {
                    var date = new Date(inv.date * 1000).toLocaleDateString('en-GB', {
                        day: 'numeric', month: 'short', year: 'numeric'
                    });
                    var amount = (inv.amount / 100).toFixed(2);
                    var currency = inv.currency.toUpperCase();
                    html += '<div class="ms-invoice-row">' +
                        '<span class="ms-invoice-date">' + date + '</span>' +
                        '<span class="ms-invoice-amount">' + currency + '\u00a0' + amount + '</span>' +
                        (inv.pdfUrl ? '<a class="ms-invoice-pdf" href="' + inv.pdfUrl + '" target="_blank" rel="noopener">PDF</a>' : '') +
                    '</div>';
                });
                if (data.invoices.length > 3) {
                    html += '<a class="ms-invoice-viewall" href="/settings.html#invoices">View all \u2192</a>';
                }
                panel.innerHTML = html;
            })
            .catch(function () {
                panel.innerHTML = '<span class="ms-invoice-none">Could not load invoices.</span>';
            });
        }

        avatar.addEventListener('click', function (e) {
            e.stopPropagation();
            var opening = !dropdown.classList.contains('open');
            dropdown.classList.toggle('open');
            if (opening) {
                _loadProjects();
                _loadInvoices();
            }
        });

        var _dropdownHovered = false;
        dropdown.addEventListener('mouseenter', function () { _dropdownHovered = true; });
        dropdown.addEventListener('mouseleave', function () { _dropdownHovered = false; });

        document.addEventListener('click', function (e) {
            if (_dropdownHovered) return;
            if (wrap.contains(e.target)) return;
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

        var billingBtn = dropdown.querySelector('#clerkBillingBtn');
        if (billingBtn) {
            billingBtn.addEventListener('click', function () {
                billingBtn.disabled = true;
                billingBtn.textContent = 'Loading…';
                window._clerkGetToken().then(function (token) {
                    return fetch('/api/billing/portal', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + token,
                        },
                    });
                })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    if (d.ok && d.url) {
                        window.location.href = d.url;
                    } else {
                        alert(d.error || 'Could not open billing portal. Please try again.');
                        billingBtn.disabled = false;
                        billingBtn.textContent = 'Manage Billing';
                    }
                })
                .catch(function () {
                    alert('Network error. Please try again.');
                    billingBtn.disabled = false;
                    billingBtn.textContent = 'Manage Billing';
                });
            });
        }

        var settingsBtn = dropdown.querySelector('#clerkSettingsBtn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', function () {
                window.location.href = '/settings.html';
            });
        }

        var signOutBtn = dropdown.querySelector('#clerkSignOutBtn');
        if (signOutBtn) {
            signOutBtn.addEventListener('click', function () {
                window.Clerk.signOut().then(function () {
                    window.location.href = '/';
                });
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
    var PENDING_PLAN_KEY    = 'ms_pending_plan';   // target plan stored by _startCheckout
    var _paymentPollingActive = false;
    var _pollTimerId = null;
    var _pollStartTime = null;
    var _pollDeadlineMs = 90000;
    var _pollVisibilityHandler = null;
    var _pollOnlineHandler = null;

    function _cleanupPoll() {
        _paymentPollingActive = false;
        if (_pollTimerId) { clearTimeout(_pollTimerId); _pollTimerId = null; }
        if (_pollVisibilityHandler) {
            document.removeEventListener('visibilitychange', _pollVisibilityHandler);
            _pollVisibilityHandler = null;
        }
        if (_pollOnlineHandler) {
            window.removeEventListener('online', _pollOnlineHandler);
            _pollOnlineHandler = null;
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

    function _setActivatingBannerText(msg) {
        var banner = document.getElementById('msActivatingBanner');
        if (!banner) return;
        var spans = banner.querySelectorAll('span');
        var textSpan = spans[spans.length - 1];
        if (textSpan) textSpan.textContent = msg;
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
            // Only persist when we have a real user ID — the '1' fallback caused
            // the poll to cancel immediately for any user (pendingUserId '1' !== actual id).
            if (currentUserId) {
                localStorage.setItem(PAYMENT_PENDING_KEY, currentUserId);
            }
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

        var planBefore  = (window.Clerk.user.publicMetadata && window.Clerk.user.publicMetadata.plan) || 'free';
        // targetPlan is written by _startCheckout before redirecting to Stripe.
        // Using it lets us correctly detect paid→paid upgrades (e.g. Starter→Pro)
        // where the user was already on a non-free plan before the new purchase.
        var targetPlan  = (function () { try { return localStorage.getItem(PENDING_PLAN_KEY); } catch (_) { return null; } })();
        var attemptDelay = 2000;
        _pollStartTime = Date.now();

        function _pauseForOnline() {
            if (_pollOnlineHandler) return;
            _setActivatingBannerText('Waiting for connection\u2026');
            _pollOnlineHandler = function () {
                window.removeEventListener('online', _pollOnlineHandler);
                _pollOnlineHandler = null;
                _setActivatingBannerText('Confirming your upgrade\u2026');
                tryReload();
            };
            window.addEventListener('online', _pollOnlineHandler);
        }

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

            if (!navigator.onLine) {
                _pauseForOnline();
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
                // If we know the exact plan the user purchased, wait until the
                // session reflects that specific plan.  Fallback: accept any paid
                // plan (handles the case where targetPlan wasn't stored — e.g. the
                // user closed the tab after payment and came back later).
                var reachedTargetPlan = targetPlan ? (newPlan === targetPlan) : (newPlan !== 'free');

                if (planUpgraded || reachedTargetPlan) {
                    localStorage.removeItem(PAYMENT_PENDING_KEY);
                    try { localStorage.removeItem(PENDING_PLAN_KEY); } catch (_) {}
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
                if (!navigator.onLine) {
                    _pauseForOnline();
                } else if (Date.now() - _pollStartTime < _pollDeadlineMs) {
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

        var msg = document.createElement('span');
        msg.textContent = 'Payment received \u2014 still activating your plan.';
        toast.appendChild(msg);

        var reloadBtn = document.createElement('button');
        reloadBtn.type = 'button';
        reloadBtn.textContent = 'Reload now';
        reloadBtn.style.cssText = 'margin-left:12px;padding:2px 10px;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;cursor:pointer;font-size:inherit;';
        reloadBtn.addEventListener('click', function () { window.location.reload(); });
        toast.appendChild(reloadBtn);

        document.body.appendChild(toast);

        setTimeout(function () { toast.classList.add('ms-upgrade-toast--visible'); }, 50);
        setTimeout(function () {
            toast.classList.remove('ms-upgrade-toast--visible');
            setTimeout(function () { toast.parentNode && toast.parentNode.removeChild(toast); }, 400);
        }, 12000);
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

    // Render sign-in button immediately as default state so it appears
    // even before Clerk finishes loading (or if it fails to load in dev).
    _renderSignInButton();

    if (window.__clerkSdkReady) {
        _clerkAuthMain();
    } else {
        window.__clerkInit = _clerkAuthMain;
    }

    // Guard against bfcache restores re-showing the activating banner.
    // When the browser restores a page from the back/forward cache, all
    // setTimeout/setInterval handles are dead but JS variables survive.
    // We reset poll state with _cleanupPoll() and only resume the payment
    // flow when ms_payment_pending is still present in localStorage.
    window.addEventListener('pageshow', function (event) {
        if (!event.persisted) return;
        // Dead timer handles must be cleared before any new poll can start.
        _cleanupPoll();
        if (localStorage.getItem(PAYMENT_PENDING_KEY)) {
            // A genuine pending key survived — resume polling.
            _handlePaymentSuccess();
        } else {
            // No pending key: dismiss any banner that was frozen mid-display.
            _dismissActivatingBanner();
        }
    });

})();
