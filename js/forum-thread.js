import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
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
const BACK_TO_TOP_FADE_MS = 180;
const ROBOTS_INDEX_DIRECTIVE =
  "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1";
const ROBOTS_NOINDEX_DIRECTIVE = "noindex,nofollow,noarchive";

const VALID_FORUM_ROLES = new Set(["member", "moderator", "admin"]);
const VALID_MODERATION_STATUSES = new Set(["visible", "pending", "hidden"]);

const state = {
  routeThreadId: "",
  thread: null,
  categories: [],
  categoriesById: new Map(),
  authUser: null,
  authClaims: {},
  currentUserRoleData: null,
  forumRole: "member",
  isAdmin: false,
  isModerator: false,
  commentPostingRestriction: null,
  moderationTargets: new Map(),
  replies: [],
  repliesSort: "newest",
  repliesCursor: null,
  hasMoreReplies: true,
  repliesUsingIndexFallback: false,
  isLoadingReplies: false,
  repliesRequestId: 0,
  isSubmittingReply: false,
  isSavingOwnerEdit: false,
  isSavingModeration: false,
  isSavingBan: false,
  editingReplyId: "",
  editingReplyValue: "",
  replyComposerExpanded: false,
  authSignature: "guest",
  backToTopHideTimeoutId: 0,
  revealedReplyIds: new Set(),
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
  threadSummaryTitle: document.getElementById("thread-summary-title"),
  threadBody: document.getElementById("thread-body"),
  threadAuthorAvatar: document.getElementById("thread-author-avatar"),
  threadAuthorName: document.getElementById("thread-author-name"),
  threadCreatedAt: document.getElementById("thread-created-at"),
  threadCategory: document.getElementById("thread-category"),
  threadRepliesCount: document.getElementById("thread-replies-count"),
  threadSummaryBadges: document.getElementById("thread-summary-badges"),
  threadLastActivity: document.getElementById("thread-last-activity"),

  replyComposeTrigger: document.getElementById("reply-compose-trigger"),
  replyForm: document.getElementById("reply-form"),
  replyCancelBtn: document.getElementById("reply-cancel-btn"),
  replyAuthNote: document.getElementById("reply-auth-note"),
  replyInput: document.getElementById("reply-input"),
  replyCharCount: document.getElementById("reply-char-count"),
  replySubmit: document.getElementById("reply-submit"),
  replyFeedback: document.getElementById("reply-feedback"),

  repliesStatus: document.getElementById("replies-status"),
  repliesLoading: document.getElementById("replies-loading"),
  repliesEmpty: document.getElementById("replies-empty"),
  repliesList: document.getElementById("replies-list"),
  repliesLoadMore: document.getElementById("replies-load-more"),
  repliesSortSelect: document.getElementById("replies-sort-select"),
  backToTopBtn: document.getElementById("forum-thread-back-to-top"),

  moderationPanel: document.getElementById("thread-moderation-panel"),
  threadToolsDetails: document.getElementById("thread-tools-details"),
  threadToolsSubtitle: document.getElementById("thread-tools-subtitle"),
  moderationCopy: document.getElementById("moderation-copy"),
  ownerSection: document.getElementById("thread-owner-section"),
  moderationSection: document.getElementById("thread-moderation-section"),
  restrictionSection: document.getElementById("thread-restriction-section"),
  ownerForm: document.getElementById("thread-owner-edit-form"),
  ownerTitle: document.getElementById("owner-thread-title"),
  ownerBody: document.getElementById("owner-thread-body"),
  ownerSubmit: document.getElementById("owner-thread-submit"),
  ownerFeedback: document.getElementById("owner-thread-feedback"),
  moderationForm: document.getElementById("thread-moderation-form"),
  modCategory: document.getElementById("mod-thread-category"),
  modStatus: document.getElementById("mod-thread-status"),
  modLocked: document.getElementById("mod-thread-locked"),
  modSticky: document.getElementById("mod-thread-sticky"),
  modSubmit: document.getElementById("mod-thread-submit"),
  modDelete: document.getElementById("mod-thread-delete"),
  modStickyHint: document.getElementById("mod-sticky-hint"),
  modFeedback: document.getElementById("mod-feedback"),
  banForm: document.getElementById("thread-ban-form"),
  banTargetUser: document.getElementById("mod-ban-target-user"),
  banTargetUid: document.getElementById("mod-ban-target-uid"),
  banTargetSummary: document.getElementById("mod-ban-target-summary"),
  banUseThreadAuthor: document.getElementById("mod-ban-use-thread-author"),
  banScope: document.getElementById("mod-ban-scope"),
  banDuration: document.getElementById("mod-ban-duration"),
  banReason: document.getElementById("mod-ban-reason"),
  banSubmit: document.getElementById("mod-ban-submit"),
  banClear: document.getElementById("mod-ban-clear"),
  banFeedback: document.getElementById("mod-ban-feedback"),

  sidebarTotalReplies: document.getElementById("sidebar-total-replies"),
  sidebarParticipants: document.getElementById("sidebar-participants"),

  metaDescription: document.getElementById("thread-meta-description"),
  metaRobots: document.getElementById("thread-meta-robots"),
  ogTitle: document.getElementById("thread-og-title"),
  ogDescription: document.getElementById("thread-og-description"),
  ogUrl: document.getElementById("thread-og-url"),
  ogUpdatedTime: document.getElementById("thread-og-updated-time"),
  articlePublishedTime: document.getElementById("thread-article-published-time"),
  articleModifiedTime: document.getElementById("thread-article-modified-time"),
  twitterTitle: document.getElementById("thread-twitter-title"),
  twitterDescription: document.getElementById("thread-twitter-description"),
  twitterUrl: document.getElementById("thread-twitter-url"),
  canonicalLink: document.getElementById("thread-canonical-link"),
  structuredData: document.getElementById("thread-structured-data"),
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

const toIsoDateTime = (rawDate) => {
  const date = toDateOrNull(rawDate);
  if (!date) return "";

  try {
    return date.toISOString();
  } catch {
    return "";
  }
};

const truncateText = (value, maxLength = 160) => {
  const normalized = toTrimmedString(value);
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;

  const sliced = normalized.slice(0, maxLength - 1).trimEnd();
  return `${sliced}…`;
};

const formatCompactUid = (uid) => {
  const normalized = toTrimmedString(uid);
  if (!normalized) return "";
  if (normalized.length <= 18) return normalized;
  return `${normalized.slice(0, 8)}...${normalized.slice(-4)}`;
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
    restriction.until ? formatAbsoluteTime(restriction.until) : "";
  const prefix =
    restriction.kind === "cooldown" ?
      `Ai un cooldown activ pentru ${scopeLabel}`
    : `Ai o restricție activă pentru ${scopeLabel}`;
  const reasonText = restriction.reason ? ` Motiv: ${restriction.reason}.` : "";
  return untilText ?
      `${prefix} până la ${untilText}.${reasonText}`
    : `${prefix}.${reasonText}`;
};

const getBanTargetUid = () => {
  const fromSelect = toTrimmedString(refs.banTargetUser?.value);
  if (fromSelect) return fromSelect;
  return toTrimmedString(refs.banTargetUid?.value);
};

const autoResizeReplyInput = () => {
  if (!refs.replyInput) return;

  const minHeight = 120;
  const maxHeight = 260;

  refs.replyInput.style.height = "auto";
  const nextHeight = Math.min(
    maxHeight,
    Math.max(minHeight, refs.replyInput.scrollHeight),
  );
  refs.replyInput.style.height = `${nextHeight}px`;
  refs.replyInput.style.overflowY =
    refs.replyInput.scrollHeight > maxHeight ? "auto" : "hidden";
};

const renderReplyCharacterCounter = () => {
  if (!refs.replyInput || !refs.replyCharCount) return;

  const currentLength = refs.replyInput.value.length;
  const maxLength = Number.parseInt(refs.replyInput.maxLength, 10) || 1500;
  refs.replyCharCount.textContent = `${currentLength}/${maxLength}`;

  const nearLimitThreshold = Math.max(0, maxLength - 120);
  refs.replyCharCount.classList.toggle(
    "is-near-limit",
    currentLength >= nearLimitThreshold && currentLength < maxLength,
  );
  refs.replyCharCount.classList.toggle("is-limit", currentLength >= maxLength);
};

const getDateTime = (rawDate) => toDateOrNull(rawDate)?.getTime?.() || 0;

const getSortedRepliesForDisplay = (replies) => {
  const direction = state.repliesSort === "oldest" ? "oldest" : "newest";
  return [...replies].sort((a, b) => {
    const delta = getDateTime(b.createdAt) - getDateTime(a.createdAt);
    return direction === "oldest" ? -delta : delta;
  });
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

  if (action) {
    node.dataset.action = action;
  }

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

const onBackToTopClick = () => {
  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
};

const safeDecodeURIComponent = (value) => {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
};

const parseThreadRoute = () => {
  const pathnameSegments = window.location.pathname.split("/").filter(Boolean);

  const hasPathThreadRoute =
    pathnameSegments.length >= 2 &&
    pathnameSegments[0] === "forum" &&
    pathnameSegments[1] === "thread";

  const pathThreadId =
    hasPathThreadRoute && pathnameSegments.length >= 3 ?
      safeDecodeURIComponent(pathnameSegments[2] || "").trim()
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

const setOwnerFeedback = (text, type = "") => {
  if (!refs.ownerFeedback) return;

  refs.ownerFeedback.textContent = text;
  refs.ownerFeedback.classList.remove("is-error", "is-success");

  if (type === "error") refs.ownerFeedback.classList.add("is-error");
  if (type === "success") refs.ownerFeedback.classList.add("is-success");
};

const setBanFeedback = (text, type = "") => {
  if (!refs.banFeedback) return;

  refs.banFeedback.textContent = text;
  refs.banFeedback.classList.remove("is-error", "is-success");

  if (type === "error") refs.banFeedback.classList.add("is-error");
  if (type === "success") refs.banFeedback.classList.add("is-success");
};

const showRepliesLoading = (isVisible) => {
  if (!refs.repliesLoading) return;
  refs.repliesLoading.hidden = !isVisible;
};

const setRepliesStatus = (text = "") => {
  if (!refs.repliesStatus) return;
  refs.repliesStatus.textContent = text;
};

const setRobotsDirective = (value) => {
  if (!refs.metaRobots) return;
  refs.metaRobots.setAttribute("content", value || ROBOTS_NOINDEX_DIRECTIVE);
};

const clearStructuredData = () => {
  if (!refs.structuredData) return;
  refs.structuredData.textContent = "{}";
};

const updateThreadStructuredData = ({
  thread,
  canonicalUrl,
  description,
  publishedIso,
  modifiedIso,
} = {}) => {
  if (!refs.structuredData || !thread || !canonicalUrl) {
    clearStructuredData();
    return;
  }

  const structuredDataPayload = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "DiscussionForumPosting",
        "@id": `${canonicalUrl}#discussion`,
        url: canonicalUrl,
        headline: toTrimmedString(thread.title) || "Subiect Forum Educheia",
        articleBody: truncateText(thread.body, 4000),
        description,
        datePublished: publishedIso || undefined,
        dateModified: modifiedIso || publishedIso || undefined,
        interactionStatistic: {
          "@type": "InteractionCounter",
          interactionType: "https://schema.org/CommentAction",
          userInteractionCount: safeInt(thread.commentCount, 0),
        },
        author: {
          "@type": "Person",
          name: toTrimmedString(thread.authorName) || "Membru Educheia",
        },
        isPartOf: {
          "@id": `${PUBLIC_ORIGIN}/forum#collection-page`,
        },
        mainEntityOfPage: canonicalUrl,
        publisher: {
          "@type": "Organization",
          name: "Educheia",
          url: PUBLIC_ORIGIN,
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Acasă",
            item: `${PUBLIC_ORIGIN}/`,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: "Forum",
            item: `${PUBLIC_ORIGIN}/forum`,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: toTrimmedString(thread.title) || "Subiect forum",
            item: canonicalUrl,
          },
        ],
      },
    ],
  };

  refs.structuredData.textContent = JSON.stringify(structuredDataPayload);
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

  if (!showContent) {
    setRobotsDirective(ROBOTS_NOINDEX_DIRECTIVE);
    clearStructuredData();
  }
};

const getThreadRef = () => {
  if (!state.routeThreadId) return null;
  return doc(db, THREADS_COLLECTION, state.routeThreadId);
};

const getCategoryById = (categoryId) =>
  state.categoriesById.get(categoryId) || null;

const getThreadCategoryLabel = (thread) => {
  const category = getCategoryById(thread?.categoryId);
  if (category) return category.name;

  if (thread?.categoryType === "admin") return "Administrare";
  return "General";
};

const canSeeModeratedReplies = () => {
  if (!state.thread) return false;
  if (state.isModerator) return true;
  return (
    Boolean(state.authUser?.uid) &&
    state.authUser.uid === state.thread.authorUid
  );
};

const isThreadOwner = () =>
  Boolean(state.thread?.authorUid) &&
  Boolean(state.authUser?.uid) &&
  state.thread.authorUid === state.authUser.uid;

const canEditReply = (reply) => {
  if (!reply || !state.authUser) return false;
  return reply.authorUid === state.authUser.uid;
};

const canDeleteReply = (reply) => {
  if (!reply || !state.authUser) return false;
  return state.isModerator || reply.authorUid === state.authUser.uid;
};

const canToggleReplyModeration = (reply) => {
  if (!reply || !state.authUser) return false;
  return state.isModerator;
};

const updateMetaTags = (thread, canonicalPath) => {
  const title = toTrimmedString(thread?.title) || "Subiect Forum";
  const body = toTrimmedString(thread?.body);
  const description = truncateText(
    body || "Discuție individuală din comunitatea Educheia.",
    160,
  );
  const publishedIso = toIsoDateTime(thread?.createdAt);
  const modifiedIso =
    toIsoDateTime(thread?.updatedAt) || toIsoDateTime(thread?.lastActivityAt);
  const isIndexableThread = toTrimmedString(thread?.moderationStatus) === "visible";

  document.title = `${title} | Forum Educheia`;

  if (refs.metaDescription)
    refs.metaDescription.setAttribute("content", description);
  if (refs.ogTitle) refs.ogTitle.setAttribute("content", title);
  if (refs.ogDescription)
    refs.ogDescription.setAttribute("content", description);
  if (refs.twitterTitle) refs.twitterTitle.setAttribute("content", title);
  if (refs.twitterDescription)
    refs.twitterDescription.setAttribute("content", description);

  const canonicalUrl = `${PUBLIC_ORIGIN}${canonicalPath}`;

  if (refs.canonicalLink) refs.canonicalLink.setAttribute("href", canonicalUrl);
  if (refs.ogUrl) refs.ogUrl.setAttribute("content", canonicalUrl);
  if (refs.twitterUrl) refs.twitterUrl.setAttribute("content", canonicalUrl);
  if (refs.ogUpdatedTime)
    refs.ogUpdatedTime.setAttribute("content", modifiedIso || publishedIso);
  if (refs.articlePublishedTime)
    refs.articlePublishedTime.setAttribute("content", publishedIso);
  if (refs.articleModifiedTime)
    refs.articleModifiedTime.setAttribute("content", modifiedIso || publishedIso);

  setRobotsDirective(
    isIndexableThread ? ROBOTS_INDEX_DIRECTIVE : ROBOTS_NOINDEX_DIRECTIVE,
  );
  updateThreadStructuredData({
    thread,
    canonicalUrl,
    description,
    publishedIso,
    modifiedIso,
  });
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
  state.currentUserRoleData = null;
  state.forumRole = "member";
  state.isAdmin = false;
  state.isModerator = false;
  state.commentPostingRestriction = null;

  if (!state.authUser) {
    state.authSignature = "guest";
    return;
  }

  state.currentUserRoleData = await loadCurrentUserRoleData(state.authUser);
  state.authClaims = await getUserClaims(state.authUser);
  state.forumRole = await resolveCurrentUserForumRole(
    state.authUser,
    state.authClaims,
    state.currentUserRoleData,
  );
  state.isAdmin = state.forumRole === "admin";
  state.isModerator = state.isAdmin || state.forumRole === "moderator";
  state.commentPostingRestriction = getActivePostingRestriction(
    state.currentUserRoleData,
    "comments",
  );
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
  state.categoriesById = new Map(
    categories.map((category) => [category.id, category]),
  );
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

  if (state.thread.isSticky)
    badges.push({ text: "sticky", className: "forum-pill forum-pill-sticky" });
  if (state.thread.isLocked)
    badges.push({ text: "blocată", className: "forum-pill" });
  if (state.thread.authorIsAdmin)
    badges.push({ text: "echipă", className: "forum-pill forum-pill-admin" });
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
    refs.sidebarTotalReplies.textContent = String(
      safeInt(state.thread.commentCount, 0),
    );
  }

  if (refs.sidebarParticipants) {
    refs.sidebarParticipants.textContent = String(
      Math.max(participants.size, 1),
    );
  }
};

const rebuildModerationTargets = () => {
  const nextTargets = new Map();

  const addTarget = (uid, name) => {
    const normalizedUid = toTrimmedString(uid);
    if (!normalizedUid) return;

    const normalizedName = toTrimmedString(name) || "Membru";
    const existing = nextTargets.get(normalizedUid);
    if (!existing || existing.name === "Membru") {
      nextTargets.set(normalizedUid, {
        uid: normalizedUid,
        name: normalizedName,
      });
    }
  };

  if (state.thread) {
    addTarget(state.thread.authorUid, state.thread.authorName);
  }

  state.replies.forEach((reply) => {
    addTarget(reply.authorUid, reply.authorName);
  });

  state.moderationTargets = nextTargets;
};

const renderBanTargetSummary = () => {
  if (!refs.banTargetSummary) return;

  const targetUid = getBanTargetUid();
  if (!targetUid) {
    refs.banTargetSummary.textContent =
      "Selectează un utilizator din conversație sau completează UID-ul manual.";
    return;
  }

  const knownTarget = state.moderationTargets.get(targetUid);
  if (!knownTarget) {
    refs.banTargetSummary.textContent = `UID manual: ${formatCompactUid(targetUid)}`;
    return;
  }

  refs.banTargetSummary.textContent = `Selectat: ${knownTarget.name} (${formatCompactUid(knownTarget.uid)})`;
};

const renderBanTargetOptions = () => {
  if (!refs.banTargetUser) return;

  const previousUid =
    toTrimmedString(refs.banTargetUser.value) ||
    toTrimmedString(refs.banTargetUid?.value);

  clearNode(refs.banTargetUser);

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Selectează un utilizator din conversație";
  refs.banTargetUser.appendChild(placeholder);

  const orderedTargets = [...state.moderationTargets.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "ro"),
  );

  orderedTargets.forEach((target) => {
    const option = document.createElement("option");
    option.value = target.uid;
    option.textContent = `${target.name} · ${formatCompactUid(target.uid)}`;
    refs.banTargetUser.appendChild(option);
  });

  let nextValue = previousUid;
  if (!nextValue && state.thread?.authorUid) {
    nextValue = toTrimmedString(state.thread.authorUid);
  }

  if (nextValue && orderedTargets.some((target) => target.uid === nextValue)) {
    refs.banTargetUser.value = nextValue;
  } else {
    refs.banTargetUser.value = "";
  }

  if (refs.banTargetUid) {
    refs.banTargetUid.value = refs.banTargetUser.value ? "" : nextValue || "";
  }

  renderBanTargetSummary();
};

const renderThreadSummary = () => {
  if (!state.thread) return;

  if (refs.threadTitle) {
    refs.threadTitle.textContent = state.thread.title;
  }
  if (refs.threadSummaryTitle) {
    refs.threadSummaryTitle.textContent = state.thread.title;
  }
  if (refs.threadBody) {
    refs.threadBody.textContent =
      state.thread.body || "Nu există conținut text pentru acest subiect.";
  }
  if (refs.threadAuthorName) {
    refs.threadAuthorName.textContent = state.thread.authorName;
  }
  if (refs.threadAuthorAvatar) {
    refs.threadAuthorAvatar.textContent = extractInitials(
      state.thread.authorName,
    );
  }
  if (refs.threadCreatedAt) {
    refs.threadCreatedAt.textContent = formatRelativeTime(state.thread.createdAt);
  }
  if (refs.threadCategory) {
    refs.threadCategory.textContent = getThreadCategoryLabel(state.thread);
  }
  if (refs.threadRepliesCount) {
    refs.threadRepliesCount.textContent = String(
      safeInt(state.thread.commentCount, 0),
    );
  }

  const activityDate = state.thread.lastActivityAt || state.thread.createdAt;
  if (refs.threadLastActivity) {
    refs.threadLastActivity.textContent =
      `Ultima activitate: ${formatRelativeTime(activityDate)} (${formatAbsoluteTime(activityDate)})`;
  }

  renderThreadBadges();
  rebuildModerationTargets();
  renderBanTargetOptions();
  updateSidebarStats();
};

const openReplyComposer = ({ focusInput = true } = {}) => {
  if (refs.replyComposeTrigger?.disabled) return;

  state.replyComposerExpanded = true;
  renderReplyComposer();
  if (focusInput && refs.replyInput && !refs.replyInput.disabled) {
    refs.replyInput.focus();
  }
};

const collapseReplyComposer = ({ clearDraft = false, force = false } = {}) => {
  if (state.isSubmittingReply && !force) return;

  state.replyComposerExpanded = false;

  if (clearDraft && refs.replyInput) {
    refs.replyInput.value = "";
    renderReplyCharacterCounter();
  }

  renderReplyComposer();
};

const renderReplyComposer = () => {
  if (
    !refs.replyInput ||
    !refs.replySubmit ||
    !refs.replyAuthNote ||
    !refs.replyComposeTrigger ||
    !refs.replyForm
  ) {
    return;
  }

  const isSignedIn = Boolean(state.authUser);
  const threadLockedForUser =
    Boolean(state.thread?.isLocked) && !state.isModerator;
  const restriction = state.commentPostingRestriction;
  const isRestricted = Boolean(restriction);
  const isDisabled =
    !isSignedIn ||
    threadLockedForUser ||
    isRestricted ||
    state.isSubmittingReply;

  refs.replyInput.disabled = isDisabled;
  refs.replySubmit.disabled = isDisabled;
  if (refs.replyCancelBtn)
    refs.replyCancelBtn.disabled = state.isSubmittingReply;
  refs.replySubmit.textContent =
    state.isSubmittingReply ? "Se trimite..." : "Comentează";
  renderReplyCharacterCounter();

  refs.replyComposeTrigger.hidden = state.replyComposerExpanded;
  refs.replyForm.hidden = !state.replyComposerExpanded;
  refs.replyComposeTrigger.disabled = isDisabled;
  refs.replyComposeTrigger.classList.toggle("is-disabled", isDisabled);

  if (!isSignedIn) {
    refs.replyComposeTrigger.textContent = "Conectează-te pentru a comenta";
    refs.replyInput.placeholder = "Autentifică-te pentru a răspunde.";

    clearNode(refs.replyAuthNote);
    refs.replyAuthNote.append("Trebuie să fii autentificat pentru a răspunde. ");

    const loginLink = document.createElement("a");
    loginLink.href = "/login";
    loginLink.className = "forum-inline-link";
    loginLink.textContent = "Login";
    refs.replyAuthNote.appendChild(loginLink);

    autoResizeReplyInput();
    return;
  }

  if (threadLockedForUser) {
    refs.replyComposeTrigger.textContent = "Subiect blocat";
    refs.replyInput.placeholder =
      "Subiect blocat: doar moderatorii mai pot răspunde.";
    refs.replyAuthNote.textContent =
      "Subiectul este blocat momentan. Doar moderatorii și administratorii pot publica.";
    autoResizeReplyInput();
    return;
  }

  if (isRestricted) {
    refs.replyComposeTrigger.textContent = "Comentariile sunt restricționate";
    refs.replyInput.placeholder =
      "Publicarea de comentarii este restricționată.";
    refs.replyAuthNote.textContent = describePostingRestriction(
      restriction,
      "comentarii",
    );
    autoResizeReplyInput();
    return;
  }

  refs.replyComposeTrigger.textContent = "Participă la conversație";
  refs.replyInput.placeholder = "Scrie un răspuns clar și util.";
  refs.replyAuthNote.textContent = `Răspunzi ca ${extractDisplayName(state.authUser)}.`;
  autoResizeReplyInput();
};

const buildReplyBadge = (className, text) => {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
};

const renderReplies = () => {
  clearNode(refs.repliesList);
  if (
    refs.repliesSortSelect &&
    refs.repliesSortSelect.value !== state.repliesSort
  ) {
    refs.repliesSortSelect.value = state.repliesSort;
  }

  const replies = getSortedRepliesForDisplay(state.replies);
  rebuildModerationTargets();
  renderBanTargetOptions();

  if (!replies.length) {
    refs.repliesEmpty.hidden = false;
    refs.repliesLoadMore.hidden = true;
    setRepliesStatus("Niciun răspuns încă.");
    updateSidebarStats();
    return;
  }

  refs.repliesEmpty.hidden = true;

  const fragment = document.createDocumentFragment();

  replies.forEach((reply, index) => {
    const replyKey = toTrimmedString(reply?.id);
    const shouldReveal = Boolean(replyKey) && !state.revealedReplyIds.has(replyKey);
    if (replyKey) {
      state.revealedReplyIds.add(replyKey);
    }

    const article = document.createElement("article");
    article.className =
      shouldReveal ? "forum-reply-card forum-reveal-item" : "forum-reply-card";
    if (shouldReveal) {
      article.style.setProperty("--forum-reveal-index", String(index));
    }
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
    const replyDate = toDateOrNull(reply.createdAt);
    if (replyDate) {
      time.dateTime = replyDate.toISOString();
      time.title = formatAbsoluteTime(replyDate);
    }

    topRow.append(authorName, time);

    const badges = document.createElement("div");
    badges.className = "forum-reply-badges";

    if (reply.authorIsAdmin) {
      badges.appendChild(
        buildReplyBadge("forum-pill forum-pill-admin", "echipă"),
      );
    }

    if (reply.moderationStatus !== "visible") {
      badges.appendChild(
        buildReplyBadge("forum-pill", `status: ${reply.moderationStatus}`),
      );
    }

    meta.append(topRow, badges);
    authorWrap.append(avatar, meta);
    head.appendChild(authorWrap);

    const canEdit = canEditReply(reply);
    const canDelete = canDeleteReply(reply);
    const canModerate = canToggleReplyModeration(reply);

    if (canEdit || canDelete || canModerate) {
      const actions = document.createElement("div");
      actions.className = "forum-reply-actions";

      const isEditing = state.editingReplyId === reply.id;

      if (canEdit) {
        const editBtn = buildIconAction({
          label: isEditing ? "Anulează editarea" : "Editează",
          icon: "edit",
          action: isEditing ? "cancel-edit" : "start-edit",
        });
        editBtn.dataset.replyId = reply.id;
        actions.appendChild(editBtn);
      }

      if (canModerate) {
        const visibilityBtn = buildIconAction({
          label: reply.moderationStatus === "hidden" ? "Afișează" : "Ascunde",
          icon: reply.moderationStatus === "hidden" ? "eye" : "eyeOff",
          action: "toggle-reply-visibility",
        });
        visibilityBtn.dataset.replyId = reply.id;
        actions.appendChild(visibilityBtn);

        const banAuthorBtn = buildIconAction({
          label: "Restricționează autor",
          icon: "ban",
          action: "ban-reply-author",
        });
        banAuthorBtn.dataset.replyAuthorUid = reply.authorUid;
        actions.appendChild(banAuthorBtn);
      }

      if (canDelete) {
        const deleteBtn = buildIconAction({
          label: "Șterge",
          icon: "trash",
          action: "delete-reply",
          danger: true,
        });
        deleteBtn.dataset.replyId = reply.id;
        actions.appendChild(deleteBtn);
      }

      head.appendChild(actions);
    }

    article.appendChild(head);

    if (state.editingReplyId === reply.id && canEditReply(reply)) {
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

  const loadedCount = replies.length;
  const totalKnown = replies.length;
  const summaryCount = safeInt(state.thread?.commentCount, totalKnown);
  const sortLabel =
    state.repliesSort === "oldest" ?
      "cele mai vechi primele"
    : "cele mai noi primele";
  const paginationNote =
    state.hasMoreReplies ?
      ` Încarcă mai multe pentru următoarele ${REPLIES_PAGE_SIZE}.`
    : "";
  setRepliesStatus(
    `${summaryCount} ${pluralizeReplies(summaryCount)} în acest subiect · afișate ${loadedCount} (${sortLabel}).${paginationNote}`,
  );

  refs.repliesLoadMore.hidden = !state.hasMoreReplies;
  refs.repliesLoadMore.disabled = state.isLoadingReplies;
  refs.repliesLoadMore.textContent =
    state.isLoadingReplies ? "Se încarcă..." : "Încarcă mai multe";

  updateSidebarStats();
};

const renderModerationPanel = () => {
  if (!refs.moderationPanel || !state.thread) return;

  const canOwnerEdit = isThreadOwner();
  const canModerate = state.isModerator;

  if (!canOwnerEdit && !canModerate) {
    refs.moderationPanel.hidden = true;
    if (refs.threadToolsDetails) refs.threadToolsDetails.open = false;
    if (refs.ownerSection) refs.ownerSection.hidden = true;
    if (refs.moderationSection) refs.moderationSection.hidden = true;
    if (refs.restrictionSection) refs.restrictionSection.hidden = true;
    return;
  }

  refs.moderationPanel.hidden = false;
  if (refs.ownerSection) refs.ownerSection.hidden = !canOwnerEdit;
  if (refs.moderationSection) refs.moderationSection.hidden = !canModerate;
  if (refs.restrictionSection) refs.restrictionSection.hidden = !canModerate;

  if (refs.threadToolsSubtitle) {
    refs.threadToolsSubtitle.textContent =
      canOwnerEdit && canModerate ? "Editor autor + moderare"
      : canOwnerEdit ? "Editor autor"
      : "Moderare și restricții";
  }

  if (refs.moderationCopy) {
    refs.moderationCopy.textContent =
      canOwnerEdit && canModerate ?
        "Poți edita conținutul propriu și poți modera subiectul."
      : canOwnerEdit ? "Doar autorul poate schimba titlul și conținutul."
      : "Poți modera statusul, șterge subiectul și restricționa publicarea.";
  }

  if (refs.ownerForm && refs.ownerTitle && refs.ownerBody && refs.ownerSubmit) {
    refs.ownerForm.hidden = !canOwnerEdit;
    if (canOwnerEdit) {
      refs.ownerTitle.value = state.thread.title;
      refs.ownerBody.value = state.thread.body;
      refs.ownerSubmit.disabled = state.isSavingOwnerEdit;
      refs.ownerSubmit.textContent =
        state.isSavingOwnerEdit ? "Se salvează..." : "Salvează conținutul";
    }
  }

  if (
    refs.moderationForm &&
    refs.modCategory &&
    refs.modStatus &&
    refs.modLocked &&
    refs.modSticky &&
    refs.modSubmit
  ) {
    refs.moderationForm.hidden = !canModerate;
    if (canModerate) {
      refs.modStatus.value =
        VALID_MODERATION_STATUSES.has(state.thread.moderationStatus) ?
          state.thread.moderationStatus
        : "visible";
      refs.modLocked.checked = Boolean(state.thread.isLocked);
      refs.modSticky.checked = Boolean(state.thread.isSticky);
      refs.modSticky.disabled = !state.isAdmin;

      clearNode(refs.modCategory);
      const categories =
        state.categories.length ?
          state.categories
        : [
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
          category.type === "admin" ?
            `${category.name} (admin)`
          : category.name;
        refs.modCategory.appendChild(option);
      });

      refs.modCategory.value = state.thread.categoryId;
      refs.modCategory.disabled = !state.isAdmin;

      refs.modStickyHint.textContent =
        state.isAdmin ?
          "Ca admin poți schimba categoria și sticky."
        : "Ca moderator poți doar bloca/debloca și schimba statusul.";

      refs.modSubmit.disabled = state.isSavingModeration;
      refs.modSubmit.textContent =
        state.isSavingModeration ? "Se salvează..." : "Salvează moderarea";
      if (refs.modDelete) refs.modDelete.disabled = state.isSavingModeration;
    }
  }

  if (
    refs.banForm &&
    refs.banUseThreadAuthor &&
    refs.banSubmit &&
    refs.banClear
  ) {
    refs.banForm.hidden = !canModerate;
    if (canModerate) {
      renderBanTargetOptions();
      refs.banUseThreadAuthor.disabled = !toTrimmedString(
        state.thread.authorUid,
      );
      refs.banSubmit.disabled = state.isSavingBan;
      refs.banClear.disabled = state.isSavingBan;
      refs.banSubmit.textContent =
        state.isSavingBan ? "Se aplică..." : "Aplică restricția";
    } else {
      renderBanTargetSummary();
    }
  }
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

  const direction = state.repliesSort === "oldest" ? "asc" : "desc";
  constraints.push(orderBy("createdAt", direction));

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
        const fallbackConstraints = [
          where("moderationStatus", "==", "visible"),
        ];

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

        const mapped = fallbackSnapshot.docs.map(mapReplyDoc);

        state.replies = mapped;
        state.repliesCursor = null;
        state.hasMoreReplies = false;
        state.repliesUsingIndexFallback = true;

        if (refs.repliesLoadMore) refs.repliesLoadMore.hidden = true;
        renderReplies();
        setRepliesStatus(
          "Răspunsurile au fost încărcate în mod compatibil. Creează indexul recomandat pentru paginare completă.",
        );
        return;
      } catch {
        // Continue to the generic error path.
      }
    }

    if (refs.repliesLoadMore) refs.repliesLoadMore.hidden = true;
    setRepliesStatus(describeError(error, "Nu am putut încărca răspunsurile."));
  } finally {
    if (requestId === state.repliesRequestId) {
      state.isLoadingReplies = false;
      showRepliesLoading(false);

      if (refs.repliesLoadMore) {
        refs.repliesLoadMore.disabled = false;
        refs.repliesLoadMore.textContent = "Încarcă mai multe";
      }
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

  const canonicalPath = buildCanonicalThreadPath(
    state.thread.id,
    state.thread.title,
  );
  updateMetaTags(state.thread, canonicalPath);

  renderThreadSummary();
  renderModerationPanel();
  renderReplyComposer();
  renderReplies();

  return true;
};

const loadThread = async () => {
  state.thread = null;
  state.revealedReplyIds.clear();

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

    const canonicalPath = buildCanonicalThreadPath(
      state.thread.id,
      state.thread.title,
    );
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

  if (state.commentPostingRestriction) {
    setReplyFeedback(
      describePostingRestriction(state.commentPostingRestriction, "comentarii"),
      "error",
    );
    return;
  }

  if (state.thread.isLocked && !state.isModerator) {
    setReplyFeedback(
      "Subiectul este blocat. Nu poți publica răspunsuri noi.",
      "error",
    );
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
    renderReplyCharacterCounter();
    autoResizeReplyInput();
    setReplyFeedback("Răspunsul a fost publicat.", "success");

    await refreshThreadDocument();
    await loadReplies({ reset: true });
    collapseReplyComposer({ clearDraft: true, force: true });
    setReplyFeedback("");
  } catch (error) {
    if (error?.code === "permission-denied") {
      if (state.commentPostingRestriction) {
        setReplyFeedback(
          describePostingRestriction(
            state.commentPostingRestriction,
            "comentarii",
          ),
          "error",
        );
        return;
      }

      const freshRoleData = await loadCurrentUserRoleData(state.authUser);
      const freshRestriction = getActivePostingRestriction(
        freshRoleData,
        "comments",
      );
      if (freshRestriction) {
        state.currentUserRoleData = freshRoleData;
        state.commentPostingRestriction = freshRestriction;
        renderReplyComposer();
        setReplyFeedback(
          describePostingRestriction(freshRestriction, "comentarii"),
          "error",
        );
        return;
      }
    }

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
        renderReplyCharacterCounter();
        autoResizeReplyInput();
        setReplyFeedback(
          "Răspuns publicat. Contorul thread-ului nu a putut fi actualizat automat.",
          "success",
        );
        await refreshThreadDocument();
        await loadReplies({ reset: true });
        collapseReplyComposer({ clearDraft: true, force: true });
        setReplyFeedback("");
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

  if (!canEditReply(reply)) {
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
      doc(
        db,
        THREADS_COLLECTION,
        state.thread.id,
        THREAD_REPLIES_COLLECTION,
        replyId,
      ),
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

  if (!canDeleteReply(reply)) {
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

  const nextCategoryId = toTrimmedString(refs.modCategory.value);
  const nextStatus = toTrimmedString(refs.modStatus.value);
  const nextLocked = Boolean(refs.modLocked.checked);
  const nextSticky = Boolean(refs.modSticky.checked);

  if (!VALID_MODERATION_STATUSES.has(nextStatus)) {
    setModerationFeedback("Statusul de moderare este invalid.", "error");
    return;
  }

  const updates = {};

  if (nextStatus !== state.thread.moderationStatus) {
    updates.moderationStatus = nextStatus;
  }

  if (nextLocked !== state.thread.isLocked) {
    updates.isLocked = nextLocked;
  }

  if (state.isAdmin && nextSticky !== state.thread.isSticky) {
    updates.isSticky = nextSticky;
  }

  if (state.isAdmin) {
    const selectedCategory = getCategoryById(nextCategoryId);
    if (!selectedCategory) {
      setModerationFeedback("Selectează o categorie validă.", "error");
      return;
    }

    if (
      selectedCategory.id !== state.thread.categoryId ||
      selectedCategory.type !== state.thread.categoryType
    ) {
      updates.categoryId = selectedCategory.id;
      updates.categoryType = selectedCategory.type;
    }
  }

  if (!Object.keys(updates).length) {
    setModerationFeedback("Nu există modificări de salvat.");
    return;
  }

  updates.updatedAt = serverTimestamp();
  updates.lastActivityAt = serverTimestamp();

  state.isSavingModeration = true;
  renderModerationPanel();

  try {
    await updateDoc(getThreadRef(), updates);

    setModerationFeedback("Moderarea a fost salvată.", "success");

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
    renderModerationPanel();
  }
};

const submitOwnerThreadEdit = async () => {
  if (!state.thread || !isThreadOwner() || state.isSavingOwnerEdit) return;
  if (!refs.ownerTitle || !refs.ownerBody) return;

  const nextTitle = toTrimmedString(refs.ownerTitle.value);
  const nextBody = toTrimmedString(refs.ownerBody.value);

  if (nextTitle.length < 6 || nextTitle.length > 160) {
    setOwnerFeedback(
      "Titlul trebuie să aibă între 6 și 160 de caractere.",
      "error",
    );
    return;
  }

  if (nextBody.length < 12 || nextBody.length > 8000) {
    setOwnerFeedback(
      "Conținutul trebuie să aibă între 12 și 8000 caractere.",
      "error",
    );
    return;
  }

  if (nextTitle === state.thread.title && nextBody === state.thread.body) {
    setOwnerFeedback("Nu există modificări de salvat.");
    return;
  }

  state.isSavingOwnerEdit = true;
  renderModerationPanel();

  try {
    await updateDoc(getThreadRef(), {
      title: nextTitle,
      body: nextBody,
      updatedAt: serverTimestamp(),
    });

    setOwnerFeedback("Conținutul subiectului a fost actualizat.", "success");
    await refreshThreadDocument();
  } catch (error) {
    setOwnerFeedback(
      describeError(error, "Nu am putut salva modificările de conținut."),
      "error",
    );
  } finally {
    state.isSavingOwnerEdit = false;
    renderModerationPanel();
  }
};

const deleteThreadWithModeration = async () => {
  if (!state.thread || !state.isModerator || state.isSavingModeration) return;

  const shouldDelete = window.confirm(
    "Confirmi ștergerea definitivă a subiectului?",
  );
  if (!shouldDelete) return;

  state.isSavingModeration = true;
  renderModerationPanel();

  try {
    await deleteDoc(getThreadRef());
    window.location.href = "/forum";
  } catch (error) {
    setModerationFeedback(
      describeError(error, "Nu am putut șterge subiectul."),
      "error",
    );
    state.isSavingModeration = false;
    renderModerationPanel();
  }
};

const applyPostingRestriction = async () => {
  if (!state.authUser || !state.isModerator || state.isSavingBan) return;
  if (!refs.banScope || !refs.banDuration || !refs.banReason) return;

  const targetUid = getBanTargetUid();
  const scope = toTrimmedString(refs.banScope.value);
  const durationDays = Number.parseInt(
    toTrimmedString(refs.banDuration.value),
    10,
  );
  const reason = toTrimmedString(refs.banReason.value);

  if (!targetUid) {
    setBanFeedback(
      "Selectează utilizatorul pe care vrei să-l restricționezi.",
      "error",
    );
    return;
  }

  if (!["threads", "comments", "both"].includes(scope)) {
    setBanFeedback("Tipul restricției este invalid.", "error");
    return;
  }

  if (!Number.isFinite(durationDays) || durationDays <= 0) {
    setBanFeedback("Durata trebuie să fie un număr pozitiv de zile.", "error");
    return;
  }

  const until = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

  const payload = {
    updatedAt: serverTimestamp(),
    updatedByUid: state.authUser.uid,
    isBanned: false,
  };

  if (scope === "threads" || scope === "both") {
    payload.threadRestrictedUntil = until;
  } else {
    payload.threadRestrictedUntil = deleteField();
  }

  if (scope === "comments" || scope === "both") {
    payload.commentRestrictedUntil = until;
  } else {
    payload.commentRestrictedUntil = deleteField();
  }

  if (reason) {
    payload.reason = reason;
  } else {
    payload.reason = deleteField();
  }

  state.isSavingBan = true;
  renderModerationPanel();

  try {
    await setDoc(doc(db, USER_ROLES_COLLECTION, targetUid), payload, {
      merge: true,
    });

    setBanFeedback("Restricția de publicare a fost aplicată.", "success");
  } catch (error) {
    setBanFeedback(
      describeError(error, "Nu am putut aplica restricția."),
      "error",
    );
  } finally {
    state.isSavingBan = false;
    renderModerationPanel();
  }
};

const clearPostingRestriction = async () => {
  if (!state.authUser || !state.isModerator || state.isSavingBan) return;
  const targetUid = getBanTargetUid();
  if (!targetUid) {
    setBanFeedback(
      "Selectează utilizatorul pentru care vrei să elimini restricțiile.",
      "error",
    );
    return;
  }

  state.isSavingBan = true;
  renderModerationPanel();

  try {
    await setDoc(
      doc(db, USER_ROLES_COLLECTION, targetUid),
      {
        isBanned: false,
        threadRestrictedUntil: deleteField(),
        commentRestrictedUntil: deleteField(),
        threadCooldownUntil: deleteField(),
        commentCooldownUntil: deleteField(),
        reason: deleteField(),
        updatedAt: serverTimestamp(),
        updatedByUid: state.authUser.uid,
      },
      { merge: true },
    );

    setBanFeedback("Restricțiile de publicare au fost eliminate.", "success");
  } catch (error) {
    setBanFeedback(
      describeError(error, "Nu am putut elimina restricțiile."),
      "error",
    );
  } finally {
    state.isSavingBan = false;
    renderModerationPanel();
  }
};

const toggleReplyVisibility = async (replyId) => {
  const reply = state.replies.find((item) => item.id === replyId);
  if (!reply) return;

  if (!canToggleReplyModeration(reply)) {
    setReplyFeedback("Nu ai permisiunea de a modera acest răspuns.", "error");
    return;
  }

  const nextStatus = reply.moderationStatus === "hidden" ? "visible" : "hidden";

  try {
    await updateDoc(
      doc(
        db,
        THREADS_COLLECTION,
        state.thread.id,
        THREAD_REPLIES_COLLECTION,
        replyId,
      ),
      {
        moderationStatus: nextStatus,
        updatedAt: serverTimestamp(),
      },
    );

    setReplyFeedback(
      nextStatus === "visible" ?
        "Răspunsul este vizibil."
      : "Răspunsul a fost ascuns.",
      "success",
    );
    await loadReplies({ reset: true });
  } catch (error) {
    setReplyFeedback(
      describeError(error, "Nu am putut actualiza statusul răspunsului."),
      "error",
    );
  }
};

const setBanTargetUid = (uid) => {
  const normalizedUid = toTrimmedString(uid);
  if (!normalizedUid) return;

  if (refs.banTargetUser) {
    const hasOption = [...refs.banTargetUser.options].some(
      (option) => option.value === normalizedUid,
    );
    refs.banTargetUser.value = hasOption ? normalizedUid : "";
    if (refs.banTargetUid) {
      refs.banTargetUid.value = hasOption ? "" : normalizedUid;
    }
  } else if (refs.banTargetUid) {
    refs.banTargetUid.value = normalizedUid;
  }

  renderBanTargetSummary();
  if (refs.threadToolsDetails) refs.threadToolsDetails.open = true;
  if (refs.banTargetUser) {
    refs.banTargetUser.focus();
    return;
  }
  refs.banTargetUid?.focus();
};

const handleRepliesListClick = async (event) => {
  const actionTrigger = event.target.closest("[data-action]");
  if (!actionTrigger) return;

  const action = actionTrigger.getAttribute("data-action") || "";
  const replyId = toTrimmedString(actionTrigger.getAttribute("data-reply-id"));

  if (action === "start-edit") {
    if (!replyId) return;
    const reply = state.replies.find((item) => item.id === replyId);
    if (!reply || !canEditReply(reply)) return;

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
    if (!replyId) return;
    await deleteReply(replyId);
    return;
  }

  if (action === "toggle-reply-visibility") {
    if (!replyId) return;
    await toggleReplyVisibility(replyId);
    return;
  }

  if (action === "ban-reply-author") {
    const authorUid = toTrimmedString(
      actionTrigger.getAttribute("data-reply-author-uid"),
    );
    if (!authorUid) return;
    setBanTargetUid(authorUid);
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

  refs.replyComposeTrigger?.addEventListener("click", () => {
    openReplyComposer();
  });

  refs.replyCancelBtn?.addEventListener("click", () => {
    setReplyFeedback("");
    collapseReplyComposer({ clearDraft: true });
  });

  refs.replyForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitNewReply();
  });

  refs.replyInput?.addEventListener("input", () => {
    renderReplyCharacterCounter();
    autoResizeReplyInput();
  });

  refs.replyInput?.addEventListener("focus", () => {
    autoResizeReplyInput();
  });

  refs.replyInput?.addEventListener("blur", () => {
    autoResizeReplyInput();
  });

  refs.repliesSortSelect?.addEventListener("change", async () => {
    const nextSort =
      refs.repliesSortSelect?.value === "oldest" ? "oldest" : "newest";
    if (nextSort === state.repliesSort) return;
    state.repliesSort = nextSort;
    state.editingReplyId = "";
    state.editingReplyValue = "";
    renderReplies();
    await loadReplies({ reset: true });
  });
  bindSelectShell(
    refs.repliesSortSelect?.closest(".forum-select-shell"),
    refs.repliesSortSelect,
  );

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

  refs.ownerForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitOwnerThreadEdit();
  });

  refs.modDelete?.addEventListener("click", async () => {
    await deleteThreadWithModeration();
  });

  refs.banForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await applyPostingRestriction();
  });

  refs.banUseThreadAuthor?.addEventListener("click", () => {
    setBanTargetUid(state.thread?.authorUid || "");
  });

  refs.banTargetUser?.addEventListener("change", () => {
    const selectedUid = toTrimmedString(refs.banTargetUser?.value);
    if (selectedUid && refs.banTargetUid) {
      refs.banTargetUid.value = "";
    }
    renderBanTargetSummary();
  });

  refs.banTargetUid?.addEventListener("input", () => {
    const manualUid = toTrimmedString(refs.banTargetUid?.value);
    if (refs.banTargetUser) {
      const hasOption = [...refs.banTargetUser.options].some(
        (option) => option.value === manualUid,
      );
      refs.banTargetUser.value = hasOption ? manualUid : "";
    }
    renderBanTargetSummary();
  });

  refs.banClear?.addEventListener("click", async () => {
    await clearPostingRestriction();
  });

  window.addEventListener("scroll", updateBackToTopVisibility, {
    passive: true,
  });
  refs.backToTopBtn?.addEventListener("click", onBackToTopClick);
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
  setOwnerFeedback("");
  setModerationFeedback("");
  setBanFeedback("");

  await loadReplies({ reset: true });
};

const init = async () => {
  state.routeThreadId = parseThreadRoute().resolvedThreadId;
  if (refs.repliesSortSelect?.value === "oldest") {
    state.repliesSort = "oldest";
  }

  bindEvents();
  updateBackToTopVisibility();
  window.addEventListener("pagehide", () => {
    clearBackToTopHideTimeout();
  });

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
