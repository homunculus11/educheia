import { auth } from './firebase-config.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';

const USERNAME_EMAIL_MAP_KEY = 'usernameEmailMap';
const AUTH_RENDER_FALLBACK_MS = 1200;

// Route constants – single source of truth for every internal nav link.
// Never derive these from window.location or relative paths; always use the
// canonical clean-URL form so they work regardless of how the hosting serves
// the underlying HTML files (e.g. src/login.html vs /login).
const ROUTES = {
	home:     '/',
	login:    '/login',
	register: '/register',
	account:  '/account',
};

const getRoute = (page) => ROUTES[page] ?? `/${page}`;

const getDisplayName = (user) => {
	const fromProfile = typeof user?.displayName === 'string' ? user.displayName.trim() : '';
	if (fromProfile) return fromProfile;

	const email = typeof user?.email === 'string' ? user.email.trim() : '';
	if (!email) return 'Contul meu';
	return email.split('@')[0] || 'Contul meu';
};

const getUserClaims = async (user) => {
	if (!user) return {};

	try {
		const tokenResult = await user.getIdTokenResult(true);
		return tokenResult?.claims || {};
	} catch {
		return {};
	}
};

const escapeHtml = (value) => String(value ?? '')
	.replaceAll('&', '&amp;')
	.replaceAll('<', '&lt;')
	.replaceAll('>', '&gt;')
	.replaceAll('"', '&quot;')
	.replaceAll("'", '&#39;');

const getInitials = (label) => {
	const normalized = String(label || '').trim();
	if (!normalized) return 'U';

	const words = normalized.split(/\s+/).filter(Boolean);
	if (words.length >= 2) {
		return `${words[0][0]}${words[1][0]}`.toUpperCase();
	}

	return normalized.slice(0, 2).toUpperCase();
};

const renderGuestActions = (container) => {
	// Use ROUTES constants directly – never derive from window.location
	container.innerHTML = `
		<a href="${ROUTES.login}" id="login-btn" class="account-link">Login</a>
		<a href="${ROUTES.register}" id="signup-btn" class="account-link">Signup</a>
	`;
	container.removeAttribute('data-auth-state');
};

const renderUserActions = (container, user, options = {}) => {
	const displayName = getDisplayName(user);
	const email = user?.email || 'Utilizator autentificat';
	const initials = getInitials(displayName);
	const isAdmin = Boolean(options?.isAdmin);
	const safeDisplayName = escapeHtml(displayName);
	const safeEmail = escapeHtml(email);
	const safeInitials = escapeHtml(initials);
	const roleLabel = isAdmin ? 'Admin' : 'Membru';
	const safeRoleLabel = escapeHtml(roleLabel);
	const roleClassName = isAdmin ? 'dropdown-role dropdown-role-admin' : 'dropdown-role';
	// Always use the constant, never window.location-derived strings
	const accountRoute = ROUTES.account;

	container.innerHTML = `
		<div class="account-widget" id="account-widget">
			<button class="account-toggle" type="button" aria-expanded="false" aria-haspopup="true" aria-label="Meniu cont">
				<span class="account-avatar" aria-hidden="true">${safeInitials}</span>
				<span class="account-toggle-name">${safeDisplayName}</span>
				<svg class="account-chevron" width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>
				</svg>
			</button>
			<div class="account-dropdown" role="menu">
				<div class="dropdown-user-section">
					<span class="dropdown-avatar" aria-hidden="true">${safeInitials}</span>
					<div class="dropdown-user-info">
						<span class="dropdown-name">${safeDisplayName}</span>
						<span class="dropdown-email">${safeEmail}</span>
						<span class="${roleClassName}">${safeRoleLabel}</span>
					</div>
				</div>
				<div class="dropdown-divider"></div>
				<div class="dropdown-actions">
					<a href="${accountRoute}" class="dropdown-item" role="menuitem">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>
						Contul meu
					</a>
					<button type="button" class="dropdown-item dropdown-item-logout" role="menuitem" id="nav-logout-btn">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"/></svg>
						Deconectare
					</button>
				</div>
			</div>
		</div>
	`;

	container.setAttribute('data-auth-state', 'authenticated');

	const widget = container.querySelector('#account-widget');
	const toggle = widget?.querySelector('.account-toggle');

	const closeDropdown = () => {
		widget?.classList.remove('open');
		toggle?.setAttribute('aria-expanded', 'false');
	};

	toggle?.addEventListener('click', (e) => {
		e.stopPropagation();
		const isOpen = widget.classList.toggle('open');
		toggle.setAttribute('aria-expanded', String(isOpen));
	});

	document.addEventListener('click', (e) => {
		if (widget && !widget.contains(e.target)) closeDropdown();
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			closeDropdown();
			toggle?.focus();
		}
	});

	const logoutBtn = container.querySelector('#nav-logout-btn');
	logoutBtn?.addEventListener('click', async () => {
		logoutBtn.disabled = true;
		const originalHTML = logoutBtn.innerHTML;
		logoutBtn.textContent = 'Se deconectează...';

		try {
			await signOut(auth);
			// Use the constant route, never a derived string
			window.location.href = ROUTES.login;
		} catch (error) {
			console.error('Logout failed', error);
			logoutBtn.disabled = false;
			logoutBtn.innerHTML = originalHTML;
			alert('Nu am putut face logout. Încearcă din nou.');
		}
	});
};

const saveUsernameEmailAlias = (user) => {
	const email = typeof user?.email === 'string' ? user.email.trim() : '';
	const displayName = typeof user?.displayName === 'string' ? user.displayName.trim() : '';

	if (!email || !displayName) return;

	try {
		const raw = localStorage.getItem(USERNAME_EMAIL_MAP_KEY);
		const parsed = raw ? JSON.parse(raw) : {};
		parsed[displayName.toLowerCase()] = email;
		localStorage.setItem(USERNAME_EMAIL_MAP_KEY, JSON.stringify(parsed));
	} catch {
		return;
	}
};

const initAccountNav = () => {
	const container = document.getElementById('header-btns');
	if (!container) return;

	container.classList.add('auth-pending');
	let hasRendered = false;

	const finalizeRender = () => {
		if (hasRendered) return;
		hasRendered = true;
		container.classList.remove('auth-pending');
	};

	const fallbackId = window.setTimeout(() => {
		if (hasRendered) return;
		renderGuestActions(container);
		finalizeRender();
	}, AUTH_RENDER_FALLBACK_MS);

	onAuthStateChanged(auth, async (user) => {
		window.clearTimeout(fallbackId);

		if (!user) {
			renderGuestActions(container);
			finalizeRender();
			return;
		}

		const claims = await getUserClaims(user);
		saveUsernameEmailAlias(user);
		renderUserActions(container, user, { isAdmin: Boolean(claims?.admin) });
		finalizeRender();
	}, () => {
		window.clearTimeout(fallbackId);
		renderGuestActions(container);
		finalizeRender();
	});
};

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initAccountNav);
} else {
	initAccountNav();
}