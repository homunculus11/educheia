import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import {
    Timestamp,
    addDoc,
    collection,
    collectionGroup,
    deleteDoc,
    deleteField,
    doc,
    getDoc,
    getDocs,
    limit,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    setDoc,
    updateDoc,
    where,
    writeBatch
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

const BLOCK_TERMS = [
    'kill yourself',
    'self harm',
    'suicide method',
    'racial hate',
    'ethnic cleansing',
    'bomb tutorial',
    'credit card dump',
    'child porn',
    'sex with minors',
    'phishing kit',
    'nazi propaganda',
    'spam bot',
    'frauda rapida',
    'porno gratis'
];

const SUSPICIOUS_TERMS = [
    'free crypto',
    'earn instantly',
    'investment guaranteed',
    'binary options',
    'telegram signal',
    'urgent transfer',
    'click this link',
    'winner selected',
    'loan without checks'
];

const RATE_KEY = 'forumLocalRateV1';
const RATE_RULES = {
    thread: {
        cooldownMs: 45 * 1000,
        windowMs: 30 * 60 * 1000,
        maxItems: 3,
        repeatedWindowMs: 5 * 60 * 1000,
        repeatedMax: 2
    },
    comment: {
        cooldownMs: 12 * 1000,
        windowMs: 10 * 60 * 1000,
        maxItems: 12,
        repeatedWindowMs: 2 * 60 * 1000,
        repeatedMax: 3
    }
};

const MAX_THREADS_FETCH = 220;
const MAX_COMMENTS_FETCH = 220;

const state = {
    user: null,
    claims: {},
    role: {
        trustedCreator: false,
        reputation: 0,
        isBanned: false,
        threadRestrictedUntil: null,
        commentRestrictedUntil: null,
        threadCooldownUntil: null,
        commentCooldownUntil: null,
        reason: ''
    },
    categories: [],
    threads: [],
    comments: [],
    filters: {
        search: '',
        categoryType: 'all',
        categoryId: 'all'
    },
    selectedThreadId: null,
    pendingUrlThreadId: null,
    categorySlugManuallyEdited: false,
    moderationTarget: null,
    busy: {
        threadSubmit: false,
        commentSubmit: false,
        categorySubmit: false,
        moderationSubmit: false,
        threadDelete: false
    },
    unsubscribers: {
        categories: null,
        threads: null,
        comments: null,
        role: null
    }
};

const ui = {
    authStatus: document.getElementById('forum-auth-status'),
    globalFeedback: document.getElementById('forum-global-feedback'),

    searchInput: document.getElementById('forum-search-input'),
    typeFilter: document.getElementById('forum-type-filter'),
    categoryFilter: document.getElementById('forum-category-filter'),
    categoryChipList: document.getElementById('category-chip-list'),

    openCategoryModalBtn: document.getElementById('open-category-modal'),

    threadForm: document.getElementById('thread-form'),
    threadTitleInput: document.getElementById('thread-title-input'),
    threadBodyInput: document.getElementById('thread-body-input'),
    threadCategorySelect: document.getElementById('thread-category-select'),
    threadStickyToggle: document.getElementById('thread-sticky-toggle'),
    stickyToggleWrap: document.getElementById('sticky-toggle-wrap'),
    threadComposeNote: document.getElementById('thread-compose-note'),
    threadPolicyPill: document.getElementById('thread-policy-pill'),
    threadRateHint: document.getElementById('thread-rate-hint'),
    threadSubmitBtn: document.getElementById('thread-submit-btn'),

    stickyThreadsList: document.getElementById('sticky-threads-list'),
    communityThreadsList: document.getElementById('community-threads-list'),
    refreshThreadsBtn: document.getElementById('refresh-threads-btn'),

    selectedThreadEmpty: document.getElementById('selected-thread-empty'),
    selectedThreadShell: document.getElementById('selected-thread-shell'),
    selectedThreadCategory: document.getElementById('selected-thread-category'),
    selectedThreadStatus: document.getElementById('selected-thread-status'),
    selectedThreadTitle: document.getElementById('selected-thread-title'),
    selectedThreadMeta: document.getElementById('selected-thread-meta'),
    selectedThreadBody: document.getElementById('selected-thread-body'),

    selectedDeleteThreadBtn: document.getElementById('selected-delete-thread-btn'),
    selectedLockThreadBtn: document.getElementById('selected-lock-thread-btn'),
    selectedToggleVisibilityBtn: document.getElementById('selected-toggle-visibility-btn'),
    selectedRestrictUserBtn: document.getElementById('selected-restrict-user-btn'),

    commentsCount: document.getElementById('comments-count'),
    commentsStatus: document.getElementById('comments-status'),
    commentsList: document.getElementById('comments-list'),

    commentForm: document.getElementById('comment-form'),
    commentInput: document.getElementById('comment-input'),
    commentComposeNote: document.getElementById('comment-compose-note'),
    commentSubmitBtn: document.getElementById('comment-submit-btn'),

    categoryModal: document.getElementById('category-modal'),
    closeCategoryModalBtn: document.getElementById('close-category-modal'),
    categoryForm: document.getElementById('category-form'),
    categoryNameInput: document.getElementById('category-name-input'),
    categorySlugInput: document.getElementById('category-slug-input'),
    categoryDescriptionInput: document.getElementById('category-description-input'),
    categoryTypeSelect: document.getElementById('category-type-select'),
    categoryFormFeedback: document.getElementById('category-form-feedback'),
    categorySubmitBtn: document.getElementById('category-submit-btn'),

    moderationModal: document.getElementById('moderation-modal'),
    closeModerationModalBtn: document.getElementById('close-moderation-modal'),
    moderationForm: document.getElementById('moderation-form'),
    moderationTargetUid: document.getElementById('moderation-target-uid'),
    moderationTargetLabel: document.getElementById('moderation-target-label'),
    restrictThreadsCheckbox: document.getElementById('restrict-threads-checkbox'),
    restrictCommentsCheckbox: document.getElementById('restrict-comments-checkbox'),
    banUserCheckbox: document.getElementById('ban-user-checkbox'),
    restrictionDurationSelect: document.getElementById('restriction-duration-select'),
    purgeUserContentCheckbox: document.getElementById('purge-user-content-checkbox'),
    moderationReasonInput: document.getElementById('moderation-reason-input'),
    moderationFeedback: document.getElementById('moderation-feedback'),
    moderationSubmitBtn: document.getElementById('moderation-submit-btn')
};

if (!ui.threadForm || !ui.stickyThreadsList || !ui.commentForm) {
    throw new Error('Forum UI failed to initialize: required elements are missing.');
}

const mapCategoryById = () => new Map(state.categories.map((category) => [category.id, category]));

const toDate = (value) => {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value.toDate === 'function') return value.toDate();
    if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
    if (typeof value === 'number') return new Date(value);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatDate = (value) => {
    const date = toDate(value);
    if (!date) return 'data necunoscuta';
    return new Intl.DateTimeFormat('ro-RO', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(date);
};

const escapeHtml = (text) => String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const normalizeText = (value) => String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const slugify = (value) => normalizeText(value)
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);

const nl2br = (text) => escapeHtml(text).replace(/\n/g, '<br>');

const clip = (value, max = 180) => {
    const clean = String(value ?? '').trim();
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 1)}...`;
};

const isAdmin = () => Boolean(state.claims?.admin);

const getDisplayName = (user) => {
    const fromProfile = String(user?.displayName || '').trim();
    if (fromProfile) return fromProfile;

    const email = String(user?.email || '').trim();
    if (!email) return 'Membru Educheia';

    return email.split('@')[0] || 'Membru Educheia';
};

const isRestrictionActive = (value) => {
    const date = toDate(value);
    return Boolean(date && date.getTime() > Date.now());
};

const canCreateCategory = () => {
    if (!state.user) return false;
    if (!state.user.emailVerified) return false;
    return isAdmin() || state.role.trustedCreator || Number(state.role.reputation || 0) >= 250;
};

const canWriteThread = () => {
    if (!state.user) return false;
    if (!state.user.emailVerified) return false;
    if (state.role.isBanned) return false;
    if (isRestrictionActive(state.role.threadRestrictedUntil)) return false;
    if (isRestrictionActive(state.role.threadCooldownUntil)) return false;
    return true;
};

const canWriteComment = () => {
    if (!state.user) return false;
    if (!state.user.emailVerified) return false;
    if (state.role.isBanned) return false;
    if (isRestrictionActive(state.role.commentRestrictedUntil)) return false;
    if (isRestrictionActive(state.role.commentCooldownUntil)) return false;
    return true;
};

const isThreadVisibleToViewer = (thread) => {
    if (!thread) return false;
    if (isAdmin()) return true;
    if (thread.moderationStatus === 'visible') return true;
    if (state.user && thread.authorUid === state.user.uid && thread.moderationStatus === 'pending') return true;
    return false;
};

const isCommentVisibleToViewer = (comment) => {
    if (!comment) return false;
    if (isAdmin()) return true;
    if (comment.moderationStatus === 'visible') return true;
    if (state.user && comment.authorUid === state.user.uid && comment.moderationStatus === 'pending') return true;
    return false;
};

const setStatusText = (element, text, type = '') => {
    if (!element) return;
    element.textContent = text;
    element.classList.remove('is-error', 'is-success');
    if (type === 'error') element.classList.add('is-error');
    if (type === 'success') element.classList.add('is-success');
};

const setGlobalFeedback = (text, type = '') => setStatusText(ui.globalFeedback, text, type);

const safeErrorMessage = (error, fallback = 'Actiunea a esuat. Incearca din nou.') => {
    const code = String(error?.code || '').toLowerCase();

    if (code.includes('permission-denied')) {
        return 'Nu ai permisiunea necesara pentru aceasta actiune.';
    }

    if (code.includes('failed-precondition') || code.includes('requires-an-index')) {
        return 'Este necesar un index Firestore pentru aceasta interogare. Verifica consola Firebase.';
    }

    if (code.includes('unavailable')) {
        return 'Serviciul nu este disponibil momentan. Incearca din nou in cateva secunde.';
    }

    if (code.includes('resource-exhausted')) {
        return 'Limita de cereri a fost atinsa. Asteapta putin inainte sa incerci din nou.';
    }

    return fallback;
};

const parseRoleDoc = (data = {}) => ({
    trustedCreator: data.trustedCreator === true,
    reputation: Number.isFinite(data.reputation) ? data.reputation : 0,
    isBanned: data.isBanned === true,
    threadRestrictedUntil: data.threadRestrictedUntil || null,
    commentRestrictedUntil: data.commentRestrictedUntil || null,
    threadCooldownUntil: data.threadCooldownUntil || null,
    commentCooldownUntil: data.commentCooldownUntil || null,
    reason: typeof data.reason === 'string' ? data.reason : ''
});

const sortCategories = (categories = []) => [...categories].sort((a, b) => {
    if (a.type !== b.type) {
        if (a.type === 'admin') return -1;
        if (b.type === 'admin') return 1;
    }

    return String(a.name || '').localeCompare(String(b.name || ''), 'ro', { sensitivity: 'base' });
});

const getRateState = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(RATE_KEY) || '{}');
        if (!parsed || typeof parsed !== 'object') return { thread: [], comment: [] };

        return {
            thread: Array.isArray(parsed.thread) ? parsed.thread : [],
            comment: Array.isArray(parsed.comment) ? parsed.comment : []
        };
    } catch {
        return { thread: [], comment: [] };
    }
};

const saveRateState = (nextState) => {
    try {
        localStorage.setItem(RATE_KEY, JSON.stringify(nextState));
    } catch {
        return;
    }
};

const sanitizeRateBucket = (events = [], windowMs = 0) => {
    const now = Date.now();
    return events
        .filter((item) => item && typeof item.at === 'number' && now - item.at <= windowMs)
        .slice(-40);
};

const checkLocalRateLimit = (kind, signature = '') => {
    const rateRules = RATE_RULES[kind];
    if (!rateRules) return { ok: true };

    const now = Date.now();
    const rateState = getRateState();
    const bucket = sanitizeRateBucket(rateState[kind], rateRules.windowMs);

    if (bucket.length) {
        const lastEvent = bucket[bucket.length - 1];
        const elapsedMs = now - lastEvent.at;
        if (elapsedMs < rateRules.cooldownMs) {
            const waitSec = Math.ceil((rateRules.cooldownMs - elapsedMs) / 1000);
            return {
                ok: false,
                message: `Asteapta ${waitSec}s inainte de urmatoarea publicare.`
            };
        }
    }

    if (bucket.length >= rateRules.maxItems) {
        return {
            ok: false,
            message: 'Ai ajuns la limita locala de publicare pentru acest interval.'
        };
    }

    if (signature) {
        const normalizedSig = normalizeText(signature);
        const repeated = bucket.filter((item) => {
            if (!item || typeof item.sig !== 'string') return false;
            const isSameSig = item.sig === normalizedSig;
            const isInRepeatedWindow = now - item.at <= rateRules.repeatedWindowMs;
            return isSameSig && isInRepeatedWindow;
        });

        if (repeated.length >= rateRules.repeatedMax) {
            return {
                ok: false,
                message: 'Evita mesaje duplicate intr-un timp scurt.'
            };
        }
    }

    return { ok: true };
};

const registerLocalRateHit = (kind, signature = '') => {
    const rateRules = RATE_RULES[kind];
    if (!rateRules) return;

    const rateState = getRateState();
    const bucket = sanitizeRateBucket(rateState[kind], rateRules.windowMs);

    bucket.push({
        at: Date.now(),
        sig: normalizeText(signature)
    });

    rateState[kind] = bucket.slice(-40);
    saveRateState(rateState);
};

const analyzeContent = (rawContent) => {
    const content = String(rawContent || '');
    const normalized = normalizeText(content);

    if (!normalized) {
        return {
            blocked: true,
            pending: false,
            reasons: ['Textul nu poate fi gol.']
        };
    }

    const blockedHit = BLOCK_TERMS.find((term) => normalized.includes(term));
    if (blockedHit) {
        return {
            blocked: true,
            pending: false,
            reasons: ['Continutul contine expresii blocate de filtrul automat.']
        };
    }

    let score = 0;
    const reasons = [];

    const linkCount = (content.match(/(https?:\/\/|www\.|discord\.gg|t\.me\/)/gi) || []).length;
    if (linkCount >= 4) {
        score += 3;
        reasons.push('Prea multe link-uri in acelasi mesaj.');
    } else if (linkCount >= 2) {
        score += 1;
        reasons.push('Mesajul are mai multe link-uri.');
    }

    if (/(.)\1{8,}/.test(normalized)) {
        score += 2;
        reasons.push('Repetitii excesive de caractere detectate.');
    }

    const lettersOnly = content.replace(/[^A-Za-z]/g, '');
    if (lettersOnly.length >= 40) {
        const uppercaseRatio = lettersOnly.replace(/[^A-Z]/g, '').length / lettersOnly.length;
        if (uppercaseRatio > 0.78) {
            score += 2;
            reasons.push('Mesajul este predominant cu MAJUSCULE.');
        }
    }

    const suspiciousHit = SUSPICIOUS_TERMS.find((term) => normalized.includes(term));
    if (suspiciousHit) {
        score += 1;
        reasons.push('A fost detectat un tipar de potential scam/spam.');
    }

    if (score >= 4) {
        return {
            blocked: true,
            pending: false,
            reasons
        };
    }

    if (score >= 2) {
        return {
            blocked: false,
            pending: true,
            reasons
        };
    }

    return {
        blocked: false,
        pending: false,
        reasons: []
    };
};

const getRestrictionSummary = () => {
    const notes = [];

    if (state.role.isBanned) {
        notes.push('cont restrictionat complet');
    }

    if (isRestrictionActive(state.role.threadRestrictedUntil)) {
        notes.push(`thread-uri blocate pana la ${formatDate(state.role.threadRestrictedUntil)}`);
    }

    if (isRestrictionActive(state.role.commentRestrictedUntil)) {
        notes.push(`comentarii blocate pana la ${formatDate(state.role.commentRestrictedUntil)}`);
    }

    return notes;
};

const renderAuthState = () => {
    if (!state.user) {
        setStatusText(ui.authStatus, 'Mod public activ: poti citi tot continutul. Pentru thread-uri/comentarii, autentifica-te.');
        return;
    }

    const name = getDisplayName(state.user);
    const roleLabel = isAdmin() ? 'admin' : 'membru';
    const verificationLabel = state.user.emailVerified ? 'email verificat' : 'email neverificat';
    const restriction = getRestrictionSummary();

    let text = `${name} (${roleLabel}, ${verificationLabel}).`;
    if (restriction.length) {
        text += ` Restrictii active: ${restriction.join('; ')}.`;
    }

    if (!state.user.emailVerified) {
        text += ' Verifica emailul pentru a publica.';
    }

    setStatusText(ui.authStatus, text);
};

const setThreadFormEnabledState = () => {
    const enabled = canWriteThread();

    const hasValidCategory = [...ui.threadCategorySelect.options]
        .some((option) => !option.disabled && Boolean(option.value));
    const finalEnabled = enabled && hasValidCategory;

    ui.threadTitleInput.disabled = !finalEnabled || state.busy.threadSubmit;
    ui.threadBodyInput.disabled = !finalEnabled || state.busy.threadSubmit;
    ui.threadCategorySelect.disabled = !finalEnabled || state.busy.threadSubmit;
    ui.threadSubmitBtn.disabled = !finalEnabled || state.busy.threadSubmit;
    ui.threadStickyToggle.disabled = !isAdmin() || !finalEnabled || state.busy.threadSubmit;

    ui.stickyToggleWrap.hidden = !isAdmin();

    if (!state.user) {
        setStatusText(ui.threadComposeNote, 'Autentifica-te pentru a publica thread-uri.');
        ui.threadPolicyPill.textContent = 'Login necesar';
    } else if (!state.user.emailVerified) {
        setStatusText(ui.threadComposeNote, 'Verifica emailul contului inainte sa publici thread-uri.');
        ui.threadPolicyPill.textContent = 'Email neverificat';
    } else if (!enabled) {
        setStatusText(ui.threadComposeNote, state.role.isBanned
            ? 'Contul este restrictionat complet de moderatori.'
            : 'Publicarea de thread-uri este restrictionata momentan.');
        ui.threadPolicyPill.textContent = 'Restrictionat';
    } else {
        setStatusText(ui.threadComposeNote, 'Thread-ul va fi vizibil imediat sau marcat pentru review automat, daca pare suspect.');
        ui.threadPolicyPill.textContent = isAdmin() ? 'Admin mode' : 'Membru verificat';
    }
};

const setCommentFormEnabledState = () => {
    const selectedThread = state.threads.find((thread) => thread.id === state.selectedThreadId) || null;
    const threadAllowsComment = Boolean(
        selectedThread
        && (!selectedThread.isLocked || isAdmin())
        && (selectedThread.moderationStatus === 'visible' || isAdmin() || (state.user && selectedThread.authorUid === state.user.uid))
    );

    const enabled = canWriteComment() && threadAllowsComment;

    ui.commentInput.disabled = !enabled || state.busy.commentSubmit;
    ui.commentSubmitBtn.disabled = !enabled || state.busy.commentSubmit;

    if (!state.user) {
        setStatusText(ui.commentComposeNote, 'Autentifica-te pentru a comenta.');
        return;
    }

    if (!state.user.emailVerified) {
        setStatusText(ui.commentComposeNote, 'Emailul trebuie verificat pentru comentarii.');
        return;
    }

    if (!selectedThread) {
        setStatusText(ui.commentComposeNote, 'Selecteaza un thread inainte sa comentezi.');
        return;
    }

    if (selectedThread.isLocked && !isAdmin()) {
        setStatusText(ui.commentComposeNote, 'Thread-ul este blocat de moderatori.');
        return;
    }

    if (!threadAllowsComment) {
        setStatusText(ui.commentComposeNote, 'Comentariile sunt disponibile doar pe thread-uri vizibile.');
        return;
    }

    if (!canWriteComment()) {
        setStatusText(ui.commentComposeNote, state.role.isBanned
            ? 'Contul este restrictionat complet de moderatori.'
            : 'Comentariile sunt restrictionate temporar.');
        return;
    }

    setStatusText(ui.commentComposeNote, 'Raspunsul tau este verificat automat inainte de publicare.');
};

const renderCategoryFiltersAndComposer = () => {
    const categories = sortCategories(state.categories);

    const categoryFilterCurrentValue = state.filters.categoryId;
    ui.categoryFilter.innerHTML = '<option value="all">Toate categoriile</option>';

    const threadSelectCurrentValue = ui.threadCategorySelect.value;
    ui.threadCategorySelect.innerHTML = '';

    if (!categories.length) {
        ui.threadCategorySelect.innerHTML = '<option value="">Nu exista categorii</option>';
    }

    for (const category of categories) {
        const labelPrefix = category.type === 'admin' ? 'Admin' : 'Comunitate';
        const optionLabel = `${labelPrefix} - ${category.name}`;

        const filterOption = document.createElement('option');
        filterOption.value = category.id;
        filterOption.textContent = optionLabel;
        ui.categoryFilter.appendChild(filterOption);

        const threadOption = document.createElement('option');
        threadOption.value = category.id;
        threadOption.textContent = optionLabel;

        if (category.type === 'admin' && !isAdmin()) {
            threadOption.disabled = true;
            threadOption.textContent = `${optionLabel} (doar admin)`;
        }

        ui.threadCategorySelect.appendChild(threadOption);
    }

    if (categoryFilterCurrentValue && [...ui.categoryFilter.options].some((option) => option.value === categoryFilterCurrentValue)) {
        ui.categoryFilter.value = categoryFilterCurrentValue;
    } else {
        state.filters.categoryId = 'all';
        ui.categoryFilter.value = 'all';
    }

    const validThreadOption = threadSelectCurrentValue && [...ui.threadCategorySelect.options].some((option) => option.value === threadSelectCurrentValue && !option.disabled);
    if (validThreadOption) {
        ui.threadCategorySelect.value = threadSelectCurrentValue;
    } else {
        const firstAvailable = [...ui.threadCategorySelect.options].find((option) => !option.disabled && option.value);
        ui.threadCategorySelect.value = firstAvailable ? firstAvailable.value : '';
    }

    const categoryChipsHtml = categories.length
        ? categories.map((category) => {
            const isActive = state.filters.categoryId === category.id;
            const chipClass = [
                'category-chip',
                category.type === 'admin' ? 'admin' : '',
                isActive ? 'active' : ''
            ].filter(Boolean).join(' ');
            const extra = category.type === 'admin' ? 'Admin' : 'Comunitate';

            return `
                <button
                    type="button"
                    class="${chipClass}"
                    data-category-chip="${escapeHtml(category.id)}"
                    data-category-type="${escapeHtml(category.type)}"
                    title="${escapeHtml(extra)}: ${escapeHtml(category.name)}"
                >
                    ${escapeHtml(category.name)}
                </button>
            `;
        }).join('')
        : '<p class="thread-empty">Nu exista categorii inca. Un admin sau un membru de incredere poate adauga prima categorie.</p>';

    ui.categoryChipList.innerHTML = categoryChipsHtml;

    ui.openCategoryModalBtn.hidden = !canCreateCategory();

    const adminCategoryOption = [...ui.categoryTypeSelect.options].find((option) => option.value === 'admin');
    if (adminCategoryOption) {
        adminCategoryOption.disabled = !isAdmin();
        if (!isAdmin() && ui.categoryTypeSelect.value === 'admin') {
            ui.categoryTypeSelect.value = 'normal';
        }
    }

    setThreadFormEnabledState();
};

const mapThreadDoc = (snap) => {
    const data = snap.data() || {};

    return {
        id: snap.id,
        title: typeof data.title === 'string' ? data.title : 'Thread fara titlu',
        body: typeof data.body === 'string' ? data.body : '',
        categoryId: typeof data.categoryId === 'string' ? data.categoryId : '',
        categoryType: data.categoryType === 'admin' ? 'admin' : 'normal',
        authorUid: typeof data.authorUid === 'string' ? data.authorUid : '',
        authorName: typeof data.authorName === 'string' ? data.authorName : 'Autor necunoscut',
        authorEmail: typeof data.authorEmail === 'string' ? data.authorEmail : '',
        authorIsAdmin: data.authorIsAdmin === true,
        isSticky: data.isSticky === true,
        isLocked: data.isLocked === true,
        moderationStatus: ['visible', 'pending', 'hidden'].includes(data.moderationStatus) ? data.moderationStatus : 'visible',
        commentCount: Number.isFinite(data.commentCount) ? data.commentCount : 0,
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null,
        lastActivityAt: data.lastActivityAt || null
    };
};

const mapCommentDoc = (snap) => {
    const data = snap.data() || {};

    return {
        id: snap.id,
        body: typeof data.body === 'string' ? data.body : '',
        authorUid: typeof data.authorUid === 'string' ? data.authorUid : '',
        authorName: typeof data.authorName === 'string' ? data.authorName : 'Utilizator',
        authorEmail: typeof data.authorEmail === 'string' ? data.authorEmail : '',
        authorIsAdmin: data.authorIsAdmin === true,
        moderationStatus: ['visible', 'pending', 'hidden'].includes(data.moderationStatus) ? data.moderationStatus : 'visible',
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null
    };
};

const threadMatchesFilters = (thread) => {
    if (!thread) return false;

    if (state.filters.categoryType !== 'all' && thread.categoryType !== state.filters.categoryType) {
        return false;
    }

    if (state.filters.categoryId !== 'all' && thread.categoryId !== state.filters.categoryId) {
        return false;
    }

    const search = normalizeText(state.filters.search);
    if (!search) return true;

    const categoryName = mapCategoryById().get(thread.categoryId)?.name || '';
    const haystack = normalizeText(`${thread.title} ${thread.body} ${thread.authorName} ${categoryName}`);
    return haystack.includes(search);
};

const getVisibleThreadsBySection = () => {
    const visible = state.threads
        .filter((thread) => isThreadVisibleToViewer(thread))
        .filter((thread) => threadMatchesFilters(thread))
        .sort((a, b) => {
            const aDate = toDate(a.createdAt)?.getTime() || 0;
            const bDate = toDate(b.createdAt)?.getTime() || 0;
            return bDate - aDate;
        });

    const sticky = visible.filter((thread) => thread.isSticky && thread.authorIsAdmin);
    const community = visible.filter((thread) => !thread.isSticky);

    return { sticky, community };
};

const renderThreadCard = (thread, selectedThreadId) => {
    const category = mapCategoryById().get(thread.categoryId);
    const categoryLabel = category?.name || 'Fara categorie';
    const statusLabelMap = {
        visible: 'vizibil',
        pending: 'in review',
        hidden: 'ascuns'
    };

    const canDeleteThread = isAdmin() || (state.user && thread.authorUid === state.user.uid);
    const canModerate = isAdmin();

    const classes = [
        'thread-card',
        thread.id === selectedThreadId ? 'is-selected' : '',
        thread.isSticky ? 'is-sticky' : '',
        thread.moderationStatus === 'pending' ? 'is-pending' : '',
        thread.moderationStatus === 'hidden' ? 'is-hidden' : ''
    ].filter(Boolean).join(' ');

    const badges = [
        `<span class="forum-pill">${escapeHtml(categoryLabel)}</span>`
    ];

    if (thread.isSticky) badges.push('<span class="forum-pill forum-pill-muted">sticky</span>');
    if (thread.isLocked) badges.push('<span class="forum-pill forum-pill-muted">blocat</span>');
    if (thread.categoryType === 'admin') badges.push('<span class="forum-pill forum-pill-muted">admin</span>');
    if (thread.moderationStatus !== 'visible') badges.push(`<span class="forum-pill forum-pill-muted">${statusLabelMap[thread.moderationStatus]}</span>`);

    const actions = [
        `<button type="button" class="thread-action" data-thread-action="open" data-thread-id="${escapeHtml(thread.id)}">Deschide</button>`
    ];

    if (canDeleteThread) {
        actions.push(`<button type="button" class="thread-action danger" data-thread-action="delete" data-thread-id="${escapeHtml(thread.id)}">Sterge</button>`);
    }

    if (canModerate) {
        actions.push(`<button type="button" class="thread-action moderation" data-thread-action="moderate-user" data-thread-id="${escapeHtml(thread.id)}" data-target-uid="${escapeHtml(thread.authorUid)}" data-target-name="${escapeHtml(thread.authorName)}">Restrange autor</button>`);
    }

    const created = formatDate(thread.createdAt);
    const excerpt = clip(thread.body, 186);

    return `
        <article class="${classes}" data-thread-id="${escapeHtml(thread.id)}" tabindex="0">
            <div class="thread-card-top">
                <div class="thread-card-badges">${badges.join('')}</div>
            </div>
            <h3>${escapeHtml(thread.title)}</h3>
            <p class="thread-excerpt">${escapeHtml(excerpt)}</p>
            <p class="thread-meta">de ${escapeHtml(thread.authorName)} | ${escapeHtml(created)} | ${escapeHtml(String(thread.commentCount || 0))} comentarii</p>
            <div class="thread-card-actions">${actions.join('')}</div>
        </article>
    `;
};

const ensureSelectedThread = ({ sticky, community }) => {
    const visibleById = new Set([...sticky, ...community].map((thread) => thread.id));

    if (state.selectedThreadId && visibleById.has(state.selectedThreadId)) {
        return;
    }

    if (state.pendingUrlThreadId && visibleById.has(state.pendingUrlThreadId)) {
        state.selectedThreadId = state.pendingUrlThreadId;
        state.pendingUrlThreadId = null;
        return;
    }

    state.selectedThreadId = community[0]?.id || sticky[0]?.id || null;
};

const updateThreadInUrl = (threadId) => {
    const current = new URL(window.location.href);
    if (threadId) {
        current.searchParams.set('thread', threadId);
    } else {
        current.searchParams.delete('thread');
    }
    window.history.replaceState({}, '', `${current.pathname}${current.search}${current.hash}`);
};

const renderThreads = () => {
    const { sticky, community } = getVisibleThreadsBySection();
    ensureSelectedThread({ sticky, community });

    ui.stickyThreadsList.innerHTML = sticky.length
        ? sticky.map((thread) => renderThreadCard(thread, state.selectedThreadId)).join('')
        : '<div class="thread-empty">Nu exista inca anunturi sticky vizibile.</div>';

    ui.communityThreadsList.innerHTML = community.length
        ? community.map((thread) => renderThreadCard(thread, state.selectedThreadId)).join('')
        : '<div class="thread-empty">Nu exista thread-uri care sa corespunda filtrarii curente.</div>';

    updateThreadInUrl(state.selectedThreadId);
    renderSelectedThread();
};

const renderSelectedThread = () => {
    const selectedThread = state.threads.find((thread) => thread.id === state.selectedThreadId) || null;

    if (!selectedThread || !isThreadVisibleToViewer(selectedThread)) {
        ui.selectedThreadEmpty.hidden = false;
        ui.selectedThreadShell.hidden = true;
        state.comments = [];
        ui.commentsList.innerHTML = '';
        ui.commentsCount.textContent = '0';
        setStatusText(ui.commentsStatus, 'Alege un thread pentru a incarca comentariile.');
        unsubscribeComments();
        setCommentFormEnabledState();
        return;
    }

    ui.selectedThreadEmpty.hidden = true;
    ui.selectedThreadShell.hidden = false;

    const category = mapCategoryById().get(selectedThread.categoryId);
    ui.selectedThreadCategory.textContent = category?.name || 'Fara categorie';

    const statusMap = {
        visible: 'vizibil',
        pending: 'in review',
        hidden: 'ascuns'
    };
    ui.selectedThreadStatus.textContent = statusMap[selectedThread.moderationStatus] || 'vizibil';

    ui.selectedThreadTitle.textContent = selectedThread.title;
    ui.selectedThreadMeta.textContent = `de ${selectedThread.authorName} | creat la ${formatDate(selectedThread.createdAt)} | ultima actualizare ${formatDate(selectedThread.updatedAt || selectedThread.createdAt)}`;
    ui.selectedThreadBody.innerHTML = nl2br(selectedThread.body);

    const canDeleteThread = isAdmin() || (state.user && selectedThread.authorUid === state.user.uid);
    ui.selectedDeleteThreadBtn.hidden = !canDeleteThread;

    ui.selectedLockThreadBtn.hidden = !isAdmin();
    ui.selectedToggleVisibilityBtn.hidden = !isAdmin();
    ui.selectedRestrictUserBtn.hidden = !isAdmin();

    ui.selectedLockThreadBtn.textContent = selectedThread.isLocked ? 'Deblocheaza thread' : 'Blocheaza thread';
    ui.selectedToggleVisibilityBtn.textContent = selectedThread.moderationStatus === 'hidden' ? 'Fa thread-ul vizibil' : 'Ascunde thread';

    subscribeComments(selectedThread.id);
    setCommentFormEnabledState();
};

const renderComments = () => {
    const selectedThread = state.threads.find((thread) => thread.id === state.selectedThreadId) || null;

    if (!selectedThread) {
        ui.commentsList.innerHTML = '';
        ui.commentsCount.textContent = '0';
        setStatusText(ui.commentsStatus, 'Alege un thread pentru a incarca comentariile.');
        return;
    }

    const visibleComments = state.comments.filter((comment) => isCommentVisibleToViewer(comment));

    ui.commentsCount.textContent = String(visibleComments.length);

    if (!visibleComments.length) {
        ui.commentsList.innerHTML = '<li class="thread-empty">Nu exista comentarii vizibile inca.</li>';
        setStatusText(ui.commentsStatus, selectedThread.isLocked
            ? 'Thread-ul este blocat: nu se mai adauga comentarii noi.'
            : 'Fii primul care comenteaza in acest thread.');
        return;
    }

    setStatusText(ui.commentsStatus, 'Comentarii incarcate in timp real.');

    const statusMap = {
        visible: 'vizibil',
        pending: 'in review',
        hidden: 'ascuns'
    };

    ui.commentsList.innerHTML = visibleComments.map((comment) => {
        const canDelete = isAdmin() || (state.user && state.user.uid === comment.authorUid);
        const classes = [
            'comment-item',
            comment.moderationStatus === 'pending' ? 'pending' : '',
            comment.moderationStatus === 'hidden' ? 'hidden' : ''
        ].filter(Boolean).join(' ');

        const actions = [];

        if (canDelete) {
            actions.push(`<button type="button" class="comment-action danger" data-comment-action="delete" data-comment-id="${escapeHtml(comment.id)}">Sterge</button>`);
        }

        if (isAdmin()) {
            const nextLabel = comment.moderationStatus === 'hidden' ? 'Fa vizibil' : 'Ascunde';
            actions.push(`<button type="button" class="comment-action" data-comment-action="toggle-visibility" data-comment-id="${escapeHtml(comment.id)}">${nextLabel}</button>`);
            actions.push(`<button type="button" class="comment-action" data-comment-action="moderate-user" data-comment-id="${escapeHtml(comment.id)}" data-target-uid="${escapeHtml(comment.authorUid)}" data-target-name="${escapeHtml(comment.authorName)}">Restrange autor</button>`);
        }

        const statusText = comment.moderationStatus !== 'visible' ? ` | ${statusMap[comment.moderationStatus]}` : '';

        return `
            <li class="${classes}" data-comment-id="${escapeHtml(comment.id)}">
                <div class="comment-meta">
                    <span class="comment-author">${escapeHtml(comment.authorName)}</span>
                    <span>${escapeHtml(formatDate(comment.createdAt))}${escapeHtml(statusText)}</span>
                </div>
                <p class="comment-body">${nl2br(comment.body)}</p>
                <div class="comment-actions">${actions.join('')}</div>
            </li>
        `;
    }).join('');
};

const unsubscribeComments = () => {
    if (typeof state.unsubscribers.comments === 'function') {
        state.unsubscribers.comments();
        state.unsubscribers.comments = null;
    }
};

const subscribeComments = (threadId) => {
    unsubscribeComments();

    if (!threadId) {
        state.comments = [];
        renderComments();
        return;
    }

    const commentsQuery = query(
        collection(db, 'forumThreads', threadId, 'comments'),
        orderBy('createdAt', 'asc'),
        limit(MAX_COMMENTS_FETCH)
    );

    state.unsubscribers.comments = onSnapshot(commentsQuery, (snapshot) => {
        state.comments = snapshot.docs.map(mapCommentDoc);
        renderComments();
    }, (error) => {
        state.comments = [];
        renderComments();
        setStatusText(ui.commentsStatus, safeErrorMessage(error, 'Nu am putut incarca comentariile.'), 'error');
    });
};

const subscribeThreads = () => {
    if (typeof state.unsubscribers.threads === 'function') {
        state.unsubscribers.threads();
    }

    const threadsQuery = query(
        collection(db, 'forumThreads'),
        orderBy('createdAt', 'desc'),
        limit(MAX_THREADS_FETCH)
    );

    state.unsubscribers.threads = onSnapshot(threadsQuery, (snapshot) => {
        state.threads = snapshot.docs.map(mapThreadDoc);
        renderThreads();
    }, (error) => {
        state.threads = [];
        renderThreads();
        setGlobalFeedback(safeErrorMessage(error, 'Nu am putut incarca thread-urile.'), 'error');
    });
};

const subscribeCategories = () => {
    if (typeof state.unsubscribers.categories === 'function') {
        state.unsubscribers.categories();
    }

    const categoriesQuery = query(
        collection(db, 'forumCategories'),
        orderBy('createdAt', 'desc'),
        limit(160)
    );

    state.unsubscribers.categories = onSnapshot(categoriesQuery, (snapshot) => {
        state.categories = snapshot.docs
            .map((docSnap) => {
                const data = docSnap.data() || {};
                return {
                    id: docSnap.id,
                    name: typeof data.name === 'string' ? data.name : docSnap.id,
                    slug: typeof data.slug === 'string' ? data.slug : docSnap.id,
                    description: typeof data.description === 'string' ? data.description : '',
                    type: data.type === 'admin' ? 'admin' : 'normal',
                    isArchived: data.isArchived === true
                };
            })
            .filter((category) => !category.isArchived);

        renderCategoryFiltersAndComposer();
        renderThreads();
    }, (error) => {
        state.categories = [];
        renderCategoryFiltersAndComposer();
        setGlobalFeedback(safeErrorMessage(error, 'Nu am putut incarca categoriile.'), 'error');
    });
};

const subscribeRole = () => {
    if (typeof state.unsubscribers.role === 'function') {
        state.unsubscribers.role();
        state.unsubscribers.role = null;
    }

    if (!state.user) {
        state.role = parseRoleDoc();
        renderAuthState();
        setThreadFormEnabledState();
        setCommentFormEnabledState();
        renderCategoryFiltersAndComposer();
        return;
    }

    const roleRef = doc(db, 'forumUserRoles', state.user.uid);
    state.unsubscribers.role = onSnapshot(roleRef, (snapshot) => {
        state.role = snapshot.exists() ? parseRoleDoc(snapshot.data()) : parseRoleDoc();
        renderAuthState();
        setThreadFormEnabledState();
        setCommentFormEnabledState();
        renderCategoryFiltersAndComposer();
    }, () => {
        state.role = parseRoleDoc();
        renderAuthState();
        setThreadFormEnabledState();
        setCommentFormEnabledState();
        renderCategoryFiltersAndComposer();
    });
};

const refreshClaims = async () => {
    if (!state.user) {
        state.claims = {};
        return;
    }

    try {
        const tokenResult = await state.user.getIdTokenResult(true);
        state.claims = tokenResult?.claims || {};
    } catch {
        state.claims = {};
    }
};

const closeModal = (modalType) => {
    if (modalType === 'category') {
        ui.categoryModal.hidden = true;
        setStatusText(ui.categoryFormFeedback, '');
        return;
    }

    if (modalType === 'moderation') {
        ui.moderationModal.hidden = true;
        setStatusText(ui.moderationFeedback, '');
    }
};

const openCategoryModal = () => {
    if (!canCreateCategory()) {
        setGlobalFeedback('Nu ai dreptul sa creezi categorii.', 'error');
        return;
    }

    ui.categoryModal.hidden = false;
    ui.categoryNameInput.focus();
};

const openModerationModal = (targetUid, targetName, context = {}) => {
    if (!isAdmin()) {
        setGlobalFeedback('Doar adminii pot modera utilizatori.', 'error');
        return;
    }

    if (!targetUid) {
        setGlobalFeedback('Nu am putut identifica utilizatorul tinta.', 'error');
        return;
    }

    state.moderationTarget = {
        uid: targetUid,
        name: targetName || 'utilizator',
        threadId: context.threadId || null,
        commentId: context.commentId || null
    };

    ui.moderationTargetUid.value = targetUid;
    ui.moderationTargetLabel.textContent = `Tinta moderare: ${targetName || targetUid}`;
    ui.restrictThreadsCheckbox.checked = true;
    ui.restrictCommentsCheckbox.checked = true;
    ui.banUserCheckbox.checked = false;
    ui.restrictionDurationSelect.value = '7d';
    ui.purgeUserContentCheckbox.checked = false;
    ui.moderationReasonInput.value = '';

    setStatusText(ui.moderationFeedback, '');
    ui.moderationModal.hidden = false;
};

const parseDurationToTimestamp = (durationValue) => {
    if (!durationValue) return null;

    const now = Date.now();

    if (durationValue === '1h') return Timestamp.fromMillis(now + 1 * 60 * 60 * 1000);
    if (durationValue === '24h') return Timestamp.fromMillis(now + 24 * 60 * 60 * 1000);
    if (durationValue === '7d') return Timestamp.fromMillis(now + 7 * 24 * 60 * 60 * 1000);
    if (durationValue === '30d') return Timestamp.fromMillis(now + 30 * 24 * 60 * 60 * 1000);
    if (durationValue === 'indefinite') return Timestamp.fromMillis(now + 50 * 365 * 24 * 60 * 60 * 1000);

    return null;
};

const logModerationAction = async ({ actionType, targetUid, threadId = null, commentId = null, reason = '', details = {} }) => {
    if (!isAdmin() || !state.user) return;

    try {
        const payload = {
            actionType,
            targetUid,
            createdAt: serverTimestamp(),
            createdByUid: state.user.uid,
            details
        };

        if (threadId) payload.threadId = threadId;
        if (commentId) payload.commentId = commentId;
        if (reason) payload.reason = reason;

        await addDoc(collection(db, 'forumModerationActions'), payload);
    } catch {
        return;
    }
};

const purgeUserThreads = async (uid) => {
    if (!uid) return;

    while (true) {
        const snapshot = await getDocs(query(
            collection(db, 'forumThreads'),
            where('authorUid', '==', uid),
            limit(120)
        ));

        if (snapshot.empty) break;

        const batch = writeBatch(db);
        snapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref));
        await batch.commit();

        if (snapshot.size < 120) break;
    }
};

const purgeUserComments = async (uid) => {
    if (!uid) return;

    while (true) {
        const snapshot = await getDocs(query(
            collectionGroup(db, 'comments'),
            where('authorUid', '==', uid),
            limit(180)
        ));

        if (snapshot.empty) break;

        const batch = writeBatch(db);
        snapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref));
        await batch.commit();

        if (snapshot.size < 180) break;
    }
};

const purgeThreadComments = async (threadId) => {
    if (!threadId || !isAdmin()) return;

    while (true) {
        const snapshot = await getDocs(query(
            collection(db, 'forumThreads', threadId, 'comments'),
            limit(180)
        ));

        if (snapshot.empty) break;

        const batch = writeBatch(db);
        snapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref));
        await batch.commit();

        if (snapshot.size < 180) break;
    }
};

const handleCategoryFormSubmit = async (event) => {
    event.preventDefault();

    if (state.busy.categorySubmit) return;

    if (!state.user) {
        setStatusText(ui.categoryFormFeedback, 'Autentifica-te pentru a crea categorii.', 'error');
        return;
    }

    if (!canCreateCategory()) {
        setStatusText(ui.categoryFormFeedback, 'Nu ai dreptul sa creezi categorii.', 'error');
        return;
    }

    const name = ui.categoryNameInput.value.trim();
    const slugInput = ui.categorySlugInput.value.trim();
    const description = ui.categoryDescriptionInput.value.trim();
    const type = ui.categoryTypeSelect.value === 'admin' ? 'admin' : 'normal';
    const slug = slugify(slugInput || name);

    if (!name || name.length < 2 || name.length > 70) {
        setStatusText(ui.categoryFormFeedback, 'Numele categoriei trebuie sa aiba intre 2 si 70 de caractere.', 'error');
        return;
    }

    if (!slug || slug.length < 2 || slug.length > 70) {
        setStatusText(ui.categoryFormFeedback, 'Slug-ul categoriei este invalid.', 'error');
        return;
    }

    if (description.length > 280) {
        setStatusText(ui.categoryFormFeedback, 'Descrierea trebuie sa aiba maximum 280 de caractere.', 'error');
        return;
    }

    if (type === 'admin' && !isAdmin()) {
        setStatusText(ui.categoryFormFeedback, 'Doar adminii pot crea categorii admin.', 'error');
        return;
    }

    state.busy.categorySubmit = true;
    ui.categorySubmitBtn.disabled = true;

    try {
        const categoryRef = doc(db, 'forumCategories', slug);
        const existing = await getDoc(categoryRef);

        if (existing.exists()) {
            setStatusText(ui.categoryFormFeedback, 'Slug-ul exista deja. Alege alt slug.', 'error');
            return;
        }

        const payload = {
            name,
            slug,
            description,
            type,
            isArchived: false,
            createdByUid: state.user.uid,
            createdByName: getDisplayName(state.user),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };

        if (!description) {
            delete payload.description;
        }

        await setDoc(categoryRef, payload);
        setStatusText(ui.categoryFormFeedback, 'Categoria a fost creata.', 'success');

        ui.categoryForm.reset();
        ui.categoryTypeSelect.value = isAdmin() ? 'normal' : 'normal';
        state.categorySlugManuallyEdited = false;

        setTimeout(() => closeModal('category'), 350);
    } catch (error) {
        setStatusText(ui.categoryFormFeedback, safeErrorMessage(error, 'Nu am putut crea categoria.'), 'error');
    } finally {
        state.busy.categorySubmit = false;
        ui.categorySubmitBtn.disabled = false;
    }
};

const handleThreadSubmit = async (event) => {
    event.preventDefault();

    if (state.busy.threadSubmit) return;

    const categoryId = ui.threadCategorySelect.value;
    const category = mapCategoryById().get(categoryId);

    if (!categoryId || !category) {
        setGlobalFeedback('Selecteaza o categorie valida.', 'error');
        return;
    }

    if (category.type === 'admin' && !isAdmin()) {
        setGlobalFeedback('Categoria admin este rezervata doar adminilor.', 'error');
        return;
    }

    if (!canWriteThread()) {
        setGlobalFeedback('Nu poti publica thread-uri in acest moment.', 'error');
        return;
    }

    const title = ui.threadTitleInput.value.trim();
    const body = ui.threadBodyInput.value.trim();

    if (title.length < 6 || title.length > 160) {
        setGlobalFeedback('Titlul trebuie sa aiba intre 6 si 160 de caractere.', 'error');
        return;
    }

    if (body.length < 12 || body.length > 8000) {
        setGlobalFeedback('Mesajul trebuie sa aiba intre 12 si 8000 de caractere.', 'error');
        return;
    }

    const localRate = checkLocalRateLimit('thread', `${title} ${body}`);
    if (!localRate.ok) {
        setGlobalFeedback(localRate.message, 'error');
        return;
    }

    const moderationCheck = analyzeContent(`${title}\n${body}`);
    if (moderationCheck.blocked) {
        setGlobalFeedback(`Thread blocat de filtrul automat. ${moderationCheck.reasons.join(' ')}`, 'error');
        return;
    }

    const shouldBePending = moderationCheck.pending;

    state.busy.threadSubmit = true;
    setThreadFormEnabledState();

    try {
        const payload = {
            title,
            body,
            categoryId,
            categoryType: category.type,
            authorUid: state.user.uid,
            authorName: getDisplayName(state.user),
            authorIsAdmin: isAdmin(),
            isSticky: isAdmin() ? ui.threadStickyToggle.checked : false,
            isLocked: false,
            moderationStatus: shouldBePending ? 'pending' : 'visible',
            commentCount: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            lastActivityAt: serverTimestamp()
        };

        if (state.user.email) {
            payload.authorEmail = state.user.email;
        }

        const created = await addDoc(collection(db, 'forumThreads'), payload);
        registerLocalRateHit('thread', `${title} ${body}`);

        ui.threadForm.reset();
        ui.threadStickyToggle.checked = false;

        state.selectedThreadId = created.id;

        if (shouldBePending) {
            setGlobalFeedback('Thread trimis in modul "in review". Va fi vizibil dupa moderare.', 'success');
        } else {
            setGlobalFeedback('Thread publicat cu succes.', 'success');
        }
    } catch (error) {
        setGlobalFeedback(safeErrorMessage(error, 'Nu am putut publica thread-ul.'), 'error');
    } finally {
        state.busy.threadSubmit = false;
        setThreadFormEnabledState();
    }
};

const handleCommentSubmit = async (event) => {
    event.preventDefault();

    if (state.busy.commentSubmit) return;

    const selectedThread = state.threads.find((thread) => thread.id === state.selectedThreadId) || null;
    if (!selectedThread) {
        setStatusText(ui.commentsStatus, 'Alege un thread inainte sa comentezi.', 'error');
        return;
    }

    if (!canWriteComment()) {
        setStatusText(ui.commentsStatus, 'Nu poti comenta in acest moment.', 'error');
        return;
    }

    if (selectedThread.isLocked && !isAdmin()) {
        setStatusText(ui.commentsStatus, 'Thread-ul este blocat de moderatori.', 'error');
        return;
    }

    const body = ui.commentInput.value.trim();
    if (!body || body.length > 1500) {
        setStatusText(ui.commentsStatus, 'Comentariul trebuie sa aiba intre 1 si 1500 de caractere.', 'error');
        return;
    }

    const localRate = checkLocalRateLimit('comment', body);
    if (!localRate.ok) {
        setStatusText(ui.commentsStatus, localRate.message, 'error');
        return;
    }

    const moderationCheck = analyzeContent(body);
    if (moderationCheck.blocked) {
        setStatusText(ui.commentsStatus, `Comentariu blocat de filtrul automat. ${moderationCheck.reasons.join(' ')}`, 'error');
        return;
    }

    state.busy.commentSubmit = true;
    setCommentFormEnabledState();

    try {
        const payload = {
            body,
            authorUid: state.user.uid,
            authorName: getDisplayName(state.user),
            authorIsAdmin: isAdmin(),
            moderationStatus: moderationCheck.pending ? 'pending' : 'visible',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };

        if (state.user.email) {
            payload.authorEmail = state.user.email;
        }

        await addDoc(collection(db, 'forumThreads', selectedThread.id, 'comments'), payload);
        registerLocalRateHit('comment', body);

        ui.commentForm.reset();

        if (moderationCheck.pending) {
            setStatusText(ui.commentsStatus, 'Comentariul a fost trimis in review automat.', 'success');
        } else {
            setStatusText(ui.commentsStatus, 'Comentariul a fost publicat.', 'success');
        }
    } catch (error) {
        setStatusText(ui.commentsStatus, safeErrorMessage(error, 'Nu am putut trimite comentariul.'), 'error');
    } finally {
        state.busy.commentSubmit = false;
        setCommentFormEnabledState();
    }
};

const deleteThread = async (threadId) => {
    const thread = state.threads.find((item) => item.id === threadId);
    if (!thread) return;

    const canDelete = isAdmin() || (state.user && state.user.uid === thread.authorUid);
    if (!canDelete) {
        setGlobalFeedback('Nu ai permisiunea sa stergi acest thread.', 'error');
        return;
    }

    const confirmDelete = window.confirm('Confirmi stergerea thread-ului selectat?');
    if (!confirmDelete) return;

    if (state.busy.threadDelete) return;

    state.busy.threadDelete = true;

    try {
        if (isAdmin()) {
            await purgeThreadComments(threadId);
        }

        await deleteDoc(doc(db, 'forumThreads', threadId));

        if (isAdmin()) {
            await logModerationAction({
                actionType: 'thread_delete',
                targetUid: thread.authorUid,
                threadId,
                reason: 'Thread sters de admin',
                details: {
                    isSticky: thread.isSticky,
                    categoryId: thread.categoryId
                }
            });
        }

        setGlobalFeedback('Thread sters.', 'success');
    } catch (error) {
        setGlobalFeedback(safeErrorMessage(error, 'Nu am putut sterge thread-ul.'), 'error');
    } finally {
        state.busy.threadDelete = false;
    }
};

const toggleSelectedThreadLock = async () => {
    const thread = state.threads.find((item) => item.id === state.selectedThreadId);
    if (!thread || !isAdmin()) return;

    try {
        await updateDoc(doc(db, 'forumThreads', thread.id), {
            isLocked: !thread.isLocked,
            updatedAt: serverTimestamp()
        });

        await logModerationAction({
            actionType: thread.isLocked ? 'thread_unlock' : 'thread_lock',
            targetUid: thread.authorUid,
            threadId: thread.id,
            reason: thread.isLocked ? 'Thread deblocat de admin' : 'Thread blocat de admin'
        });

        setGlobalFeedback(thread.isLocked ? 'Thread deblocat.' : 'Thread blocat.', 'success');
    } catch (error) {
        setGlobalFeedback(safeErrorMessage(error, 'Nu am putut modifica starea thread-ului.'), 'error');
    }
};

const toggleSelectedThreadVisibility = async () => {
    const thread = state.threads.find((item) => item.id === state.selectedThreadId);
    if (!thread || !isAdmin()) return;

    const nextStatus = thread.moderationStatus === 'hidden' ? 'visible' : 'hidden';

    try {
        await updateDoc(doc(db, 'forumThreads', thread.id), {
            moderationStatus: nextStatus,
            updatedAt: serverTimestamp()
        });

        await logModerationAction({
            actionType: nextStatus === 'hidden' ? 'thread_hide' : 'thread_approve',
            targetUid: thread.authorUid,
            threadId: thread.id,
            reason: nextStatus === 'hidden' ? 'Thread ascuns manual de admin' : 'Thread aprobat manual de admin'
        });

        setGlobalFeedback(nextStatus === 'hidden' ? 'Thread ascuns.' : 'Thread facut vizibil.', 'success');
    } catch (error) {
        setGlobalFeedback(safeErrorMessage(error, 'Nu am putut actualiza vizibilitatea thread-ului.'), 'error');
    }
};

const deleteComment = async (commentId) => {
    if (!commentId || !state.selectedThreadId) return;

    const comment = state.comments.find((item) => item.id === commentId);
    if (!comment) return;

    const canDelete = isAdmin() || (state.user && state.user.uid === comment.authorUid);
    if (!canDelete) {
        setStatusText(ui.commentsStatus, 'Nu ai permisiunea sa stergi acest comentariu.', 'error');
        return;
    }

    const confirmDelete = window.confirm('Confirmi stergerea comentariului?');
    if (!confirmDelete) return;

    try {
        await deleteDoc(doc(db, 'forumThreads', state.selectedThreadId, 'comments', commentId));

        if (isAdmin()) {
            await logModerationAction({
                actionType: 'comment_delete',
                targetUid: comment.authorUid,
                threadId: state.selectedThreadId,
                commentId,
                reason: 'Comentariu sters de admin'
            });
        }

        setStatusText(ui.commentsStatus, 'Comentariu sters.', 'success');
    } catch (error) {
        setStatusText(ui.commentsStatus, safeErrorMessage(error, 'Nu am putut sterge comentariul.'), 'error');
    }
};

const toggleCommentVisibility = async (commentId) => {
    if (!isAdmin() || !state.selectedThreadId || !commentId) return;

    const comment = state.comments.find((item) => item.id === commentId);
    if (!comment) return;

    const nextStatus = comment.moderationStatus === 'hidden' ? 'visible' : 'hidden';

    try {
        await updateDoc(doc(db, 'forumThreads', state.selectedThreadId, 'comments', commentId), {
            moderationStatus: nextStatus,
            updatedAt: serverTimestamp()
        });

        await logModerationAction({
            actionType: nextStatus === 'hidden' ? 'comment_hide' : 'comment_approve',
            targetUid: comment.authorUid,
            threadId: state.selectedThreadId,
            commentId,
            reason: nextStatus === 'hidden' ? 'Comentariu ascuns de admin' : 'Comentariu aprobat de admin'
        });

        setStatusText(ui.commentsStatus, nextStatus === 'hidden' ? 'Comentariu ascuns.' : 'Comentariu facut vizibil.', 'success');
    } catch (error) {
        setStatusText(ui.commentsStatus, safeErrorMessage(error, 'Nu am putut actualiza comentariul.'), 'error');
    }
};

const handleModerationSubmit = async (event) => {
    event.preventDefault();

    if (!isAdmin()) {
        setStatusText(ui.moderationFeedback, 'Doar adminii pot aplica moderare.', 'error');
        return;
    }

    if (state.busy.moderationSubmit) return;

    const targetUid = ui.moderationTargetUid.value.trim();
    if (!targetUid) {
        setStatusText(ui.moderationFeedback, 'Lipseste utilizatorul tinta.', 'error');
        return;
    }

    const reason = ui.moderationReasonInput.value.trim();
    const restrictThreads = ui.restrictThreadsCheckbox.checked;
    const restrictComments = ui.restrictCommentsCheckbox.checked;
    const banUser = ui.banUserCheckbox.checked;
    const deleteUserContent = ui.purgeUserContentCheckbox.checked;
    const durationValue = ui.restrictionDurationSelect.value;
    const untilTimestamp = parseDurationToTimestamp(durationValue);

    if ((restrictThreads || restrictComments || banUser) && !untilTimestamp) {
        setStatusText(ui.moderationFeedback, 'Durata este invalida.', 'error');
        return;
    }

    state.busy.moderationSubmit = true;
    ui.moderationSubmitBtn.disabled = true;

    try {
        const roleRef = doc(db, 'forumUserRoles', targetUid);

        const updates = {
            updatedAt: serverTimestamp(),
            updatedByUid: state.user.uid,
            reason: reason || ''
        };

        if (banUser) {
            updates.isBanned = true;
            updates.threadRestrictedUntil = untilTimestamp;
            updates.commentRestrictedUntil = untilTimestamp;
        } else {
            updates.isBanned = false;
            updates.threadRestrictedUntil = restrictThreads ? untilTimestamp : deleteField();
            updates.commentRestrictedUntil = restrictComments ? untilTimestamp : deleteField();
        }

        await setDoc(roleRef, updates, { merge: true });

        if (deleteUserContent) {
            await purgeUserThreads(targetUid);
            await purgeUserComments(targetUid);
        }

        await logModerationAction({
            actionType: 'user_restriction',
            targetUid,
            threadId: state.moderationTarget?.threadId || null,
            commentId: state.moderationTarget?.commentId || null,
            reason,
            details: {
                restrictThreads,
                restrictComments,
                banUser,
                deleteUserContent,
                durationValue
            }
        });

        setStatusText(ui.moderationFeedback, 'Moderarea a fost aplicata.', 'success');
        setGlobalFeedback('Moderarea utilizatorului a fost aplicata.', 'success');

        setTimeout(() => closeModal('moderation'), 350);
    } catch (error) {
        setStatusText(ui.moderationFeedback, safeErrorMessage(error, 'Nu am putut aplica moderarea.'), 'error');
    } finally {
        state.busy.moderationSubmit = false;
        ui.moderationSubmitBtn.disabled = false;
    }
};

const handleThreadListInteraction = (event) => {
    const actionBtn = event.target.closest('[data-thread-action]');
    const card = event.target.closest('[data-thread-id]');

    if (actionBtn) {
        const action = actionBtn.getAttribute('data-thread-action');
        const threadId = actionBtn.getAttribute('data-thread-id') || card?.getAttribute('data-thread-id');

        if (!threadId) return;

        if (action === 'open') {
            state.selectedThreadId = threadId;
            renderThreads();
            return;
        }

        if (action === 'delete') {
            deleteThread(threadId);
            return;
        }

        if (action === 'moderate-user') {
            const targetUid = actionBtn.getAttribute('data-target-uid');
            const targetName = actionBtn.getAttribute('data-target-name');
            openModerationModal(targetUid, targetName, { threadId });
            return;
        }

        return;
    }

    if (card) {
        const threadId = card.getAttribute('data-thread-id');
        if (threadId) {
            state.selectedThreadId = threadId;
            renderThreads();
        }
    }
};

const handleCommentsInteraction = (event) => {
    const actionBtn = event.target.closest('[data-comment-action]');
    if (!actionBtn) return;

    const action = actionBtn.getAttribute('data-comment-action');
    const commentId = actionBtn.getAttribute('data-comment-id');

    if (!commentId) return;

    if (action === 'delete') {
        deleteComment(commentId);
        return;
    }

    if (action === 'toggle-visibility') {
        toggleCommentVisibility(commentId);
        return;
    }

    if (action === 'moderate-user') {
        const targetUid = actionBtn.getAttribute('data-target-uid');
        const targetName = actionBtn.getAttribute('data-target-name');
        openModerationModal(targetUid, targetName, {
            threadId: state.selectedThreadId,
            commentId
        });
    }
};

const refreshAllData = async () => {
    await refreshClaims();
    renderAuthState();
    renderCategoryFiltersAndComposer();
    renderThreads();
    setCommentFormEnabledState();
    setGlobalFeedback('Fluxul a fost actualizat.', 'success');
};

const bindEvents = () => {
    ui.searchInput.addEventListener('input', () => {
        state.filters.search = ui.searchInput.value;
        renderThreads();
    });

    ui.typeFilter.addEventListener('change', () => {
        state.filters.categoryType = ui.typeFilter.value;
        renderThreads();
    });

    ui.categoryFilter.addEventListener('change', () => {
        state.filters.categoryId = ui.categoryFilter.value;
        renderThreads();
        renderCategoryFiltersAndComposer();
    });

    ui.categoryChipList.addEventListener('click', (event) => {
        const chip = event.target.closest('[data-category-chip]');
        if (!chip) return;

        state.filters.categoryId = chip.getAttribute('data-category-chip') || 'all';
        ui.categoryFilter.value = state.filters.categoryId;

        const chipType = chip.getAttribute('data-category-type');
        if (chipType === 'admin' || chipType === 'normal') {
            state.filters.categoryType = chipType;
            ui.typeFilter.value = chipType;
        }

        renderThreads();
        renderCategoryFiltersAndComposer();
    });

    ui.threadForm.addEventListener('submit', handleThreadSubmit);
    ui.commentForm.addEventListener('submit', handleCommentSubmit);

    ui.stickyThreadsList.addEventListener('click', handleThreadListInteraction);
    ui.communityThreadsList.addEventListener('click', handleThreadListInteraction);
    ui.commentsList.addEventListener('click', handleCommentsInteraction);

    ui.stickyThreadsList.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target.closest('[data-thread-id]');
        if (!card) return;

        event.preventDefault();
        const threadId = card.getAttribute('data-thread-id');
        if (!threadId) return;
        state.selectedThreadId = threadId;
        renderThreads();
    });

    ui.communityThreadsList.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target.closest('[data-thread-id]');
        if (!card) return;

        event.preventDefault();
        const threadId = card.getAttribute('data-thread-id');
        if (!threadId) return;
        state.selectedThreadId = threadId;
        renderThreads();
    });

    ui.refreshThreadsBtn.addEventListener('click', refreshAllData);

    ui.selectedDeleteThreadBtn.addEventListener('click', () => {
        if (!state.selectedThreadId) return;
        deleteThread(state.selectedThreadId);
    });

    ui.selectedLockThreadBtn.addEventListener('click', toggleSelectedThreadLock);
    ui.selectedToggleVisibilityBtn.addEventListener('click', toggleSelectedThreadVisibility);

    ui.selectedRestrictUserBtn.addEventListener('click', () => {
        const selectedThread = state.threads.find((thread) => thread.id === state.selectedThreadId);
        if (!selectedThread) return;

        openModerationModal(selectedThread.authorUid, selectedThread.authorName, {
            threadId: selectedThread.id
        });
    });

    ui.openCategoryModalBtn.addEventListener('click', openCategoryModal);
    ui.closeCategoryModalBtn.addEventListener('click', () => closeModal('category'));
    ui.closeModerationModalBtn.addEventListener('click', () => closeModal('moderation'));

    document.addEventListener('click', (event) => {
        const closer = event.target.closest('[data-close-modal]');
        if (!closer) return;

        const modalType = closer.getAttribute('data-close-modal');
        if (!modalType) return;

        closeModal(modalType);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (!ui.categoryModal.hidden) closeModal('category');
            if (!ui.moderationModal.hidden) closeModal('moderation');
        }
    });

    ui.categoryNameInput.addEventListener('input', () => {
        if (state.categorySlugManuallyEdited) return;
        ui.categorySlugInput.value = slugify(ui.categoryNameInput.value);
    });

    ui.categorySlugInput.addEventListener('input', () => {
        state.categorySlugManuallyEdited = true;
        ui.categorySlugInput.value = slugify(ui.categorySlugInput.value);
    });

    ui.categoryForm.addEventListener('submit', handleCategoryFormSubmit);
    ui.moderationForm.addEventListener('submit', handleModerationSubmit);
};

const initFromUrl = () => {
    const current = new URL(window.location.href);
    const threadId = current.searchParams.get('thread');
    if (threadId) {
        state.pendingUrlThreadId = threadId;
    }
};

const initAuth = () => {
    onAuthStateChanged(auth, async (user) => {
        state.user = user;
        await refreshClaims();
        subscribeRole();
        renderAuthState();
        setThreadFormEnabledState();
        setCommentFormEnabledState();
        renderCategoryFiltersAndComposer();
        renderThreads();
    }, () => {
        state.user = null;
        state.claims = {};
        state.role = parseRoleDoc();
        subscribeRole();
        renderAuthState();
        setThreadFormEnabledState();
        setCommentFormEnabledState();
        renderCategoryFiltersAndComposer();
        renderThreads();
    });
};

const initForumPage = () => {
    initFromUrl();
    bindEvents();
    subscribeCategories();
    subscribeThreads();
    initAuth();
    renderAuthState();
    setThreadFormEnabledState();
    setCommentFormEnabledState();
    setGlobalFeedback('Forum incarcat.');
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initForumPage);
} else {
    initForumPage();
}
