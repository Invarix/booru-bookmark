// Booru Bookmark -- content.js

(function () {
  "use strict";

  // Booru detection -- only software-specific signals
  function looksLikeBooru() {
    const appName = document.querySelector('meta[name="application-name"]')
                             ?.content?.toLowerCase() || "";
    if (appName && /danbooru|booru|shimmie|gelbooru|moebooru|szurubooru|philomena/.test(appName))
      return true;
    const generator = document.querySelector('meta[name="generator"]')
                               ?.content?.toLowerCase() || "";
    if (generator && /shimmie|danbooru|booru/.test(generator)) return true;
    if (document.body?.classList?.contains("c-posts")) return true;
    if (document.querySelector(".shm-thumb, [data-post-id], #shm-tag-list")) return true;
    if (location.search.includes("page=post") &&
        document.querySelector('span.thumb[id^="s"]')) return true;
    for (const a of document.querySelectorAll("a[href] > img"))
      if (/\/post\/(view|list)\/\d+/i.test(a.parentElement.getAttribute("href"))) return true;
    return false;
  }

  if (!looksLikeBooru()) return;

  function signalBooru() {
    chrome.runtime.sendMessage({ type: "IS_BOORU" }).catch(() => {});
  }
  signalBooru();

  const BOOKMARK_CLASS = "booru-bookmark-active";
  const PULSE_CLASS    = "booru-bookmark-pulse";
  const BM_ATTR        = "data-booru-bm-id";
  const STORAGE_KEY    = "booru_bm_" + location.origin;

  let _lastTarget  = null;
  let _mutingObs   = false;
  // Global cycle index across all stored bookmarks for this site.
  // Persisted in sessionStorage so cross-page navigation remembers position.
  let _jumpIndex = parseInt(sessionStorage.getItem("booru_bm_jumpindex") ?? "-1", 10);

  // ── Storage ────────────────────────────────────────────────────────────────
  // { postId: pageUrl }  keyed by site origin.
  // pageUrl is location.href at bookmark time.

  function loadBookmarks() {
    return new Promise(res =>
      chrome.storage.local.get(STORAGE_KEY, d => res(d[STORAGE_KEY] || {}))
    );
  }
  function saveBookmarks(obj) {
    return new Promise(res =>
      chrome.storage.local.set({ [STORAGE_KEY]: obj }, res)
    );
  }

  // ── Container & ID resolution ──────────────────────────────────────────────

  function getBestContainer(startEl) {
    let node = startEl;
    for (let i = 0; i < 12; i++) {
      if (!node || node === document.body) break;
      if (node.hasAttribute(BM_ATTR)) return node;
      const tag = node.tagName?.toLowerCase();
      const cls = node.classList;
      const ds  = node.dataset;
      if (
        tag === "article"                          ||
        ds?.postId                                 ||
        ds?.id                                     ||
        (tag === "span" && cls?.contains("thumb")) ||
        cls?.contains("shm-thumb")                ||
        cls?.contains("post-preview")             ||
        cls?.contains("image-container")          ||
        cls?.contains("preview-container")
      ) return node;
      node = node.parentElement;
    }
    const img = startEl.tagName?.toLowerCase() === "img"
      ? startEl : startEl.closest?.("img");
    return img || startEl.parentElement || startEl;
  }

  function getPostId(container) {
    if (container.dataset?.postId) return "pid:" + container.dataset.postId;
    if (container.dataset?.id)     return "did:" + container.dataset.id;
    if (container.id) {
      const m = container.id.match(/^[a-z]?(\d+)$/i);
      if (m) return "eid:" + m[1];
    }
    if (container.tagName?.toLowerCase() === "img") {
      const link = container.closest("a[href]");
      if (link) return "href:" + link.getAttribute("href");
      const src = container.src || container.currentSrc;
      if (src && !src.startsWith("data:")) return "src:" + src;
    }
    const href = container.querySelector("a[href]")?.getAttribute("href");
    if (href) return "href:" + href;
    return null;
  }

  function resolveFromElement(el) {
    const container = getBestContainer(el);
    const id        = getPostId(container);
    const imgEl     = container.tagName?.toLowerCase() === "img"
                    ? container : container.querySelector("img");
    const srcUrl    = imgEl?.src && !imgEl.src.startsWith("data:")
                    ? imgEl.src : (imgEl?.currentSrc || null);
    return { container, id, srcUrl };
  }

  function findContainerByPostId(postId) {
    const stamped = document.querySelector(`[${BM_ATTR}="${CSS.escape(postId)}"]`);
    if (stamped) return { container: stamped, id: postId };
    for (const el of document.querySelectorAll(
      "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb"
    )) {
      if (getPostId(el) === postId) return { container: el, id: postId };
    }
    for (const img of document.querySelectorAll("img")) {
      if (img.closest("article, [data-post-id], [data-id], span.thumb, li.thumb")) continue;
      if (getPostId(img) === postId) return { container: img, id: postId };
    }
    return null;
  }

  function findContainerBySrc(srcUrl) {
    for (const img of document.querySelectorAll("img")) {
      const srcs = new Set([img.src, img.currentSrc, img.dataset?.src]);
      const pic  = img.closest("picture");
      if (pic) {
        pic.querySelectorAll("source").forEach(s => {
          const first = (s.srcset || s.dataset?.srcset || "").split(/[\s,]+/)[0];
          if (first) srcs.add(first);
        });
      }
      if (srcs.has(srcUrl)) {
        const r = resolveFromElement(img);
        return r.id ? r : null;
      }
    }
    return null;
  }

  // ── Apply / remove bookmark visuals ───────────────────────────────────────

  function applyBookmark(container, id) {
    _mutingObs = true;
    try {
      container.setAttribute(BM_ATTR, id);
      container.classList.add(BOOKMARK_CLASS);
      container.classList.remove(PULSE_CLASS);
      void container.offsetWidth;
      container.classList.add(PULSE_CLASS);
      container.addEventListener("animationend",
        () => container.classList.remove(PULSE_CLASS), { once: true });
      const tag = container.tagName?.toLowerCase();
      if (tag !== "img" && !container.querySelector(".booru-bookmark-label")) {
        const label       = document.createElement("span");
        label.className   = "booru-bookmark-label";
        label.textContent = "📌";
        label.title       = "Bookmarked -- right-click to remove";
        container.appendChild(label);
      }
      if (tag !== "img" && getComputedStyle(container).position === "static")
        container.style.position = "relative";
    } finally {
      _mutingObs = false;
    }
  }

  function removeBookmark(container) {
    _mutingObs = true;
    try {
      container.classList.remove(BOOKMARK_CLASS, PULSE_CLASS);
      container.removeAttribute(BM_ATTR);
      container.querySelector(".booru-bookmark-label")?.remove();
      if (container.style.position === "relative") container.style.position = "";
    } finally {
      _mutingObs = false;
    }
  }

  // ── Restore bookmarks ──────────────────────────────────────────────────────

  let _restoreTimer   = null;
  let _restoreRunning = false;

  function scheduleRestore() {
    if (_mutingObs) return;
    clearTimeout(_restoreTimer);
    _restoreTimer = setTimeout(runRestore, 200);
  }

  async function runRestore() {
    if (_restoreRunning) return;
    _restoreRunning = true;
    try {
      const stored = await loadBookmarks();
      if (!Object.keys(stored).length) return;
      // Track which IDs we've already applied this pass so we never
      // stamp two DOM elements with the same post ID (e.g. an <article>
      // and a descendant element that also matches the wrapper selector).
      const applied = new Set();
      for (const el of document.querySelectorAll(
        "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb"
      )) {
        const id = getPostId(el);
        if (id && stored[id] && !el.classList.contains(BOOKMARK_CLASS) && !applied.has(id)) {
          applyBookmark(el, id);
          applied.add(id);
        }
      }
      // Bare-img fallback: only for imgs with no recognised wrapper ancestor
      for (const img of document.querySelectorAll("img")) {
        if (img.closest("article, [data-post-id], [data-id], span.thumb, li.thumb")) continue;
        const id = getPostId(img);
        if (id && stored[id] && !img.classList.contains(BOOKMARK_CLASS) && !applied.has(id)) {
          applyBookmark(img, id);
          applied.add(id);
        }
      }
    } finally {
      _restoreRunning = false;
    }
  }

  // ── Jump toast ─────────────────────────────────────────────────────────────
  // Separate element appended to <html> (not <body>) so booru CSS that sets
  // overflow/transform/position on body doesn't clip or hide it.
  // Visible as long as any bookmarks exist for this site.

  function getJumpToast() {
    let el = document.getElementById("booru-bookmark-jump-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "booru-bookmark-jump-toast";
      // Append to <html>, not <body> -- avoids body overflow/stacking clipping
      document.documentElement.appendChild(el);
      el.addEventListener("click", () => jumpToBookmark());
    }
    return el;
  }

  function showJumpToast() {
    getJumpToast().classList.add("visible");
  }

  function updateJumpToastLabel(count) {
    getJumpToast().textContent = `Navigate Bookmarks [${count}]`;
  }

  function hideJumpToast() {
    document.getElementById("booru-bookmark-jump-toast")?.classList.remove("visible");
  }

  // Show the nav button if any bookmarks exist for this site.
  // Always uses the storage count -- the single source of truth.
  // DOM element count is unreliable (duplicates, not-yet-rendered, etc.)
  async function refreshJumpToast() {
    const stored = await loadBookmarks();
    const total  = Object.keys(stored).length;
    if (total === 0) {
      hideJumpToast();
      return;
    }
    updateJumpToastLabel(total);
    showJumpToast();
  }

  // ── Auto-jump after cross-page navigation ──────────────────────────────────
  // When jumpToBookmark navigates to a different page, sessionStorage carries
  // a flag telling the new page to scroll to the bookmark once it's in the DOM.
  // We retry up to 8 times to handle slow async thumbnail rendering.
  // We never navigate again from here -- that's what caused the redirect loop.

  async function maybeAutoJump() {
    if (!sessionStorage.getItem("booru_bm_autojump")) return;
    sessionStorage.removeItem("booru_bm_autojump");

    // Restore _jumpIndex from sessionStorage -- the in-memory variable resets
    // to -1 on every page load, so the saved index must be explicitly restored.
    const savedIdx = sessionStorage.getItem("booru_bm_jumpindex");
    if (savedIdx !== null) {
      _jumpIndex = parseInt(savedIdx, 10);
      sessionStorage.removeItem("booru_bm_jumpindex");
    }

    const stored  = await loadBookmarks();
    const entries = Object.entries(stored);
    if (!entries.length) return;

    // Clamp index in case bookmarks were removed while navigating
    const idx = Math.max(0, Math.min(_jumpIndex, entries.length - 1));
    const [postId] = entries[idx];

    let attempts = 0;
    function tryScroll() {
      attempts++;
      const result = findContainerByPostId(postId);

      if (result && !isDeleted(result.container)) {
        scrollToBookmark(result.container);
        return;
      }

      if (result && isDeleted(result.container)) {
        highlightNearest(result.container);
        return;
      }

      if (attempts < 8) {
        setTimeout(tryScroll, 350);
      }
      // Give up silently -- nav button still visible for manual retry
    }

    setTimeout(tryScroll, 300);
  }

  // ── Deleted-post detection ─────────────────────────────────────────────────

  function isDeleted(container) {
    if (container.classList.contains("deleted")) return true;
    const flags = container.dataset?.flags || "";
    if (flags.includes("deleted")) return true;
    const img = container.tagName?.toLowerCase() === "img"
      ? container : container.querySelector("img");
    if (img && img.complete && img.naturalWidth === 0 &&
        img.src && !img.src.startsWith("data:")) return true;
    return false;
  }

  // ── Scroll helper ──────────────────────────────────────────────────────────

  function scrollToBookmark(target) {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove(PULSE_CLASS);
    void target.offsetWidth;
    target.classList.add(PULSE_CLASS);
    target.addEventListener("animationend",
      () => target.classList.remove(PULSE_CLASS), { once: true });
    // Nav button count stays as-is (refreshJumpToast owns it)
  }

  // ── Nearest-thumbnail highlight ────────────────────────────────────────────
  // When a bookmarked post is deleted, find the thumbnail immediately after it
  // in DOM order (or before it if it was the last one) and pulse it so the
  // user knows roughly where they left off.

  function highlightNearest(deletedContainer) {
    // Collect all thumbnail containers on the page in DOM order
    const all = Array.from(document.querySelectorAll(
      "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb, a[href] > img"
    ));

    if (!all.length) return;

    // Find the index of the deleted container within all thumbnails
    let idx = all.indexOf(deletedContainer);
    if (idx === -1) {
      // Deleted container not in the list -- find the closest by DOM position
      idx = all.findIndex(el =>
        el.compareDocumentPosition(deletedContainer) &
        Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (idx === -1) idx = all.length - 1;
    }

    // Try the next thumbnail; fall back to previous if at the end
    const candidate = all[idx + 1] || all[idx - 1] || all[0];
    if (!candidate) return;

    candidate.scrollIntoView({ behavior: "smooth", block: "center" });
    candidate.classList.remove(PULSE_CLASS);
    void candidate.offsetWidth;
    candidate.classList.add(PULSE_CLASS);
    candidate.addEventListener("animationend",
      () => candidate.classList.remove(PULSE_CLASS), { once: true });
  }

  // ── Jump to bookmark ───────────────────────────────────────────────────────
  // Cycles through ALL stored bookmarks for this site in insertion order,
  // across pages.  _jumpIndex is the position in the global stored list.
  //
  // If the next bookmark is on the current page: scroll to it.
  // If it is on a different page: navigate there (autojump flag carries us).

  async function jumpToBookmark() {
    const stored  = await loadBookmarks();
    const entries = Object.entries(stored); // [ [postId, pageUrl], ... ]

    if (!entries.length) {
      showToast("No bookmarks saved for this site", "info");
      return;
    }

    // Advance global index, wrapping around the full list
    _jumpIndex = (_jumpIndex + 1) % entries.length;
    sessionStorage.setItem("booru_bm_jumpindex", String(_jumpIndex));

    const [postId, pageUrl] = entries[_jumpIndex];

    // Check if this bookmark's page matches the current page
    let onThisPage = false;
    if (pageUrl && typeof pageUrl === "string") {
      const target  = new URL(pageUrl);
      const current = new URL(location.href);
      onThisPage = target.origin   === current.origin &&
                   target.pathname === current.pathname &&
                   target.search   === current.search;
    } else {
      // Legacy entry (stored as `true` before schema upgrade) -- assume current page
      onThisPage = true;
    }

    if (onThisPage) {
      // Try to find and scroll to the bookmark in the current DOM
      const result = findContainerByPostId(postId);
      if (result && !isDeleted(result.container)) {
        scrollToBookmark(result.container);
        return;
      }
      // On the right page but element not found or deleted -- highlight nearest
      if (result) {
        highlightNearest(result.container);
      } else {
        // DOM doesn't have it yet (async render) -- pulse a generic message
        showToast("Bookmark loading...", "info");
      }
      return;
    }

    // Bookmark is on a different page -- navigate there.
    // The autojump flag tells the destination to scroll to it after restore.
    sessionStorage.setItem("booru_bm_autojump", "1");

    // Use Turbo.visit if available
    // This ensures turbo:load fires on the destination, triggering onNavigate
    // and then maybeAutoJump.  Without this, Turbo intercepts location.href
    // assignments and may not fire turbo:load reliably.
    if (window.Turbo?.visit) {
      window.Turbo.visit(pageUrl);
    } else if (window.Turbolinks?.visit) {
      window.Turbolinks.visit(pageUrl);
    } else {
      location.href = pageUrl;
    }
  }

  // ── Initialise ────────────────────────────────────────────────────────────

  // onNavigate is called after every navigation -- real page load, Turbo Drive
  // swap, or browser back/forward.  It re-runs restore, refreshes the jump
  // toast count, and fires the autojump if the flag is set.
  function onNavigate() {
    // Re-observe body in case Turbo replaced it entirely
    observeBody();
    runRestore().then(() => {
      signalBooru();
      refreshJumpToast();
      maybeAutoJump();
    });
  }

  // Initial load
  onNavigate();

  // Turbo Drive fires turbo:load after every
  // navigation -- this is the equivalent of DOMContentLoaded for Turbo pages.
  // Without this the content script never re-runs after Turbo swaps the body.
  document.addEventListener("turbo:load", onNavigate);

  // Turbolinks (older Danbooru forks) uses a different event name
  document.addEventListener("turbolinks:load", onNavigate);

  // Browser back/forward on any site
  window.addEventListener("popstate", onNavigate);

  // MutationObserver for dynamic content (infinite scroll, lazy load etc.)
  let _bodyObserver = null;
  function observeBody() {
    if (_bodyObserver) _bodyObserver.disconnect();
    _bodyObserver = new MutationObserver(scheduleRestore);
    _bodyObserver.observe(document.body, { childList: true, subtree: true });
  }
  observeBody();

  setInterval(() => { signalBooru(); scheduleRestore(); }, 10_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { signalBooru(); scheduleRestore(); }
  });
  window.addEventListener("focus", () => { signalBooru(); scheduleRestore(); });

  // ── Context-menu capture ───────────────────────────────────────────────────

  document.addEventListener("contextmenu", (e) => {
    try {
      const r = resolveFromElement(e.target);
      _lastTarget = r.id ? { postId: r.id, srcUrl: r.srcUrl } : null;
    } catch (_) { _lastTarget = null; }
  }, true);

  // ── Regular toast ─────────────────────────────────────────────────────────

  function showToast(msg, type = "info") {
    let toast = document.getElementById("booru-bookmark-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "booru-bookmark-toast";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = "";
    void toast.offsetWidth;
    toast.className = "booru-bookmark-toast-show " + type;
    clearTimeout(toast._timer);
    toast.onclick = null;
    toast._timer = setTimeout(() => { toast.className = ""; }, 2400);
  }

  // ── Message listener ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    if (msg.type === "GET_TARGET") {
      sendResponse(_lastTarget);
      return;
    }

    if (msg.type === "JUMP_TO_BOOKMARK") {
      jumpToBookmark();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "CLEAR_ALL") {
      document.querySelectorAll("." + BOOKMARK_CLASS).forEach(removeBookmark);
      saveBookmarks({}).then(() => refreshJumpToast());
      showToast("All bookmarks cleared", "warn");
      sendResponse({ ok: true });
      return;
    }

    let resolved = null;
    if (msg.postId) resolved = findContainerByPostId(msg.postId);
    if (!resolved && msg.srcUrl) resolved = findContainerBySrc(msg.srcUrl);

    if (!resolved) {
      showToast("Could not identify image -- try again", "warn");
      sendResponse({ ok: false });
      return;
    }

    const { container, id } = resolved;

    if (msg.type === "BOOKMARK") {
      applyBookmark(container, id);
      loadBookmarks().then(stored => {
        stored[id] = location.href;
        return saveBookmarks(stored);
      }).then(() => {
        refreshJumpToast();
        showToast("Bookmarked!", "success");
        sendResponse({ ok: true });
      });
      return true;

    } else if (msg.type === "UNBOOKMARK") {
      removeBookmark(container);
      loadBookmarks().then(stored => {
        delete stored[id];
        return saveBookmarks(stored);
      }).then(() => {
        refreshJumpToast();
        showToast("Bookmark removed", "info");
        sendResponse({ ok: true });
      });
      return true;
    }
  });

})();
