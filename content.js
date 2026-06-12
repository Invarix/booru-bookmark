// Booru Bookmark -- content.js

(function () {
  "use strict";

  // ── Booru detection ────────────────────────────────────────────────────────
  // Only software-specific signals. Generic attributes like data-id or class
  // names like .thumbnail are excluded -- they appear on too many other sites.

  function looksLikeBooru() {
    const appName = document.querySelector('meta[name="application-name"]')
                             ?.content?.toLowerCase() || "";
    if (appName && /danbooru|booru|shimmie|gelbooru|moebooru|szurubooru|philomena/.test(appName))
      return true;
    const generator = document.querySelector('meta[name="generator"]')
                               ?.content?.toLowerCase() || "";
    if (generator && /shimmie|danbooru|booru/.test(generator)) return true;
    // [booru] / [booru] / [booru]: body gets class "c-posts" on the posts listing page
    if (document.body?.classList?.contains("c-posts")) return true;
    // [booru] specific elements
    if (document.querySelector(".shm-thumb, [data-post-id], #shm-tag-list")) return true;
    // [booru] / [booru]
    if (location.search.includes("page=post") &&
        document.querySelector('span.thumb[id^="s"]')) return true;
    // Old [booru] themes (e.g. [booru]): bare <a href="/post/view/N"><img>
    for (const a of document.querySelectorAll("a[href] > img"))
      if (/\/post\/(view|list)\/\d+/i.test(a.parentElement.getAttribute("href")))
        return true;
    return false;
  }

  if (!looksLikeBooru()) return;

  // Tell the background this tab is a booru so it shows the context menus.
  // Called immediately and re-called after each navigation and on focus,
  // so the background service worker always has current tab state even after
  // being recycled.
  function signalBooru() {
    chrome.runtime.sendMessage({ type: "IS_BOORU" }).catch(() => {});
  }
  signalBooru();

  const BOOKMARK_CLASS = "booru-bookmark-active";
  const PULSE_CLASS    = "booru-bookmark-pulse";
  const BM_ATTR        = "data-booru-bm-id";
  // Keyed by origin only -- survives SPA URL changes and cross-page navigation
  const STORAGE_KEY    = "booru_bm_" + location.origin;

  let _lastTarget    = null;  // set by contextmenu listener, read by GET_TARGET
  let _mutingObs     = false; // true while we mutate the DOM ourselves
  let _jumpIndex     = -1;    // current position in the global bookmark list
  let _pendingJumpId = null;  // post ID to scroll to as soon as it appears in DOM

  // ── Storage ────────────────────────────────────────────────────────────────
  // Format: { "did:12345": "https://[booru].net/posts?page=2", ... }
  // Value is location.href at bookmark time for cross-page navigation.

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
  // Walk up from any element to find the post card container.
  //   [booru] / [booru] / [booru]  ->  <article data-id="12345">
  //   [booru] ([booru])           ->  <li class="shm-thumb" data-post-id="12345">
  //   [booru]                    ->  <span class="thumb" id="s12345">
  //   Old [booru] ([booru])     ->  <img> (no wrapper)

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
      const applied = new Set();
      for (const el of document.querySelectorAll(
        "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb"
      )) {
        const id = getPostId(el);
        if (id && stored[id] && !el.classList.contains(BOOKMARK_CLASS) && !applied.has(id)) {
          applyBookmark(el, id);
          applied.add(id);
          checkPendingJump(el, id);
        }
      }
      for (const img of document.querySelectorAll("img")) {
        if (img.closest("article, [data-post-id], [data-id], span.thumb, li.thumb")) continue;
        const id = getPostId(img);
        if (id && stored[id] && !img.classList.contains(BOOKMARK_CLASS) && !applied.has(id)) {
          applyBookmark(img, id);
          applied.add(id);
          checkPendingJump(img, id);
        }
      }
    } finally {
      _restoreRunning = false;
    }
  }

  // ── Nav button (jump toast) ────────────────────────────────────────────────
  // Separate element appended to <html> (not <body>) so booru CSS that clips
  // body overflow never hides it.  Visible whenever any bookmark exists.

  function getJumpToast() {
    let el = document.getElementById("booru-bookmark-jump-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "booru-bookmark-jump-toast";
      document.documentElement.appendChild(el);
      el.addEventListener("click", () => jumpToBookmark());
    }
    return el;
  }

  function showJumpToast()             { getJumpToast().classList.add("visible"); }
  function hideJumpToast()             { document.getElementById("booru-bookmark-jump-toast")?.classList.remove("visible"); }
  function updateJumpToastLabel(count) { getJumpToast().textContent = `Navigate Bookmarks [${count}]`; }

  async function refreshJumpToast() {
    const stored = await loadBookmarks();
    const total  = Object.keys(stored).length;
    if (total === 0) { hideJumpToast(); return; }
    updateJumpToastLabel(total);
    showJumpToast();
  }

  // ── Pending jump ───────────────────────────────────────────────────────────
  // When navigating to a bookmark's page, arm _pendingJumpId with the target
  // post ID.  runRestore calls checkPendingJump after each applyBookmark, so
  // the scroll fires the instant the element appears -- no fixed timeout needed.

  function checkPendingJump(container, id) {
    if (!_pendingJumpId || id !== _pendingJumpId) return;
    _pendingJumpId = null;
    if (!isDeleted(container)) {
      scrollToBookmark(container);
    } else {
      highlightNearest(container);
    }
  }

  function maybeAutoJump() {
    if (!sessionStorage.getItem("booru_bm_autojump")) return;
    sessionStorage.removeItem("booru_bm_autojump");
    const savedIdx = sessionStorage.getItem("booru_bm_jumpindex");
    if (savedIdx !== null) {
      _jumpIndex = parseInt(savedIdx, 10);
      sessionStorage.removeItem("booru_bm_jumpindex");
    }
    loadBookmarks().then(stored => {
      const entries = Object.entries(stored);
      if (!entries.length) return;
      const idx = Math.max(0, Math.min(_jumpIndex, entries.length - 1));
      _pendingJumpId = entries[idx][0];
    });
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

  // ── Scroll helpers ─────────────────────────────────────────────────────────

  function scrollToBookmark(target) {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove(PULSE_CLASS);
    void target.offsetWidth;
    target.classList.add(PULSE_CLASS);
    target.addEventListener("animationend",
      () => target.classList.remove(PULSE_CLASS), { once: true });
  }

  function highlightNearest(deletedContainer) {
    const all = Array.from(document.querySelectorAll(
      "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb, a[href] > img"
    ));
    if (!all.length) return;
    let idx = all.indexOf(deletedContainer);
    if (idx === -1) {
      idx = all.findIndex(el =>
        el.compareDocumentPosition(deletedContainer) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (idx === -1) idx = all.length - 1;
    }
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

  async function jumpToBookmark() {
    const stored  = await loadBookmarks();
    const entries = Object.entries(stored);
    if (!entries.length) {
      showToast("No bookmarks saved for this site", "info");
      return;
    }

    _jumpIndex = (_jumpIndex + 1) % entries.length;
    sessionStorage.setItem("booru_bm_jumpindex", String(_jumpIndex));

    const [postId, pageUrl] = entries[_jumpIndex];

    // Check whether this bookmark lives on the current page
    let onThisPage = false;
    if (pageUrl && typeof pageUrl === "string") {
      try {
        const target  = new URL(pageUrl);
        const current = new URL(location.href);
        onThisPage = target.origin   === current.origin &&
                     target.pathname === current.pathname &&
                     target.search   === current.search;
      } catch (_) { onThisPage = true; }
    } else {
      onThisPage = true; // legacy entry
    }

    if (onThisPage) {
      const result = findContainerByPostId(postId);
      if (result && !isDeleted(result.container)) {
        scrollToBookmark(result.container);
      } else if (result) {
        highlightNearest(result.container);
      } else {
        showToast("Bookmark is loading...", "info");
      }
      return;
    }

    // Navigate to the page where this bookmark lives
    sessionStorage.setItem("booru_bm_autojump", "1");
    if (window.Turbo?.visit)        window.Turbo.visit(pageUrl);
    else if (window.Turbolinks?.visit) window.Turbolinks.visit(pageUrl);
    else                            location.href = pageUrl;
  }

  // ── Initialise ────────────────────────────────────────────────────────────

  runRestore().then(() => {
    refreshJumpToast();
    maybeAutoJump();
  });

  // MutationObserver: re-apply bookmarks when new thumbnails appear
  new MutationObserver(scheduleRestore).observe(document.body, {
    childList: true, subtree: true,
  });

  // Turbo Drive ([booru], [booru]): fires after every Turbo navigation.
  // [booru] does NOT use Turbo, but [booru] does, so we listen for both.
  document.addEventListener("turbo:load", () => {
    runRestore().then(() => { signalBooru(); refreshJumpToast(); maybeAutoJump(); });
  });
  document.addEventListener("turbolinks:load", () => {
    runRestore().then(() => { signalBooru(); refreshJumpToast(); maybeAutoJump(); });
  });

  // Heartbeat: keeps service worker tab state alive and re-applies borders
  // after PC wake from sleep or Chrome tab unfreeze.
  setInterval(() => { signalBooru(); scheduleRestore(); }, 10_000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { signalBooru(); scheduleRestore(); }
  });
  window.addEventListener("focus", () => { signalBooru(); scheduleRestore(); });
  window.addEventListener("popstate", () => {
    runRestore().then(() => { signalBooru(); refreshJumpToast(); maybeAutoJump(); });
  });

  // ── Context-menu capture ───────────────────────────────────────────────────

  document.addEventListener("contextmenu", (e) => {
    try {
      const r = resolveFromElement(e.target);
      _lastTarget = r.id ? { postId: r.id, srcUrl: r.srcUrl } : null;
    } catch (_) { _lastTarget = null; }
  }, true);

  // ── Regular toast ─────────────────────────────────────────────────────────

  function showToast(msg, type = "info") {
    let el = document.getElementById("booru-bookmark-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "booru-bookmark-toast";
      document.documentElement.appendChild(el);
    }
    el.textContent = msg;
    el.className   = "";
    void el.offsetWidth;
    el.className   = "booru-bookmark-toast-show " + type;
    clearTimeout(el._timer);
    el.onclick = null;
    el._timer  = setTimeout(() => { el.className = ""; }, 2400);
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
