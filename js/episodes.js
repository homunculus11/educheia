// State
let episodes = [];
let originalEpisodes = []; // Store original fetch for sorting
let sortOrder = 'desc'; // 'desc' (newest first) or 'asc' (oldest first)
let scrollContainer, stickyWrapper, horizontalTrack, timelineFillBottom, timelineFillTrack, cards, scrollHint;
let mobileTrackMarkers = [];
let maxScroll = 0;
let windowHeight = window.innerHeight;
let isScrolling = false;
let snapTimeout;
let hasRemovedScrollHintLabel = false;

// Player State
let playerState = {
    isOpen: false,
    mode: 'video', // 'video' | 'audio'
    currentEpisode: null
};

let currentAuthUser = null;
let currentAuthClaims = {};
let activeCommentsRequestId = 0;
let isSubmittingComment = false;
let isCommentActionPending = false;
const commentsById = new Map();
let isPlayerSetupComplete = false;
let mobileActiveCardIndex = 0;
let mobileCardsObserver = null;
let commentsSetupPromise = null;
let auth = null;
let db = null;
let onAuthStateChangedFn = null;
let addDocFn = null;
let collectionFn = null;
let deleteDocFn = null;
let docFn = null;
let getDocsFn = null;
let limitFn = null;
let orderByFn = null;
let queryFn = null;
let serverTimestampFn = null;
let updateDocFn = null;
let firebaseReadyPromise = null;
let mobileTrackRefreshRaf = 0;

let lastFocusedElement = null;

const isMobileLayout = () => window.matchMedia('(max-width: 767px)').matches;

const EPISODES_CACHE_KEY = 'episodesCacheV1';
const EPISODES_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const readEpisodesCache = () => {
    try {
        const raw = localStorage.getItem(EPISODES_CACHE_KEY);
        if (!raw) return [];

        const parsed = JSON.parse(raw);
        const timestamp = Number(parsed?.timestamp || 0);
        const items = Array.isArray(parsed?.items) ? parsed.items : [];

        if (!timestamp || (Date.now() - timestamp) > EPISODES_CACHE_TTL_MS || !items.length) {
            return [];
        }

        return items.map((item) => ({
            ...item,
            dateObj: new Date(item.publishedAt || Date.now())
        }));
    } catch {
        return [];
    }
};

const writeEpisodesCache = (items = []) => {
    if (!Array.isArray(items) || !items.length) return;

    try {
        const payload = items.map((item) => ({
            videoId: item.videoId,
            title: item.title,
            description: item.description,
            publishedAt: item.publishedAt,
            thumbnails: item.thumbnails
        }));

        localStorage.setItem(EPISODES_CACHE_KEY, JSON.stringify({
            timestamp: Date.now(),
            items: payload
        }));
    } catch {
        return;
    }
};

const normalizeEpisodeItems = (rawItems = []) => rawItems.map((item) => {
    const snippet = item.snippet || item;
    return {
        videoId: (snippet.resourceId && snippet.resourceId.videoId) || item.videoId,
        title: snippet.title,
        description: snippet.description,
        publishedAt: snippet.publishedAt,
        thumbnails: snippet.thumbnails,
        dateObj: new Date(snippet.publishedAt)
    };
});

const ensureFirebaseReady = async () => {
    if (firebaseReadyPromise) {
        return firebaseReadyPromise;
    }

    firebaseReadyPromise = Promise.all([
        import('./firebase-config.js'),
        import('https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js'),
        import('https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js')
    ]).then(([firebaseConfigModule, authModule, firestoreModule]) => {
        auth = firebaseConfigModule.auth;
        db = firebaseConfigModule.db;

        onAuthStateChangedFn = authModule.onAuthStateChanged;

        addDocFn = firestoreModule.addDoc;
        collectionFn = firestoreModule.collection;
        deleteDocFn = firestoreModule.deleteDoc;
        docFn = firestoreModule.doc;
        getDocsFn = firestoreModule.getDocs;
        limitFn = firestoreModule.limit;
        orderByFn = firestoreModule.orderBy;
        queryFn = firestoreModule.query;
        serverTimestampFn = firestoreModule.serverTimestamp;
        updateDocFn = firestoreModule.updateDoc;
    }).catch((error) => {
        firebaseReadyPromise = null;
        throw error;
    });

    return firebaseReadyPromise;
};

const ensurePlayerSetup = () => {
    if (isPlayerSetupComplete) return;
    setupPlayer();
    isPlayerSetupComplete = true;
};

const updateTrackProgressGeometry = () => {
    if (isMobileLayout()) return;
    if (!horizontalTrack || !cards || !cards.length) return;

    const connector = horizontalTrack.querySelector('.episodes-track-progress');
    if (!connector) return;

    const firstCard = cards[0];
    const lastCard = cards[cards.length - 1];
    const start = firstCard.offsetLeft + (firstCard.offsetWidth / 2);
    const end = lastCard.offsetLeft + (lastCard.offsetWidth / 2);

    connector.style.left = `${start}px`;
    connector.style.width = `${Math.max(0, end - start)}px`;
};

const renderMobileTrackMarkers = () => {
    if (!isMobileLayout()) {
        mobileTrackMarkers = [];
        if (mobileCardsObserver) {
            mobileCardsObserver.disconnect();
            mobileCardsObserver = null;
        }
        return;
    }
    if (!horizontalTrack || !cards?.length) return;

    const connector = horizontalTrack.querySelector('.episodes-track-progress');
    if (!connector) return;

    connector.querySelectorAll('.episodes-track-marker').forEach((marker) => marker.remove());
    mobileTrackMarkers = [];

    const connectorHeight = connector.offsetHeight;
    const connectorTop = connector.offsetTop;
    if (!Number.isFinite(connectorHeight) || connectorHeight <= 0) return;

    cards.forEach((card, index) => {
        const centerY = card.offsetTop + (card.offsetHeight / 2);
        const relativeCenter = (centerY - connectorTop) / connectorHeight;
        const clamped = Math.max(0, Math.min(1, relativeCenter));

        const marker = document.createElement('span');
        marker.className = 'episodes-track-marker';
        marker.setAttribute('aria-hidden', 'true');
        marker.dataset.index = String(index);
        marker.style.top = `${clamped * 100}%`;

        connector.appendChild(marker);
        mobileTrackMarkers.push(marker);
    });
};

const updateMobileTrackMarkerState = (activeIndex = 0) => {
    if (!isMobileLayout() || !cards?.length || !mobileTrackMarkers.length) return;

    cards.forEach((card, index) => {
        card.classList.toggle('active', index === activeIndex);
    });

    mobileTrackMarkers.forEach((marker, index) => {
        marker.classList.toggle('is-passed', index <= activeIndex);
        marker.classList.toggle('is-active', index === activeIndex);
    });
};

const updateMobileTrackProgress = () => {
    if (!isMobileLayout()) return;
    if (!horizontalTrack || !cards?.length) return;

    const connector = horizontalTrack.querySelector('.episodes-track-progress');
    const fillTrack = document.getElementById('timeline-fill-track');
    if (!connector || !fillTrack) return;

    const connectorRect = connector.getBoundingClientRect();
    if (!Number.isFinite(connectorRect.height) || connectorRect.height <= 0) return;

    // Use a viewport probe line slightly above center so progress reacts earlier while scrolling.
    const probeY = window.innerHeight * 0.45;
    const filledPx = Math.max(0, Math.min(connectorRect.height, probeY - connectorRect.top));
    const fillPercent = (filledPx / connectorRect.height) * 100;
    fillTrack.style.height = `${fillPercent}%`;
    fillTrack.style.width = '';

    let closestIndex = mobileActiveCardIndex;
    let minDistance = Infinity;

    cards.forEach((card, index) => {
        const rect = card.getBoundingClientRect();
        const centerY = rect.top + (rect.height / 2);
        const distance = Math.abs(centerY - probeY);

        if (distance < minDistance) {
            minDistance = distance;
            closestIndex = index;
        }
    });

    if (closestIndex !== mobileActiveCardIndex) {
        mobileActiveCardIndex = closestIndex;
    }

    updateMobileTrackMarkerState(mobileActiveCardIndex);
};

const scheduleMobileTrackRefresh = () => {
    if (!isMobileLayout()) return;

    cancelAnimationFrame(mobileTrackRefreshRaf);
    mobileTrackRefreshRaf = requestAnimationFrame(() => {
        renderMobileTrackMarkers();
        updateMobileTrackProgress();
    });
};

const setupMobileCardsObserver = () => {
    if (!isMobileLayout() || !cards?.length) return;

    if (mobileCardsObserver) {
        mobileCardsObserver.disconnect();
    }

    mobileCardsObserver = new IntersectionObserver((entries) => {
        let bestIndex = mobileActiveCardIndex;
        let bestRatio = 0;

        entries.forEach((entry) => {
            const index = Number(entry.target?.dataset?.index ?? -1);
            if (index < 0) return;
            if (entry.isIntersecting && entry.intersectionRatio >= bestRatio) {
                bestRatio = entry.intersectionRatio;
                bestIndex = index;
            }
        });

        if (bestIndex !== mobileActiveCardIndex) {
            mobileActiveCardIndex = bestIndex;
            updateMobileTrackMarkerState(mobileActiveCardIndex);
        }
    }, {
        root: null,
        threshold: [0.4, 0.6, 0.8],
        rootMargin: '-10% 0px -35% 0px'
    });

    cards.forEach((card) => {
        mobileCardsObserver.observe(card);
    });

    mobileActiveCardIndex = 0;
    updateMobileTrackMarkerState(mobileActiveCardIndex);
    updateMobileTrackProgress();
};

// Utils
const formatDate = (dateString) => {
    try {
        const date = new Date(dateString);
        return new Intl.DateTimeFormat('ro-RO', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
    } catch {
        return dateString;
    }
};

const SKELETON_COUNT = 5;

const renderSkeletonCards = () => {
    horizontalTrack = document.getElementById('horizontal-track');
    if (!horizontalTrack) return;

    horizontalTrack.innerHTML = '';

    const connector = document.createElement('div');
    connector.className = 'episodes-track-progress';
    connector.innerHTML = `
        <div class="episodes-track-progress-line"></div>
        <div id="timeline-fill-track" class="episodes-track-progress-fill"></div>
    `;
    horizontalTrack.appendChild(connector);

    for (let i = 0; i < SKELETON_COUNT; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = 'skeleton-card';
        skeleton.setAttribute('aria-hidden', 'true');
        skeleton.innerHTML = `
            <div class="skeleton-card-image skeleton-shimmer"></div>
            <div class="skeleton-card-content">
                <div class="skeleton-badge skeleton-shimmer"></div>
                <div class="skeleton-title skeleton-shimmer"></div>
                <div class="skeleton-meta skeleton-shimmer"></div>
            </div>
        `;
        horizontalTrack.appendChild(skeleton);
    }
};

const init = async () => {
    // 0. Show skeleton cards immediately
    renderSkeletonCards();
    setupScroll();

    const cachedItems = readEpisodesCache();
    if (cachedItems.length) {
        originalEpisodes = cachedItems;
        episodes = [...originalEpisodes].sort((a, b) => b.dateObj - a.dateObj);
        renderCards();
        updateScroll();
    }

    // 1. Fetch Episodes
    try {
        if (typeof getEpisodes === 'function') {
            const data = await getEpisodes();
            const rawItems = (data && data.items) ? data.items : [];
            originalEpisodes = normalizeEpisodeItems(rawItems);
            writeEpisodesCache(originalEpisodes);
            
            // Default Sort: Newest First
            episodes = [...originalEpisodes].sort((a, b) => b.dateObj - a.dateObj);

        } else {
            throw new Error('getEpisodes not available');
        }
    } catch (e) {
        console.warn('API fetch failed or function missing, using fallbacks.', e);
        originalEpisodes = Array.from({ length: 8 }).map((_, i) => ({
            videoId: "jNQXAC9IVRw",
            title: `Perspective Digitale: Episodul ${i + 1}`,
            description: "O discuție despre viitorul tehnologiei și impactul inteligenței artificiale în educație.",
            publishedAt: new Date().toISOString(),
            dateObj: new Date()
        }));
        episodes = [...originalEpisodes];
    }

    // 2. Render Cards (replaces skeletons)
    renderCards();
    
    // 3. Setup Scroll Logic (re-calibrate with real cards)
    updateScroll();

    // 4. Player setup is deferred until first open (mobile perf)
    
    // 5. Check URL
    checkUrlForEpisode();
    
    // 6. Setup Controls (Sort & Jump)
    setupControls();
};

const setupControls = () => {
    const sortBtn = document.getElementById('sort-btn');
    const sortLabel = document.getElementById('sort-label');
    const jumpBtn = document.getElementById('scroll-jump-btn');
    
    if (sortBtn) {
        sortBtn.addEventListener('click', () => {
            sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
            
            // Update Label & Icon Rotation
            if (sortOrder === 'desc') {
                sortLabel.textContent = 'Cele mai noi';
                sortBtn.querySelector('svg').style.transform = 'rotate(0deg)';
            } else {
                sortLabel.textContent = 'Cele mai vechi';
                sortBtn.querySelector('svg').style.transform = 'rotate(180deg)';
            }
            
            // Sort Data
            episodes.sort((a, b) => {
                return sortOrder === 'desc' ? b.dateObj - a.dateObj : a.dateObj - b.dateObj;
            });
            
            // Re-render
            renderCards();
            // Reset Scroll
            window.scrollTo({ top: 0, behavior: 'auto' });
            updateScroll();
        });
    }
    
    if (jumpBtn) {
        jumpBtn.addEventListener('click', () => {
            const containerRect = scrollContainer.getBoundingClientRect();
            const containerTop = window.scrollY + containerRect.top;
            const containerHeight = containerRect.height;
            const scrollDistance = containerHeight - windowHeight;
            
            // Check current position to decide where to jump
            const currentRelative = Math.max(0, Math.min(scrollDistance, window.scrollY - containerTop));
            const targetRelative = currentRelative < (scrollDistance / 2) ? scrollDistance : 0;
            
            // Update button text logic for next click?
            // User asked for "To End" button. Let's make it toggle or contextual?
            // Or just "To End". Since native scroll bar is hidden, maybe "To Start" is useful too.
            
            window.scrollTo({
                top: containerTop + targetRelative,
                behavior: 'smooth'
            });
            
            // Update text after a delay or based on scroll? Maybe keep it simple.
        });
    }
};

const renderCards = () => {
    horizontalTrack = document.getElementById('horizontal-track');
    if (!horizontalTrack) return;

    horizontalTrack.innerHTML = ''; // Clear

    const connector = document.createElement('div');
    connector.className = 'episodes-track-progress';
    connector.innerHTML = `
        <div class="episodes-track-progress-line"></div>
        <div id="timeline-fill-track" class="episodes-track-progress-fill"></div>
    `;
    horizontalTrack.appendChild(connector);

    const mobileLayout = isMobileLayout();

    episodes.forEach((ep, index) => {
        // Thumbnail logic
        let imageUrl = '../images/logo-light.webp';
        if (ep.thumbnails) {
            imageUrl = mobileLayout
                ? (ep.thumbnails.medium?.url || ep.thumbnails.high?.url || ep.thumbnails.maxres?.url)
                : (ep.thumbnails.maxres?.url || ep.thumbnails.high?.url || ep.thumbnails.medium?.url);
        } else if (ep.videoId) {
            imageUrl = mobileLayout
                ? `https://img.youtube.com/vi/${ep.videoId}/mqdefault.jpg`
                : `https://img.youtube.com/vi/${ep.videoId}/hqdefault.jpg`;
        }
        const safeImageUrl = sanitizeImageUrl(imageUrl);
        const safeTitle = escapeHtml(ep.title || 'Episod fără titlu');
        const isLcpCandidate = index === 0;
        const imageLoading = isLcpCandidate ? 'eager' : 'lazy';
        const imageFetchPriority = isLcpCandidate ? 'high' : 'auto';
        
        // Use index for numbering display, but respect sort order
        // If sorting desc (newest first), display numbers N down to 1?
        // Or just "Episodul X" from title if available? 
        // Let's stick to simple logic: 
        const displayNum = getEpisodeDisplayNumber(index);

        const card = document.createElement('div');
        card.className = 'episode-card group';
        card.dataset.index = index;
        card.dataset.id = ep.videoId;
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `Deschide episodul ${displayNum}`);
        
        // Add more top padding inside card or track to center it better?
        // The track has pt-20 now.
        
        card.dataset.revealDelay = Math.min(index, 7);

        card.innerHTML = `
            <div class="card-image-wrapper">
                <img src="${safeImageUrl}" alt="${safeTitle}" class="card-image" loading="${imageLoading}" fetchpriority="${imageFetchPriority}" decoding="async" width="1280" height="720" sizes="(max-width: 767px) 100vw, 78vw" referrerpolicy="no-referrer">
                <div class="card-content">
                    <span class="episode-number">Episodul ${displayNum}</span>
                    <h3 class="episode-title">${safeTitle}</h3>
                    <div class="episode-meta">
                        <span>${formatDate(ep.publishedAt)}</span>
                    </div>
                </div>
                
                <!-- Play Overlay -->
                     <div class="card-play-overlay">
                         <button class="card-play-btn" aria-label="Redă episodul ${displayNum}">
                        <svg class="w-7 h-7 md:w-10 md:h-10 ml-0.5 md:ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                   </button>
                </div>
            </div>
            
            <!-- Audio Wave Animation (Injected via JS when active) -->
            <div class="audio-wave">
                <span class="wave-bar"></span>
                <span class="wave-bar"></span>
                <span class="wave-bar"></span>
                <span class="wave-bar"></span>
                <span class="wave-bar"></span>
            </div>
        `;
        
        card.addEventListener('click', () => openPlayer(ep));
        card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openPlayer(ep);
            }
        });

        const cardImage = card.querySelector('.card-image');
        if (cardImage) {
            cardImage.addEventListener('load', scheduleMobileTrackRefresh, { once: true });
            cardImage.addEventListener('error', scheduleMobileTrackRefresh, { once: true });
        }

        horizontalTrack.appendChild(card);
    });

    cards = document.querySelectorAll('.episode-card');
    timelineFillTrack = document.getElementById('timeline-fill-track');
    updateTrackProgressGeometry();
    renderMobileTrackMarkers();
    setupMobileCardsObserver();
    updateMobileTrackProgress();
};

const setupScroll = () => {
    scrollContainer = document.getElementById('scroll-container');
    timelineFillBottom = document.getElementById('timeline-fill-bottom'); // Updated ID
    scrollHint = document.getElementById('scroll-hint');
    
    if (!scrollContainer) return;

    let resizeRaf = 0;
    window.addEventListener('resize', () => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
            windowHeight = window.innerHeight;
            updateTrackProgressGeometry();
            renderMobileTrackMarkers();
            updateScroll();
            updateMobileTrackProgress();
        });
    }, { passive: true });

    // Throttled scroll handling for performance
    window.addEventListener('scroll', () => {
        if (!isScrolling) {
            window.requestAnimationFrame(() => {
                updateScroll();
                isScrolling = false;
            });
            isScrolling = true;
        }
        
        // Hide scroll hint on first scroll - Faster fade
        if (window.scrollY > 20 && scrollHint && scrollHint.style.opacity !== '0') {
            scrollHint.classList.add('is-dismissed');

            if (!hasRemovedScrollHintLabel) {
                const hintLabel = scrollHint.querySelector('span');
                hintLabel?.remove();
                hasRemovedScrollHintLabel = true;
            }
        }
        
        handleSnap();
            }, { passive: true });
    
    updateScroll();
};


const handleSnap = () => {
    clearTimeout(snapTimeout);

    if (isMobileLayout()) return;
    if (!scrollContainer || !horizontalTrack || !cards?.length) return;
    
    // Only snap if we are distinctly within the scroll container bounds
    // We want to avoid snapping if the user is transitioning in/out of the section.
    const rect = scrollContainer.getBoundingClientRect();
    const containerHeight = rect.height;
    const scrollDistance = containerHeight - windowHeight;
    if (!Number.isFinite(scrollDistance) || scrollDistance <= 0) return;
    
    // Check if we are in the "active sticky" region.
    // Sticky is active roughly when rect.top <= 0 and rect.bottom >= windowHeight.
    // However, we want to allow smooth exit/entry.
    
    // Defining margins in pixels where we disable snapping
    const snapMargin = 100; // 100px buffer zone at top and bottom

    // If rect.top is > -snapMargin, we are near the start (scrolling up to header). Don't snap.
    if (rect.top > -snapMargin) return;
    
    // If rect.bottom < windowHeight + snapMargin, we are near the end (scrolling down to footer). Don't snap.
    // rect.bottom = rect.top + containerHeight
    // So if (rect.top + containerHeight) < windowHeight + snapMargin
    if (rect.bottom < windowHeight + snapMargin) return;

    snapTimeout = setTimeout(() => {
        // ... (rest of logic same as before)
        
        // Output from previous turn ends here, I need to complete the function body I'm replacing
        
        // Current progress (0 to 1) based on scroll
        // progress = -rect.top / scrollDistance
        // We need to match this to the nearest card center.
        
        // 1. Calculate target translations for all cards to be centered
        const viewportWidth = window.innerWidth;
        const trackWidth = horizontalTrack.scrollWidth;
        const maxTranslate = trackWidth - viewportWidth; 
        if (!Number.isFinite(maxTranslate) || maxTranslate <= 0) return;
        
        // Current translation
        const currentProgress = Math.max(0, Math.min(1, -rect.top / scrollDistance));
        const currentTranslate = -(currentProgress * maxTranslate);

        let closestCardIndex = 0;
        let minDistance = Infinity;
        let targetProgress = 0;

        cards.forEach((card, index) => {
            // Calculate where this card's center is in the track
            const cardLeft = card.offsetLeft;
            const cardWidth = card.offsetWidth;
            const cardCenter = cardLeft + (cardWidth / 2);
            
            // To center this card, we need a translation X such that:
            // cardCenter + X = viewportWidth / 2
            // So X = (viewportWidth / 2) - cardCenter
            
            // However, X is constrained between 0 and -maxTranslate.
            // Actually, usually X is negative (sliding left).
            // Let's call requiredTranslate the value we need.
            let requiredTranslate = (viewportWidth / 2) - cardCenter;
            
            // Clamp it to legal bounds [ -maxTranslate, 0 ]
            // Note: maxTranslate is positive number representing magnitude.
            // transform is negative.
            // So range is [-maxTranslate, 0]
            requiredTranslate = Math.max(-maxTranslate, Math.min(0, requiredTranslate));
            
            // What "progress" does this correspond to?
            // currentTranslate = -(progress * maxTranslate)
            // progress = -currentTranslate / maxTranslate
            let cardProgress = -requiredTranslate / maxTranslate;
            
            // Check if this card is closest to current scroll state
            const dist = Math.abs(cardProgress - currentProgress);
            if (dist < minDistance) {
                minDistance = dist;
                closestCardIndex = index;
                targetProgress = cardProgress;
            }
        });

        // Calculate the absolute scroll position target
        const absoluteContainerTop = window.scrollY + rect.top; // Valid property of the element in doc
        const snapScrollY = absoluteContainerTop + (targetProgress * scrollDistance);

        // Snap
        if (Math.abs(window.scrollY - snapScrollY) > 5) {
            window.scrollTo({
                top: snapScrollY,
                behavior: 'smooth'
            });
        }

    }, 150);
};

const updateScroll = () => {
    if (isMobileLayout()) {
        updateMobileTrackProgress();
        return;
    }
    if (!scrollContainer || !horizontalTrack) return;

    const rect = scrollContainer.getBoundingClientRect();
    const containerTop = rect.top;
    const containerHeight = rect.height;
    
    // Calculate progress: 0 when container starts entering viewport (or hits top), 1 when it ends.
    // Sticky starts when rect.top <= 0.
    // Sticky ends when rect.bottom <= windowHeight.
    
    const scrollDistance = containerHeight - windowHeight;
    if (!Number.isFinite(scrollDistance) || scrollDistance <= 0) {
        horizontalTrack.style.transform = 'translate3d(0, 0, 0)';
        if (timelineFillBottom) timelineFillBottom.style.width = '0%';
        if (timelineFillTrack) timelineFillTrack.style.width = '0%';
        return;
    }
    let progress = -containerTop / scrollDistance;
    
    // Clamp progress 0 to 1
    progress = Math.max(0, Math.min(1, progress));

    // Move Track
    // We want to transform the track to the left.
    // Max translation = trackWidth - viewportWidth
    // To center the last card, we subtract viewportWidth but might need adjustment based on gaps/padding.
    // Better: Calculate total scrollable width
    
    // Center the first card initially:
    // It is centered by CSS defaults (flexbox centering in HTML?), or we align it.
    // Let's assume standard left-to-right scroll.
    
    const trackWidth = horizontalTrack.scrollWidth;
    const viewportWidth = window.innerWidth;
    
    // We want to scroll until the *last* card is centered or fully visible.
    // Actually, let's map it so card N is centered at progress N/Total.
    
    // Total translation needed to see the last card.
    // If cards are `70vw`, and we have 5 cards + gaps.
    // We want the last card to be centered.
    // Center of last card is at: (Width - cardWidth/2 - paddingRight) approx?
    // Let's just scroll the full width minus one screen width (plus some margin).
    
    const maxTranslate = trackWidth - viewportWidth; 
    if (!Number.isFinite(maxTranslate) || maxTranslate <= 0) {
        horizontalTrack.style.transform = 'translate3d(0, 0, 0)';
        const percentageFallback = `${progress * 100}%`;
        if (timelineFillBottom) timelineFillBottom.style.width = percentageFallback;
        if (timelineFillTrack) timelineFillTrack.style.width = percentageFallback;
        return;
    }
    
    // Refined Progress Mapping for Centering
    // We can just translate linearly. 
    // To ensure "snapping" visuals align with "snapping" scroll, linear is best.

    const translateX = -(progress * maxTranslate);
    
    if (rect.top <= 0 && rect.bottom >= windowHeight) {
        horizontalTrack.style.transform = `translate3d(${translateX}px, 0, 0)`;
    } else if (rect.top > 0) {
        horizontalTrack.style.transform = `translate3d(0, 0, 0)`;
    } else {
        horizontalTrack.style.transform = `translate3d(${-maxTranslate}px, 0, 0)`;
    }

    // Update Timeline Fill (Bottom)
    const percentage = `${progress * 100}%`;
    if (timelineFillBottom) timelineFillBottom.style.width = percentage;
    if (timelineFillTrack) timelineFillTrack.style.width = percentage;

    // Active Card & Snapping Visuals
    // Find centered card based on translation
    const currentTranslate = Math.abs(translateX);
    const centerPoint = currentTranslate + (viewportWidth / 2);
    
    cards?.forEach(card => {
        const cardLeft = card.offsetLeft;
        const cardWidth = card.offsetWidth;
        const cardCenter = cardLeft + (cardWidth / 2);
        
        // Check distance to visual center
        const dist = Math.abs(centerPoint - cardCenter);
        const isClose = dist < (cardWidth / 1.5); // Threshold

        if (isClose) {
            card.classList.add('active');
        } else {
            card.classList.remove('active');
        }
    });

    // Parallax Header Opacity & Scroll Hint
    const header = document.getElementById('section-header');
    if (header) {
        // "fade out instantly" - start fade at 0, end at 0.05
        const fadeEnd = 0.05;
        if (progress > fadeEnd) {
            header.style.opacity = '0';
        } else {
            // Map 0 -> 1 to fadeEnd -> 0
            const opacity = 1 - (progress / fadeEnd);
            header.style.opacity = Math.max(0, opacity).toString();
        }
     
        if (progress > 0) {
            header.style.pointerEvents = 'none';
        } else {
             // header.style.pointerEvents = 'auto'; // It's pointer-events-none in CSS anyway essentially
        }
    }
    
    // Also fade out buttons/controls if needed? No, user wants controls.
};

// --- PLAYER ---

let youtubePlayer;
let isPlayerReady = false;
let isUserSeeking = false;
let playerUiInterval = null;
let pendingSeekTime = 0;
let optimisticTimelineSeconds = null;
let optimisticTimelineLastTick = 0;
let seekHoldTargetSeconds = null;
let youtubeApiRetryCount = 0;
const MAX_YOUTUBE_API_RETRIES = 50;
let youtubeApiReadyPromise = null;

const PLAYBACK_MEMORY_KEY = 'episodePlaybackPositions';
const COMMENTS_COLLECTION = 'episodeComments';
const COMMENT_MAX_LENGTH = 500;
const DEFAULT_QUALITY = 'hd1080';
const QUALITY_PRIORITY = ['highres', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];

const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const sanitizeImageUrl = (url, fallback = '../images/logo-light.webp') => {
    if (typeof url !== 'string' || !url.trim()) return fallback;

    try {
        const parsed = new URL(url, window.location.origin);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.href;
        }
    } catch {
        return fallback;
    }

    return fallback;
};

const formatPlaybackTime = (seconds) => {
    const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    const hours = Math.floor(safeSeconds / 3600);
    const mins = Math.floor((safeSeconds % 3600) / 60);
    const secs = safeSeconds % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const formatEpisodeDescription = (text) => {
    if (!text || typeof text !== 'string') {
        return 'Descriere indisponibilă momentan.';
    }

    const compact = text.replace(/\s+/g, ' ').trim();
    if (!compact) return 'Descriere indisponibilă momentan.';

    return compact.length > 320 ? `${compact.slice(0, 320).trim()}...` : compact;
};

const getLoginRoute = () => {
    const normalizedPath = window.location.pathname.replaceAll('\\', '/');
    return normalizedPath.includes('/src/') ? './login.html' : './src/login.html';
};

const getCommentDisplayName = (user) => {
    const fromProfile = typeof user?.displayName === 'string' ? user.displayName.trim() : '';
    if (fromProfile) return fromProfile;

    const email = typeof user?.email === 'string' ? user.email.trim() : '';
    if (email) {
        return email.split('@')[0] || 'Utilizator';
    }

    return 'Utilizator';
};

const formatCommentTimestamp = (value) => {
    const dateValue = value?.toDate?.() || (value instanceof Date ? value : null);
    if (!dateValue) return 'Acum câteva momente';

    try {
        return new Intl.DateTimeFormat('ro-RO', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }).format(dateValue);
    } catch {
        return 'Acum câteva momente';
    }
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

const isCurrentUserAdmin = () => Boolean(currentAuthClaims?.admin);

const canManageComment = (comment) => {
    const uid = currentAuthUser?.uid;
    if (!uid) return false;

    return Boolean(comment?.authorUid === uid || isCurrentUserAdmin());
};

const getCommentsElements = () => ({
    list: document.getElementById('comments-list'),
    status: document.getElementById('comments-status'),
    count: document.getElementById('comments-count'),
    form: document.getElementById('comment-form'),
    input: document.getElementById('comment-input'),
    submit: document.getElementById('comment-submit'),
    authNote: document.getElementById('comment-auth-note')
});

const setCommentsStatus = (message = '') => {
    const { status } = getCommentsElements();
    if (!status) return;

    status.textContent = message;
    status.classList.toggle('hidden', !message);
};

const updateCommentFormState = () => {
    const { input, submit, authNote } = getCommentsElements();
    const isSignedIn = Boolean(currentAuthUser);

    if (input) {
        input.disabled = !isSignedIn;
        input.placeholder = isSignedIn
            ? 'Scrie un comentariu (max 500 caractere)...'
            : 'Autentifică-te pentru a adăuga un comentariu.';
    }

    if (submit) {
        submit.disabled = !isSignedIn || isSubmittingComment;
        submit.textContent = isSubmittingComment ? 'Se trimite...' : 'Comentează';
    }

    if (authNote) {
        if (isSignedIn) {
            const safeName = escapeHtml(getCommentDisplayName(currentAuthUser));
            authNote.innerHTML = `Comentezi ca <strong class="text-white/80">${safeName}</strong>`;
            return;
        }

        authNote.innerHTML = `Trebuie să fii autentificat pentru a comenta. <a href="${getLoginRoute()}" class="text-primary hover:underline">Login</a>`;
    }
};

const renderCommentSkeletons = (count = 3) => {
    const { list } = getCommentsElements();
    if (!list) return;

    list.innerHTML = Array.from({ length: count }, () => `
        <li class="skeleton-comment" aria-hidden="true">
            <div class="skeleton-comment-head">
                <div class="skeleton-comment-avatar skeleton-shimmer"></div>
                <div class="skeleton-comment-name skeleton-shimmer"></div>
                <div class="skeleton-comment-time skeleton-shimmer"></div>
            </div>
            <div class="skeleton-comment-body skeleton-shimmer"></div>
            <div class="skeleton-comment-body-short skeleton-shimmer"></div>
        </li>
    `).join('');
};

const renderComments = (comments = []) => {
    const { list, count } = getCommentsElements();
    if (!list || !count) return;

    commentsById.clear();
    comments.forEach((comment) => {
        if (comment?.id) {
            commentsById.set(comment.id, comment);
        }
    });

    count.textContent = String(comments.length);

    if (!comments.length) {
        list.innerHTML = '';
        setCommentsStatus('Nu există comentarii încă. Fii primul care comentează.');
        return;
    }

    setCommentsStatus('');

    list.innerHTML = comments.map((comment) => {
        const safeAuthor = escapeHtml(comment.authorName || 'Utilizator');
        const safeBody = escapeHtml(comment.body || '').replaceAll('\n', '<br>');
        const safeTime = escapeHtml(formatCommentTimestamp(comment.createdAt));
        const safeCommentId = escapeHtml(comment.id || '');
        const controls = canManageComment(comment)
            ? `
                <div class="comment-item-actions">
                    <button type="button" class="comment-action-btn" data-comment-action="edit" data-comment-id="${safeCommentId}">Editează</button>
                    <button type="button" class="comment-action-btn comment-action-btn-danger" data-comment-action="delete" data-comment-id="${safeCommentId}">Șterge</button>
                </div>
            `
            : '';

        return `
            <li class="comment-item">
                <div class="comment-item-head">
                    <div class="comment-item-meta">
                        <span class="comment-author">${safeAuthor}</span>
                        <time class="comment-time">${safeTime}</time>
                    </div>
                    ${controls}
                </div>
                <p class="comment-body">${safeBody}</p>
            </li>
        `;
    }).join('');
};

const loadEpisodeComments = async (episodeId) => {
    const { list, count } = getCommentsElements();
    if (!episodeId || !list || !count || !db || !collectionFn || !queryFn || !orderByFn || !limitFn || !getDocsFn) return;

    const requestId = ++activeCommentsRequestId;
    count.textContent = '0';
    setCommentsStatus('');
    renderCommentSkeletons(3);

    try {
        const commentsRef = collectionFn(db, COMMENTS_COLLECTION, episodeId, 'items');
        const commentsQuery = queryFn(commentsRef, orderByFn('createdAt', 'desc'), limitFn(50));
        const snapshot = await getDocsFn(commentsQuery);

        if (requestId !== activeCommentsRequestId) return;

        const comments = snapshot.docs.map((docSnap) => {
            const data = docSnap.data() || {};
            return {
                id: docSnap.id,
                authorName: data.authorName || 'Utilizator',
                authorUid: typeof data.authorUid === 'string' ? data.authorUid : '',
                body: typeof data.body === 'string' ? data.body : '',
                createdAt: data.createdAt || null
            };
        }).filter((item) => item.body.trim());

        renderComments(comments);
    } catch (error) {
        console.error('Failed to load comments', error);
        if (requestId !== activeCommentsRequestId) return;
        setCommentsStatus('Nu am putut încărca comentariile. Încearcă din nou.');
    }
};

const handleCommentSubmit = async (event) => {
    event.preventDefault();

    const episodeId = playerState.currentEpisode?.videoId;
    const { input } = getCommentsElements();
    if (!episodeId || !input || isSubmittingComment) return;

    if (!currentAuthUser) {
        updateCommentFormState();
        return;
    }

    const body = String(input.value || '').trim();
    if (!body) {
        setCommentsStatus('Comentariul nu poate fi gol.');
        return;
    }

    if (body.length > COMMENT_MAX_LENGTH) {
        setCommentsStatus(`Comentariul poate avea maxim ${COMMENT_MAX_LENGTH} caractere.`);
        return;
    }

    isSubmittingComment = true;
    updateCommentFormState();
    setCommentsStatus('Se publică comentariul...');

    try {
        if (!db || !collectionFn || !addDocFn || !serverTimestampFn) {
            setCommentsStatus('Comentariile nu sunt disponibile momentan. Încearcă din nou.');
            return;
        }

        const commentsRef = collectionFn(db, COMMENTS_COLLECTION, episodeId, 'items');
        await addDocFn(commentsRef, {
            body,
            authorUid: currentAuthUser.uid,
            authorName: getCommentDisplayName(currentAuthUser),
            authorEmail: currentAuthUser.email || '',
            createdAt: serverTimestampFn()
        });

        input.value = '';
        await loadEpisodeComments(episodeId);
        setCommentsStatus('Comentariul a fost publicat.');
    } catch (error) {
        console.error('Failed to post comment', error);
        setCommentsStatus('Nu am putut publica comentariul. Verifică autentificarea și încearcă din nou.');
    } finally {
        isSubmittingComment = false;
        updateCommentFormState();
    }
};

const setCommentActionButtonsDisabled = (isDisabled) => {
    const { list } = getCommentsElements();
    if (!list) return;

    list.querySelectorAll('.comment-action-btn').forEach((button) => {
        button.disabled = isDisabled;
    });
};

const handleCommentActions = async (event) => {
    const actionButton = event.target?.closest?.('[data-comment-action]');
    if (!actionButton || isCommentActionPending) return;

    const episodeId = playerState.currentEpisode?.videoId;
    const commentId = actionButton.getAttribute('data-comment-id') || '';
    const action = actionButton.getAttribute('data-comment-action') || '';
    const comment = commentsById.get(commentId);

    if (!episodeId || !comment || !commentId) return;
    if (!canManageComment(comment)) {
        setCommentsStatus('Poți edita sau șterge doar comentariile tale.');
        return;
    }

    if (!db || !docFn) {
        setCommentsStatus('Comentariile nu sunt disponibile momentan.');
        return;
    }

    const commentRef = docFn(db, COMMENTS_COLLECTION, episodeId, 'items', commentId);

    if (action === 'delete') {
        const shouldDelete = window.confirm('Vrei să ștergi acest comentariu?');
        if (!shouldDelete) return;

        isCommentActionPending = true;
        setCommentActionButtonsDisabled(true);
        setCommentsStatus('Se șterge comentariul...');

        try {
            if (!deleteDocFn) throw new Error('Delete action unavailable');
            await deleteDocFn(commentRef);
            await loadEpisodeComments(episodeId);
            setCommentsStatus('Comentariul a fost șters.');
        } catch (error) {
            console.error('Failed to delete comment', error);
            setCommentsStatus('Nu am putut șterge comentariul. Încearcă din nou.');
        } finally {
            isCommentActionPending = false;
            setCommentActionButtonsDisabled(false);
        }

        return;
    }

    if (action === 'edit') {
        const draft = window.prompt('Editează comentariul:', comment.body || '');
        if (draft === null) return;

        const nextBody = String(draft).trim();
        if (!nextBody) {
            setCommentsStatus('Comentariul nu poate fi gol.');
            return;
        }

        if (nextBody.length > COMMENT_MAX_LENGTH) {
            setCommentsStatus(`Comentariul poate avea maxim ${COMMENT_MAX_LENGTH} caractere.`);
            return;
        }

        if (nextBody === (comment.body || '').trim()) {
            setCommentsStatus('Nu există modificări de salvat.');
            return;
        }

        isCommentActionPending = true;
        setCommentActionButtonsDisabled(true);
        setCommentsStatus('Se actualizează comentariul...');

        try {
            if (!updateDocFn) throw new Error('Update action unavailable');
            await updateDocFn(commentRef, { body: nextBody });
            await loadEpisodeComments(episodeId);
            setCommentsStatus('Comentariul a fost actualizat.');
        } catch (error) {
            console.error('Failed to update comment', error);
            setCommentsStatus('Nu am putut actualiza comentariul. Încearcă din nou.');
        } finally {
            isCommentActionPending = false;
            setCommentActionButtonsDisabled(false);
        }
    }
};

const setupComments = () => {
    if (commentsSetupPromise) {
        return commentsSetupPromise;
    }

    commentsSetupPromise = (async () => {
        try {
            await ensureFirebaseReady();
        } catch {
            setCommentsStatus('Comentariile sunt indisponibile momentan.');
            updateCommentFormState();
            return;
        }

    const { form, list } = getCommentsElements();
    if (!form || !list) return;

    form.addEventListener('submit', handleCommentSubmit);
    list.addEventListener('click', handleCommentActions);
    onAuthStateChangedFn(auth, async (user) => {
        currentAuthUser = user || null;
        currentAuthClaims = currentAuthUser ? await getUserClaims(currentAuthUser) : {};
        updateCommentFormState();

        const episodeId = playerState.currentEpisode?.videoId;
        if (episodeId) {
            loadEpisodeComments(episodeId);
        }
    });

    updateCommentFormState();
    })();

    return commentsSetupPromise;
};

const updateRangeProgress = (rangeInput, activeColor = 'rgba(88, 199, 214, 1)', trackColor = 'rgba(255, 255, 255, 0.22)') => {
    if (!rangeInput) return;

    const min = Number(rangeInput.min || 0);
    const max = Number(rangeInput.max || 100);
    const value = Number(rangeInput.value || 0);
    const safeMax = max > min ? max : min + 1;
    const percent = ((value - min) / (safeMax - min)) * 100;
    const clamped = Math.max(0, Math.min(100, percent));

    rangeInput.style.background = `linear-gradient(to right, ${activeColor} 0%, ${activeColor} ${clamped}%, ${trackColor} ${clamped}%, ${trackColor} 100%)`;
};

const getEpisodeDisplayNumber = (index) => {
    if (index < 0) return null;
    return sortOrder === 'desc' ? (episodes.length - index) : (index + 1);
};

const readPlaybackMemory = () => {
    try {
        const raw = localStorage.getItem(PLAYBACK_MEMORY_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
};

const writePlaybackMemory = (data) => {
    try {
        localStorage.setItem(PLAYBACK_MEMORY_KEY, JSON.stringify(data));
    } catch {
        return;
    }
};

const savePlaybackPosition = (videoId, seconds) => {
    if (!videoId || !Number.isFinite(seconds)) return;

    const memory = readPlaybackMemory();
    memory[videoId] = Math.max(0, Math.floor(seconds));
    writePlaybackMemory(memory);
};

const getPlaybackPosition = (videoId) => {
    if (!videoId) return 0;

    const memory = readPlaybackMemory();
    const value = memory[videoId];
    return Number.isFinite(value) ? Math.max(0, value) : 0;
};

const updatePlayButtonState = (isPlaying) => {
    const label = document.getElementById('player-play-label');
    const playIcon = document.getElementById('player-icon-play');
    const pauseIcon = document.getElementById('player-icon-pause');

    if (label) label.textContent = isPlaying ? 'Playing' : 'Paused';
    playIcon?.classList.toggle('hidden', isPlaying);
    pauseIcon?.classList.toggle('hidden', !isPlaying);
};

const updateTimelineUI = () => {
    if (!youtubePlayer || !isPlayerReady) return;

    const seek = document.getElementById('player-seek');
    const currentTimeEl = document.getElementById('player-current-time');
    const durationEl = document.getElementById('player-duration');

    const duration = Number(youtubePlayer.getDuration?.() || 0);
    const actualCurrent = Number(youtubePlayer.getCurrentTime?.() || 0);
    const isPlaying = youtubePlayer.getPlayerState?.() === window.YT?.PlayerState?.PLAYING;

    const now = performance.now();
    if (optimisticTimelineSeconds !== null) {
        if (optimisticTimelineLastTick > 0 && isPlaying) {
            const deltaSeconds = (now - optimisticTimelineLastTick) / 1000;
            optimisticTimelineSeconds = Math.min(duration || Infinity, optimisticTimelineSeconds + deltaSeconds);
        }
        optimisticTimelineLastTick = now;

        if (seekHoldTargetSeconds !== null) {
            if (actualCurrent >= seekHoldTargetSeconds - 0.6) {
                seekHoldTargetSeconds = null;
                optimisticTimelineSeconds = null;
                optimisticTimelineLastTick = 0;
            }
        } else if (actualCurrent >= optimisticTimelineSeconds - 0.6 || !isPlaying) {
            optimisticTimelineSeconds = null;
            optimisticTimelineLastTick = 0;
        }
    }

    let current = actualCurrent;
    if (seekHoldTargetSeconds !== null) {
        current = optimisticTimelineSeconds !== null
            ? Math.max(seekHoldTargetSeconds, optimisticTimelineSeconds)
            : Math.max(seekHoldTargetSeconds, actualCurrent);
    } else if (optimisticTimelineSeconds !== null) {
        current = Math.max(actualCurrent, optimisticTimelineSeconds);
    }

    if (!isUserSeeking && seek) {
        seek.max = String(duration || 0);
        seek.value = String(current);
        updateRangeProgress(seek);
    }

    if (currentTimeEl) currentTimeEl.textContent = formatPlaybackTime(current);
    if (durationEl) durationEl.textContent = formatPlaybackTime(duration);

    if (playerState.currentEpisode?.videoId) {
        savePlaybackPosition(playerState.currentEpisode.videoId, current);
    }
};

const startTimelineSync = () => {
    clearInterval(playerUiInterval);
    playerUiInterval = setInterval(updateTimelineUI, 300);
};

const stopTimelineSync = () => {
    clearInterval(playerUiInterval);
    playerUiInterval = null;
};

const applyInitialPlayerSettings = () => {
    const volumeInput = document.getElementById('player-volume');
    const speedSelect = document.getElementById('player-speed');

    const volumeValue = Number(volumeInput?.value || 80);
    updateRangeProgress(volumeInput);
    if (youtubePlayer?.setVolume) {
        youtubePlayer.setVolume(volumeValue);
        if (volumeValue === 0) {
            youtubePlayer.mute?.();
        } else {
            youtubePlayer.unMute?.();
        }
    }

    const rate = Number(speedSelect?.value || 1);
    if (youtubePlayer?.setPlaybackRate && Number.isFinite(rate)) {
        youtubePlayer.setPlaybackRate(rate);
    }
};

const applyPendingSeek = () => {
    if (!youtubePlayer || !isPlayerReady || pendingSeekTime <= 0) return;
    youtubePlayer.seekTo(pendingSeekTime, true);
    pendingSeekTime = 0;
};

const seekBy = (delta) => {
    if (!youtubePlayer || !isPlayerReady) return;

    const current = Number(youtubePlayer.getCurrentTime?.() || 0);
    const duration = Number(youtubePlayer.getDuration?.() || 0);
    const next = Math.max(0, Math.min(duration || current + delta, current + delta));
    seekHoldTargetSeconds = next;
    optimisticTimelineSeconds = next;
    optimisticTimelineLastTick = performance.now();
    youtubePlayer.seekTo(next, true);
    updateTimelineUI();
};

const isFullscreenActive = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);

const setFullscreenButtonState = () => {
    const isActive = isFullscreenActive();
    const fullscreenBtn = document.getElementById('player-fullscreen');
    const enterIcon = document.getElementById('player-icon-full-enter');
    const exitIcon = document.getElementById('player-icon-full-exit');

    if (fullscreenBtn) {
        fullscreenBtn.setAttribute('aria-label', isActive ? 'Ieși din fullscreen' : 'Fullscreen');
    }

    enterIcon?.classList.toggle('hidden', isActive);
    exitIcon?.classList.toggle('hidden', !isActive);
};

const togglePlayerFullscreen = async () => {
    const stage = document.getElementById('player-stage');
    if (!stage) return;

    try {
        if (isFullscreenActive()) {
            if (document.exitFullscreen) {
                await document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } else if (stage.requestFullscreen) {
            await stage.requestFullscreen();
        } else if (stage.webkitRequestFullscreen) {
            stage.webkitRequestFullscreen();
        }
    } catch {
        return;
    }

    setFullscreenButtonState();
};

const applyBestVideoQuality = () => {
    if (!youtubePlayer || !isPlayerReady) return;

    const levels = youtubePlayer.getAvailableQualityLevels?.() || [];
    if (!levels.length) return;

    const chosenQuality = levels.includes(DEFAULT_QUALITY)
        ? DEFAULT_QUALITY
        : QUALITY_PRIORITY.find((quality) => levels.includes(quality));
    if (!chosenQuality) return;

    youtubePlayer.setPlaybackQuality?.(chosenQuality);
    youtubePlayer.setPlaybackQualityRange?.(chosenQuality, chosenQuality);
};

const scheduleQualityEnforcement = () => {
    [100, 500, 1500, 3000].forEach((delay) => {
        setTimeout(() => {
            applyBestVideoQuality();
        }, delay);
    });
};

const togglePlayPause = () => {
    if (!youtubePlayer || !isPlayerReady) return;
    const state = youtubePlayer.getPlayerState?.();
    if (state === window.YT?.PlayerState?.PLAYING) {
        youtubePlayer.pauseVideo?.();
    } else {
        youtubePlayer.playVideo?.();
    }
};

const setupPlayerControls = () => {
    const playPauseBtn = document.getElementById('player-play-pause');
    const backwardBtn = document.getElementById('player-backward');
    const forwardBtn = document.getElementById('player-forward');
    const muteBtn = document.getElementById('player-mute');
    const seekInput = document.getElementById('player-seek');
    const volumeInput = document.getElementById('player-volume');
    const speedSelect = document.getElementById('player-speed');
    const fullscreenBtn = document.getElementById('player-fullscreen');

    playPauseBtn?.addEventListener('click', () => {
        togglePlayPause();
    });

    backwardBtn?.addEventListener('click', () => seekBy(-10));
    forwardBtn?.addEventListener('click', () => seekBy(10));

    seekInput?.addEventListener('input', () => {
        isUserSeeking = true;
        updateRangeProgress(seekInput);
        const currentTimeEl = document.getElementById('player-current-time');
        if (currentTimeEl) {
            currentTimeEl.textContent = formatPlaybackTime(Number(seekInput.value));
        }
    });

    seekInput?.addEventListener('change', () => {
        if (!youtubePlayer || !isPlayerReady) {
            isUserSeeking = false;
            return;
        }
        const seekValue = Number(seekInput.value);
        seekHoldTargetSeconds = seekValue;
        optimisticTimelineSeconds = seekValue;
        optimisticTimelineLastTick = performance.now();
        youtubePlayer.seekTo(seekValue, true);
        isUserSeeking = false;
        updateTimelineUI();
    });

    volumeInput?.addEventListener('input', () => {
        if (!youtubePlayer || !isPlayerReady) return;
        updateRangeProgress(volumeInput);
        const volume = Number(volumeInput.value);
        youtubePlayer.setVolume?.(volume);
        if (volume === 0) {
            youtubePlayer.mute?.();
            if (muteBtn) muteBtn.textContent = 'Unmute';
        } else {
            youtubePlayer.unMute?.();
            if (muteBtn) muteBtn.textContent = 'Mute';
        }
    });

    muteBtn?.addEventListener('click', () => {
        if (!youtubePlayer || !isPlayerReady) return;
        if (youtubePlayer.isMuted?.()) {
            youtubePlayer.unMute?.();
            muteBtn.textContent = 'Mute';
            if (volumeInput && Number(volumeInput.value) === 0) {
                volumeInput.value = '80';
                youtubePlayer.setVolume?.(80);
            }
        } else {
            youtubePlayer.mute?.();
            muteBtn.textContent = 'Unmute';
        }
    });

    speedSelect?.addEventListener('change', () => {
        if (!youtubePlayer || !isPlayerReady) return;
        const rate = Number(speedSelect.value);
        if (Number.isFinite(rate)) {
            youtubePlayer.setPlaybackRate?.(rate);
        }
    });

    fullscreenBtn?.addEventListener('click', () => {
        togglePlayerFullscreen();
    });

    document.addEventListener('fullscreenchange', setFullscreenButtonState);
    document.addEventListener('webkitfullscreenchange', setFullscreenButtonState);
    setFullscreenButtonState();
};

const setupPlayer = () => {
    // Close Button
    document.getElementById('close-player')?.addEventListener('click', closePlayer);
    document.getElementById('player-modal')?.addEventListener('click', (event) => {
        if (event.target?.id === 'player-modal') {
            closePlayer();
        }
    });
    document.getElementById('player-modal')?.setAttribute('role', 'dialog');
    document.getElementById('player-modal')?.setAttribute('aria-modal', 'true');
    
    // Mode Toggles
    document.getElementById('mode-video')?.addEventListener('click', () => setPlayerMode('video'));
    document.getElementById('mode-audio')?.addEventListener('click', () => setPlayerMode('audio'));
    setupPlayerControls();
    setupComments();

    // Keyboard 'Escape'
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && playerState.isOpen) {
            closePlayer();
            return;
        }

        if (!playerState.isOpen) return;

        const activeTag = document.activeElement?.tagName;
        if (activeTag === 'INPUT' || activeTag === 'SELECT' || activeTag === 'TEXTAREA') return;

        if (e.key === 'ArrowRight') {
            e.preventDefault();
            seekBy(10);
            return;
        }

        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            seekBy(-10);
            return;
        }

        if (e.key === ' ' || e.key.toLowerCase() === 'k') {
            e.preventDefault();
            togglePlayPause();
            return;
        }

        if (e.key.toLowerCase() === 'm') {
            e.preventDefault();
            document.getElementById('player-mute')?.click();
            return;
        }

        if (e.key.toLowerCase() === 'f') {
            e.preventDefault();
            togglePlayerFullscreen();
        }
    });

    window.addEventListener('popstate', () => {
        if (!window.location.hash && playerState.isOpen) {
            closePlayer();
        }
    });
};

const ensureYouTubeApiReady = () => {
    if (window.YT?.Player) {
        return Promise.resolve();
    }

    if (youtubeApiReadyPromise) {
        return youtubeApiReadyPromise;
    }

    youtubeApiReadyPromise = new Promise((resolve, reject) => {
        const previousOnReady = window.onYouTubeIframeAPIReady;
        let settled = false;

        const finalizeReady = () => {
            if (settled) return;
            settled = true;
            if (typeof previousOnReady === 'function') {
                try {
                    previousOnReady();
                } catch {
                    return;
                }
            }
            resolve();
        };

        window.onYouTubeIframeAPIReady = finalizeReady;

        const existingTag = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
        if (!existingTag) {
            const tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';
            tag.async = true;
            tag.onerror = () => {
                if (settled) return;
                settled = true;
                reject(new Error('Failed to load YouTube Iframe API'));
            };
            const firstScriptTag = document.getElementsByTagName('script')[0];
            firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
        }

        setTimeout(() => {
            if (settled) return;
            if (window.YT?.Player) {
                finalizeReady();
                return;
            }
            settled = true;
            reject(new Error('Timed out waiting for YouTube Iframe API'));
        }, 10000);
    }).catch((error) => {
        youtubeApiReadyPromise = null;
        throw error;
    });

    return youtubeApiReadyPromise;
};

const openPlayer = (episode) => {
    ensurePlayerSetup();
    playerState.isOpen = true;
    playerState.currentEpisode = episode;
    lastFocusedElement = document.activeElement;
    
    const modal = document.getElementById('player-modal');
    modal.classList.add('open', 'modal-open');
    modal.classList.remove('opacity-0', 'pointer-events-none');
    modal.classList.add('opacity-100', 'pointer-events-auto');
    modal.setAttribute('aria-hidden', 'false');
    modal.removeAttribute('inert');
    modal.classList.remove('scale-95');
    modal.classList.add('scale-100');
    document.body.classList.add('player-open');
    
    // Update Content
    document.getElementById('player-title').textContent = episode.title;
    document.getElementById('player-desc').textContent = formatEpisodeDescription(episode.description);
    document.getElementById('player-date').textContent = formatDate(episode.publishedAt);
    const currentEpisodeIndex = episodes.findIndex((item) => item.videoId === episode.videoId);
    document.getElementById('player-episode-num').textContent = currentEpisodeIndex >= 0
        ? `EP ${String(getEpisodeDisplayNumber(currentEpisodeIndex)).padStart(2, '0')}`
        : 'EP --';

    const episodeCover = episode.thumbnails?.maxres?.url
        || episode.thumbnails?.high?.url
        || episode.thumbnails?.medium?.url
        || (episode.videoId ? `https://img.youtube.com/vi/${episode.videoId}/hqdefault.jpg` : '../images/logo-light.webp');
    const coverEl = document.getElementById('audio-cover');
    if (coverEl) {
        coverEl.src = episodeCover;
        coverEl.alt = `Copertă ${episode.title}`;
    }

    pendingSeekTime = getPlaybackPosition(episode.videoId);
    seekHoldTargetSeconds = pendingSeekTime || 0;
    optimisticTimelineSeconds = pendingSeekTime || 0;
    optimisticTimelineLastTick = performance.now();
    document.getElementById('player-current-time').textContent = formatPlaybackTime(pendingSeekTime);
    document.getElementById('player-duration').textContent = '00:00';
    const seek = document.getElementById('player-seek');
    if (seek) {
        seek.value = String(pendingSeekTime || 0);
        updateRangeProgress(seek);
    }

    setPlayerMode('video');
    updatePlayButtonState(false);
    document.getElementById('close-player')?.focus();
    
    // Update URL hash without reload
    history.replaceState(null, '', `#${encodeURIComponent(episode.videoId)}`);

    setupComments().then(() => {
        loadEpisodeComments(episode.videoId);
    });

    loadYoutubeVideo(episode.videoId);
};

const closePlayer = () => {
    if (playerState.currentEpisode?.videoId && youtubePlayer?.getCurrentTime) {
        const currentTime = Number(youtubePlayer.getCurrentTime() || 0);
        savePlaybackPosition(playerState.currentEpisode.videoId, currentTime);
    }

    playerState.isOpen = false;
    
    const modal = document.getElementById('player-modal');
    modal.classList.remove('open', 'modal-open');
    modal.classList.add('opacity-0', 'pointer-events-none');
    modal.classList.remove('opacity-100', 'pointer-events-auto');
    modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('inert', '');
    modal.classList.add('scale-95');
    modal.classList.remove('scale-100');
    document.body.classList.remove('player-open');
    setPlayerMode('video');
    stopTimelineSync();
    updatePlayButtonState(false);
    seekHoldTargetSeconds = null;
    optimisticTimelineSeconds = null;
    optimisticTimelineLastTick = 0;
    activeCommentsRequestId += 1;
    commentsById.clear();

    const { list, count } = getCommentsElements();
    if (list) list.innerHTML = '';
    if (count) count.textContent = '0';
    setCommentsStatus('');

    // Stop Video
    if (youtubePlayer && youtubePlayer.stopVideo) {
        youtubePlayer.stopVideo();
    }

    if (isFullscreenActive()) {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
    }

    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
        lastFocusedElement.focus();
    }
    
    // Clean URL
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
};

const loadYoutubeVideo = async (videoId) => {
    try {
        await ensureYouTubeApiReady();
    } catch (error) {
        console.error('YouTube API failed to load.', error);
        return;
    }

    youtubeApiRetryCount = 0;
    if (youtubePlayer) {
        isPlayerReady = true;
        youtubePlayer.cueVideoById({
            videoId,
            startSeconds: pendingSeekTime || 0,
            suggestedQuality: DEFAULT_QUALITY,
        });
        applyInitialPlayerSettings();
        startTimelineSync();
        scheduleQualityEnforcement();
        return;
    }

    youtubePlayer = new YT.Player('youtube-player-container', {
        height: '100%',
        width: '100%',
        videoId: videoId,
        host: 'https://www.youtube-nocookie.com',
        playerVars: {
            'playsinline': 1,
            'autoplay': 0,
            'controls': 0,
            'disablekb': 1,
            'fs': 0,
            'iv_load_policy': 3,
            'modestbranding': 1,
            'rel': 0,
            'cc_load_policy': 0,
            'vq': DEFAULT_QUALITY,
        },
        events: {
            'onReady': () => {
                isPlayerReady = true;
                youtubePlayer.cueVideoById({
                    videoId,
                    startSeconds: pendingSeekTime || 0,
                    suggestedQuality: DEFAULT_QUALITY,
                });
                applyInitialPlayerSettings();
                applyPendingSeek();
                startTimelineSync();
                updateTimelineUI();
                scheduleQualityEnforcement();
            },
            'onStateChange': onPlayerStateChange,
            'onPlaybackQualityChange': () => {
                applyBestVideoQuality();
            }
        }
    });
};

const setPlayerMode = (mode) => {
    playerState.mode = mode;
    
    const visualizer = document.getElementById('audio-visualizer');
    const videoContainer = document.getElementById('youtube-player-container');
    const playerStage = document.getElementById('player-stage');
    const btnVideo = document.getElementById('mode-video');
    const btnAudio = document.getElementById('mode-audio');

    if (!visualizer || !btnVideo || !btnAudio) return;

    if (mode === 'audio') {
        visualizer.classList.replace('hidden', 'flex');
        videoContainer?.classList.add('audio-hidden');
        playerStage?.classList.add('is-audio-mode');
        
        btnAudio.classList.add('active', 'bg-primary', 'text-slate-900');
        btnAudio.classList.remove('text-text-muted', 'hover:text-white', 'hover:bg-white/5', 'bg-white/10', 'text-white');
        
        btnVideo.classList.remove('active', 'bg-primary', 'text-slate-900', 'bg-white/10', 'text-white', 'shadow-sm');
        btnVideo.classList.add('text-text-muted', 'hover:text-white', 'hover:bg-white/5');
        btnVideo.setAttribute('aria-pressed', 'false');
        btnAudio.setAttribute('aria-pressed', 'true');
        
    } else {
        visualizer.classList.replace('flex', 'hidden');
        videoContainer?.classList.remove('audio-hidden');
        playerStage?.classList.remove('is-audio-mode');
        
        btnVideo.classList.add('active', 'bg-primary', 'text-slate-900');
        btnVideo.classList.remove('text-text-muted', 'hover:text-white', 'hover:bg-white/5', 'bg-white/10', 'text-white');
        
        btnAudio.classList.remove('active', 'bg-primary', 'text-slate-900');
        btnAudio.classList.add('text-text-muted', 'hover:text-white', 'hover:bg-white/5');
        btnVideo.setAttribute('aria-pressed', 'true');
        btnAudio.setAttribute('aria-pressed', 'false');
    }
};

const onPlayerStateChange = (event) => {
    const state = event?.data;

    if (state === window.YT?.PlayerState?.PLAYING) {
        updatePlayButtonState(true);
        startTimelineSync();
        applyBestVideoQuality();
        if (optimisticTimelineSeconds !== null && optimisticTimelineLastTick === 0) {
            optimisticTimelineLastTick = performance.now();
        }
        if (seekHoldTargetSeconds !== null && optimisticTimelineSeconds === null) {
            optimisticTimelineSeconds = seekHoldTargetSeconds;
            optimisticTimelineLastTick = performance.now();
        }
    } else {
        updatePlayButtonState(false);
    }

    if (state === window.YT?.PlayerState?.PAUSED || state === window.YT?.PlayerState?.ENDED) {
        updateTimelineUI();
    }

    if (state === window.YT?.PlayerState?.ENDED && playerState.currentEpisode?.videoId) {
        savePlaybackPosition(playerState.currentEpisode.videoId, 0);
    }
};

const checkUrlForEpisode = () => {
    const hash = decodeURIComponent(window.location.hash.substring(1)); // Remove #
    if (hash && episodes.length > 0) {
        const titleMatch = episodes.find(e => e.videoId === hash);
        if (titleMatch) {
            openPlayer(titleMatch);
        }
    }
};

// Run Init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
