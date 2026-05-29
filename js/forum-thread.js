import { db } from "./firebase-config.js";
import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

const THREADS_COLLECTION = "forumThreads";
const CANONICAL_PENDING_ATTR = "data-thread-canonical-pending";

const toTrimmedString = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

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

const normalizePath = (value) => String(value || "").replace(/\/+$/, "");

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
  const resolvedThreadId = toTrimmedString(pathThreadId || queryThreadId);

  return {
    resolvedThreadId,
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

const updatePlaceholderId = (threadId) => {
  const target = document.getElementById("placeholder-thread-id");
  if (!target || !threadId) return;
  target.textContent = `ID subiect: ${threadId}`;
};

const runWhenDomReady = (callback) => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", callback, { once: true });
    return;
  }
  callback();
};

const canonicalizeThreadUrl = async () => {
  const { resolvedThreadId } = parseThreadRoute();
  runWhenDomReady(() => {
    updatePlaceholderId(resolvedThreadId || "necunoscut");
  });

  if (!resolvedThreadId) {
    revealThreadPage();
    return;
  }

  try {
    const snapshot = await getDoc(
      doc(db, THREADS_COLLECTION, resolvedThreadId),
    );
    if (!snapshot.exists()) {
      revealThreadPage();
      return;
    }

    const title = toTrimmedString(snapshot.data()?.title) || "Subiect";
    const canonicalPath = buildCanonicalThreadPath(resolvedThreadId, title);
    const currentPath = normalizePath(window.location.pathname);

    if (normalizePath(canonicalPath) === currentPath) {
      revealThreadPage();
      return;
    }

    const canonicalUrl = `${canonicalPath}${window.location.hash || ""}`;
    window.history.replaceState(window.history.state, "", canonicalUrl);
    revealThreadPage();
  } catch {
    revealThreadPage();
    // Keep rendering even when the thread cannot be fetched.
  }
};

canonicalizeThreadUrl();
