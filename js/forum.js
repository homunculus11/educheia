import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  where,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

const AUTH_RETURN_KEY = "authReturnTo";
const PAGE_SIZE = 5;
const STICKY_LIMIT = 8;
const MAX_VISIBLE_CATEGORY_CHIPS = 6;
const FEED_AUTOLOAD_MARGIN_PX = 240;
const FEED_AUTOLOAD_DELAY_MS = 160;
const MODAL_TRANSITION_MS = 220;
const THREADS_COLLECTION = "forumThreads";
const CATEGORIES_COLLECTION = "forumCategories";
const USER_ROLES_COLLECTION = "forumUserRoles";

const SORT_CONFIG = {
  activity: {
    label: "Activitate recentă",
    build: () => [orderBy("lastActivityAt", "desc")],
  },
  newest: {
    label: "Cele mai noi",
    build: () => [orderBy("createdAt", "desc")],
  },
  comments: {
    label: "Cele mai comentate",
    build: () => [
      orderBy("commentCount", "desc"),
      orderBy("lastActivityAt", "desc"),
    ],
  },
};

const state = {
  categories: [],
  categoriesById: new Map(),
  stickyThreads: [],
  feedThreads: [],
  activeCategory: "all",
  stickyCategory: "all-admin",
  activeSort: "activity",
  searchTerm: "",
  composerCategoryScope: "all",
  feedCursor: null,
  feedLastBatchSize: 0,
  feedAutoCheckTimeoutId: 0,
  hasMoreFeed: true,
  isLoadingFeed: false,
  isLoadingSticky: false,
  stickyLoadFailed: false,
  feedRequestId: 0,
  authUser: null,
  authClaims: {},
  forumRole: "member",
  isAdmin: false,
  isSubmittingThread: false,
  isModalOpen: false,
  modalCloseTimeoutId: 0,
  searchDebounceId: 0,
};

const refs = {
  metaThreads: document.getElementById("forum-meta-threads"),
  metaMembers: document.getElementById("forum-meta-members"),
  newThreadBtn: document.getElementById("new-thread-btn"),
  createHelp: document.getElementById("forum-create-help"),

  stickyLoading: document.getElementById("sticky-loading"),
  stickyList: document.getElementById("sticky-list"),
  stickyEmpty: document.getElementById("sticky-empty"),
  stickyCategoryChips: document.getElementById("forum-sticky-category-chips"),

  feedStatus: document.getElementById("feed-status-inline"),
  feedLoading: document.getElementById("feed-loading"),
  feedList: document.getElementById("feed-list"),
  feedEmpty: document.getElementById("feed-empty"),
  feedError: document.getElementById("feed-error"),
  feedErrorMessage: document.getElementById("feed-error-message"),
  feedRetryBtn: document.getElementById("feed-retry-btn"),
  feedScrollStatus: document.getElementById("feed-scroll-status"),
  feedSentinel: document.getElementById("feed-sentinel"),

  searchInput: document.getElementById("forum-search-input"),
  sortSelect: document.getElementById("forum-sort-select"),
  categoryChips: document.getElementById("forum-category-chips"),
  backToTopBtn: document.getElementById("forum-back-to-top"),

  modal: document.getElementById("thread-modal"),
  modalClose: document.getElementById("thread-modal-close"),
  threadForm: document.getElementById("thread-form"),
  threadTitle: document.getElementById("thread-title"),
  threadCategory: document.getElementById("thread-category"),
  threadStickyWrap: document.getElementById("thread-sticky-wrap"),
  threadIsSticky: document.getElementById("thread-is-sticky"),
  threadStickyHint: document.getElementById("thread-sticky-hint"),
  threadBody: document.getElementById("thread-body"),
  threadSubmit: document.getElementById("thread-submit"),
  threadFeedback: document.getElementById("thread-form-feedback"),

  adminTools: document.getElementById("forum-admin-tools"),
  adminCategoryForm: document.getElementById("admin-category-form"),
  adminCategoryName: document.getElementById("admin-category-name"),
  adminCategorySlug: document.getElementById("admin-category-slug"),
  adminCategoryType: document.getElementById("admin-category-type"),
  adminCategoryDescription: document.getElementById(
    "admin-category-description",
  ),
  adminCategorySubmit: document.getElementById("admin-category-submit"),
};
let feedObserver = null;

const toTrimmedString = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
const VALID_FORUM_ROLES = new Set(["member", "moderator", "admin"]);

const normalizeForumRole = (value) => {
  const role = toTrimmedString(value).toLowerCase();
  return VALID_FORUM_ROLES.has(role) ? role : "member";
};

const slugify = (value) =>
  toTrimmedString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

const slugifyThreadTitle = (value) => {
  const rawSlug = slugify(value);
  if (!rawSlug) return "subiect";
  return rawSlug.split("-").slice(0, 8).join("-");
};

const safeInt = (value, fallback = 0) => {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.max(0, Math.floor(value));
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
};

const toDateOrNull = (raw) => {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw?.toDate === "function") {
    const converted = raw.toDate();
    return Number.isNaN(converted?.getTime?.()) ? null : converted;
  }
  if (typeof raw?.seconds === "number") {
    const converted = new Date(raw.seconds * 1000);
    return Number.isNaN(converted.getTime()) ? null : converted;
  }
  const converted = new Date(raw);
  return Number.isNaN(converted.getTime()) ? null : converted;
};

const extractDisplayName = (user) => {
  const fromProfile = toTrimmedString(user?.displayName);
  if (fromProfile) return fromProfile;

  const email = toTrimmedString(user?.email);
  if (!email) return "Membru Educheia";
  const local = email.split("@")[0] || "Membru Educheia";
  return local.slice(0, 80);
};

const pluralizeComments = (count) =>
  count === 1 ? "comentariu" : "comentarii";

const formatRelativeTime = (rawDate) => {
  const date = toDateOrNull(rawDate);
  if (!date) return "dată necunoscută";

  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSeconds < 60) return "acum câteva secunde";

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60)
    return diffMinutes === 1 ? "acum 1 minut" : `acum ${diffMinutes} minute`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24)
    return diffHours === 1 ? "acum 1 oră" : `acum ${diffHours} ore`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7)
    return diffDays === 1 ? "acum 1 zi" : `acum ${diffDays} zile`;

  return new Intl.DateTimeFormat("ro-RO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
};

const describeError = (
  error,
  fallback = "A apărut o eroare. Încearcă din nou.",
) => {
  const code = error?.code || "";
  const message = toTrimmedString(error?.message);

  if (code === "permission-denied") {
    return "Nu ai permisiunea necesară pentru această acțiune.";
  }

  if (code === "failed-precondition" && /index/i.test(message)) {
    return "Lipsește un index Firestore pentru combinația de filtre/sortare. Creează indexul sugerat din Firebase Console, apoi reîncarcă pagina.";
  }

  if (code === "unavailable") {
    return "Serviciul nu este disponibil momentan. Verifică conexiunea și încearcă din nou.";
  }

  if (code === "unauthenticated") {
    return "Trebuie să fii autentificat pentru această acțiune.";
  }

  return fallback;
};

const mapCategoryDoc = (docSnap) => {
  const data = docSnap.data() || {};
  const categoryType = data.type === "admin" ? "admin" : "normal";

  return {
    id: docSnap.id,
    name: toTrimmedString(data.name) || "Categorie",
    slug: toTrimmedString(data.slug) || docSnap.id,
    description: toTrimmedString(data.description),
    type: categoryType,
    isArchived: Boolean(data.isArchived),
  };
};

const mapThreadDoc = (docSnap) => {
  const data = docSnap.data() || {};

  return {
    id: docSnap.id,
    title: toTrimmedString(data.title) || "Subiect fără titlu",
    body: toTrimmedString(data.body),
    categoryId: toTrimmedString(data.categoryId),
    categoryType: data.categoryType === "admin" ? "admin" : "normal",
    authorUid: toTrimmedString(data.authorUid),
    authorName: toTrimmedString(data.authorName) || "Membru",
    authorIsAdmin: Boolean(data.authorIsAdmin),
    isSticky: Boolean(data.isSticky),
    isLocked: Boolean(data.isLocked),
    moderationStatus: toTrimmedString(data.moderationStatus) || "visible",
    commentCount: safeInt(data.commentCount, 0),
    createdAt: toDateOrNull(data.createdAt),
    updatedAt: toDateOrNull(data.updatedAt),
    lastActivityAt:
      toDateOrNull(data.lastActivityAt) || toDateOrNull(data.createdAt),
  };
};

const getCategoryById = (categoryId) =>
  state.categoriesById.get(categoryId) || null;

const getThreadCategoryLabel = (thread) => {
  const category = getCategoryById(thread.categoryId);
  if (category) return category.name;
  return thread.categoryType === "admin" ? "Administrare" : "General";
};

const buildThreadSearchText = (thread) => {
  const categoryLabel = getThreadCategoryLabel(thread);
  return [thread.title, thread.body, thread.authorName, categoryLabel]
    .join(" ")
    .toLowerCase();
};

const buildThreadUrl = (thread) => {
  const threadId = encodeURIComponent(thread?.id || "");
  const threadSlug = encodeURIComponent(
    slugifyThreadTitle(thread?.title || ""),
  );
  return `/forum/thread/${threadId}/${threadSlug}`;
};
const isAdminCategoryThread = (thread) => thread?.categoryType === "admin";
const toPublicFeedThreads = (threads) =>
  threads.filter((thread) => !isAdminCategoryThread(thread));

const updateMetaCounters = () => {
  const totalLoaded = state.stickyThreads.length + state.feedThreads.length;
  const uniqueAuthors = new Set(
    [...state.stickyThreads, ...state.feedThreads]
      .map((thread) => toTrimmedString(thread.authorName).toLowerCase())
      .filter(Boolean),
  );

  if (refs.metaThreads) {
    refs.metaThreads.textContent = `${totalLoaded}${state.hasMoreFeed ? "+" : ""} subiecte`;
  }

  if (refs.metaMembers) {
    refs.metaMembers.textContent = `${uniqueAuthors.size} membri activi`;
  }
};

const renderFeedStatus = (text) => {
  if (!refs.feedStatus) return;
  refs.feedStatus.textContent = text;
};

const clearNode = (node) => {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
};

const showFeedLoading = (isVisible) => {
  if (!refs.feedLoading || !refs.feedEmpty) return;
  const shouldShowSkeleton = isVisible && state.feedThreads.length === 0;
  refs.feedLoading.hidden = !shouldShowSkeleton;

  if (shouldShowSkeleton) {
    refs.feedEmpty.hidden = true;
  }
};

const showFeedError = (message = "") => {
  if (!refs.feedError || !refs.feedEmpty || !refs.feedErrorMessage) return;

  if (message) {
    refs.feedErrorMessage.textContent = message;
  }
  refs.feedError.hidden = false;
  refs.feedEmpty.hidden = true;
};

const hideFeedError = () => {
  if (!refs.feedError) return;
  refs.feedError.hidden = true;
};

const applyFeedFilters = (threads) => {
  const categoryId = state.activeCategory;
  const search = state.searchTerm.toLowerCase();

  return threads.filter((thread) => {
    if (categoryId !== "all" && thread.categoryId !== categoryId) {
      return false;
    }

    if (!search) {
      return true;
    }

    return buildThreadSearchText(thread).includes(search);
  });
};

const applyStickyFilters = (threads) => {
  const categoryId = state.stickyCategory;
  const search = state.searchTerm.toLowerCase();

  return threads.filter((thread) => {
    if (thread.categoryType !== "admin") {
      return false;
    }

    if (categoryId !== "all-admin" && thread.categoryId !== categoryId) {
      return false;
    }

    if (!search) {
      return true;
    }

    return buildThreadSearchText(thread).includes(search);
  });
};

const getFilteredFeedThreads = () =>
  applyFeedFilters(toPublicFeedThreads(state.feedThreads));

const updateChipRowOverflow = (
  chipRowRef,
  maxVisibleChips = MAX_VISIBLE_CATEGORY_CHIPS,
) => {
  if (!chipRowRef) return;

  const chipCount = chipRowRef.querySelectorAll(".forum-chip").length;
  chipRowRef.classList.toggle("is-scrollable", chipCount > maxVisibleChips);
  chipRowRef.dataset.chipCount = String(chipCount);
};

const applySearchTermWithDebounce = (rawValue) => {
  window.clearTimeout(state.searchDebounceId);

  state.searchDebounceId = window.setTimeout(() => {
    state.searchTerm = toTrimmedString(rawValue);
    renderStickySection();
    renderFeedSection();
  }, 170);
};

const updateFeedInfiniteStatus = ({ hasError, visibleCount }) => {
  if (!refs.feedScrollStatus || !refs.feedSentinel) return;

  if (hasError) {
    refs.feedSentinel.hidden = true;
    refs.feedScrollStatus.textContent = "";
    return;
  }

  const isSearchActive = state.searchTerm.length > 0;
  const hasLoadedSome = visibleCount > 0;

  if (state.isLoadingFeed && hasLoadedSome) {
    refs.feedScrollStatus.textContent = "Se încarcă mai multe subiecte...";
    refs.feedSentinel.hidden = false;
    return;
  }

  if (state.hasMoreFeed) {
    const shouldProbeForEnd =
      state.feedLastBatchSize > 0 && state.feedLastBatchSize < PAGE_SIZE;

    if (shouldProbeForEnd) {
      refs.feedScrollStatus.textContent =
        "Verificăm dacă mai există subiecte...";
    } else {
      refs.feedScrollStatus.textContent =
        isSearchActive ?
          "Continuă să derulezi pentru mai multe rezultate."
        : "Derulează pentru a încărca mai multe subiecte.";
    }
    refs.feedSentinel.hidden = false;
    return;
  }

  refs.feedSentinel.hidden = true;
  refs.feedScrollStatus.textContent =
    hasLoadedSome ? "Ai ajuns la finalul subiectelor." : "";
};

const clearFeedAutoCheckTimeout = () => {
  if (!state.feedAutoCheckTimeoutId) return;
  window.clearTimeout(state.feedAutoCheckTimeoutId);
  state.feedAutoCheckTimeoutId = 0;
};

const isFeedSentinelInAutoloadRange = () => {
  if (!refs.feedSentinel || refs.feedSentinel.hidden) return false;
  const sentinelRect = refs.feedSentinel.getBoundingClientRect();
  return sentinelRect.top <= window.innerHeight + FEED_AUTOLOAD_MARGIN_PX;
};

const scheduleFeedAutoCheck = () => {
  clearFeedAutoCheckTimeout();

  if (!state.hasMoreFeed || state.isLoadingFeed) return;
  if (!refs.feedSentinel || refs.feedSentinel.hidden) return;

  state.feedAutoCheckTimeoutId = window.setTimeout(async () => {
    state.feedAutoCheckTimeoutId = 0;

    if (!state.hasMoreFeed || state.isLoadingFeed) return;
    if (!isFeedSentinelInAutoloadRange()) return;

    await loadFeedPage({ reset: false });
  }, FEED_AUTOLOAD_DELAY_MS);
};

const updateBackToTopVisibility = () => {
  if (!refs.backToTopBtn) return;

  const shouldShow = window.scrollY > 720;
  refs.backToTopBtn.hidden = !shouldShow;
  refs.backToTopBtn.classList.toggle("is-visible", shouldShow);
};

const renderThreadList = (listRef, threads) => {
  clearNode(listRef);

  if (!threads.length) return;

  const fragment = document.createDocumentFragment();

  threads.forEach((thread) => {
    const link = document.createElement("a");
    link.className = "forum-thread-link";
    link.href = buildThreadUrl(thread);
    link.setAttribute("role", "listitem");

    const head = document.createElement("div");
    head.className = "forum-thread-head";

    const copyWrap = document.createElement("div");

    const title = document.createElement("h3");
    title.className = "forum-thread-title";
    title.textContent = thread.title;

    const body = document.createElement("p");
    body.className = "forum-thread-body";
    body.textContent =
      thread.body || "Deschide subiectul pentru a vedea detaliile complete.";

    const meta = document.createElement("div");
    meta.className = "forum-thread-meta";

    const categoryPill = document.createElement("span");
    categoryPill.className = "forum-pill";
    categoryPill.textContent = getThreadCategoryLabel(thread);
    meta.appendChild(categoryPill);

    if (thread.isSticky) {
      const stickyPill = document.createElement("span");
      stickyPill.className = "forum-pill forum-pill-sticky";
      stickyPill.textContent = "Fixat";
      meta.appendChild(stickyPill);
    }

    if (thread.authorIsAdmin) {
      const adminPill = document.createElement("span");
      adminPill.className = "forum-pill forum-pill-admin";
      adminPill.textContent = "Echipă";
      meta.appendChild(adminPill);
    }

    if (thread.isLocked) {
      const lockedPill = document.createElement("span");
      lockedPill.className = "forum-pill";
      lockedPill.textContent = "Blocată";
      meta.appendChild(lockedPill);
    }

    const byline = document.createElement("span");
    byline.textContent = `de ${thread.authorName} · ${formatRelativeTime(thread.createdAt)}`;
    meta.appendChild(byline);

    copyWrap.append(title, body, meta);

    const stats = document.createElement("div");
    stats.className = "forum-thread-stats";

    const count = document.createElement("p");
    count.className = "forum-thread-count";
    count.textContent = String(thread.commentCount);

    const countLabel = document.createElement("span");
    countLabel.className = "forum-thread-count-label";
    countLabel.textContent = pluralizeComments(thread.commentCount);

    const activity = document.createElement("p");
    activity.className = "forum-thread-activity";
    activity.textContent = `Activitate: ${formatRelativeTime(thread.lastActivityAt || thread.createdAt)}`;

    stats.append(count, countLabel, activity);
    head.append(copyWrap, stats);
    link.appendChild(head);

    fragment.appendChild(link);
  });

  listRef.appendChild(fragment);
};

const updateAuxPanels = () => {
  updateMetaCounters();
};

const renderStickySection = () => {
  const visibleSticky = applyStickyFilters(state.stickyThreads);

  refs.stickyLoading.hidden = !state.isLoadingSticky;

  if (
    !state.isLoadingSticky &&
    !state.stickyLoadFailed &&
    !visibleSticky.length
  ) {
    refs.stickyEmpty.hidden = false;
  } else {
    refs.stickyEmpty.hidden = true;
  }

  renderThreadList(refs.stickyList, visibleSticky);
};

const renderFeedSection = () => {
  const visibleFeed = getFilteredFeedThreads();
  const hasError = !refs.feedError.hidden;

  const isEmpty = !state.isLoadingFeed && !hasError && !visibleFeed.length;
  refs.feedEmpty.hidden = !isEmpty;

  renderThreadList(refs.feedList, visibleFeed);

  if (isEmpty) {
    renderFeedStatus("Niciun rezultat pentru filtrele selectate.");
  } else {
    renderFeedStatus(
      `${visibleFeed.length} subiecte încărcate · ${SORT_CONFIG[state.activeSort]?.label || ""}`,
    );
  }

  updateFeedInfiniteStatus({
    hasError,
    visibleCount: visibleFeed.length,
  });

  scheduleFeedAutoCheck();
  updateAuxPanels();
};

const getThreadTimestamp = (date) => toDateOrNull(date)?.getTime?.() || 0;

const sortThreadsClientSide = (threads) => {
  const sorted = [...threads];

  if (state.activeSort === "comments") {
    sorted.sort((a, b) => {
      if (b.commentCount !== a.commentCount)
        return b.commentCount - a.commentCount;
      return (
        getThreadTimestamp(b.lastActivityAt) -
        getThreadTimestamp(a.lastActivityAt)
      );
    });
    return sorted;
  }

  if (state.activeSort === "newest") {
    sorted.sort(
      (a, b) =>
        getThreadTimestamp(b.createdAt) - getThreadTimestamp(a.createdAt),
    );
    return sorted;
  }

  sorted.sort(
    (a, b) =>
      getThreadTimestamp(b.lastActivityAt) -
      getThreadTimestamp(a.lastActivityAt),
  );
  return sorted;
};

const loadFeedPageFallback = async ({ requestId, reset }) => {
  const threadsRef = collection(db, THREADS_COLLECTION);
  const fallbackConstraints = [
    where("isSticky", "==", false),
    where("categoryType", "==", "normal"),
    where("moderationStatus", "==", "visible"),
  ];

  if (state.activeCategory !== "all") {
    fallbackConstraints.unshift(
      where("categoryId", "==", state.activeCategory),
    );
  }

  if (state.feedCursor) {
    fallbackConstraints.push(startAfter(state.feedCursor));
  }

  fallbackConstraints.push(limit(PAGE_SIZE));

  const snapshot = await getDocs(query(threadsRef, ...fallbackConstraints));
  if (requestId !== state.feedRequestId) return false;

  state.feedLastBatchSize = snapshot.docs.length;
  const fetched = sortThreadsClientSide(snapshot.docs.map(mapThreadDoc));

  if (reset) {
    state.feedThreads = fetched;
  } else {
    const seen = new Set(state.feedThreads.map((thread) => thread.id));
    fetched.forEach((thread) => {
      if (!seen.has(thread.id)) {
        state.feedThreads.push(thread);
        seen.add(thread.id);
      }
    });
  }

  if (snapshot.docs.length) {
    state.feedCursor = snapshot.docs[snapshot.docs.length - 1];
  }

  state.hasMoreFeed = snapshot.docs.length > 0;
  hideFeedError();
  return true;
};

const buildFeedConstraints = () => {
  const constraints = [where("isSticky", "==", false)];
  constraints.push(where("categoryType", "==", "normal"));
  constraints.push(where("moderationStatus", "==", "visible"));

  if (state.activeCategory !== "all") {
    constraints.push(where("categoryId", "==", state.activeCategory));
  }

  const selectedSort = SORT_CONFIG[state.activeSort] || SORT_CONFIG.activity;
  constraints.push(...selectedSort.build());

  if (state.feedCursor) {
    constraints.push(startAfter(state.feedCursor));
  }

  constraints.push(limit(PAGE_SIZE));

  return constraints;
};

const loadCategories = async () => {
  const categoriesRef = collection(db, CATEGORIES_COLLECTION);

  let docs = [];

  try {
    const snapshot = await getDocs(
      query(
        categoriesRef,
        where("isArchived", "==", false),
        orderBy("name", "asc"),
      ),
    );
    docs = snapshot.docs;
  } catch {
    const fallback = await getDocs(categoriesRef);
    docs = fallback.docs;
  }

  const parsed = docs
    .map(mapCategoryDoc)
    .filter((category) => !category.isArchived)
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "normal" ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "ro");
    });

  state.categories = parsed;
  state.categoriesById = new Map(
    parsed.map((category) => [category.id, category]),
  );

  const normalIds = new Set(
    getNormalCategories().map((category) => category.id),
  );
  if (state.activeCategory !== "all" && !normalIds.has(state.activeCategory)) {
    state.activeCategory = "all";
  }

  const adminIds = new Set(getAdminCategories().map((category) => category.id));
  if (
    state.stickyCategory !== "all-admin" &&
    !adminIds.has(state.stickyCategory)
  ) {
    state.stickyCategory = "all-admin";
  }
};

const loadStickyThreads = async () => {
  state.isLoadingSticky = true;
  state.stickyLoadFailed = false;
  renderStickySection();

  const threadsRef = collection(db, THREADS_COLLECTION);

  try {
    const stickyQuery = query(
      threadsRef,
      where("isSticky", "==", true),
      where("categoryType", "==", "admin"),
      where("moderationStatus", "==", "visible"),
      orderBy("lastActivityAt", "desc"),
      limit(STICKY_LIMIT),
    );

    const snapshot = await getDocs(stickyQuery);
    state.stickyThreads = snapshot.docs.map(mapThreadDoc);
  } catch (error) {
    try {
      const fallbackSnapshot = await getDocs(
        query(
          threadsRef,
          where("isSticky", "==", true),
          where("categoryType", "==", "admin"),
          where("moderationStatus", "==", "visible"),
          limit(STICKY_LIMIT),
        ),
      );
      state.stickyThreads = fallbackSnapshot.docs
        .map(mapThreadDoc)
        .sort(
          (a, b) =>
            (b.lastActivityAt?.getTime?.() || 0) -
            (a.lastActivityAt?.getTime?.() || 0),
        );
    } catch {
      state.stickyThreads = [];
      state.stickyLoadFailed = true;
      renderFeedStatus(
        describeError(error, "Nu am putut încărca subiectele fixate."),
      );
    }
  } finally {
    state.isLoadingSticky = false;
    renderStickySection();
    updateAuxPanels();
  }
};

const loadFeedPage = async ({ reset = false } = {}) => {
  if (state.isLoadingFeed) return;
  if (!reset && !state.hasMoreFeed) return;

  if (reset) {
    clearFeedAutoCheckTimeout();
    state.feedThreads = [];
    state.feedCursor = null;
    state.feedLastBatchSize = 0;
    state.hasMoreFeed = true;
    hideFeedError();
    refs.feedEmpty.hidden = true;
    clearNode(refs.feedList);
  }

  state.isLoadingFeed = true;
  hideFeedError();
  showFeedLoading(true);
  renderFeedStatus("Se încarcă subiectele...");

  const requestId = ++state.feedRequestId;

  try {
    const threadsRef = collection(db, THREADS_COLLECTION);
    const snapshot = await getDocs(
      query(threadsRef, ...buildFeedConstraints()),
    );

    if (requestId !== state.feedRequestId) return;

    state.feedLastBatchSize = snapshot.docs.length;
    const fetched = snapshot.docs.map(mapThreadDoc);

    if (reset) {
      state.feedThreads = fetched;
    } else {
      const seen = new Set(state.feedThreads.map((thread) => thread.id));
      fetched.forEach((thread) => {
        if (!seen.has(thread.id)) {
          state.feedThreads.push(thread);
          seen.add(thread.id);
        }
      });
    }

    if (snapshot.docs.length) {
      state.feedCursor = snapshot.docs[snapshot.docs.length - 1];
    }

    state.hasMoreFeed = snapshot.docs.length > 0;
    hideFeedError();
  } catch (error) {
    if (requestId !== state.feedRequestId) return;
    let recovered = false;

    try {
      recovered = await loadFeedPageFallback({ requestId, reset });
    } catch {
      recovered = false;
    }

    if (!recovered) {
      state.hasMoreFeed = false;
      state.feedLastBatchSize = 0;
      const readableError = describeError(error);

      if (state.feedThreads.length > 0) {
        hideFeedError();
        renderFeedStatus(readableError);
      } else {
        showFeedError(readableError);
      }
    }
  } finally {
    if (requestId === state.feedRequestId) {
      state.isLoadingFeed = false;
      showFeedLoading(false);
      renderFeedSection();
    }
  }
};

const buildFilterChip = ({ id, label, selected, datasetKey }) => {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = selected ? "forum-chip is-active" : "forum-chip";
  chip.dataset[datasetKey] = id;
  chip.setAttribute("role", "tab");
  chip.setAttribute("aria-selected", String(selected));
  chip.textContent = label;
  return chip;
};

const getNormalCategories = () =>
  state.categories.filter(
    (category) => category.type === "normal" && !category.isArchived,
  );
const getAdminCategories = () =>
  state.categories.filter(
    (category) => category.type === "admin" && !category.isArchived,
  );

const normalizeComposerScope = (scope) => {
  if (!state.isAdmin) return "normal";
  if (scope === "admin" || scope === "normal" || scope === "all") return scope;
  return "all";
};

const getComposerCategoriesByScope = (scope) => {
  const normalizedScope = normalizeComposerScope(scope);
  const activeCategories = state.categories.filter(
    (category) => !category.isArchived,
  );

  if (!state.isAdmin) {
    return activeCategories.filter((category) => category.type === "normal");
  }

  if (normalizedScope === "admin") {
    return activeCategories.filter((category) => category.type === "admin");
  }

  if (normalizedScope === "normal") {
    return activeCategories.filter((category) => category.type === "normal");
  }

  return activeCategories;
};

const renderCategoryChips = () => {
  if (!refs.categoryChips) return;

  clearNode(refs.categoryChips);

  refs.categoryChips.appendChild(
    buildFilterChip({
      id: "all",
      label: "Toate categoriile",
      selected: state.activeCategory === "all",
      datasetKey: "category",
    }),
  );

  getNormalCategories().forEach((category) => {
    refs.categoryChips.appendChild(
      buildFilterChip({
        id: category.id,
        label: category.name,
        selected: state.activeCategory === category.id,
        datasetKey: "category",
      }),
    );
  });

  updateChipRowOverflow(refs.categoryChips);
};

const renderStickyCategoryChips = () => {
  if (!refs.stickyCategoryChips) return;

  clearNode(refs.stickyCategoryChips);

  const adminCategories = getAdminCategories();

  if (
    state.stickyCategory !== "all-admin" &&
    !adminCategories.some((category) => category.id === state.stickyCategory)
  ) {
    state.stickyCategory = "all-admin";
  }

  refs.stickyCategoryChips.appendChild(
    buildFilterChip({
      id: "all-admin",
      label: "Toate categoriile admin",
      selected: state.stickyCategory === "all-admin",
      datasetKey: "stickyCategory",
    }),
  );

  adminCategories.forEach((category) => {
    refs.stickyCategoryChips.appendChild(
      buildFilterChip({
        id: category.id,
        label: category.name,
        selected: state.stickyCategory === category.id,
        datasetKey: "stickyCategory",
      }),
    );
  });

  updateChipRowOverflow(refs.stickyCategoryChips);
};

const populateThreadCategorySelect = ({
  scope = state.composerCategoryScope,
  preferredValue = null,
} = {}) => {
  const normalizedScope = normalizeComposerScope(scope);
  state.composerCategoryScope = normalizedScope;

  const previousValue = preferredValue ?? refs.threadCategory.value;
  clearNode(refs.threadCategory);

  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = "Selectează categoria";
  refs.threadCategory.appendChild(placeholderOption);

  const allowedCategories = getComposerCategoriesByScope(normalizedScope);

  allowedCategories.forEach((category) => {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent =
      category.type === "admin" ? `${category.name} (admin)` : category.name;
    refs.threadCategory.appendChild(option);
  });

  if (
    previousValue &&
    allowedCategories.some((category) => category.id === previousValue)
  ) {
    refs.threadCategory.value = previousValue;
  }

  return allowedCategories;
};

const updateThreadStickyModeState = () => {
  if (!refs.threadStickyWrap || !refs.threadIsSticky) return;

  if (!state.isAdmin) {
    refs.threadStickyWrap.hidden = true;
    refs.threadIsSticky.checked = false;
    refs.threadIsSticky.disabled = true;
    return;
  }

  refs.threadStickyWrap.hidden = false;

  const selectedCategory = getCategoryById(refs.threadCategory.value);
  const selectedIsAdminCategory = selectedCategory?.type === "admin";
  const scope = normalizeComposerScope(state.composerCategoryScope);

  let canToggleSticky = true;
  if (scope === "all") {
    canToggleSticky = selectedIsAdminCategory;
  }

  if (!canToggleSticky) {
    refs.threadIsSticky.checked = false;
  }

  refs.threadIsSticky.disabled = !canToggleSticky;

  if (!refs.threadStickyHint) return;

  if (scope === "admin" && refs.threadIsSticky.checked) {
    refs.threadStickyHint.textContent =
      "Mod sticky activ: sunt afișate doar categoriile administrative.";
    return;
  }

  if (scope === "normal") {
    refs.threadStickyHint.textContent =
      "Mod normal activ: sunt afișate doar categoriile normale. Bifează pentru a trece pe sticky.";
    return;
  }

  if (selectedIsAdminCategory) {
    refs.threadStickyHint.textContent =
      "Categoria administrativă este selectată: poți fixa subiectul dacă este important pentru comunitate.";
    return;
  }

  refs.threadStickyHint.textContent =
    "Selectează o categorie administrativă pentru a activa opțiunea sticky.";
};

const setComposerCategoryScope = (scope, { preferredValue = null } = {}) => {
  populateThreadCategorySelect({ scope, preferredValue });
  updateThreadStickyModeState();
};

const updateCreateUiState = () => {
  if (state.authUser) {
    refs.newThreadBtn.textContent = "Start o nouă discuție";
    if (refs.createHelp) {
      if (state.isAdmin) {
        refs.createHelp.textContent =
          "Ai acces admin: poți fixa thread-uri direct din formular.";
      } else {
        refs.createHelp.textContent =
          "Ai un context util? Publică-l și ajută comunitatea.";
      }
    }
  } else {
    refs.newThreadBtn.textContent = "Intră pentru a publica";
    if (refs.createHelp) {
      refs.createHelp.textContent =
        "Autentifică-te pentru a porni un subiect nou în forum.";
    }
  }
};

const setFormFeedback = (text, type = "") => {
  refs.threadFeedback.textContent = text;
  refs.threadFeedback.classList.remove("is-error", "is-success");

  if (type === "error") refs.threadFeedback.classList.add("is-error");
  if (type === "success") refs.threadFeedback.classList.add("is-success");
};

const updateAdminToolsVisibility = () => {
  if (refs.adminTools) {
    refs.adminTools.hidden = !state.isAdmin;
  }

  if (!state.isAdmin) {
    state.composerCategoryScope = "normal";
    if (refs.threadIsSticky) {
      refs.threadIsSticky.checked = false;
    }
  }

  updateThreadStickyModeState();
};

const getFocusableInModal = () => {
  if (!refs.modal) return [];
  return [
    ...refs.modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter(
    (el) => !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden"),
  );
};

const clearModalCloseTimeout = () => {
  if (!state.modalCloseTimeoutId) return;
  window.clearTimeout(state.modalCloseTimeoutId);
  state.modalCloseTimeoutId = 0;
};

const setModalBodyScrollLock = (isLocked) => {
  if (isLocked) {
    const scrollbarGap = Math.max(
      0,
      window.innerWidth - document.documentElement.clientWidth,
    );
    document.body.style.setProperty(
      "--modal-scrollbar-gap",
      `${scrollbarGap}px`,
    );
    document.body.classList.add("modal-open");
    return;
  }

  document.body.classList.remove("modal-open");
  document.body.style.removeProperty("--modal-scrollbar-gap");
};

const closeThreadModal = () => {
  if (!state.isModalOpen) return;

  state.isModalOpen = false;
  refs.modal.setAttribute("aria-hidden", "true");
  refs.modal.classList.remove("is-open");
  refs.modal.classList.add("is-closing");
  setModalBodyScrollLock(false);
  clearModalCloseTimeout();

  const finalizeClose = () => {
    refs.modal.hidden = true;
    refs.modal.classList.remove("is-closing");
    state.modalCloseTimeoutId = 0;
    refs.newThreadBtn.focus();
  };

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    finalizeClose();
    return;
  }

  state.modalCloseTimeoutId = window.setTimeout(
    finalizeClose,
    MODAL_TRANSITION_MS,
  );
};

const openThreadModal = () => {
  if (!state.authUser) {
    const returnTarget = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    try {
      sessionStorage.setItem(AUTH_RETURN_KEY, returnTarget);
    } catch {
      // no-op
    }
    window.location.href = "/login";
    return;
  }

  setFormFeedback("");
  if (state.isAdmin) {
    state.composerCategoryScope = "all";
    refs.threadIsSticky.checked = false;
    setComposerCategoryScope("all", { preferredValue: "" });
  } else {
    setComposerCategoryScope("normal", { preferredValue: "" });
  }

  clearModalCloseTimeout();
  state.isModalOpen = true;
  refs.modal.hidden = false;
  refs.modal.setAttribute("aria-hidden", "false");
  refs.modal.classList.remove("is-closing");
  setModalBodyScrollLock(true);

  window.requestAnimationFrame(() => {
    refs.modal.classList.add("is-open");
    refs.threadTitle.focus();
  });
};

const validateThreadInput = () => {
  const title = toTrimmedString(refs.threadTitle.value);
  const categoryId = toTrimmedString(refs.threadCategory.value);
  const body = toTrimmedString(refs.threadBody.value);
  const wantsSticky = Boolean(refs.threadIsSticky?.checked);

  if (!state.authUser) {
    return {
      ok: false,
      message: "Trebuie să fii autentificat pentru a publica.",
    };
  }

  if (title.length < 6 || title.length > 160) {
    return {
      ok: false,
      message: "Titlul trebuie să aibă între 6 și 160 de caractere.",
    };
  }

  if (body.length < 12 || body.length > 8000) {
    return {
      ok: false,
      message: "Mesajul trebuie să aibă între 12 și 8000 de caractere.",
    };
  }

  const category = getCategoryById(categoryId);
  if (!category) {
    return { ok: false, message: "Selectează o categorie validă." };
  }

  if (category.isArchived) {
    return { ok: false, message: "Categoria selectată este arhivată." };
  }

  if (category.type === "admin" && !state.isAdmin) {
    return {
      ok: false,
      message: "Doar echipa poate publica în categoriile administrative.",
    };
  }

  if (wantsSticky && !state.isAdmin) {
    return { ok: false, message: "Doar administratorii pot fixa subiecte." };
  }

  if (wantsSticky && category.type !== "admin") {
    return {
      ok: false,
      message:
        "Subiectele sticky pot fi publicate doar în categorii administrative.",
    };
  }

  return {
    ok: true,
    title,
    body,
    category,
    isSticky: wantsSticky && state.isAdmin,
  };
};

const resetThreadForm = () => {
  refs.threadForm.reset();
  if (refs.threadIsSticky) {
    refs.threadIsSticky.checked = false;
  }
  if (state.isAdmin) {
    state.composerCategoryScope = "all";
    setComposerCategoryScope("all", { preferredValue: "" });
  } else {
    setComposerCategoryScope("normal", { preferredValue: "" });
  }
  setFormFeedback("");
};

const submitThread = async () => {
  if (state.isSubmittingThread) return;

  const validation = validateThreadInput();
  if (!validation.ok) {
    setFormFeedback(validation.message, "error");
    return;
  }

  state.isSubmittingThread = true;
  refs.threadSubmit.disabled = true;
  refs.threadSubmit.textContent = "Se publică...";

  try {
    const user = state.authUser;
    const payload = {
      title: validation.title,
      body: validation.body,
      categoryId: validation.category.id,
      categoryType: validation.category.type,
      authorUid: user.uid,
      authorName: extractDisplayName(user),
      authorIsAdmin: state.isAdmin,
      isSticky: Boolean(validation.isSticky),
      isLocked: false,
      moderationStatus: "visible",
      commentCount: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastActivityAt: serverTimestamp(),
    };

    if (toTrimmedString(user.email)) {
      payload.authorEmail = toTrimmedString(user.email);
    }

    await addDoc(collection(db, THREADS_COLLECTION), payload);

    resetThreadForm();
    closeThreadModal();
    renderFeedStatus("Subiect publicat cu succes. Se actualizează lista...");

    await loadStickyThreads();
    await loadFeedPage({ reset: true });
  } catch (error) {
    setFormFeedback(
      describeError(error, "Nu am putut publica subiectul. Încearcă din nou."),
      "error",
    );
  } finally {
    state.isSubmittingThread = false;
    refs.threadSubmit.disabled = false;
    refs.threadSubmit.textContent = "Publică subiectul";
  }
};

const submitAdminCategory = async () => {
  if (
    !refs.adminCategoryForm ||
    !refs.adminCategoryName ||
    !refs.adminCategorySlug ||
    !refs.adminCategoryType ||
    !refs.adminCategoryDescription ||
    !refs.adminCategorySubmit
  ) {
    return;
  }

  if (!state.isAdmin) {
    renderFeedStatus("Doar administratorii pot crea categorii.");
    return;
  }

  if (!state.authUser) {
    renderFeedStatus("Trebuie să fii autentificat pentru a crea categorii.");
    return;
  }

  const name = toTrimmedString(refs.adminCategoryName.value);
  const rawSlug = toTrimmedString(refs.adminCategorySlug.value);
  const slug = slugify(rawSlug || name);
  const categoryType =
    toTrimmedString(refs.adminCategoryType.value) === "admin" ? "admin" : (
      "normal"
    );
  const description = toTrimmedString(refs.adminCategoryDescription.value);

  if (name.length < 2 || name.length > 70) {
    renderFeedStatus(
      "Numele categoriei trebuie să aibă între 2 și 70 de caractere.",
    );
    return;
  }

  if (slug.length < 2 || slug.length > 70) {
    renderFeedStatus("Slug-ul trebuie să aibă între 2 și 70 de caractere.");
    return;
  }

  if (description.length > 280) {
    renderFeedStatus("Descrierea poate avea maximum 280 de caractere.");
    return;
  }

  refs.adminCategorySubmit.disabled = true;
  refs.adminCategorySubmit.textContent = "Se creează...";

  try {
    const payload = {
      name,
      slug,
      type: categoryType,
      isArchived: false,
      createdByUid: state.authUser.uid,
      createdByName: extractDisplayName(state.authUser),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (description) {
      payload.description = description;
    }

    await addDoc(collection(db, CATEGORIES_COLLECTION), payload);

    refs.adminCategoryForm.reset();
    renderFeedStatus("Categoria a fost creată cu succes.");

    await loadCategories();
    renderCategoryChips();
    renderStickyCategoryChips();
    setComposerCategoryScope(state.composerCategoryScope, {
      preferredValue: refs.threadCategory.value,
    });
  } catch (error) {
    renderFeedStatus(describeError(error, "Nu am putut crea categoria."));
  } finally {
    refs.adminCategorySubmit.disabled = false;
    refs.adminCategorySubmit.textContent = "Creează categorie";
  }
};

const onModalKeydown = (event) => {
  if (!state.isModalOpen) return;

  if (event.key === "Escape") {
    event.preventDefault();
    closeThreadModal();
    return;
  }

  if (event.key !== "Tab") return;

  const focusables = getFocusableInModal();
  if (!focusables.length) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }

  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
};

const onSearchInput = () => {
  applySearchTermWithDebounce(refs.searchInput?.value || "");
};

const onFeedSentinelIntersect = async (entries) => {
  const hasVisibleSentinel = entries.some((entry) => entry.isIntersecting);
  if (!hasVisibleSentinel) return;
  if (state.isLoadingFeed || !state.hasMoreFeed) return;

  await loadFeedPage({ reset: false });
};

const initFeedInfiniteScroll = () => {
  if (!refs.feedSentinel || feedObserver) return;
  if (!("IntersectionObserver" in window)) return;

  feedObserver = new IntersectionObserver(onFeedSentinelIntersect, {
    root: null,
    rootMargin: "0px 0px 300px 0px",
    threshold: 0,
  });
  feedObserver.observe(refs.feedSentinel);
};

const onBackToTopClick = () => {
  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
};

const onCategoryChipClick = async (event) => {
  const target = event.target.closest("[data-category]");
  if (!target) return;

  const categoryId = target.getAttribute("data-category") || "all";
  if (categoryId === state.activeCategory) return;

  state.activeCategory = categoryId;
  renderCategoryChips();

  await loadFeedPage({ reset: true });
};

const onStickyCategoryChipClick = (event) => {
  const target = event.target.closest("[data-sticky-category]");
  if (!target) return;

  const categoryId = target.getAttribute("data-sticky-category") || "all-admin";
  if (categoryId === state.stickyCategory) return;

  state.stickyCategory = categoryId;
  renderStickyCategoryChips();
  renderStickySection();
};

const onThreadCategoryChange = () => {
  if (!state.isAdmin) return;

  if (state.composerCategoryScope !== "all") {
    updateThreadStickyModeState();
    return;
  }

  const selectedCategory = getCategoryById(refs.threadCategory.value);
  if (!selectedCategory || selectedCategory.type !== "admin") {
    refs.threadIsSticky.checked = false;
  }

  updateThreadStickyModeState();
};

const onThreadStickyToggle = () => {
  if (!state.isAdmin || !refs.threadIsSticky) return;

  if (refs.threadIsSticky.checked) {
    const adminCategories = getComposerCategoriesByScope("admin");
    if (!adminCategories.length) {
      refs.threadIsSticky.checked = false;
      setFormFeedback(
        "Nu există categorii administrative active pentru un subiect sticky.",
        "error",
      );
      updateThreadStickyModeState();
      return;
    }

    setFormFeedback("");
    setComposerCategoryScope("admin", {
      preferredValue: refs.threadCategory.value || adminCategories[0].id,
    });
    refs.threadIsSticky.checked = true;
    return;
  }

  const normalCategories = getComposerCategoriesByScope("normal");
  if (!normalCategories.length) {
    setComposerCategoryScope("all", {
      preferredValue: refs.threadCategory.value,
    });
    return;
  }

  setComposerCategoryScope("normal", {
    preferredValue: refs.threadCategory.value || normalCategories[0].id,
  });
};

const onSortChange = async () => {
  const nextSort = refs.sortSelect.value;
  if (!SORT_CONFIG[nextSort]) return;
  if (nextSort === state.activeSort) return;

  state.activeSort = nextSort;
  await loadFeedPage({ reset: true });
};

const resolveCurrentUserForumRole = async (user, claims = {}) => {
  if (!user) return "member";

  if (claims.admin === true || claims.role === "admin") return "admin";
  if (claims.moderator === true || claims.role === "moderator")
    return "moderator";

  try {
    const roleSnapshot = await getDoc(doc(db, USER_ROLES_COLLECTION, user.uid));
    if (roleSnapshot.exists()) {
      const roleFromDoc = normalizeForumRole(roleSnapshot.data()?.role);
      return roleFromDoc;
    }
  } catch {
    return "member";
  }

  return "member";
};

const initAuth = () => {
  onAuthStateChanged(auth, async (user) => {
    state.authUser = user;
    state.authClaims = {};
    state.forumRole = "member";
    state.isAdmin = false;

    if (user) {
      try {
        const tokenResult = await user.getIdTokenResult(true);
        state.authClaims = tokenResult?.claims || {};
        state.forumRole = await resolveCurrentUserForumRole(
          user,
          state.authClaims,
        );
        state.isAdmin = state.forumRole === "admin";
      } catch {
        state.authClaims = {};
        state.forumRole = await resolveCurrentUserForumRole(user, {});
        state.isAdmin = state.forumRole === "admin";
      }
    }

    state.composerCategoryScope = state.isAdmin ? "all" : "normal";
    setComposerCategoryScope(state.composerCategoryScope, {
      preferredValue: refs.threadCategory.value,
    });
    renderStickyCategoryChips();
    updateCreateUiState();
    updateAdminToolsVisibility();
  });
};

const bindEvents = () => {
  refs.newThreadBtn.addEventListener("click", openThreadModal);

  refs.feedRetryBtn.addEventListener("click", async () => {
    hideFeedError();
    await loadFeedPage({ reset: true });
  });

  refs.sortSelect.addEventListener("change", onSortChange);
  refs.searchInput?.addEventListener("input", onSearchInput);
  refs.categoryChips.addEventListener("click", onCategoryChipClick);
  refs.stickyCategoryChips?.addEventListener(
    "click",
    onStickyCategoryChipClick,
  );
  refs.threadCategory.addEventListener("change", onThreadCategoryChange);
  refs.threadIsSticky?.addEventListener("change", onThreadStickyToggle);

  refs.modal.addEventListener("click", (event) => {
    const closeTrigger = event.target.closest("[data-close-modal]");
    if (closeTrigger) {
      closeThreadModal();
    }
  });

  refs.modalClose.addEventListener("click", closeThreadModal);

  document.addEventListener("keydown", onModalKeydown);
  window.addEventListener("scroll", updateBackToTopVisibility, {
    passive: true,
  });
  refs.backToTopBtn?.addEventListener("click", onBackToTopClick);

  refs.threadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitThread();
  });

  refs.adminCategoryForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAdminCategory();
  });
};

const init = async () => {
  bindEvents();
  initAuth();
  initFeedInfiniteScroll();
  updateBackToTopVisibility();

  if (refs.sortSelect && SORT_CONFIG[refs.sortSelect.value]) {
    state.activeSort = refs.sortSelect.value;
  }

  try {
    await loadCategories();
  } catch (error) {
    renderFeedStatus(
      describeError(error, "Nu am putut încărca categoriile forumului."),
    );
  }

  renderCategoryChips();
  renderStickyCategoryChips();
  setComposerCategoryScope(state.composerCategoryScope, {
    preferredValue: refs.threadCategory.value,
  });
  updateCreateUiState();

  await Promise.all([loadStickyThreads(), loadFeedPage({ reset: true })]);
};

init().catch((error) => {
  showFeedLoading(false);
  showFeedError(
    describeError(error, "Nu am putut inițializa forumul. Încearcă din nou."),
  );
});
