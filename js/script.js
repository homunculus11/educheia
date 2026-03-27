document.querySelectorAll('[data-scroll]').forEach((btn) => {
	btn.addEventListener('click', () => {
		const target = btn.getAttribute('data-scroll');
		if (!target) return;
		const el = document.querySelector(target);
		if (el) {
			const header = document.querySelector('.site-header');
			const headerHeight = header ? header.getBoundingClientRect().height : 0;
			const extraOffset = 12;
			const targetTop = el.getBoundingClientRect().top + window.scrollY - headerHeight - extraOffset;

			window.scrollTo({
				top: Math.max(targetTop, 0),
				behavior: 'smooth'
			});
		}
	});
});

// Mobile nav toggle
const menuToggle = document.querySelector('.menu-toggle');
const headerDrawer = document.getElementById('header-drawer');
const headerOverlay = document.querySelector('.header-overlay');

const closeMenu = () => {
	document.body.classList.remove('nav-open');
	if (menuToggle) {
		menuToggle.setAttribute('aria-expanded', 'false');
	}
};

if (menuToggle && headerDrawer) {
	menuToggle.addEventListener('click', () => {
		const isOpen = document.body.classList.toggle('nav-open');
		menuToggle.setAttribute('aria-expanded', String(isOpen));
	});

	headerOverlay?.addEventListener('click', closeMenu);
	headerDrawer.addEventListener('click', (event) => {
		const interactive = event.target?.closest('a, button');
		if (interactive) {
			closeMenu();
		}
	});

	window.addEventListener('resize', () => {
		if (window.innerWidth > 900) {
			closeMenu();
		}
	});
}

const readSessionValue = (key) => {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
};

const writeSessionValue = (key, value) => {
	try {
		sessionStorage.setItem(key, value);
	} catch {
		return;
	}
};

const AUTH_RETURN_KEY = 'authReturnTo';

const isAuthPath = (path) => /\/(?:(?:src\/)?(?:login|register)(?:\.html)?)$/i.test(String(path || '').replace(/\/+$/, ''));

const isSafeReturnPath = (target) => {
	if (!target) return false;

	try {
		const parsed = new URL(target, window.location.origin);
		if (parsed.origin !== window.location.origin) return false;
		if (isAuthPath(parsed.pathname)) return false;
		return true;
	} catch {
		return false;
	}
};

const readAuthReturnPath = () => {
	const value = readSessionValue(AUTH_RETURN_KEY);
	return isSafeReturnPath(value) ? value : null;
};

const writeAuthReturnPath = (value) => {
	if (!isSafeReturnPath(value)) return;
	writeSessionValue(AUTH_RETURN_KEY, value);
};

const getCurrentRelativeUrl = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

const decorateAuthLinksWithRedirect = () => {
	const isOnAuthPage = isAuthPath(window.location.pathname);
	const currentUrl = getCurrentRelativeUrl();
	const search = new URLSearchParams(window.location.search);
	const queryRedirect = search.get('redirect');

	if (!isOnAuthPage) {
		writeAuthReturnPath(currentUrl);
	} else if (isSafeReturnPath(queryRedirect)) {
		writeAuthReturnPath(queryRedirect);
	}

	const storedRedirect = readAuthReturnPath();
	const redirectTarget = isOnAuthPage
		? (isSafeReturnPath(queryRedirect) ? queryRedirect : storedRedirect)
		: currentUrl;

	if (!isSafeReturnPath(redirectTarget)) return;

	const links = document.querySelectorAll('a[href]');
	links.forEach((link) => {
		const rawHref = link.getAttribute('href');
		if (!rawHref) return;

		let parsedHref;
		try {
			parsedHref = new URL(rawHref, window.location.href);
		} catch {
			return;
		}

		if (!isAuthPath(parsedHref.pathname)) return;

		parsedHref.searchParams.set('redirect', redirectTarget);
		const nextHref = `${parsedHref.pathname}${parsedHref.search}${parsedHref.hash}`;
		if (rawHref !== nextHref) {
			link.setAttribute('href', nextHref);
		}
	});
};

decorateAuthLinksWithRedirect();

const authLinksObserver = new MutationObserver((mutations) => {
	const hasRelevantMutation = mutations.some((mutation) => {
		if (mutation.type === 'childList') {
			return Array.from(mutation.addedNodes).some((node) => node instanceof Element);
		}
		return mutation.type === 'attributes' && mutation.attributeName === 'href';
	});

	if (hasRelevantMutation) {
		decorateAuthLinksWithRedirect();
	}
});

authLinksObserver.observe(document.body, {
	childList: true,
	subtree: true,
	attributes: true,
	attributeFilter: ['href']
});

const readSessionNumber = (key, fallback = null) => {
	const value = readSessionValue(key);
	if (value === null) return fallback;

	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
};

const readSessionJson = (key, fallback) => {
	const value = readSessionValue(key);
	if (!value) return fallback;

	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
};

const API_TIMEOUT_MS = 12000;

const fetchJsonWithTimeout = async (url, timeoutMs = API_TIMEOUT_MS) => {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) {
			throw new Error(`Request failed: ${response.status}`);
		}

		return await response.json();
	} finally {
		clearTimeout(timeoutId);
	}
};

const getEpisodes = async () => {
	const CACHE_DURATION = 60 * 60 * 1000; // 1 hour
	const cachedTimestamp = readSessionNumber('episodesFetchedAt');

	if (cachedTimestamp && (cachedTimestamp + CACHE_DURATION > Date.now())) {
		const cachedItemsRaw = readSessionJson('episodes', []);
		const cachedItems = Array.isArray(cachedItemsRaw) ? cachedItemsRaw : [];

		return {
			items: cachedItems,
			lastFetched: cachedTimestamp,
			numberOfEpisodes: readSessionNumber('numberOfEpisodes', 0)
		};
	}

	try {
		const data = await fetchJsonWithTimeout('https://tekwill-serverless.orletchi-bogdan2009.workers.dev/episodes');
		const fetchedAt = Date.now();
		const items = Array.isArray(data?.items) ? data.items : [];

		writeSessionValue('episodes', JSON.stringify(items));
		writeSessionValue('episodesFetchedAt', fetchedAt.toString());
		writeSessionValue('numberOfEpisodes', String(Number.isFinite(data?.numberOfEpisodes) ? data.numberOfEpisodes : 0));
	} catch (error) {
		console.warn('Error fetching episodes:', error);
	}

	const storedItemsRaw = readSessionJson('episodes', []);
	const storedItems = Array.isArray(storedItemsRaw) ? storedItemsRaw : [];

	return {
		items: storedItems,
		lastFetched: readSessionNumber('episodesFetchedAt'),
		numberOfEpisodes: readSessionNumber('numberOfEpisodes', 0)
	};
};

const extractGuestName = (title) => {
	if (!title || typeof title !== 'string') return null;

	const normalizedTitle = title.replace(/\s+/g, ' ').trim();
	if (!normalizedTitle || /trailer/i.test(normalizedTitle)) return null;

	const firstSegment = normalizedTitle.split(':')[0]?.trim();
	if (!firstSegment || firstSegment.length < 2) return null;

	if (/(educheia|podcast|episod)/i.test(firstSegment)) return null;

	return firstSegment;
};

const getChannelStats = async () => {
	const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
	const cachedTimestamp = readSessionNumber('channelFetchedAt');

	if (cachedTimestamp && (cachedTimestamp + CACHE_DURATION > Date.now())) {
		const cachedChannelRaw = readSessionJson('channel', {});
		const cachedChannel = cachedChannelRaw && typeof cachedChannelRaw === 'object' ? cachedChannelRaw : {};

		return {
			channel: cachedChannel,
			lastFetched: cachedTimestamp,
		};
	}

	try {
		const data = await fetchJsonWithTimeout('https://tekwill-serverless.orletchi-bogdan2009.workers.dev/channel');
		const fetchedAt = Date.now();
		const channelInfo = data?.channelInfo && typeof data.channelInfo === 'object' ? data.channelInfo : {};

		writeSessionValue('channel', JSON.stringify(channelInfo));
		writeSessionValue('channelFetchedAt', fetchedAt.toString());
	} catch (error) {
		console.warn('Error fetching channel:', error);
	}

	const storedChannelRaw = readSessionJson('channel', {});
	const storedChannel = storedChannelRaw && typeof storedChannelRaw === 'object' ? storedChannelRaw : {};

	return {
		channel: storedChannel,
		lastFetched: readSessionNumber('channelFetchedAt'),
	};
};
