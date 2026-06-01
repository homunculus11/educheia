import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  startAfter,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

const THREADS_COLLECTION = "forumThreads";
const CATEGORIES_COLLECTION = "forumCategories";
const USER_ROLES_COLLECTION = "forumUserRoles";
const THREAD_REPLIES_COLLECTION = "comments";

const CANONICAL_PENDING_ATTR = "data-thread-canonical-pending";
const AUTH_RETURN_KEY = "authReturnTo";
const PUBLIC_ORIGIN = "https://educheia.md";
const REPLIES_PAGE_SIZE = 12;
const AUTH_RESOLVE_TIMEOUT_MS = 1800;

const VALID_FORUM_ROLES = new Set(["member", "moderator", "admin"]);
const VALID_MODERATION_STATUSES = new Set(["visible", "pending", "hidden"]);

const state = {
  routeThreadId: "",
  thread: null,
  categories: [],
  categoriesById: new Map(),
  authUser: null,
  authClaims: {},
  forumRole: "member",
  isAdmin: false,
  isModerator: false,
  replies: [],
  repliesCursor: null,
  hasMoreReplies: true,
  repliesUsingIndexFallback: false,
  isLoadingReplies: false,
  repliesRequestId: 0,
  isSubmittingReply: false,
  isSavingModeration: false,
  editingReplyId: "",
  editingReplyValue: "",
  authSignature: "guest",
};

const refs = {
  stateLoading: document.getElementById("thread-state-loading"),
  stateNotFound: document.getElementById("thread-state-not-found"),
  stateDenied: document.getElementById("thread-state-denied"),
  stateError: document.getElementById("thread-state-error"),
  stateErrorMessage: document.getElementById("thread-state-error-message"),
  retryBtn: document.getElementById("thread-retry-btn"),

  threadContent: document.getElementById("thread-content"),
  threadTitle: document.getElementById("thread-title"),
  threadBody: document.getElementById("thread-body"),
  threadAuthorAvatar: document.getElementById("thread-author-avatar"),
  threadAuthorName: document.getElementById("thread-author-name"),
  threadCreatedAt: document.getElementById("thread-created-at"),
  threadCategory: document.getElementById("thread-category"),
  threadRepliesCount: document.getElementById("thread-replies-count"),
  threadSummaryBadges: document.getElementById("thread-summary-badges"),
  threadLastActivity: document.getElementById("thread-last-activity"),
  replyStartBtn: document.getElementById("reply-start-btn"),

  replyForm: document.getElementById("reply-form"),
  replyAuthNote: document.getElementById("reply-auth-note"),
  replyInput: document.getElementById("reply-input"),
  replySubmit: document.getElementById("reply-submit"),
  replyFeedback: document.getElementById("reply-feedback"),

  repliesStatus: document.getElementById("replies-status"),
  repliesLoading: document.getElementById("replies-loading"),
  repliesEmpty: document.getElementById("replies-empty"),
  repliesList: document.getElementById("replies-list"),
  repliesLoadMore: document.getElementById("replies-load-more"),

  moderationPanel: document.getElementById("thread-moderation-panel"),
  moderationForm: document.getElementById("thread-moderation-form"),
  modTitle: document.getElementById("mod-thread-title"),
  modCategory: document.getElementById("mod-thread-category"),
  modStatus: document.getElementById("mod-thread-status"),
  modLocked: document.getElementById("mod-thread-locked"),
  modSticky: document.getElementById("mod-thread-sticky"),
  modBody: document.getElementById("mod-thread-body"),
  modSubmit: document.getElementById("mod-thread-submit"),
  modStickyHint: document.getElementById("mod-sticky-hint"),
  modFeedback: document.getElementById("mod-feedback"),

  sidebarTotalReplies: document.getElementById("sidebar-total-replies"),
  sidebarParticipants: document.getElementById("sidebar-participants"),

  metaDescription: document.getElementById("thread-meta-description"),
  ogTitle: document.getElementById("thread-og-title"),
  ogDescription: document.getElementById("thread-og-description"),
  ogUrl: document.getElementById("thread-og-url"),
  twitterTitle: document.getElementById("thread-twitter-title"),
  twitterDescription: document.getElementById("thread-twitter-description"),
  canonicalLink: document.getElementById("thread-canonical-link"),
};

const toTrimmedString = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const normalizePath = (value) => String(value || "").replace(/\/+$/, "");

const safeInt = (value, fallback = 0) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
};

const toDateOrNull = (raw) => {
  if (!raw) return null;

  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }

  if (typeof raw?.toDate === "function") {
    const parsed = raw.toDate();
    return Number.isNaN(parsed?.getTime?.()) ? null : parsed;
  }

  if (typeof raw?.seconds === "number") {
    const parsed = new Date(raw.seconds * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
  if (!normalized) return "M";

  const words = normalized.split(" ").filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }

  return normalized.slice(0, 2).toUpperCase();
};

const formatRelativeTime = (rawDate) => {
  const date = toDateOrNull(rawDate);
  if (!date) return "dată necunoscută";

  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.max(0, Math.floor(diffMs / 1000));

  if (diffSeconds < 60) return "acum câteva secunde";

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return diffMinutes === 1 ? "acum 1 minut" : `acum ${diffMinutes} minute`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return diffHours === 1 ? "acum 1 oră" : `acum ${diffHours} ore`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return diffDays === 1 ? "acum 1 zi" : `acum ${diffDays} zile`;
  }

  return new Intl.DateTimeFormat("ro-RO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
};

const formatAbsoluteTime = (rawDate) => {
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

const getDateTime = (rawDate) => toDateOrNull(rawDate)?.getTime?.() || 0;

const sortRepliesByNewest = (replies) =>
  [...replies].sort(
    (a, b) => getDateTime(b.createdAt) - getDateTime(a.createdAt),
  );

const pluralizeReplies = (count) => {
  if (count === 1) return "răspuns";
  return "răspunsuri";
};

const normalizeForumRole = (value) => {
  const role = toTrimmedString(value).toLowerCase();
  return VALID_FORUM_ROLES.has(role) ? role : "member";
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
    return "Lipsește un index Firestore pentru această interogare. Creează indexul sugerat în Firebase Console.";
  }

  if (code === "unavailable") {
    return "Serviciul este indisponibil momentan. Verifică conexiunea și încearcă din nou.";
  }

  if (code === "unauthenticated") {
    return "Trebuie să fii autentificat pentru această acțiune.";
  }

  return fallback;
};

const parseThreadRoute = () => {
  const pathnameSegments = window.location.pathname.split("/").filter(Boolean);

  const hasPathThreadRoute =
    pathnameSegments.length >= 2 &&
    pathnameSegments[0] === "forum" &&
    pathnameSegments[1] === "thread";

  const pathThreadId =
    hasPathThreadRoute && pathnameSegments.length >= 3 ?
      decodeURIComponent(pathnameSegments[2] || "").trim()
    : "";

  const params = new URLSearchParams(window.location.search);
  const queryThreadId = toTrimmedString(params.get("tid"));

  return {
    resolvedThreadId: toTrimmedString(pathThreadId || queryThreadId),
  };
};

const buildCanonicalThreadPath = (threadId, title) => {
  const encodedThreadId = encodeURIComponent(toTrimmedString(threadId));
  const encodedSlug = encodeURIComponent(slugifyThreadTitle(title));
  return `/forum/thread/${encodedThreadId}/${encodedSlug}`;
};

const revealThreadPage = () => {
  document.documentElement.removeAttribute(CANONICAL_PENDING_ATTR);
};

const clearNode = (node) => {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
};

const setReplyFeedback = (text, type = "") => {
  if (!refs.replyFeedback) return;

  refs.replyFeedback.textContent = text;
  refs.replyFeedback.classList.remove("is-error", "is-success");

  if (type === "error") refs.replyFeedback.classList.add("is-error");
  if (type === "success") refs.replyFeedback.classList.add("is-success");
};

const setModerationFeedback = (text, type = "") => {
  if (!refs.modFeedback) return;

  refs.modFeedback.textContent = text;
  refs.modFeedback.classList.remove("is-error", "is-success");

  if (type === "error") refs.modFeedback.classList.add("is-error");
  if (type === "success") refs.modFeedback.classList.add("is-success");
};

const showRepliesLoading = (isVisible) => {
  if (!refs.repliesLoading) return;
  refs.repliesLoading.hidden = !isVisible;
};

const setRepliesStatus = (text = "") => {
  if (!refs.repliesStatus) return;
  refs.repliesStatus.textContent = text;
};

const showViewState = (view) => {
  const showLoading = view === "loading";
  const showNotFound = view === "not-found";
  const showDenied = view === "denied";
  const showError = view === "error";
  const showContent = view === "content";

  if (refs.stateLoading) refs.stateLoading.hidden = !showLoading;
  if (refs.stateNotFound) refs.stateNotFound.hidden = !showNotFound;
  if (refs.stateDenied) refs.stateDenied.hidden = !showDenied;
  if (refs.stateError) refs.stateError.hidden = !showError;
  if (refs.threadContent) refs.threadContent.hidden = !showContent;
};

const getThreadRef = () => {
  if (!state.routeThreadId) return null;
  return doc(db, THREADS_COLLECTION, state.routeThreadId);
};

const getCategoryById = (categoryId) => state.categoriesById.get(categoryId) || null;

const getThreadCategoryLabel = (thread) => {
  const category = getCategoryById(thread?.categoryId);
  if (category) return category.name;

  if (thread?.categoryType === "admin") return "Administrare";
  return "General";
};

const canSeeModeratedReplies = () => {
  if (!state.thread) return false;
  if (state.isModerator) return true;
  return Boolean(state.authUser?.uid) && state.authUser.uid === state.thread.authorUid;
};

const canManageReply = (reply) => {
  if (!reply || !state.authUser) return false;
  if (state.isModerator) return true;
  return reply.authorUid === state.authUser.uid;
};

const updateMetaTags = (thread, canonicalPath) => {
  const title = toTrimmedString(thread?.title) || "Subiect Forum";
  const body = toTrimmedString(thread?.body);
  const description =
    body ? body.slice(0, 160) : "Discuție individuală din comunitatea Educheia.";

  document.title = `Subiect: ${title} | Forum Educheia`;

  if (refs.metaDescription) refs.metaDescription.setAttribute("content", description);
  if (refs.ogTitle) refs.ogTitle.setAttribute("content", title);
  if (refs.ogDescription) refs.ogDescription.setAttribute("content", description);
  if (refs.twitterTitle) refs.twitterTitle.setAttribute("content", title);
  if (refs.twitterDescription) refs.twitterDescription.setAttribute("content", description);

  const canonicalUrl = `${PUBLIC_ORIGIN}${canonicalPath}`;

  if (refs.canonicalLink) refs.canonicalLink.setAttribute("href", canonicalUrl);
  if (refs.ogUrl) refs.ogUrl.setAttribute("content", canonicalUrl);
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
    authorEmail: toTrimmedString(data.authorEmail),
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

const mapReplyDoc = (docSnap) => {
  const data = docSnap.data() || {};

  return {
    id: docSnap.id,
    body: toTrimmedString(data.body),
    authorUid: toTrimmedString(data.authorUid),
    authorName: toTrimmedString(data.authorName) || "Membru",
    authorIsAdmin: Boolean(data.authorIsAdmin),
    moderationStatus: toTrimmedString(data.moderationStatus) || "visible",
    createdAt: toDateOrNull(data.createdAt),
    updatedAt: toDateOrNull(data.updatedAt),
  };
};

const redirectToLogin = () => {
  const returnTarget = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  try {
    sessionStorage.setItem(AUTH_RETURN_KEY, returnTarget);
  } catch {
    // no-op
  }
  window.location.href = "/login";
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

const resolveCurrentUserForumRole = async (user, claims = {}) => {
  if (!user) return "member";

  if (claims.admin === true || claims.role === "admin") return "admin";
  if (claims.moderator === true || claims.role === "moderator") return "moderator";

  try {
    const roleSnapshot = await getDoc(doc(db, USER_ROLES_COLLECTION, user.uid));
    if (roleSnapshot.exists()) {
      return normalizeForumRole(roleSnapshot.data()?.role);
    }
  } catch {
    return "member";
  }

  return "member";
};

const waitForInitialAuth = () =>
  new Promise((resolve) => {
    let resolved = false;

    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        if (resolved) return;
        resolved = true;
        unsubscribe();
        resolve(user || null);
      },
      () => {
        if (resolved) return;
        resolved = true;
        unsubscribe();
        resolve(null);
      },
    );

    window.setTimeout(() => {
      if (resolved) return;
      resolved = true;
      unsubscribe();
      resolve(auth.currentUser || null);
    }, AUTH_RESOLVE_TIMEOUT_MS);
  });

const applyAuthState = async (user) => {
  state.authUser = user || null;
  state.authClaims = {};
  state.forumRole = "member";
  state.isAdmin = false;
  state.isModerator = false;

  if (!state.authUser) {
    state.authSignature = "guest";
    return;
  }

  state.authClaims = await getUserClaims(state.authUser);
  state.forumRole = await resolveCurrentUserForumRole(state.authUser, state.authClaims);
  state.isAdmin = state.forumRole === "admin";
  state.isModerator = state.isAdmin || state.forumRole === "moderator";
  state.authSignature = `${state.authUser.uid}|${state.forumRole}`;
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
    const fallbackSnapshot = await getDocs(categoriesRef);
    docs = fallbackSnapshot.docs;
  }

  const categories = docs
    .map(mapCategoryDoc)
    .filter((category) => !category.isArchived)
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "normal" ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "ro");
    });

  state.categories = categories;
  state.categoriesById = new Map(categories.map((category) => [category.id, category]));
};

const ensureThreadCategoryPresent = () => {
  if (!state.thread) return;
  if (state.categoriesById.has(state.thread.categoryId)) return;

  const fallbackCategory = {
    id: state.thread.categoryId || "general",
    name: state.thread.categoryType === "admin" ? "Administrare" : "General",
    slug: state.thread.categoryId || "general",
    type: state.thread.categoryType,
    description: "",
    isArchived: false,
  };

  state.categories.push(fallbackCategory);
  state.categoriesById.set(fallbackCategory.id, fallbackCategory);
};

const renderThreadBadges = () => {
  if (!refs.threadSummaryBadges || !state.thread) return;

  clearNode(refs.threadSummaryBadges);

  const badges = [];

  if (state.thread.isSticky) badges.push({ text: "sticky", className: "forum-pill forum-pill-sticky" });
  if (state.thread.isLocked) badges.push({ text: "blocată", className: "forum-pill" });
  if (state.thread.authorIsAdmin) badges.push({ text: "echipă", className: "forum-pill forum-pill-admin" });
  if (state.thread.moderationStatus !== "visible") {
    badges.push({
      text: `status: ${state.thread.moderationStatus}`,
      className: "forum-pill",
    });
  }

  badges.forEach((badge) => {
    const node = document.createElement("span");
    node.className = badge.className;
    node.textContent = badge.text;
    refs.threadSummaryBadges.appendChild(node);
  });
};

const updateSidebarStats = () => {
  if (!state.thread) return;

  const participants = new Set();
  if (state.thread.authorUid) participants.add(state.thread.authorUid);

  state.replies.forEach((reply) => {
    if (reply.authorUid) participants.add(reply.authorUid);
  });

  if (refs.sidebarTotalReplies) {
    refs.sidebarTotalReplies.textContent = String(safeInt(state.thread.commentCount, 0));
  }

  if (refs.sidebarParticipants) {
    refs.sidebarParticipants.textContent = String(Math.max(participants.size, 1));
  }
};

const renderThreadSummary = () => {
  if (!state.thread) return;

  refs.threadTitle.textContent = state.thread.title;
  refs.threadBody.textContent =
    state.thread.body || "Nu există conținut text pentru acest subiect.";
  refs.threadAuthorName.textContent = state.thread.authorName;
  refs.threadAuthorAvatar.textContent = extractInitials(state.thread.authorName);
  refs.threadCreatedAt.textContent = formatRelativeTime(state.thread.createdAt);
  refs.threadCategory.textContent = getThreadCategoryLabel(state.thread);
  refs.threadRepliesCount.textContent = String(safeInt(state.thread.commentCount, 0));

  const activityDate = state.thread.lastActivityAt || state.thread.createdAt;
  refs.threadLastActivity.textContent = `Ultima activitate: ${formatRelativeTime(activityDate)} (${formatAbsoluteTime(activityDate)})`;

  renderThreadBadges();
  updateSidebarStats();
};

const renderReplyComposer = () => {
  if (!refs.replyInput || !refs.replySubmit || !refs.replyAuthNote) return;

  const isSignedIn = Boolean(state.authUser);
  const threadLockedForUser = Boolean(state.thread?.isLocked) && !state.isModerator;
  const isDisabled = !isSignedIn || threadLockedForUser || state.isSubmittingReply;

  refs.replyInput.disabled = isDisabled;
  refs.replySubmit.disabled = isDisabled;
  refs.replySubmit.textContent =
    state.isSubmittingReply ? "Se publică..." : "Publică răspunsul";

  if (!isSignedIn) {
    refs.replyInput.placeholder = "Autentifică-te pentru a răspunde.";
    refs.replyAuthNote.innerHTML =
      'Trebuie să fii autentificat pentru a răspunde. <a href="/login" class="forum-inline-link">Login</a>';
    return;
  }

  if (threadLockedForUser) {
    refs.replyInput.placeholder = "Subiect blocat: doar moderatorii mai pot răspunde.";
    refs.replyAuthNote.textContent =
      "Subiectul este blocat momentan. Doar moderatorii și administratorii pot publica.";
    return;
  }

  refs.replyInput.placeholder = "Scrie un răspuns util și respectuos.";
  refs.replyAuthNote.textContent = `Răspunzi ca ${extractDisplayName(state.authUser)}.`;
};

const buildReplyBadge = (className, text) => {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
};

const renderReplies = () => {
  clearNode(refs.repliesList);

  const replies = state.replies;

  if (!replies.length) {
    refs.repliesEmpty.hidden = false;
    refs.repliesLoadMore.hidden = true;
    setRepliesStatus("Niciun răspuns încă.");
    updateSidebarStats();
    return;
  }

  refs.repliesEmpty.hidden = true;

  const fragment = document.createDocumentFragment();

  replies.forEach((reply) => {
    const article = document.createElement("article");
    article.className = "forum-reply-card";
    article.setAttribute("role", "listitem");

    const head = document.createElement("div");
    head.className = "forum-reply-head";

    const authorWrap = document.createElement("div");
    authorWrap.className = "forum-reply-author";

    const avatar = document.createElement("span");
    avatar.className = "forum-reply-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = extractInitials(reply.authorName);

    const meta = document.createElement("div");
    meta.className = "forum-reply-meta";

    const topRow = document.createElement("div");
    topRow.className = "forum-reply-meta-top";

    const authorName = document.createElement("span");
    authorName.className = "forum-reply-name";
    authorName.textContent = reply.authorName;

    const time = document.createElement("time");
    time.className = "forum-reply-time";
    time.textContent = formatRelativeTime(reply.createdAt);

    topRow.append(authorName, time);

    const badges = document.createElement("div");
    badges.className = "forum-reply-badges";

    if (reply.authorIsAdmin) {
      badges.appendChild(buildReplyBadge("forum-pill forum-pill-admin", "echipă"));
    }

    if (reply.moderationStatus !== "visible") {
      badges.appendChild(
        buildReplyBadge("forum-pill", `status: ${reply.moderationStatus}`),
      );
    }

    meta.append(topRow, badges);
    authorWrap.append(avatar, meta);
    head.appendChild(authorWrap);

    const canManage = canManageReply(reply);
    if (canManage) {
      const actions = document.createElement("div");
      actions.className = "forum-reply-actions";

      const isEditing = state.editingReplyId === reply.id;

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "forum-reply-action";
      editBtn.dataset.action = isEditing ? "cancel-edit" : "start-edit";
      editBtn.dataset.replyId = reply.id;
      editBtn.textContent = isEditing ? "Anulează" : "Editează";

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "forum-reply-action forum-reply-action-danger";
      deleteBtn.dataset.action = "delete-reply";
      deleteBtn.dataset.replyId = reply.id;
      deleteBtn.textContent = "Șterge";

      actions.append(editBtn, deleteBtn);
      head.appendChild(actions);
    }

    article.appendChild(head);

    if (state.editingReplyId === reply.id) {
      const editForm = document.createElement("form");
      editForm.className = "forum-reply-edit-form";
      editForm.dataset.replyId = reply.id;

      const textarea = document.createElement("textarea");
      textarea.className = "forum-reply-edit-input";
      textarea.maxLength = 1500;
      textarea.required = true;
      textarea.value = state.editingReplyValue;
      textarea.dataset.replyId = reply.id;

      const row = document.createElement("div");
      row.className = "forum-reply-edit-actions";

      const saveBtn = document.createElement("button");
      saveBtn.type = "submit";
      saveBtn.className = "btn btn-primary";
      saveBtn.textContent = "Salvează";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn btn-ghost";
      cancelBtn.dataset.action = "cancel-edit";
      cancelBtn.dataset.replyId = reply.id;
      cancelBtn.textContent = "Renunță";

      row.append(saveBtn, cancelBtn);
      editForm.append(textarea, row);
      article.appendChild(editForm);
    } else {
      const body = document.createElement("p");
      body.className = "forum-reply-body";
      body.textContent = reply.body;
      article.appendChild(body);
    }

    fragment.appendChild(article);
  });

  refs.repliesList.appendChild(fragment);

  const totalKnown = replies.length;
  const summaryCount = safeInt(state.thread?.commentCount, totalKnown);
  setRepliesStatus(`${summaryCount} ${pluralizeReplies(summaryCount)} în acest subiect.`);

  refs.repliesLoadMore.hidden = !state.hasMoreReplies;
  refs.repliesLoadMore.disabled = state.isLoadingReplies;
  refs.repliesLoadMore.textContent = state.isLoadingReplies ? "Se încarcă..." : "Încarcă mai multe";

  updateSidebarStats();
};

const renderModerationPanel = () => {
  if (!refs.moderationPanel || !refs.moderationForm || !state.thread) return;

  if (!state.isModerator) {
    refs.moderationPanel.hidden = true;
    return;
  }

  refs.moderationPanel.hidden = false;

  refs.modTitle.value = state.thread.title;
  refs.modBody.value = state.thread.body;
  refs.modStatus.value = VALID_MODERATION_STATUSES.has(state.thread.moderationStatus) ?
      state.thread.moderationStatus
    : "visible";
  refs.modLocked.checked = Boolean(state.thread.isLocked);
  refs.modSticky.checked = Boolean(state.thread.isSticky);
  refs.modSticky.disabled = !state.isAdmin;

  refs.modStickyHint.textContent =
    state.isAdmin ?
      "Ai rol admin: poți controla statusul sticky al subiectului."
    : "Ai rol moderator: sticky este blocat și poate fi schimbat doar de admin.";

  clearNode(refs.modCategory);

  const categories = state.categories.length ? state.categories : [
    {
      id: state.thread.categoryId,
      name: getThreadCategoryLabel(state.thread),
      type: state.thread.categoryType,
    },
  ];

  categories.forEach((category) => {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent =
      category.type === "admin" ? `${category.name} (admin)` : category.name;
    refs.modCategory.appendChild(option);
  });

  refs.modCategory.value = state.thread.categoryId;

  refs.modSubmit.disabled = state.isSavingModeration;
  refs.modSubmit.textContent =
    state.isSavingModeration ? "Se salvează..." : "Salvează modificările";
};

const buildRepliesQuery = () => {
  const repliesRef = collection(
    db,
    THREADS_COLLECTION,
    state.thread.id,
    THREAD_REPLIES_COLLECTION,
  );

  const constraints = [];

  if (!canSeeModeratedReplies()) {
    constraints.push(where("moderationStatus", "==", "visible"));
  }

  constraints.push(orderBy("createdAt", "desc"));

  if (state.repliesCursor) {
    constraints.push(startAfter(state.repliesCursor));
  }

  constraints.push(limit(REPLIES_PAGE_SIZE));

  return query(repliesRef, ...constraints);
};

const loadReplies = async ({ reset = false } = {}) => {
  if (!state.thread) return;
  if (state.isLoadingReplies) return;
  if (!reset && !state.hasMoreReplies) return;
  if (state.repliesUsingIndexFallback && !reset) return;

  if (reset) {
    state.replies = [];
    state.repliesCursor = null;
    state.hasMoreReplies = true;
    state.repliesUsingIndexFallback = false;
    state.editingReplyId = "";
    state.editingReplyValue = "";
    clearNode(refs.repliesList);
    refs.repliesEmpty.hidden = true;
  }

  const requestId = ++state.repliesRequestId;
  state.isLoadingReplies = true;
  showRepliesLoading(reset && state.replies.length === 0);

  try {
    const snapshot = await getDocs(buildRepliesQuery());

    if (requestId !== state.repliesRequestId) return;

    const mapped = snapshot.docs.map(mapReplyDoc);

    if (reset) {
      state.replies = mapped;
    } else {
      const seen = new Set(state.replies.map((reply) => reply.id));
      mapped.forEach((reply) => {
        if (!seen.has(reply.id)) {
          state.replies.push(reply);
          seen.add(reply.id);
        }
      });
    }

    if (snapshot.docs.length) {
      state.repliesCursor = snapshot.docs[snapshot.docs.length - 1];
    }

    if (snapshot.docs.length < REPLIES_PAGE_SIZE) {
      state.hasMoreReplies = false;
    }

    state.repliesUsingIndexFallback = false;
    renderReplies();
  } catch (error) {
    if (requestId !== state.repliesRequestId) return;

    const code = error?.code || "";
    const message = toTrimmedString(error?.message);
    const isMissingIndexError =
      code === "failed-precondition" && /index/i.test(message);

    if (isMissingIndexError && !state.repliesUsingIndexFallback) {
      try {
        const fallbackConstraints = [where("moderationStatus", "==", "visible")];

        if (canSeeModeratedReplies()) {
          fallbackConstraints.length = 0;
        }

        fallbackConstraints.push(limit(REPLIES_PAGE_SIZE * 6));

        const fallbackSnapshot = await getDocs(
          query(
            collection(
              db,
              THREADS_COLLECTION,
              state.thread.id,
              THREAD_REPLIES_COLLECTION,
            ),
            ...fallbackConstraints,
          ),
        );

        if (requestId !== state.repliesRequestId) return;

        const mapped = sortRepliesByNewest(
          fallbackSnapshot.docs.map(mapReplyDoc),
        );

        state.replies = mapped;
        state.repliesCursor = null;
        state.hasMoreReplies = false;
        state.repliesUsingIndexFallback = true;

        refs.repliesLoadMore.hidden = true;
        renderReplies();
        setRepliesStatus(
          "Răspunsurile au fost încărcate în mod compatibil. Creează indexul recomandat pentru paginare completă.",
        );
        return;
      } catch {
        // Continue to the generic error path.
      }
    }

    refs.repliesLoadMore.hidden = true;
    setRepliesStatus(describeError(error, "Nu am putut încărca răspunsurile."));
  } finally {
    if (requestId === state.repliesRequestId) {
      state.isLoadingReplies = false;
      showRepliesLoading(false);

      refs.repliesLoadMore.disabled = false;
      refs.repliesLoadMore.textContent = "Încarcă mai multe";
    }
  }
};

const refreshThreadDocument = async () => {
  const threadRef = getThreadRef();
  if (!threadRef) return false;

  const snapshot = await getDoc(threadRef);
  if (!snapshot.exists()) return false;

  state.thread = mapThreadDoc(snapshot);
  ensureThreadCategoryPresent();

  const canonicalPath = buildCanonicalThreadPath(state.thread.id, state.thread.title);
  updateMetaTags(state.thread, canonicalPath);

  renderThreadSummary();
  renderModerationPanel();
  renderReplyComposer();
  renderReplies();

  return true;
};

const loadThread = async () => {
  state.thread = null;

  if (!state.routeThreadId) {
    showViewState("not-found");
    return false;
  }

  const threadRef = getThreadRef();

  try {
    const snapshot = await getDoc(threadRef);

    if (!snapshot.exists()) {
      showViewState("not-found");
      return false;
    }

    state.thread = mapThreadDoc(snapshot);
    ensureThreadCategoryPresent();

    const canonicalPath = buildCanonicalThreadPath(state.thread.id, state.thread.title);
    const currentPath = normalizePath(window.location.pathname);
    const hasTidParam = new URLSearchParams(window.location.search).has("tid");

    if (normalizePath(canonicalPath) !== currentPath || hasTidParam) {
      const canonicalUrl = `${canonicalPath}${window.location.hash || ""}`;
      window.history.replaceState(window.history.state, "", canonicalUrl);
    }

    updateMetaTags(state.thread, canonicalPath);
    renderThreadSummary();
    renderModerationPanel();
    renderReplyComposer();
    showViewState("content");

    return true;
  } catch (error) {
    if (error?.code === "permission-denied") {
      showViewState("denied");
      return false;
    }

    showViewState("error");
    refs.stateErrorMessage.textContent = describeError(
      error,
      "Nu am putut încărca acest subiect.",
    );

    return false;
  }
};

const submitNewReply = async () => {
  if (state.isSubmittingReply) return;

  if (!state.authUser) {
    redirectToLogin();
    return;
  }

  if (!state.thread) return;

  if (state.thread.isLocked && !state.isModerator) {
    setReplyFeedback("Subiectul este blocat. Nu poți publica răspunsuri noi.", "error");
    return;
  }

  const body = toTrimmedString(refs.replyInput.value);

  if (!body) {
    setReplyFeedback("Răspunsul nu poate fi gol.", "error");
    return;
  }

  if (body.length > 1500) {
    setReplyFeedback("Răspunsul poate avea maxim 1500 caractere.", "error");
    return;
  }

  state.isSubmittingReply = true;
  setReplyFeedback("Se publică răspunsul...");
  renderReplyComposer();

  const buildReplyPayload = () => {
    const payload = {
      body,
      authorUid: state.authUser.uid,
      authorName: extractDisplayName(state.authUser),
      authorIsAdmin: state.isAdmin,
      moderationStatus: "visible",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    const userEmail = toTrimmedString(state.authUser.email);
    if (userEmail) {
      payload.authorEmail = userEmail;
    }

    return payload;
  };

  try {
    const threadRef = getThreadRef();

    await runTransaction(db, async (transaction) => {
      const threadSnapshot = await transaction.get(threadRef);

      if (!threadSnapshot.exists()) {
        throw new Error("Thread missing");
      }

      const currentThread = threadSnapshot.data() || {};
      const nextCount = safeInt(currentThread.commentCount, 0) + 1;
      const replyRef = doc(collection(threadRef, THREAD_REPLIES_COLLECTION));

      transaction.set(replyRef, buildReplyPayload());
      transaction.update(threadRef, {
        commentCount: nextCount,
        updatedAt: serverTimestamp(),
        lastActivityAt: serverTimestamp(),
      });
    });

    refs.replyInput.value = "";
    setReplyFeedback("Răspunsul a fost publicat.", "success");

    await refreshThreadDocument();
    await loadReplies({ reset: true });
  } catch (error) {
    const isCounterSyncDenied = error?.code === "permission-denied";

    if (isCounterSyncDenied) {
      try {
        await addDoc(
          collection(
            db,
            THREADS_COLLECTION,
            state.thread.id,
            THREAD_REPLIES_COLLECTION,
          ),
          buildReplyPayload(),
        );

        refs.replyInput.value = "";
        setReplyFeedback(
          "Răspuns publicat. Contorul thread-ului nu a putut fi actualizat automat.",
          "success",
        );
        await refreshThreadDocument();
        await loadReplies({ reset: true });
        return;
      } catch {
        // Continue to the standard error message below.
      }
    }

    setReplyFeedback(
      describeError(error, "Nu am putut publica răspunsul. Încearcă din nou."),
      "error",
    );
  } finally {
    state.isSubmittingReply = false;
    renderReplyComposer();
  }
};

const saveEditedReply = async (replyId) => {
  const reply = state.replies.find((item) => item.id === replyId);
  if (!reply) return;

  if (!canManageReply(reply)) {
    setReplyFeedback("Nu ai permisiunea de a edita acest răspuns.", "error");
    return;
  }

  const nextBody = toTrimmedString(state.editingReplyValue);

  if (!nextBody) {
    setReplyFeedback("Răspunsul nu poate fi gol.", "error");
    return;
  }

  if (nextBody.length > 1500) {
    setReplyFeedback("Răspunsul poate avea maxim 1500 caractere.", "error");
    return;
  }

  if (nextBody === reply.body) {
    state.editingReplyId = "";
    state.editingReplyValue = "";
    renderReplies();
    return;
  }

  try {
    await updateDoc(
      doc(db, THREADS_COLLECTION, state.thread.id, THREAD_REPLIES_COLLECTION, replyId),
      {
        body: nextBody,
        updatedAt: serverTimestamp(),
      },
    );

    state.editingReplyId = "";
    state.editingReplyValue = "";
    setReplyFeedback("Răspuns actualizat.", "success");
    await loadReplies({ reset: true });
  } catch (error) {
    setReplyFeedback(
      describeError(error, "Nu am putut actualiza răspunsul."),
      "error",
    );
  }
};

const deleteReply = async (replyId) => {
  const reply = state.replies.find((item) => item.id === replyId);
  if (!reply) return;

  if (!canManageReply(reply)) {
    setReplyFeedback("Nu ai permisiunea de a șterge acest răspuns.", "error");
    return;
  }

  const shouldDelete = window.confirm("Vrei să ștergi acest răspuns?");
  if (!shouldDelete) return;

  try {
    const threadRef = getThreadRef();
    const replyRef = doc(
      db,
      THREADS_COLLECTION,
      state.thread.id,
      THREAD_REPLIES_COLLECTION,
      replyId,
    );

    await runTransaction(db, async (transaction) => {
      const threadSnapshot = await transaction.get(threadRef);

      if (!threadSnapshot.exists()) {
        throw new Error("Thread missing");
      }

      const currentThread = threadSnapshot.data() || {};
      const nextCount = Math.max(0, safeInt(currentThread.commentCount, 0) - 1);

      transaction.delete(replyRef);
      transaction.update(threadRef, {
        commentCount: nextCount,
        updatedAt: serverTimestamp(),
        lastActivityAt: serverTimestamp(),
      });
    });

    state.editingReplyId = "";
    state.editingReplyValue = "";
    setReplyFeedback("Răspuns șters.", "success");

    await refreshThreadDocument();
    await loadReplies({ reset: true });
  } catch (error) {
    const isCounterSyncDenied = error?.code === "permission-denied";

    if (isCounterSyncDenied) {
      try {
        await deleteDoc(
          doc(
            db,
            THREADS_COLLECTION,
            state.thread.id,
            THREAD_REPLIES_COLLECTION,
            replyId,
          ),
        );

        state.editingReplyId = "";
        state.editingReplyValue = "";
        setReplyFeedback(
          "Răspuns șters. Contorul thread-ului nu a putut fi actualizat automat.",
          "success",
        );

        await refreshThreadDocument();
        await loadReplies({ reset: true });
        return;
      } catch {
        // Continue to the standard error message below.
      }
    }

    setReplyFeedback(
      describeError(error, "Nu am putut șterge răspunsul."),
      "error",
    );
  }
};

const submitModerationUpdate = async () => {
  if (!state.thread || !state.isModerator || state.isSavingModeration) return;

  const nextTitle = toTrimmedString(refs.modTitle.value);
  const nextBody = toTrimmedString(refs.modBody.value);
  const nextCategoryId = toTrimmedString(refs.modCategory.value);
  const nextStatus = toTrimmedString(refs.modStatus.value);
  const nextLocked = Boolean(refs.modLocked.checked);
  const nextSticky = Boolean(refs.modSticky.checked);

  if (nextTitle.length < 6 || nextTitle.length > 160) {
    setModerationFeedback("Titlul trebuie să aibă între 6 și 160 de caractere.", "error");
    return;
  }

  if (nextBody.length < 12 || nextBody.length > 8000) {
    setModerationFeedback("Conținutul trebuie să aibă între 12 și 8000 caractere.", "error");
    return;
  }

  const selectedCategory = getCategoryById(nextCategoryId);
  if (!selectedCategory) {
    setModerationFeedback("Selectează o categorie validă.", "error");
    return;
  }

  if (!VALID_MODERATION_STATUSES.has(nextStatus)) {
    setModerationFeedback("Statusul de moderare este invalid.", "error");
    return;
  }

  const updates = {};

  if (nextTitle !== state.thread.title) updates.title = nextTitle;
  if (nextBody !== state.thread.body) updates.body = nextBody;

  if (
    nextCategoryId !== state.thread.categoryId ||
    selectedCategory.type !== state.thread.categoryType
  ) {
    updates.categoryId = nextCategoryId;
    updates.categoryType = selectedCategory.type;
  }

  if (nextStatus !== state.thread.moderationStatus) {
    updates.moderationStatus = nextStatus;
  }

  if (nextLocked !== state.thread.isLocked) {
    updates.isLocked = nextLocked;
  }

  if (state.isAdmin && nextSticky !== state.thread.isSticky) {
    updates.isSticky = nextSticky;
  }

  if (!Object.keys(updates).length) {
    setModerationFeedback("Nu există modificări de salvat.");
    return;
  }

  updates.updatedAt = serverTimestamp();
  updates.lastActivityAt = serverTimestamp();

  state.isSavingModeration = true;
  refs.modSubmit.disabled = true;
  refs.modSubmit.textContent = "Se salvează...";

  try {
    await updateDoc(getThreadRef(), updates);

    setModerationFeedback("Modificările au fost salvate.", "success");

    const refreshed = await refreshThreadDocument();
    if (!refreshed) {
      showViewState("not-found");
      return;
    }

    await loadReplies({ reset: true });
  } catch (error) {
    setModerationFeedback(
      describeError(error, "Nu am putut salva modificările."),
      "error",
    );
  } finally {
    state.isSavingModeration = false;
    refs.modSubmit.disabled = false;
    refs.modSubmit.textContent = "Salvează modificările";
  }
};

const handleRepliesListClick = async (event) => {
  const actionTrigger = event.target.closest("[data-action]");
  if (!actionTrigger) return;

  const action = actionTrigger.getAttribute("data-action") || "";
  const replyId = toTrimmedString(actionTrigger.getAttribute("data-reply-id"));
  if (!replyId) return;

  if (action === "start-edit") {
    const reply = state.replies.find((item) => item.id === replyId);
    if (!reply || !canManageReply(reply)) return;

    state.editingReplyId = replyId;
    state.editingReplyValue = reply.body;
    renderReplies();
    return;
  }

  if (action === "cancel-edit") {
    state.editingReplyId = "";
    state.editingReplyValue = "";
    renderReplies();
    return;
  }

  if (action === "delete-reply") {
    await deleteReply(replyId);
  }
};

const handleRepliesListInput = (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;

  const replyId = toTrimmedString(target.getAttribute("data-reply-id"));
  if (!replyId || state.editingReplyId !== replyId) return;

  state.editingReplyValue = target.value;
};

const handleRepliesListSubmit = async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (!form.classList.contains("forum-reply-edit-form")) return;

  event.preventDefault();

  const replyId = toTrimmedString(form.getAttribute("data-reply-id"));
  if (!replyId) return;

  await saveEditedReply(replyId);
};

const onAuthChangedAfterInit = async (user) => {
  const previousSignature = state.authSignature;
  await applyAuthState(user);

  renderReplyComposer();
  renderModerationPanel();

  if (!state.thread) {
    if (previousSignature !== state.authSignature) {
      await bootstrapPage();
    }
    return;
  }

  if (previousSignature === state.authSignature) return;

  try {
    const refreshed = await refreshThreadDocument();
    if (!refreshed) {
      showViewState("not-found");
      return;
    }

    await loadReplies({ reset: true });
  } catch {
    // Keep current rendered state if token refresh fails.
  }
};

const bindEvents = () => {
  refs.retryBtn?.addEventListener("click", async () => {
    await bootstrapPage({ refreshCategories: true });
  });

  refs.replyStartBtn?.addEventListener("click", () => {
    if (!state.authUser) {
      redirectToLogin();
      return;
    }

    refs.replyInput?.focus();
    refs.replyInput?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  refs.replyForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitNewReply();
  });

  refs.repliesLoadMore?.addEventListener("click", async () => {
    refs.repliesLoadMore.disabled = true;
    refs.repliesLoadMore.textContent = "Se încarcă...";
    await loadReplies({ reset: false });
  });

  refs.repliesList?.addEventListener("click", async (event) => {
    await handleRepliesListClick(event);
  });

  refs.repliesList?.addEventListener("input", handleRepliesListInput);
  refs.repliesList?.addEventListener("submit", async (event) => {
    await handleRepliesListSubmit(event);
  });

  refs.moderationForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitModerationUpdate();
  });
};

const bootstrapPage = async ({ refreshCategories = false } = {}) => {
  showViewState("loading");

  if (refreshCategories || !state.categories.length) {
    try {
      await loadCategories();
    } catch {
      state.categories = [];
      state.categoriesById = new Map();
    }
  }

  const hasThread = await loadThread();

  if (!hasThread) {
    renderReplyComposer();
    return;
  }

  renderReplyComposer();
  renderModerationPanel();
  setReplyFeedback("");
  setModerationFeedback("");

  await loadReplies({ reset: true });
};

const init = async () => {
  state.routeThreadId = parseThreadRoute().resolvedThreadId;

  bindEvents();

  try {
    const initialUser = await waitForInitialAuth();
    await applyAuthState(initialUser);
    await bootstrapPage({ refreshCategories: true });

    onAuthStateChanged(auth, async (user) => {
      await onAuthChangedAfterInit(user || null);
    });
  } catch (error) {
    showViewState("error");
    if (refs.stateErrorMessage) {
      refs.stateErrorMessage.textContent = describeError(
        error,
        "Nu am putut inițializa pagina subiectului.",
      );
    }
  } finally {
    revealThreadPage();
  }
};

init();
