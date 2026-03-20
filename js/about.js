/* ── About page interactions ── */

/* Prevent default on smooth-scroll anchor links so script.js handler works */
document.querySelectorAll('a[data-scroll]').forEach(a => {
	a.addEventListener('click', e => e.preventDefault());
});

const progressBar = document.getElementById('reading-progress');
const parallaxNodes = [...document.querySelectorAll('[data-parallax]')];
const revealNodes = [...document.querySelectorAll('[data-reveal]')];
const timelineSteps = [...document.querySelectorAll('[data-step]')];
const counterNodes = [...document.querySelectorAll('[data-counter]')];
const tiltNodes = [...document.querySelectorAll('[data-tilt]')];
const timelineFill = document.getElementById('timeline-fill');
const jumpLinks = [...document.querySelectorAll('.about-jump-link')];
const siteHeader = document.querySelector('.site-header');

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const prefersCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
const hasIntersectionObserver = 'IntersectionObserver' in window;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const lerp = (a, b, t) => a + (b - a) * t;

/* ── Reading progress bar ── */
function updateReadingProgress() {
	if (!progressBar) return;
	const scrollable = document.documentElement.scrollHeight - window.innerHeight;
	const progress = scrollable > 0 ? clamp(window.scrollY / scrollable, 0, 1) : 0;
	progressBar.style.transform = `scaleX(${progress})`;
}

/* ── Sticky jump-nav offset (keeps nav below the floating header) ── */
function updateStickyNavOffset() {
	const root = document.documentElement;
	if (!root) return;

	let offset = 102;
	if (siteHeader) {
		const rect = siteHeader.getBoundingClientRect();
		offset = Math.max(72, Math.round(rect.bottom));
	}

	root.style.setProperty('--about-sticky-offset', `${offset}px`);
}

/* ── Parallax ── */
function updateParallax() {
	if (prefersReducedMotion || !parallaxNodes.length) return;
	const vh = window.innerHeight || 1;
	parallaxNodes.forEach((node) => {
		const speed = Number(node.dataset.parallax || 0);
		const rect = node.getBoundingClientRect();
		const center = rect.top + rect.height / 2;
		const offset = -(center - vh / 2) * speed;
		node.style.transform = `translate3d(0,${offset}px,0)`;
	});
}

/* ── Timeline active step + progress line fill ── */
function updateTimeline() {
	if (!timelineSteps.length) return;

	const focusLine = window.innerHeight * 0.38;
	let activeStep = timelineSteps[0];
	let minDist = Infinity;

	timelineSteps.forEach((step) => {
		const rect = step.getBoundingClientRect();
		const center = rect.top + rect.height / 2;
		const dist = Math.abs(center - focusLine);
		if (dist < minDist) {
			minDist = dist;
			activeStep = step;
		}
	});

	timelineSteps.forEach((step) => step.classList.toggle('is-active', step === activeStep));

	if (timelineFill) {
		const track = document.getElementById('timeline-track');
		if (track) {
			const trackRect = track.getBoundingClientRect();
			if (trackRect.height <= 0) return;
			const activeRect = activeStep.getBoundingClientRect();
			const activeCenterY = activeRect.top + activeRect.height / 2 - trackRect.top;
			const pct = clamp(activeCenterY / trackRect.height, 0, 1) * 100;
			timelineFill.style.height = `${pct}%`;
		}
	}
}

/* ── Counter animation (with live API data) ── */
function animateCounter(node) {
	const target = Number(node.dataset.counter || 0);
	if (target === 0) return;
	const duration = 1400;
	const start = performance.now();

	const tick = (now) => {
		const t = clamp((now - start) / duration, 0, 1);
		const eased = 1 - Math.pow(1 - t, 3);
		const value = Math.round(target * eased);
		node.textContent = value.toLocaleString();
		if (t < 1) {
			requestAnimationFrame(tick);
		} else {
			node.textContent = target.toLocaleString();
		}
	};

	requestAnimationFrame(tick);
}

/* ── Fetch real stats and patch counters (reuses script.js helpers) ── */
async function loadRealStats() {
	try {
		if (typeof getEpisodes !== 'function' || typeof getChannelStats !== 'function') {
			throw new Error('Missing API helpers for stats');
		}

		const [episodesData, channelData] = await Promise.all([
			getEpisodes(),
			getChannelStats(),
		]);

		const episodes = episodesData?.numberOfEpisodes || 0;
		const items = Array.isArray(episodesData?.items) ? episodesData.items : [];
		const ch = channelData?.channel || {};
		const subscribers = Number(ch.statistics.subscriberCount) || 0;
		const views = Number(ch.statistics.viewCount) || 0;

		const guestNames = new Set();
		items.forEach((item) => {
			const name = typeof extractGuestName === 'function'
				? extractGuestName(item?.snippet?.title)
				: '';
			if (name) guestNames.add(name);
		});

		const mapping = {
			episodes,
			guests: guestNames.size,
			subscribers,
			views,
		};

		counterNodes.forEach((node) => {
			const key = node.dataset.counterKey;
			if (key && mapping[key] != null) {
				node.dataset.counter = String(mapping[key]);
			}
		});
	} catch (err) {
		counterNodes.forEach((node) => {
			const key = node.dataset.counterKey;
			const fallbacks = { episodes: 15, guests: 14, subscribers: 5000, views: 250000 };
			if (key && fallbacks[key]) {
				node.dataset.counter = String(fallbacks[key]);
			}
		});
	}
}

/* ── Intersection-based reveals with stagger ── */
if (revealNodes.length) {
	if (!hasIntersectionObserver) {
		revealNodes.forEach((node) => node.classList.add('is-visible'));
	} else {
		const staggerMap = new Map();

		const revealObserver = new IntersectionObserver(
			(entries, observer) => {
				entries.forEach((entry) => {
					if (!entry.isIntersecting) return;

					const parent = entry.target.parentElement;
					if (!staggerMap.has(parent)) staggerMap.set(parent, 0);
					const idx = staggerMap.get(parent);
					staggerMap.set(parent, idx + 1);

					const delay = Math.min(idx * 80, 320);
					entry.target.style.transitionDelay = `${delay}ms`;
					entry.target.classList.add('is-visible');
					observer.unobserve(entry.target);
				});
			},
			{ threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
		);

		revealNodes.forEach((node) => revealObserver.observe(node));
	}
}

/* ── Counter observer ── */
if (counterNodes.length) {
	loadRealStats().then(() => {
		if (!hasIntersectionObserver) {
			counterNodes.forEach((node) => animateCounter(node));
		} else {
			const counterObserver = new IntersectionObserver(
				(entries, observer) => {
					entries.forEach((entry) => {
						if (!entry.isIntersecting) return;
						animateCounter(entry.target);
						observer.unobserve(entry.target);
					});
				},
				{ threshold: 0.5 },
			);
			counterNodes.forEach((node) => counterObserver.observe(node));
		}
	});
}

/* ── 3D tilt effect on cards ── */
if (!prefersReducedMotion && !prefersCoarsePointer && tiltNodes.length) {
	const MAX_TILT = 6;
	const GLOW_SIZE = 260;

	tiltNodes.forEach((card) => {
		const glowEl = document.createElement('div');
		glowEl.classList.add('tilt-glow');
		card.style.position = card.style.position || 'relative';
		card.appendChild(glowEl);

		card.addEventListener('mousemove', (e) => {
			const rect = card.getBoundingClientRect();
			const x = (e.clientX - rect.left) / rect.width;
			const y = (e.clientY - rect.top) / rect.height;
			const rotateX = (0.5 - y) * MAX_TILT;
			const rotateY = (x - 0.5) * MAX_TILT;

			/* Disable CSS transition so tilt responds instantly */
			card.style.transition = 'none';
			card.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02,1.02,1)`;

			glowEl.style.opacity = '1';
			glowEl.style.left = `${e.clientX - rect.left - GLOW_SIZE / 2}px`;
			glowEl.style.top = `${e.clientY - rect.top - GLOW_SIZE / 2}px`;
		});

		card.addEventListener('mouseleave', () => {
			card.style.transition = 'transform 0.35s cubic-bezier(0.22,1,0.36,1)';
			card.style.transform = '';
			glowEl.style.opacity = '0';
		});
	});
}

/* ── Smooth scroll-linked opacity for quote section ── */
const quoteBlock = document.querySelector('.featured-quote');
if (quoteBlock && !prefersReducedMotion) {
	const quoteObserver = new IntersectionObserver(
		(entries) => {
			entries.forEach((entry) => {
				const ratio = entry.intersectionRatio;
				const scale = lerp(0.92, 1, ratio);
				const blur = lerp(6, 0, ratio);
				quoteBlock.style.transform = `scale(${scale})`;
				quoteBlock.style.filter = `blur(${blur}px)`;
				quoteBlock.style.opacity = String(ratio);
			});
		},
		{ threshold: Array.from({ length: 20 }, (_, i) => i / 19) },
	);
	quoteObserver.observe(quoteBlock);
}

/* ── Jump nav active section ── */
if (jumpLinks.length && hasIntersectionObserver) {
	const sectionById = new Map();
	jumpLinks.forEach((link) => {
		const href = link.getAttribute('href') || '';
		if (!href.startsWith('#')) return;
		const id = href.slice(1);
		const section = document.getElementById(id);
		if (section) sectionById.set(id, section);
	});

	const setCurrentLink = (id) => {
		jumpLinks.forEach((link) => {
			const active = link.getAttribute('href') === `#${id}`;
			link.classList.toggle('is-current', active);
			if (active) {
				link.setAttribute('aria-current', 'page');
			} else {
				link.removeAttribute('aria-current');
			}
		});
	};

	if (sectionById.size) {
		const observer = new IntersectionObserver(
			(entries) => {
				const visible = entries
					.filter((entry) => entry.isIntersecting)
					.sort((a, b) => b.intersectionRatio - a.intersectionRatio);

				if (visible.length) {
					setCurrentLink(visible[0].target.id);
				}
			},
			{ threshold: [0.2, 0.4, 0.6], rootMargin: '-12% 0px -55% 0px' },
		);

		sectionById.forEach((section) => observer.observe(section));

		jumpLinks.forEach((link) => {
			link.addEventListener('click', () => {
				const href = link.getAttribute('href') || '';
				if (href.startsWith('#')) setCurrentLink(href.slice(1));
			});
		});

		setCurrentLink('host');
	}
}

/* ── Scroll-frame loop ── */
function onScrollFrame() {
	updateReadingProgress();
	updateParallax();
	updateTimeline();
}

let rafLocked = false;
function handleScroll() {
	if (rafLocked) return;
	rafLocked = true;
	requestAnimationFrame(() => {
		onScrollFrame();
		rafLocked = false;
	});
}

window.addEventListener('scroll', handleScroll, { passive: true });
window.addEventListener('resize', () => {
	updateStickyNavOffset();
	onScrollFrame();
});

updateStickyNavOffset();
onScrollFrame();
