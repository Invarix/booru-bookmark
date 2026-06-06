// Booru Bookmark -- content.js

(function () {
  "use strict";

  // ── Booru detection ────────────────────────────────────────────────────────
  //
  // Only signals specific to known booru software are checked.
  // Generic attributes like data-id or class names like .thumbnail are
  // deliberately excluded -- they appear on too many non-booru sites.

  function looksLikeBooru() {
    // 1. <meta name="application-name"> set by Danbooru and its forks
    const appName = document.querySelector('meta[name="application-name"]')
                             ?.content?.toLowerCase() || "";
    if (appName && /danbooru|booru|shimmie|gelbooru|moebooru|szurubooru|philomena/.test(appName))
      return true;

    // 2. <meta name="generator"> set by Shimmie2 and some other engines
    const generator = document.querySelector('meta[name="generator"]')
                               ?.content?.toLowerCase() || "";
    if (generator && /shimmie|danbooru|booru/.test(generator))
      return true;

    // 3. Danbooru body class: every Danbooru controller adds c-{name} to <body>
    //    c-posts is specific to the posts listing page
    if (document.body?.classList?.contains("c-posts")) return true;

    // 4. Shimmie2-specific elements
    if (document.querySelector(".shm-thumb, [data-post-id], #shm-tag-list"))
      return true;

    // 5. Gelbooru/Moebooru: <span class="thumb" id="sNNNN"> + ?page=post in URL
    if (location.search.includes("page=post") &&
        document.querySelector('span.thumb[id^="s"]')) return true;

    // 6. Old Shimmie2 themes (e.g. Pixboard): bare <a href="/post/view/N"><img>
    for (const a of document.querySelectorAll("a[href] > img")) {
      if (/\/post\/(view|list)\/\d+/i.test(a.parentElement.getAttribute("href")))
        return true;
    }

    return false;
  }

  if (!looksLikeBooru()) return;

  // Tell the background this tab is a booru so it shows the context menus.
  function signalBooru() {
    chrome.runtime.sendMessage({ type: "IS_BOORU" }).catch(() => {});
  }
  signalBooru();

  const BOOKMARK_CLASS = "booru-bookmark-active";
  const PULSE_CLASS    = "booru-bookmark-pulse";
  const BM_ATTR        = "data-booru-bm-id";

  // Storage key is scoped to the site origin only -- NOT the URL path or query.
  //
  // This is the critical design decision that makes bookmarks persistent:
  // Booru sites use JavaScript navigation (pushState) to paginate and filter,
  // which changes location.pathname and location.search without reloading the
  // page.  Keying by the full URL means a bookmark saved on /posts is lost the
  // moment e621 pushes /posts?page=2 into the URL bar.
  //
  // Keying by origin means all pages of a site share one bookmark record.
  // The post ID (not the URL) is what identifies a specific bookmark.
  const STORAGE_KEY = "booru_bm_" + location.origin;

  let _lastTarget = null;  // set by contextmenu listener, read by GET_TARGET
  let _mutingObs  = false; // true while we are mutating the DOM ourselves

  // ── Storage ────────────────────────────────────────────────────────────────
  // Bookmarks are stored as a plain object: { postId: true, ... }
  // Keyed by origin so they survive any URL change within the same site.

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
  //
  // Walk UP from any clicked element to find the post card container.
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
    // Bare-img fallback for old Shimmie2 themes
    const img = startEl.tagName?.toLowerCase() === "img"
      ? startEl : startEl.closest?.("img");
    return img || startEl.parentElement || startEl;
  }

  // Returns a stable namespaced string ID for a container element.
  // The prefix prevents collisions between different ID sources.
  function getPostId(container) {
    if (container.dataset?.postId) return "pid:" + container.dataset.postId;
    if (container.dataset?.id)     return "did:" + container.dataset.id;

    // Gelbooru: <span id="s12345"> or <a id="p12345"> -- use numeric part only
    if (container.id) {
      const m = container.id.match(/^[a-z]?(\d+)$/i);
      if (m) return "eid:" + m[1];
    }

    // Bare <img>: use the enclosing link href (stable path like /post/view/659)
    if (container.tagName?.toLowerCase() === "img") {
      const link = container.closest("a[href]");
      if (link) return "href:" + link.getAttribute("href");
      const src = container.src || container.currentSrc;
      if (src && !src.startsWith("data:")) return "src:" + src;
    }

    // Generic: href of first link inside the container
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

  // ── Lookup helpers ─────────────────────────────────────────────────────────

  function findContainerByPostId(postId) {
    // Fastest: our own BM_ATTR stamp on the exact node
    const stamped = document.querySelector(`[${BM_ATTR}="${CSS.escape(postId)}"]`);
    if (stamped) return { container: stamped, id: postId };

    // Scan recognised wrapper elements
    for (const el of document.querySelectorAll(
      "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb"
    )) {
      if (getPostId(el) === postId) return { container: el, id: postId };
    }

    // Bare-img fallback: only imgs with no recognised wrapper above them
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

      // Wrappers first (all booru engines with explicit containers)
      for (const el of document.querySelectorAll(
        "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb"
      )) {
        const id = getPostId(el);
        if (id && stored[id] && !el.classList.contains(BOOKMARK_CLASS))
          applyBookmark(el, id);
      }

      // Bare-img fallback
      for (const img of document.querySelectorAll("img")) {
        if (img.closest("article, [data-post-id], [data-id], span.thumb, li.thumb")) continue;
        const id = getPostId(img);
        if (id && stored[id] && !img.classList.contains(BOOKMARK_CLASS))
          applyBookmark(img, id);
      }
    } finally {
      _restoreRunning = false;
    }
  }

  runRestore();

  new MutationObserver(scheduleRestore).observe(document.body, {
    childList: true, subtree: true,
  });

  // Heartbeat: re-signal and re-restore every 10 seconds.
  // Covers PC wake from sleep and Chrome tab unfreezing, where no DOM or
  // focus event fires but the tab is visually active.
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

  // ── Toast ──────────────────────────────────────────────────────────────────

  function showToast(msg, type = "info") {
    let toast = document.getElementById("booru-bookmark-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "booru-bookmark-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className   = "booru-bookmark-toast-show " + type;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.className = ""; }, 2400);
  }

  // ── Message listener ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    if (msg.type === "GET_TARGET") {
      sendResponse(_lastTarget);
      return;
    }

    if (msg.type === "CLEAR_ALL") {
      document.querySelectorAll("." + BOOKMARK_CLASS).forEach(removeBookmark);
      saveBookmarks({});
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
        stored[id] = true;
        return saveBookmarks(stored);
      }).then(() => {
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
        showToast("Bookmark removed", "info");
        sendResponse({ ok: true });
      });
      return true;
    }
  });

})();
