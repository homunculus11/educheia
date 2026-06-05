import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

const AUTH_RETURN_KEY = "authReturnTo";
const PAGE_SIZE = 5;
const FEED_QUERY_LIMIT = PAGE_SIZE + 1;
const STICKY_LIMIT = 12;
const RECENT_EPISODES_LIMIT = 3;
const EPISODES_CACHE_KEY = "episodesCacheV1";
const MAX_VISIBLE_CATEGORY_CHIPS = 6;
const MODAL_TRANSITION_MS = 220;
const BACK_TO_TOP_FADE_MS = 180;
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
  recentEpisodes: [],
  recentEpisodeThreadCounts: new Map(),
  episodeThreads: [],
  feedThreads: [],
  activeCategory: "all",
  stickyCategory: "all-admin",
  activeEpisodeId: "",
  activeEpisodeTitle: "",
  activeSort: "activity",
  searchTerm: "",
  composerCategoryScope: "normal",
  feedCursor: null,
  feedLastBatchSize: 0,
  hasMoreFeed: true,
  isLoadingFeed: false,
  isLoadingSticky: false,
  isLoadingEpisodeThreads: false,
  stickyLoadFailed: false,
  recentEpisodesLoadFailed: false,
  hasScrolledToInitialEpisodeSection: false,
  episodeThreadsLoadFailed: false,
  feedRequestId: 0,
  episodeThreadsRequestId: 0,
  authUser: null,
  authClaims: {},
  currentUserRoleData: null,
  forumRole: "member",
  isAdmin: false,
  threadPostingRestriction: null,
  adminModerationStatus: "pending",
  adminModerationThreads: [],
  isLoadingAdminModeration: false,
  hasLoadedAdminModeration: false,
  adminModerationRequestId: 0,
  isSubmittingThread: false,
  isModalOpen: false,
  modalCloseTimeoutId: 0,
  lastModalFocusedElement: null,
  searchDebounceId: 0,
  backToTopHideTimeoutId: 0,
  revealedFeedThreadIds: new Set(),
  revealedStickyThreadIds: new Set(),
  revealedEpisodeThreadIds: new Set(),
  revealedAdminThreadIds: new Set(),
  isAuthResolved: false,
  shouldAutoOpenThreadComposer: false,
};

const refs = {
  metaThreads: document.getElementById("forum-meta-threads"),
  metaMembers: document.getElementById("forum-meta-members"),
  newThreadBtn: document.getElementById("new-thread-btn"),
  createHelp: document.getElementById("forum-create-help"),

  stickyLoading: document.getElementById("sticky-loading"),
  stickyPanel: document.getElementById("forum-sticky-panel"),
  stickyList: document.getElementById("sticky-list"),
  stickyEmpty: document.getElementById("sticky-empty"),
  stickyCategoryChips: document.getElementById("forum-sticky-category-chips"),

  recentEpisodesList: document.getElementById("forum-recent-episodes-list"),

  episodeSection: document.getElementById("forum-episode-section"),
  episodeTitle: document.getElementById("forum-episode-title"),
  episodeSubtitle: document.getElementById("forum-episode-subtitle"),
  episodeNewThread: document.getElementById("forum-episode-new-thread"),
  episodeClear: document.getElementById("forum-episode-clear"),
  episodeThreadsLoading: document.getElementById("episode-threads-loading"),
  episodeThreadsEmpty: document.getElementById("episode-threads-empty"),
  episodeThreadsList: document.getElementById("episode-threads-list"),
  episodeThreadsFeedback: document.getElementById("episode-threads-feedback"),

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
  threadEpisodeContext: document.getElementById("thread-episode-context"),
  threadEpisodeContextLabel: document.getElementById(
    "thread-episode-context-label",
  ),
  threadStickyWrap: document.getElementById("thread-sticky-wrap"),
  threadIsSticky: document.getElementById("thread-is-sticky"),
  threadStickyHint: document.getElementById("thread-sticky-hint"),
  threadBody: document.getElementById("thread-body"),
  threadSubmit: document.getElementById("thread-submit"),
  threadFeedback: document.getElementById("thread-form-feedback"),

  adminTools: document.getElementById("forum-admin-tools"),
  adminModerationPanel: document.getElementById("forum-admin-moderation-panel"),
  adminCategoryForm: document.getElementById("admin-category-form"),
  adminCategoryName: document.getElementById("admin-category-name"),
  adminCategorySlug: document.getElementById("admin-category-slug"),
  adminCategoryType: document.getElementById("admin-category-type"),
  adminCategoryDescription: document.getElementById(
    "admin-category-description",
  ),
  adminCategorySubmit: document.getElementById("admin-category-submit"),
  adminThreadFilterChips: document.getElementById("admin-thread-filter-chips"),
  adminThreadsLoading: document.getElementById("admin-threads-loading"),
  adminThreadsEmpty: document.getElementById("admin-threads-empty"),
  adminThreadsList: document.getElementById("admin-threads-list"),
  adminThreadsFeedback: document.getElementById("admin-threads-feedback"),
};
let feedObserver = null;

const toTrimmedString = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
const VALID_FORUM_ROLES = new Set(["member", "moderator", "admin"]);

const normalizeEpisodeId = (value) => {
  const normalized = toTrimmedString(value);
  if (!normalized || normalized.length > 128) return "";
  return normalized;
};

const readInitialEpisodeFilter = () => {
  const params = new URLSearchParams(window.location.search);
  return {
    episodeId: normalizeEpisodeId(params.get("episode")),
    episodeTitle: toTrimmedString(params.get("episodeTitle"))
      .replace(/\s*\|\s*Educheia cu Elena Vorotneac\s*$/i, "")
      .slice(0, 180),
    shouldAutoOpen: params.get("new") === "1",
  };
};

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

const sanitizeImageUrl = (url, fallback = "../images/logo-light.webp") => {
  if (typeof url !== "string" || !url.trim()) return fallback;

  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    return fallback;
  }

  return fallback;
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

const extractInitials = (value) => {
  const normalized = toTrimmedString(value);
  if (!normalized) return "ME";

  const words = normalized.split(" ").filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }

  return normalized.slice(0, 2).toUpperCase();
};

const pluralizeReplies = (count) => (count === 1 ? "răspuns" : "răspunsuri");
const pluralizeThreads = (count) => (count === 1 ? "subiect" : "subiecte");

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

const formatAbsoluteDateTime = (rawDate) => {
  const date = toDateOrNull(rawDate);
  if (!date) return "dată necunoscută";

  return new Intl.DateTimeFormat("ro-RO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const getActivePostingRestriction = (roleData, scope) => {
  if (!roleData || typeof roleData !== "object") return null;

  const reason = toTrimmedString(roleData.reason);
  if (roleData.isBanned === true) {
    return {
      kind: "banned",
      reason,
      until: null,
    };
  }

  const restrictionField =
    scope === "threads" ? "threadRestrictedUntil" : "commentRestrictedUntil";
  const cooldownField =
    scope === "threads" ? "threadCooldownUntil" : "commentCooldownUntil";

  const restrictedUntil = toDateOrNull(roleData[restrictionField]);
  if (restrictedUntil && restrictedUntil.getTime() > Date.now()) {
    return {
      kind: "restricted",
      reason,
      until: restrictedUntil,
    };
  }

  const cooldownUntil = toDateOrNull(roleData[cooldownField]);
  if (cooldownUntil && cooldownUntil.getTime() > Date.now()) {
    return {
      kind: "cooldown",
      reason,
      until: cooldownUntil,
    };
  }

  return null;
};

const describePostingRestriction = (restriction, scopeLabel = "conținut") => {
  if (!restriction) return "";

  if (restriction.kind === "banned") {
    return restriction.reason ?
        `Nu poți publica ${scopeLabel}. Motiv: ${restriction.reason}.`
      : `Nu poți publica ${scopeLabel} momentan.`;
  }

  const untilText =
    restriction.until ? formatAbsoluteDateTime(restriction.until) : "";
  const prefix =
    restriction.kind === "cooldown" ?
      `Ai un cooldown activ pentru ${scopeLabel}`
    : `Ai o restricție activă pentru ${scopeLabel}`;
  const reasonText = restriction.reason ? ` Motiv: ${restriction.reason}.` : "";
  return untilText ?
      `${prefix} până la ${untilText}.${reasonText}`
    : `${prefix}.${reasonText}`;
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

const normalizeThreadContributors = (rawContributors) => {
  if (!Array.isArray(rawContributors)) return [];

  return rawContributors
    .map((item) => ({
      uid: toTrimmedString(item?.uid),
      name: toTrimmedString(item?.name) || "Membru",
      count: safeInt(item?.count, 0),
      isAdmin: Boolean(item?.isAdmin),
    }))
    .filter((item) => item.uid && item.count > 0)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name, "ro");
    })
    .slice(0, 2);
};

const mapThreadDoc = (docSnap) => {
  const data = docSnap.data() || {};
  const topContributors = normalizeThreadContributors(data.topContributors);
  const uniqueResponderCount = Math.max(
    safeInt(data.uniqueResponderCount, 0),
    topContributors.length,
  );

  return {
    id: docSnap.id,
    title: toTrimmedString(data.title) || "Subiect fără titlu",
    body: toTrimmedString(data.body),
    categoryId: toTrimmedString(data.categoryId),
    categoryType: data.categoryType === "admin" ? "admin" : "normal",
    episodeId: normalizeEpisodeId(data.episodeId),
    authorUid: toTrimmedString(data.authorUid),
    authorName: toTrimmedString(data.authorName) || "Membru",
    authorIsAdmin: Boolean(data.authorIsAdmin),
    isSticky: Boolean(data.isSticky),
    isLocked: Boolean(data.isLocked),
    moderationStatus: toTrimmedString(data.moderationStatus) || "visible",
    commentCount: safeInt(data.commentCount, 0),
    topContributors,
    uniqueResponderCount,
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
  return [
    thread.title,
    thread.body,
    thread.authorName,
    categoryLabel,
    thread.episodeId,
  ]
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

const normalizeEpisodeItems = (rawItems = []) =>
  rawItems
    .map((item) => {
      const snippet = item?.snippet || item || {};
      return {
        videoId: toTrimmedString(
          snippet?.resourceId?.videoId || item?.videoId || snippet?.videoId,
        ),
        title: toTrimmedString(snippet.title || item?.title),
        description: toTrimmedString(snippet.description || item?.description),
        publishedAt: snippet.publishedAt || item?.publishedAt || "",
        thumbnails: snippet.thumbnails || item?.thumbnails || null,
        dateObj: toDateOrNull(snippet.publishedAt || item?.publishedAt),
      };
    })
    .filter((episode) => episode.videoId && episode.title);

const readEpisodesFromLocalCache = () => {
  const sources = [];

  try {
    sources.push(
      JSON.parse(localStorage.getItem(EPISODES_CACHE_KEY) || "{}")?.items,
    );
  } catch {
    sources.push([]);
  }

  try {
    sources.push(JSON.parse(sessionStorage.getItem("episodes") || "[]"));
  } catch {
    sources.push([]);
  }

  for (const source of sources) {
    const normalized = normalizeEpisodeItems(
      Array.isArray(source) ? source : [],
    );
    if (normalized.length) return normalized;
  }

  return [];
};

const loadEpisodesForForum = async () => {
  if (state.recentEpisodes.length) return state.recentEpisodes;

  try {
    if (typeof getEpisodes === "function") {
      const data = await getEpisodes();
      const normalized = normalizeEpisodeItems(
        Array.isArray(data?.items) ? data.items : [],
      );
      if (normalized.length) {
        state.recentEpisodes = normalized;
        return normalized;
      }
    }
  } catch {
    // Cached episodes below still give the panel useful content offline.
  }

  const cached = readEpisodesFromLocalCache();
  state.recentEpisodes = cached;
  return cached;
};

const getEpisodeDisplayTitle = (episode) =>
  toTrimmedString(episode?.title)
    .replace(/\s*\|\s*Educheia cu Elena Vorotneac\s*$/i, "")
    .trim() || "Episod Educheia";

const getEpisodeThumbnailUrl = (episode) => {
  const thumbnails = episode?.thumbnails || {};
  const imageUrl =
    thumbnails.medium?.url ||
    thumbnails.high?.url ||
    thumbnails.maxres?.url ||
    thumbnails.default?.url ||
    (episode?.videoId ?
      `https://img.youtube.com/vi/${encodeURIComponent(episode.videoId)}/mqdefault.jpg`
    : "");
  return sanitizeImageUrl(imageUrl);
};

const getEpisodeDisplayNumber = (episode, allEpisodes) => {
  if (!episode?.videoId) return null;

  const ordered = [...allEpisodes].sort((a, b) => {
    const dateDelta =
      getThreadTimestamp(a.dateObj || a.publishedAt) -
      getThreadTimestamp(b.dateObj || b.publishedAt);
    if (dateDelta !== 0) return dateDelta;
    return String(a.videoId || "").localeCompare(String(b.videoId || ""));
  });

  const index = ordered.findIndex((item) => item.videoId === episode.videoId);
  return index >= 0 ? index + 1 : null;
};

const buildEpisodeForumUrl = (episode, { newThread = false } = {}) => {
  const url = new URL("/forum", window.location.origin);
  const episodeId = normalizeEpisodeId(episode?.videoId);
  if (episodeId) {
    url.searchParams.set("episode", episodeId);
  }

  const title = getEpisodeDisplayTitle(episode);
  if (title) {
    url.searchParams.set("episodeTitle", title.slice(0, 180));
  }

  if (newThread) {
    url.searchParams.set("new", "1");
  }

  return `${url.pathname}${url.search}`;
};

const hydrateActiveEpisodeTitleFromCatalog = () => {
  if (!state.activeEpisodeId || state.activeEpisodeTitle) return;
  const match = state.recentEpisodes.find(
    (episode) => episode.videoId === state.activeEpisodeId,
  );
  if (!match) return;
  state.activeEpisodeTitle = getEpisodeDisplayTitle(match).slice(0, 180);
  syncEpisodeFilterToUrl();
};

const countVisibleEpisodeThreads = async (episodeId) => {
  const normalizedEpisodeId = normalizeEpisodeId(episodeId);
  if (!normalizedEpisodeId) return 0;

  const threadsRef = collection(db, THREADS_COLLECTION);
  const constraints = [
    where("episodeId", "==", normalizedEpisodeId),
    where("moderationStatus", "==", "visible"),
  ];

  try {
    const countSnapshot = await getCountFromServer(
      query(threadsRef, ...constraints),
    );
    return safeInt(countSnapshot.data()?.count, 0);
  } catch {
    const fallbackSnapshot = await getDocs(
      query(threadsRef, ...constraints, limit(50)),
    );
    return fallbackSnapshot.docs.length;
  }
};

const renderRecentEpisodesPanel = ({ isLoading = false } = {}) => {
  if (!refs.recentEpisodesList) return;

  clearNode(refs.recentEpisodesList);

  if (isLoading) {
    for (let index = 0; index < RECENT_EPISODES_LIMIT; index += 1) {
      const skeleton = document.createElement("div");
      skeleton.className = "forum-recent-episode-skeleton";
      skeleton.setAttribute("aria-hidden", "true");
      refs.recentEpisodesList.appendChild(skeleton);
    }
    return;
  }

  const sortedEpisodes = [...state.recentEpisodes].sort(
    (a, b) =>
      getThreadTimestamp(b.dateObj || b.publishedAt) -
      getThreadTimestamp(a.dateObj || a.publishedAt),
  );
  const latest = sortedEpisodes.slice(0, RECENT_EPISODES_LIMIT);

  if (!latest.length) {
    const empty = document.createElement("p");
    empty.className = "forum-recent-episodes-empty";
    empty.textContent = "Episoadele recente nu sunt disponibile momentan.";
    refs.recentEpisodesList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  latest.forEach((episode) => {
    const episodeNumber = getEpisodeDisplayNumber(
      episode,
      state.recentEpisodes,
    );
    const threadCount = safeInt(
      state.recentEpisodeThreadCounts.get(episode.videoId),
      0,
    );

    const link = document.createElement("a");
    link.className = "forum-recent-episode";
    link.href = buildEpisodeForumUrl(episode);
    link.setAttribute("role", "listitem");

    const image = document.createElement("img");
    image.className = "forum-recent-episode-thumb";
    image.src = getEpisodeThumbnailUrl(episode);
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.width = 46;
    image.height = 46;
    image.referrerPolicy = "no-referrer";

    const copy = document.createElement("span");
    copy.className = "forum-recent-episode-copy";

    const top = document.createElement("span");
    top.className = "forum-recent-episode-top";

    const number = document.createElement("span");
    number.className = "forum-recent-episode-number";
    number.textContent =
      episodeNumber ? `EP ${String(episodeNumber).padStart(2, "0")}` : "EP";

    const title = document.createElement("span");
    title.className = "forum-recent-episode-title";
    title.textContent = getEpisodeDisplayTitle(episode);

    top.append(number, title);

    const count = document.createElement("span");
    count.className = "forum-recent-episode-count";
    count.textContent = `${threadCount} ${pluralizeThreads(threadCount)}`;

    copy.append(top, count);

    const arrow = document.createElement("span");
    arrow.className = "forum-recent-episode-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6"></path></svg>';

    link.append(image, copy, arrow);
    fragment.appendChild(link);
  });

  refs.recentEpisodesList.appendChild(fragment);
};

const loadRecentEpisodesPanel = async () => {
  state.recentEpisodesLoadFailed = false;
  renderRecentEpisodesPanel({ isLoading: true });

  try {
    const episodes = await loadEpisodesForForum();
    hydrateActiveEpisodeTitleFromCatalog();

    const latest = [...episodes]
      .sort(
        (a, b) =>
          getThreadTimestamp(b.dateObj || b.publishedAt) -
          getThreadTimestamp(a.dateObj || a.publishedAt),
      )
      .slice(0, RECENT_EPISODES_LIMIT);

    const counts = await Promise.all(
      latest.map(async (episode) => [
        episode.videoId,
        await countVisibleEpisodeThreads(episode.videoId),
      ]),
    );

    state.recentEpisodeThreadCounts = new Map(counts);
  } catch {
    state.recentEpisodesLoadFailed = true;
  } finally {
    renderRecentEpisodesPanel();
    updateThreadEpisodeContext();
    renderEpisodeSection();
  }
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

const ICON_SVG_MARKUP = {
  externalLink:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-external-link-icon lucide-external-link"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  eye: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye-icon lucide-eye"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye-off-icon lucide-eye-off"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>',
  edit: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil-icon lucide-pencil"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>',
  ban: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-ban-icon lucide-ban"><circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/></svg>',
  trash:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash2-icon lucide-trash-2"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

const THREAD_PILL_ICON_MARKUP = {
  episode:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clapperboard-icon lucide-clapperboard"><path d="m12.296 3.464 3.02 3.956"/><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m6.18 5.276 3.1 3.899"/></svg>',
  sticky:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pin-icon lucide-pin"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
  admin:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-users-icon lucide-users"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/></svg>',
  locked:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lock-icon lucide-lock"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
};

const createActionIcon = (iconName) => {
  const template = document.createElement("template");
  template.innerHTML = (
    ICON_SVG_MARKUP[iconName] || ICON_SVG_MARKUP.externalLink
  ).trim();
  const node = template.content.firstElementChild;
  if (!(node instanceof SVGElement)) return null;
  node.classList.add("forum-icon-action-svg");
  node.setAttribute("aria-hidden", "true");
  return node;
};

const createThreadPillIcon = (iconName) => {
  const template = document.createElement("template");
  template.innerHTML = (
    THREAD_PILL_ICON_MARKUP[iconName] || THREAD_PILL_ICON_MARKUP.episode
  ).trim();
  const node = template.content.firstElementChild;
  if (!(node instanceof SVGElement)) return null;
  node.classList.add("forum-thread-pill-icon");
  node.setAttribute("aria-hidden", "true");
  return node;
};

const createThreadStatusPill = (className, iconName, label) => {
  const pill = document.createElement("span");
  pill.className = className;

  const icon = createThreadPillIcon(iconName);
  if (icon) {
    pill.appendChild(icon);
  }

  const text = document.createElement("span");
  text.className = "forum-thread-pill-label";
  text.textContent = label;
  pill.appendChild(text);

  return pill;
};

const buildIconAction = ({
  label,
  icon,
  action = "",
  danger = false,
  tag = "button",
  href = "",
} = {}) => {
  const node =
    tag === "a" ?
      document.createElement("a")
    : document.createElement("button");

  node.className = `forum-icon-action${danger ? " forum-icon-action-danger" : ""}`;
  node.setAttribute("aria-label", label || "Acțiune");
  node.setAttribute("title", label || "Acțiune");

  if (node instanceof HTMLAnchorElement) {
    node.href = href || "#";
  } else {
    node.type = "button";
  }

  if (action) node.dataset.adminThreadAction = action;

  const iconNode = createActionIcon(icon);
  if (iconNode) {
    node.appendChild(iconNode);
  }

  const labelWrap = document.createElement("span");
  labelWrap.className = "forum-icon-action-label";
  labelWrap.textContent = label || "";

  node.appendChild(labelWrap);
  return node;
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
  sortThreadsClientSide(
    applyFeedFilters(toPublicFeedThreads(state.feedThreads)),
  );

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
    refs.feedScrollStatus.textContent =
      isSearchActive ?
        "Continuă să derulezi pentru mai multe rezultate."
      : "Derulează pentru a încărca mai multe subiecte.";
    refs.feedSentinel.hidden = false;
    return;
  }

  refs.feedSentinel.hidden = true;
  refs.feedScrollStatus.textContent =
    hasLoadedSome ? "Ai ajuns la finalul subiectelor." : "";
};

const clearBackToTopHideTimeout = () => {
  if (!state.backToTopHideTimeoutId) return;
  window.clearTimeout(state.backToTopHideTimeoutId);
  state.backToTopHideTimeoutId = 0;
};

const updateBackToTopVisibility = () => {
  if (!refs.backToTopBtn) return;

  const shouldShow = window.scrollY > 720;
  clearBackToTopHideTimeout();

  if (shouldShow) {
    refs.backToTopBtn.hidden = false;
    window.requestAnimationFrame(() => {
      refs.backToTopBtn?.classList.add("is-visible");
    });
    return;
  }

  refs.backToTopBtn.classList.remove("is-visible");

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    refs.backToTopBtn.hidden = true;
    return;
  }

  state.backToTopHideTimeoutId = window.setTimeout(() => {
    if (window.scrollY > 720) return;
    refs.backToTopBtn.hidden = true;
    state.backToTopHideTimeoutId = 0;
  }, BACK_TO_TOP_FADE_MS);
};

const getCategoryTone = (thread) => {
  const tones = ["teal", "blue", "violet", "amber", "green"];
  const source = toTrimmedString(
    thread?.categoryId || getThreadCategoryLabel(thread),
  );
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash + source.charCodeAt(index) * (index + 1)) % tones.length;
  }
  return tones[hash] || tones[0];
};

const createUserAvatar = (name, className = "forum-thread-avatar") => {
  const avatar = document.createElement("span");
  avatar.className = className;
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = extractInitials(name);
  return avatar;
};

const formatCappedCount = (count) => {
  const safeCount = safeInt(count, 0);
  return safeCount > 9 ? "9+" : String(safeCount);
};

const renderThreadList = (listRef, threads, { revealedIds = null } = {}) => {
  clearNode(listRef);

  if (!threads.length) return;

  const fragment = document.createDocumentFragment();

  threads.forEach((thread, index) => {
    const threadKey = toTrimmedString(thread?.id);
    const shouldReveal =
      revealedIds instanceof Set ?
        Boolean(threadKey) && !revealedIds.has(threadKey)
      : true;
    if (revealedIds instanceof Set && threadKey) {
      revealedIds.add(threadKey);
    }

    const link = document.createElement("a");
    link.className =
      shouldReveal ?
        "forum-thread-link forum-reveal-item"
      : "forum-thread-link";
    if (shouldReveal) {
      link.style.setProperty("--forum-reveal-index", String(index));
    }
    link.href = buildThreadUrl(thread);
    link.setAttribute("role", "listitem");

    const categoryPill = document.createElement("span");
    categoryPill.className = `forum-thread-category-badge forum-thread-category-${getCategoryTone(thread)}`;
    categoryPill.textContent = getThreadCategoryLabel(thread);

    const head = document.createElement("div");
    head.className = "forum-thread-head";

    const title = document.createElement("h3");
    title.className = "forum-thread-title";
    title.textContent = thread.title;

    const statusCluster = document.createElement("div");
    statusCluster.className = "forum-thread-status-group";

    head.append(categoryPill, title, statusCluster);

    const footer = document.createElement("div");
    footer.className = "forum-thread-footer";

    const opAvatar = createUserAvatar(
      thread.authorName,
      thread.authorIsAdmin ?
        "forum-thread-avatar forum-thread-avatar-op forum-thread-avatar-admin"
      : "forum-thread-avatar forum-thread-avatar-op",
    );

    const byline = document.createElement("span");
    byline.className = "forum-thread-byline";
    byline.textContent = `${thread.authorName} · ${formatRelativeTime(
      thread.lastActivityAt || thread.createdAt,
    )}`;

    footer.append(opAvatar, byline);

    if (thread.episodeId) {
      statusCluster.appendChild(
        createThreadStatusPill(
          "forum-thread-category-badge forum-pill-episode",
          "episode",
          "Episod",
        ),
      );
    }

    if (thread.isSticky) {
      statusCluster.appendChild(
        createThreadStatusPill(
          "forum-thread-category-badge forum-pill-sticky",
          "sticky",
          "Fixat",
        ),
      );
    }

    if (thread.authorIsAdmin) {
      statusCluster.appendChild(
        createThreadStatusPill(
          "forum-thread-category-badge forum-pill-admin",
          "admin",
          "Echipă",
        ),
      );
    }

    if (thread.isLocked) {
      statusCluster.appendChild(
        createThreadStatusPill(
          "forum-thread-category-badge forum-pill-locked",
          "locked",
          "Blocată",
        ),
      );
    }

    const middle = document.createElement("div");
    middle.className = "forum-thread-middle";

    const body = document.createElement("p");
    body.className = "forum-thread-body";
    body.textContent =
      thread.body || "Deschide subiectul pentru a vedea detaliile complete.";

    const stats = document.createElement("div");
    stats.className = "forum-thread-stats";

    const contributors = document.createElement("div");
    contributors.className = "forum-thread-contributors";

    thread.topContributors.forEach((contributor) => {
      const avatar = createUserAvatar(
        contributor.name,
        contributor.isAdmin ?
          "forum-thread-avatar forum-thread-avatar-admin"
        : "forum-thread-avatar",
      );
      avatar.title = `${contributor.name} · ${contributor.count} ${pluralizeReplies(contributor.count)}`;
      contributors.appendChild(avatar);
    });

    const extraContributors = Math.max(
      0,
      safeInt(thread.uniqueResponderCount, 0) - thread.topContributors.length,
    );
    if (extraContributors > 0) {
      const extra = document.createElement("span");
      extra.className = "forum-thread-avatar forum-thread-avatar-extra";
      extra.setAttribute("aria-hidden", "true");
      extra.textContent = `+${formatCappedCount(extraContributors)}`;
      contributors.appendChild(extra);
    }

    if (!contributors.childElementCount) {
      contributors.hidden = true;
    }

    const replies = document.createElement("div");
    replies.className = "forum-thread-replies-count";

    const count = document.createElement("p");
    count.className = "forum-thread-count";
    count.textContent = String(thread.commentCount);

    const countLabel = document.createElement("span");
    countLabel.className = "forum-thread-count-label";
    countLabel.textContent = pluralizeReplies(thread.commentCount);

    replies.append(count, countLabel);
    stats.append(contributors, replies);
    middle.append(body, stats);

    link.append(head, middle, footer);

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

  renderThreadList(refs.stickyList, visibleSticky, {
    revealedIds: state.revealedStickyThreadIds,
  });
};

const setEpisodeThreadsFeedback = (text = "", type = "") => {
  if (!refs.episodeThreadsFeedback) return;

  refs.episodeThreadsFeedback.textContent = text;
  refs.episodeThreadsFeedback.classList.remove("is-error", "is-success");

  if (type === "error") refs.episodeThreadsFeedback.classList.add("is-error");
  if (type === "success")
    refs.episodeThreadsFeedback.classList.add("is-success");
};

const getEpisodeFilterLabel = () =>
  state.activeEpisodeTitle || `Episod ${state.activeEpisodeId}`;

const renderEpisodeSection = () => {
  if (
    !refs.episodeSection ||
    !refs.episodeThreadsLoading ||
    !refs.episodeThreadsEmpty ||
    !refs.episodeThreadsList
  ) {
    return;
  }

  const hasEpisodeFilter = Boolean(state.activeEpisodeId);
  refs.episodeSection.hidden = !hasEpisodeFilter;

  if (!hasEpisodeFilter) {
    clearNode(refs.episodeThreadsList);
    refs.episodeThreadsLoading.hidden = true;
    refs.episodeThreadsEmpty.hidden = true;
    setEpisodeThreadsFeedback("");
    return;
  }

  const episodeLabel = getEpisodeFilterLabel();
  if (refs.episodeTitle) {
    refs.episodeTitle.textContent = "Discuții pentru episod";
  }
  if (refs.episodeSubtitle) {
    refs.episodeSubtitle.textContent = `${episodeLabel} · thread-uri conectate direct cu episodul selectat.`;
  }

  refs.episodeThreadsLoading.hidden = !state.isLoadingEpisodeThreads;

  const isEmpty =
    !state.isLoadingEpisodeThreads &&
    !state.episodeThreadsLoadFailed &&
    state.episodeThreads.length === 0;
  refs.episodeThreadsEmpty.hidden = !isEmpty;

  renderThreadList(refs.episodeThreadsList, state.episodeThreads, {
    revealedIds: state.revealedEpisodeThreadIds,
  });
};

const renderFeedSection = () => {
  const visibleFeed = getFilteredFeedThreads();
  const hasError = !refs.feedError.hidden;

  const isEmpty = !state.isLoadingFeed && !hasError && !visibleFeed.length;
  refs.feedEmpty.hidden = !isEmpty;

  renderThreadList(refs.feedList, visibleFeed, {
    revealedIds: state.revealedFeedThreadIds,
  });

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

  constraints.push(limit(FEED_QUERY_LIMIT));

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

    if (!docs.length) {
      const fallbackSnapshot = await getDocs(categoriesRef);
      docs = fallbackSnapshot.docs;
    }
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

const loadEpisodeThreads = async () => {
  if (!state.activeEpisodeId) {
    state.episodeThreads = [];
    state.episodeThreadsLoadFailed = false;
    state.isLoadingEpisodeThreads = false;
    renderEpisodeSection();
    return;
  }

  const requestId = ++state.episodeThreadsRequestId;
  state.isLoadingEpisodeThreads = true;
  state.episodeThreadsLoadFailed = false;
  state.revealedEpisodeThreadIds.clear();
  setEpisodeThreadsFeedback("");
  renderEpisodeSection();

  const threadsRef = collection(db, THREADS_COLLECTION);

  try {
    const episodeQuery = query(
      threadsRef,
      where("episodeId", "==", state.activeEpisodeId),
      where("moderationStatus", "==", "visible"),
      orderBy("lastActivityAt", "desc"),
      limit(12),
    );

    const snapshot = await getDocs(episodeQuery);
    if (requestId !== state.episodeThreadsRequestId) return;
    state.episodeThreads = snapshot.docs.map(mapThreadDoc);
  } catch (error) {
    try {
      const fallbackSnapshot = await getDocs(
        query(
          threadsRef,
          where("episodeId", "==", state.activeEpisodeId),
          where("moderationStatus", "==", "visible"),
          limit(30),
        ),
      );

      if (requestId !== state.episodeThreadsRequestId) return;
      state.episodeThreads = fallbackSnapshot.docs
        .map(mapThreadDoc)
        .sort(
          (a, b) =>
            getThreadTimestamp(b.lastActivityAt || b.createdAt) -
            getThreadTimestamp(a.lastActivityAt || a.createdAt),
        )
        .slice(0, 12);
    } catch {
      if (requestId !== state.episodeThreadsRequestId) return;
      state.episodeThreads = [];
      state.episodeThreadsLoadFailed = true;
      setEpisodeThreadsFeedback(
        describeError(error, "Nu am putut încărca thread-urile episodului."),
        "error",
      );
    }
  } finally {
    if (requestId === state.episodeThreadsRequestId) {
      state.isLoadingEpisodeThreads = false;
      renderEpisodeSection();
      updateAuxPanels();
    }
  }
};

const loadFeedPage = async ({ reset = false } = {}) => {
  if (state.isLoadingFeed) return;
  if (!reset && !state.hasMoreFeed) return;

  if (reset) {
    state.feedThreads = [];
    state.feedCursor = null;
    state.feedLastBatchSize = 0;
    state.hasMoreFeed = true;
    hideFeedError();
    refs.feedEmpty.hidden = true;
    clearNode(refs.feedList);
    state.revealedFeedThreadIds.clear();
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

    // Fetch one extra document so we can tell whether another page exists.
    const pageDocs = snapshot.docs.slice(0, PAGE_SIZE);
    state.feedLastBatchSize = pageDocs.length;
    const fetched = pageDocs.map(mapThreadDoc);

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
    state.feedThreads = sortThreadsClientSide(state.feedThreads);

    state.feedCursor =
      pageDocs.length ? pageDocs[pageDocs.length - 1] : state.feedCursor;
    state.hasMoreFeed = snapshot.docs.length > PAGE_SIZE;
    hideFeedError();
  } catch (error) {
    if (requestId !== state.feedRequestId) return;

    state.hasMoreFeed = false;
    state.feedLastBatchSize = 0;
    const readableError = describeError(error);

    if (state.feedThreads.length > 0) {
      hideFeedError();
      renderFeedStatus(readableError);
    } else {
      showFeedError(readableError);
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

const updateThreadEpisodeContext = () => {
  if (!refs.threadEpisodeContext || !refs.threadEpisodeContextLabel) return;

  const hasEpisode = Boolean(state.activeEpisodeId);
  refs.threadEpisodeContext.hidden = !hasEpisode;
  refs.threadEpisodeContextLabel.textContent =
    hasEpisode ? getEpisodeFilterLabel() : "Episod selectat";
};

const updateCreateUiState = () => {
  if (!refs.newThreadBtn) return;

  const restrictionMessage = describePostingRestriction(
    state.threadPostingRestriction,
    "thread-uri",
  );
  const isRestricted = Boolean(state.threadPostingRestriction);

  refs.newThreadBtn.disabled = isRestricted;
  refs.newThreadBtn.classList.toggle("is-disabled", isRestricted);
  refs.newThreadBtn.setAttribute("aria-disabled", String(isRestricted));

  if (state.authUser) {
    refs.newThreadBtn.textContent =
      isRestricted ? "Publicare restricționată" : "Start o nouă discuție";
    if (refs.createHelp) {
      if (isRestricted) {
        refs.createHelp.textContent = restrictionMessage;
      } else if (state.isAdmin) {
        refs.createHelp.textContent =
          "Ai acces admin: poți fixa thread-uri direct din formular.";
      } else {
        refs.createHelp.textContent =
          "Ai un context util? Publică-l și ajută comunitatea.";
      }
    }
  } else {
    refs.newThreadBtn.textContent = "Intră pentru a publica";
    refs.newThreadBtn.disabled = false;
    refs.newThreadBtn.classList.remove("is-disabled");
    refs.newThreadBtn.setAttribute("aria-disabled", "false");
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

const setAdminThreadsFeedback = (text, type = "") => {
  if (!refs.adminThreadsFeedback) return;

  refs.adminThreadsFeedback.textContent = text;
  refs.adminThreadsFeedback.classList.remove("is-error", "is-success");

  if (type === "error") refs.adminThreadsFeedback.classList.add("is-error");
  if (type === "success") refs.adminThreadsFeedback.classList.add("is-success");
};

const renderAdminThreadFilterChips = () => {
  if (!refs.adminThreadFilterChips) return;

  const chips = refs.adminThreadFilterChips.querySelectorAll(
    "[data-admin-thread-status]",
  );

  chips.forEach((chip) => {
    const status = toTrimmedString(
      chip.getAttribute("data-admin-thread-status"),
    );
    const isActive = status === state.adminModerationStatus;
    chip.classList.toggle("is-active", isActive);
    chip.setAttribute("aria-selected", String(isActive));
  });
};

const renderAdminModerationThreads = () => {
  if (
    !refs.adminThreadsLoading ||
    !refs.adminThreadsEmpty ||
    !refs.adminThreadsList ||
    !refs.adminThreadFilterChips
  ) {
    return;
  }

  if (!state.isAdmin) {
    refs.adminThreadFilterChips.hidden = true;
    refs.adminThreadsLoading.hidden = true;
    refs.adminThreadsEmpty.hidden = true;
    clearNode(refs.adminThreadsList);
    state.revealedAdminThreadIds.clear();
    setAdminThreadsFeedback("");
    return;
  }

  refs.adminThreadFilterChips.hidden = false;
  renderAdminThreadFilterChips();

  refs.adminThreadsLoading.hidden = !state.isLoadingAdminModeration;

  const isEmpty =
    state.hasLoadedAdminModeration &&
    !state.isLoadingAdminModeration &&
    state.adminModerationThreads.length === 0;
  refs.adminThreadsEmpty.hidden = !isEmpty;

  clearNode(refs.adminThreadsList);

  const fragment = document.createDocumentFragment();
  state.adminModerationThreads.forEach((thread, index) => {
    const threadKey = toTrimmedString(thread?.id);
    const shouldReveal =
      Boolean(threadKey) && !state.revealedAdminThreadIds.has(threadKey);
    if (threadKey) {
      state.revealedAdminThreadIds.add(threadKey);
    }

    const article = document.createElement("article");
    article.className =
      shouldReveal ?
        "forum-admin-thread-card forum-reveal-item"
      : "forum-admin-thread-card";
    if (shouldReveal) {
      article.style.setProperty("--forum-reveal-index", String(index));
    }
    article.setAttribute("role", "listitem");

    const head = document.createElement("div");
    head.className = "forum-admin-thread-head";

    const title = document.createElement("h4");
    title.className = "forum-admin-thread-title";
    title.textContent = thread.title;
    head.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "forum-admin-thread-meta";

    const statusPill = document.createElement("span");
    statusPill.className = "forum-pill";
    statusPill.textContent = `status: ${thread.moderationStatus}`;
    meta.appendChild(statusPill);

    const categoryPill = document.createElement("span");
    categoryPill.className = "forum-pill";
    categoryPill.textContent = getThreadCategoryLabel(thread);
    meta.appendChild(categoryPill);

    const author = document.createElement("span");
    author.textContent = `de ${thread.authorName}`;
    meta.appendChild(author);

    const activity = document.createElement("span");
    activity.textContent = `actualizat ${formatRelativeTime(
      thread.lastActivityAt || thread.createdAt,
    )}`;
    meta.appendChild(activity);

    const actions = document.createElement("div");
    actions.className = "forum-admin-thread-actions";

    const openLink = buildIconAction({
      tag: "a",
      label: "Deschide",
      icon: "externalLink",
      href: buildThreadUrl(thread),
    });
    actions.appendChild(openLink);

    if (thread.moderationStatus !== "visible") {
      const showBtn = buildIconAction({
        label: "Fă vizibil",
        icon: "eye",
        action: "visible",
      });
      showBtn.dataset.threadId = thread.id;
      actions.appendChild(showBtn);
    }

    if (thread.moderationStatus !== "hidden") {
      const hideBtn = buildIconAction({
        label: "Ascunde",
        icon: "eyeOff",
        action: "hidden",
      });
      hideBtn.dataset.threadId = thread.id;
      actions.appendChild(hideBtn);
    }

    const deleteBtn = buildIconAction({
      label: "Șterge",
      icon: "trash",
      action: "delete",
      danger: true,
    });
    deleteBtn.dataset.threadId = thread.id;
    actions.appendChild(deleteBtn);

    article.append(head, meta, actions);
    fragment.appendChild(article);
  });

  refs.adminThreadsList.appendChild(fragment);
};

const loadAdminModerationThreads = async () => {
  if (!state.isAdmin) return;

  const status = state.adminModerationStatus;
  const requestId = ++state.adminModerationRequestId;
  state.isLoadingAdminModeration = true;
  renderAdminModerationThreads();
  setAdminThreadsFeedback("");

  const threadsRef = collection(db, THREADS_COLLECTION);

  try {
    const snapshot = await getDocs(
      query(
        threadsRef,
        where("moderationStatus", "==", status),
        orderBy("updatedAt", "desc"),
        limit(30),
      ),
    );

    if (requestId !== state.adminModerationRequestId) return;
    state.adminModerationThreads = snapshot.docs.map(mapThreadDoc);
  } catch (error) {
    if (requestId !== state.adminModerationRequestId) return;

    try {
      const fallbackSnapshot = await getDocs(
        query(threadsRef, where("moderationStatus", "==", status), limit(60)),
      );

      if (requestId !== state.adminModerationRequestId) return;
      state.adminModerationThreads = fallbackSnapshot.docs
        .map(mapThreadDoc)
        .sort((a, b) => {
          const aTime =
            a.updatedAt?.getTime?.() ||
            0 ||
            a.lastActivityAt?.getTime?.() ||
            0 ||
            a.createdAt?.getTime?.() ||
            0;
          const bTime =
            b.updatedAt?.getTime?.() ||
            0 ||
            b.lastActivityAt?.getTime?.() ||
            0 ||
            b.createdAt?.getTime?.() ||
            0;
          return bTime - aTime;
        })
        .slice(0, 30);
    } catch {
      state.adminModerationThreads = [];
      setAdminThreadsFeedback(
        describeError(error, "Nu am putut încărca thread-urile moderate."),
        "error",
      );
    }
  } finally {
    if (requestId === state.adminModerationRequestId) {
      state.isLoadingAdminModeration = false;
      state.hasLoadedAdminModeration = true;
      renderAdminModerationThreads();
    }
  }
};

const updateAdminThreadModerationStatus = async (threadId, status) => {
  if (!state.isAdmin || !threadId) return;
  if (!["visible", "hidden", "pending"].includes(status)) return;

  try {
    await updateDoc(doc(db, THREADS_COLLECTION, threadId), {
      moderationStatus: status,
      updatedAt: serverTimestamp(),
      lastActivityAt: serverTimestamp(),
    });

    setAdminThreadsFeedback("Thread actualizat.", "success");
    await Promise.all([
      loadAdminModerationThreads(),
      loadStickyThreads(),
      loadFeedPage({ reset: true }),
      loadEpisodeThreads(),
    ]);
  } catch (error) {
    setAdminThreadsFeedback(
      describeError(error, "Nu am putut actualiza statusul thread-ului."),
      "error",
    );
  }
};

const deleteAdminModeratedThread = async (threadId) => {
  if (!state.isAdmin || !threadId) return;

  const shouldDelete = window.confirm(
    "Confirmi ștergerea definitivă a acestui thread?",
  );
  if (!shouldDelete) return;

  try {
    await deleteDoc(doc(db, THREADS_COLLECTION, threadId));
    setAdminThreadsFeedback("Thread șters.", "success");
    await Promise.all([
      loadAdminModerationThreads(),
      loadStickyThreads(),
      loadFeedPage({ reset: true }),
      loadEpisodeThreads(),
    ]);
  } catch (error) {
    setAdminThreadsFeedback(
      describeError(error, "Nu am putut șterge thread-ul."),
      "error",
    );
  }
};

const updateAdminToolsVisibility = () => {
  if (refs.adminTools) {
    refs.adminTools.hidden = !state.isAdmin;
  }
  if (refs.adminModerationPanel) {
    refs.adminModerationPanel.hidden = !state.isAdmin;
  }

  if (!state.isAdmin) {
    state.composerCategoryScope = "normal";
    if (refs.threadIsSticky) {
      refs.threadIsSticky.checked = false;
    }
  }

  updateThreadStickyModeState();
  renderAdminModerationThreads();
};

const getFocusableInModal = () => {
  if (!refs.modal) return [];
  return [
    ...refs.modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      el.getAttribute("aria-hidden") !== "true" &&
      !el.closest("[hidden]"),
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
  if (!state.isModalOpen || !refs.modal) return;

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
    const focusTarget =
      state.lastModalFocusedElement instanceof HTMLElement ?
        state.lastModalFocusedElement
      : refs.newThreadBtn;
    state.lastModalFocusedElement = null;
    focusTarget?.focus();
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
  if (
    !refs.modal ||
    !refs.threadTitle ||
    !refs.threadIsSticky ||
    !refs.threadCategory
  ) {
    return;
  }

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

  if (state.threadPostingRestriction) {
    renderFeedStatus(
      describePostingRestriction(state.threadPostingRestriction, "thread-uri"),
    );
    return;
  }

  setFormFeedback("");
  if (state.isAdmin) {
    state.composerCategoryScope = "normal";
    refs.threadIsSticky.checked = false;
    setComposerCategoryScope("normal", { preferredValue: "" });
  } else {
    setComposerCategoryScope("normal", { preferredValue: "" });
  }
  updateThreadEpisodeContext();

  clearModalCloseTimeout();
  state.isModalOpen = true;
  state.lastModalFocusedElement =
    document.activeElement instanceof HTMLElement ?
      document.activeElement
    : null;
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

  if (state.threadPostingRestriction) {
    return {
      ok: false,
      message: describePostingRestriction(
        state.threadPostingRestriction,
        "thread-uri",
      ),
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
    state.composerCategoryScope = "normal";
    setComposerCategoryScope("normal", { preferredValue: "" });
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
      contributorStats: {},
      topContributors: [],
      uniqueResponderCount: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastActivityAt: serverTimestamp(),
    };

    if (toTrimmedString(user.email)) {
      payload.authorEmail = toTrimmedString(user.email);
    }

    if (state.activeEpisodeId) {
      payload.episodeId = state.activeEpisodeId;
    }

    await addDoc(collection(db, THREADS_COLLECTION), payload);

    resetThreadForm();
    closeThreadModal();
    renderFeedStatus("Subiect publicat cu succes. Se actualizează lista...");

    await Promise.all([
      loadStickyThreads(),
      loadFeedPage({ reset: true }),
      loadEpisodeThreads(),
    ]);
  } catch (error) {
    if (error?.code === "permission-denied") {
      if (state.threadPostingRestriction) {
        setFormFeedback(
          describePostingRestriction(
            state.threadPostingRestriction,
            "thread-uri",
          ),
          "error",
        );
        return;
      }

      const freshRoleData = await loadCurrentUserRoleData(state.authUser);
      const freshRestriction = getActivePostingRestriction(
        freshRoleData,
        "threads",
      );
      if (freshRestriction) {
        state.currentUserRoleData = freshRoleData;
        state.threadPostingRestriction = freshRestriction;
        updateCreateUiState();
        setFormFeedback(
          describePostingRestriction(freshRestriction, "thread-uri"),
          "error",
        );
        return;
      }
    }

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

const onAdminModerationPanelToggle = async () => {
  if (!state.isAdmin || !refs.adminModerationPanel) return;
  if (!refs.adminModerationPanel.open) return;
  if (state.isLoadingAdminModeration || state.hasLoadedAdminModeration) return;
  await loadAdminModerationThreads();
};

const onAdminThreadFilterClick = async (event) => {
  const target = event.target.closest("[data-admin-thread-status]");
  if (!target || !state.isAdmin) return;

  const status = toTrimmedString(
    target.getAttribute("data-admin-thread-status"),
  );
  if (!["pending", "hidden"].includes(status)) return;
  if (
    status === state.adminModerationStatus &&
    state.hasLoadedAdminModeration
  ) {
    return;
  }

  state.adminModerationStatus = status;
  state.revealedAdminThreadIds.clear();
  renderAdminThreadFilterChips();
  if (!refs.adminModerationPanel?.open) return;
  await loadAdminModerationThreads();
};

const onAdminThreadsListClick = async (event) => {
  const target = event.target.closest("[data-admin-thread-action]");
  if (!target || !state.isAdmin) return;

  const action = toTrimmedString(
    target.getAttribute("data-admin-thread-action"),
  );
  const threadId = toTrimmedString(target.getAttribute("data-thread-id"));
  if (!threadId) return;

  if (action === "visible") {
    await updateAdminThreadModerationStatus(threadId, "visible");
    return;
  }

  if (action === "hidden") {
    await updateAdminThreadModerationStatus(threadId, "hidden");
    return;
  }

  if (action === "delete") {
    await deleteAdminModeratedThread(threadId);
  }
};

const onThreadCategoryChange = () => {
  if (!state.isAdmin || !refs.threadCategory || !refs.threadIsSticky) return;

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
    const currentCategoryId = refs.threadCategory.value;
    const preferredAdminCategoryId =
      adminCategories.some((category) => category.id === currentCategoryId) ?
        currentCategoryId
      : adminCategories[0].id;
    setComposerCategoryScope("admin", {
      preferredValue: preferredAdminCategoryId,
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

  const currentCategoryId = refs.threadCategory.value;
  const preferredNormalCategoryId =
    normalCategories.some((category) => category.id === currentCategoryId) ?
      currentCategoryId
    : normalCategories[0].id;
  setComposerCategoryScope("normal", {
    preferredValue: preferredNormalCategoryId,
  });
};

const openNativeSelectPicker = (selectElement) => {
  if (!(selectElement instanceof HTMLSelectElement)) return;
  if (selectElement.disabled) return;

  selectElement.focus({ preventScroll: true });

  if (typeof selectElement.showPicker === "function") {
    try {
      selectElement.showPicker();
      return;
    } catch {
      // Browser may block showPicker without a trusted click.
    }
  }

  selectElement.click();
};

const bindSelectShell = (shellElement, selectElement) => {
  if (!(shellElement instanceof HTMLElement)) return;
  if (!(selectElement instanceof HTMLSelectElement)) return;
  if (shellElement.dataset.selectShellBound === "true") return;

  shellElement.dataset.selectShellBound = "true";

  if (!shellElement.hasAttribute("tabindex")) {
    shellElement.tabIndex = 0;
  }

  shellElement.addEventListener("click", (event) => {
    if (event.target instanceof HTMLSelectElement) return;
    event.preventDefault();
    openNativeSelectPicker(selectElement);
  });

  shellElement.addEventListener("keydown", (event) => {
    if (!["Enter", " ", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    openNativeSelectPicker(selectElement);
  });
};

const onSortChange = async () => {
  if (!refs.sortSelect) return;

  const nextSort = refs.sortSelect.value;
  if (!SORT_CONFIG[nextSort]) return;
  if (nextSort === state.activeSort) return;

  state.activeSort = nextSort;
  await loadFeedPage({ reset: true });
};

const syncEpisodeFilterToUrl = () => {
  const url = new URL(window.location.href);
  if (state.activeEpisodeId) {
    url.searchParams.set("episode", state.activeEpisodeId);
    if (state.activeEpisodeTitle) {
      url.searchParams.set("episodeTitle", state.activeEpisodeTitle);
    } else {
      url.searchParams.delete("episodeTitle");
    }
  } else {
    url.searchParams.delete("episode");
    url.searchParams.delete("episodeTitle");
  }
  url.searchParams.delete("new");
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
};

const scrollInitialEpisodeSectionIntoView = () => {
  if (state.hasScrolledToInitialEpisodeSection) return;
  if (!state.activeEpisodeId || !refs.episodeSection) return;
  if (refs.episodeSection.hidden) return;

  state.hasScrolledToInitialEpisodeSection = true;
  window.requestAnimationFrame(() => {
    refs.episodeSection.scrollIntoView({
      behavior:
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ?
          "auto"
        : "smooth",
      block: "start",
    });
  });
};

const clearEpisodeFilter = async () => {
  state.activeEpisodeId = "";
  state.activeEpisodeTitle = "";
  state.episodeThreads = [];
  state.episodeThreadsLoadFailed = false;
  state.revealedEpisodeThreadIds.clear();
  state.episodeThreadsRequestId += 1;
  syncEpisodeFilterToUrl();
  updateThreadEpisodeContext();
  renderEpisodeSection();
};

const maybeAutoOpenThreadModal = () => {
  if (!state.shouldAutoOpenThreadComposer || !state.isAuthResolved) return;
  state.shouldAutoOpenThreadComposer = false;
  openThreadModal();
};

const loadCurrentUserRoleData = async (user) => {
  if (!user) return null;

  try {
    const roleSnapshot = await getDoc(doc(db, USER_ROLES_COLLECTION, user.uid));
    if (!roleSnapshot.exists()) return null;
    return roleSnapshot.data() || null;
  } catch {
    return null;
  }
};

const resolveCurrentUserForumRole = async (
  user,
  claims = {},
  roleData = null,
) => {
  if (!user) return "member";

  if (claims.admin === true || claims.role === "admin") return "admin";
  if (claims.moderator === true || claims.role === "moderator")
    return "moderator";

  if (roleData) {
    return normalizeForumRole(roleData.role);
  }

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
    state.isAuthResolved = false;
    state.authClaims = {};
    state.currentUserRoleData = null;
    state.forumRole = "member";
    state.isAdmin = false;
    state.threadPostingRestriction = null;

    if (user) {
      state.currentUserRoleData = await loadCurrentUserRoleData(user);
      try {
        const tokenResult = await user.getIdTokenResult(true);
        state.authClaims = tokenResult?.claims || {};
        state.forumRole = await resolveCurrentUserForumRole(
          user,
          state.authClaims,
          state.currentUserRoleData,
        );
        state.isAdmin = state.forumRole === "admin";
      } catch {
        state.authClaims = {};
        state.forumRole = await resolveCurrentUserForumRole(
          user,
          {},
          state.currentUserRoleData,
        );
        state.isAdmin = state.forumRole === "admin";
      }
    }

    state.threadPostingRestriction = getActivePostingRestriction(
      state.currentUserRoleData,
      "threads",
    );

    state.composerCategoryScope = "normal";
    setComposerCategoryScope(state.composerCategoryScope, {
      preferredValue: refs.threadCategory.value,
    });
    renderStickyCategoryChips();
    updateCreateUiState();
    updateThreadEpisodeContext();
    updateAdminToolsVisibility();

    if (!state.isAdmin) {
      state.adminModerationThreads = [];
      state.isLoadingAdminModeration = false;
      state.hasLoadedAdminModeration = false;
      state.adminModerationRequestId++;
      renderAdminModerationThreads();
      setAdminThreadsFeedback("");
      state.isAuthResolved = true;
      maybeAutoOpenThreadModal();
      return;
    }

    if (refs.adminModerationPanel?.open && !state.hasLoadedAdminModeration) {
      await loadAdminModerationThreads();
    }

    state.isAuthResolved = true;
    maybeAutoOpenThreadModal();
  });
};

const bindEvents = () => {
  if (
    !refs.newThreadBtn ||
    !refs.feedRetryBtn ||
    !refs.sortSelect ||
    !refs.categoryChips ||
    !refs.threadCategory ||
    !refs.modal ||
    !refs.modalClose ||
    !refs.threadForm
  ) {
    return false;
  }

  refs.newThreadBtn.addEventListener("click", openThreadModal);

  refs.feedRetryBtn.addEventListener("click", async () => {
    hideFeedError();
    await loadFeedPage({ reset: true });
  });

  refs.sortSelect.addEventListener("change", onSortChange);
  bindSelectShell(
    refs.sortSelect?.closest(".forum-select-shell"),
    refs.sortSelect,
  );
  refs.searchInput?.addEventListener("input", onSearchInput);
  refs.categoryChips.addEventListener("click", onCategoryChipClick);
  refs.stickyCategoryChips?.addEventListener(
    "click",
    onStickyCategoryChipClick,
  );
  refs.episodeNewThread?.addEventListener("click", openThreadModal);
  refs.episodeClear?.addEventListener("click", async () => {
    await clearEpisodeFilter();
  });
  refs.adminThreadFilterChips?.addEventListener("click", async (event) => {
    await onAdminThreadFilterClick(event);
  });
  refs.adminModerationPanel?.addEventListener("toggle", async () => {
    await onAdminModerationPanelToggle();
  });
  refs.adminThreadsList?.addEventListener("click", async (event) => {
    await onAdminThreadsListClick(event);
  });
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

  return true;
};

const init = async () => {
  const initialEpisodeFilter = readInitialEpisodeFilter();
  state.activeEpisodeId = initialEpisodeFilter.episodeId;
  state.activeEpisodeTitle = initialEpisodeFilter.episodeTitle;
  state.shouldAutoOpenThreadComposer =
    initialEpisodeFilter.shouldAutoOpen && Boolean(state.activeEpisodeId);

  const eventsBound = bindEvents();
  if (!eventsBound) {
    showFeedError(
      "Interfața forumului nu a putut fi inițializată complet. Reîncarcă pagina.",
    );
    return;
  }

  initAuth();
  initFeedInfiniteScroll();
  updateBackToTopVisibility();
  const recentEpisodesPromise = loadRecentEpisodesPanel();

  window.addEventListener("pagehide", () => {
    clearModalCloseTimeout();
    clearBackToTopHideTimeout();
    window.clearTimeout(state.searchDebounceId);
    state.searchDebounceId = 0;
    feedObserver?.disconnect();
    feedObserver = null;
  });

  if (refs.sortSelect && SORT_CONFIG[refs.sortSelect.value]) {
    state.activeSort = refs.sortSelect.value;
  }

  try {
    await Promise.all([loadCategories(), recentEpisodesPromise]);
  } catch (error) {
    renderFeedStatus(
      describeError(error, "Nu am putut încărca categoriile forumului."),
    );
  }

  hydrateActiveEpisodeTitleFromCatalog();

  renderCategoryChips();
  renderStickyCategoryChips();
  setComposerCategoryScope(state.composerCategoryScope, {
    preferredValue: refs.threadCategory.value,
  });
  updateThreadEpisodeContext();
  updateCreateUiState();
  renderEpisodeSection();
  renderAdminModerationThreads();

  await Promise.all([
    loadStickyThreads(),
    loadFeedPage({ reset: true }),
    loadEpisodeThreads(),
  ]);
  scrollInitialEpisodeSectionIntoView();
  maybeAutoOpenThreadModal();
};

init().catch((error) => {
  showFeedLoading(false);
  showFeedError(
    describeError(error, "Nu am putut inițializa forumul. Încearcă din nou."),
  );
});
