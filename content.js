// Booru Bookmark -- content.js

(function () {
  "use strict";

  // Guard: if the extension context is invalidated (e.g. after an update),
  // chrome.runtime is undefined or disconnected. Bail out silently.
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

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
      if (/\/post\/(view|list)\/\d+/i.test(a.parentElement.getAttribute("href")))
        return true;
    return false;
  }

  if (!looksLikeBooru()) return;

  function signalBooru() {
    try {
      chrome.runtime.sendMessage({ type: "IS_BOORU" }).catch(() => {});
    } catch (_) {}
  }
  signalBooru();

  const BOOKMARK_CLASS = "booru-bookmark-active";
  const PULSE_CLASS    = "booru-bookmark-pulse";
  const BM_ATTR        = "data-booru-bm-id";
  const STORAGE_KEY    = "booru_bm_" + location.origin;

  let _lastTarget    = null;
  let _mutingObs     = false;
  let _jumpIndex     = -1;
  let _pendingJumpId = null;
  let _pendingTimer  = null; // timeout to navigate if pending jump never resolves

  // ── True page URL detection ───────────────────────────────────────────────
  // location.href is unreliable for storing the bookmark's page -- boorus
  // often update it asynchronously after the page loads (e.g. adding tags=,
  // changing page numbers, etc.). We read the canonical URL from the page
  // itself, which is always accurate.

  function getTruePageUrl() {
    // 1. <link rel="canonical"> -- most reliable, many boorus include it
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical?.href) return canonical.href;

    // 2. Paginator current page link (e621/Danbooru style)
    //    <span class="page current"> with adjacent <a> links
    //    or prev/next links let us reconstruct the current page URL
    const paginatorNav = document.querySelector('nav.pagination, #paginator, .pagination');
    if (paginatorNav) {
      // Try the current page span's surrounding context -- if there's a
      // data-current attribute, combine with the next/prev link to get the URL
      const nextLink = document.querySelector('#paginator-next[href], a#paginator-next, nav.pagination a.next');
      const prevLink = document.querySelector('#paginator-prev[href], a#paginator-prev, nav.pagination a.prev');
      const currentData = paginatorNav.dataset?.current;

      if (nextLink?.href && currentData) {
        // Next link is for page N+1; current page is N
        // Replace the page number in the next URL with current page number
        try {
          const url = new URL(nextLink.href);
          // Handle ?page=N query param style
          if (url.searchParams.has('page')) {
            url.searchParams.set('page', currentData);
            return url.toString();
          }
          // Handle /page/N path style (Shimmie2)
          const pathWithPage = url.pathname.replace(/\/\d+\/?$/, '/' + currentData);
          if (pathWithPage !== url.pathname) {
            url.pathname = pathWithPage;
            return url.toString();
          }
        } catch (_) {}
      }

      if (prevLink?.href && currentData) {
        // Prev link is for page N-1; current page is N
        try {
          const url = new URL(prevLink.href);
          if (url.searchParams.has('page')) {
            url.searchParams.set('page', currentData);
            return url.toString();
          }
          const pathWithPage = url.pathname.replace(/\/\d+\/?$/, '/' + currentData);
          if (pathWithPage !== url.pathname) {
            url.pathname = pathWithPage;
            return url.toString();
          }
        } catch (_) {}
      }
    }

    // 3. Fall back to location.href
    return location.href;
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  // isExtensionAlive checks whether chrome.storage/runtime are still usable.
  // The extension context can be invalidated mid-session (e.g. the user
  // updates or reloads the extension while this tab stays open). Once that
  // happens, every chrome.* call throws synchronously. All Promise-returning
  // wrappers below guard against this so the page never crashes -- they just
  // resolve to empty/no-op results, which silently disables the extension's
  // functionality on this tab until the page is refreshed.

  function isExtensionAlive() {
    try {
      return !!(chrome?.runtime?.id && chrome?.storage?.local);
    } catch (_) {
      return false;
    }
  }

  function loadBookmarks() {
    return new Promise(res => {
      if (!isExtensionAlive()) { res({}); return; }
      try {
        chrome.storage.local.get(STORAGE_KEY, d => {
          if (chrome.runtime.lastError) { res({}); return; }
          res(d[STORAGE_KEY] || {});
        });
      } catch (_) {
        res({});
      }
    });
  }
  function saveBookmarks(obj) {
    return new Promise(res => {
      if (!isExtensionAlive()) { res(); return; }
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: obj }, () => res());
      } catch (_) {
        res();
      }
    });
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

  // Extract the post's own permalink from a container (e.g. /posts/12345).
  // This is the stable destination for the "open post page" fallback -- unlike
  // the index page URL, a post's permalink never changes as the index reshuffles.
  function getPostLink(container) {
    // The first <a href> inside the container that looks like a post permalink
    const links = container.tagName?.toLowerCase() === "a"
      ? [container]
      : Array.from(container.querySelectorAll("a[href]"));
    // Also consider an enclosing <a> if the container is an <img>
    const enclosing = container.closest?.("a[href]");
    if (enclosing) links.unshift(enclosing);

    for (const a of links) {
      const href = a.getAttribute("href");
      if (!href) continue;
      // Common booru post permalink patterns:
      //   /posts/12345           (Danbooru / e621 family)
      //   /post/view/12345       (Shimmie2 / paheal)
      //   /index.php?page=post&s=view&id=12345  (Gelbooru)
      if (/\/post[s]?\/(view\/)?\d+/i.test(href)) return new URL(href, location.origin).href;
      if (/[?&]id=\d+/.test(href) && /s=view|page=post/.test(href))
        return new URL(href, location.origin).href;
    }
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
    _restoreTimer = setTimeout(runRestore, 100);
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

  // ── Nav button ─────────────────────────────────────────────────────────────

  function getJumpToast() {
    let el = document.getElementById("booru-bookmark-jump-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "booru-bookmark-jump-toast";
      document.documentElement.appendChild(el);
      el.addEventListener("click", () => jumpToBookmark());
    }
    if (el.parentElement !== document.documentElement)
      document.documentElement.appendChild(el);
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
  // Arms a post ID to scroll to as soon as it appears in the DOM via
  // runRestore. If it hasn't appeared within 2 seconds, navigate to the
  // stored page URL instead -- the bookmark is on a different page.

  function checkPendingJump(container, id) {
    if (!_pendingJumpId || id !== _pendingJumpId) return;
    _pendingJumpId = null;
    clearTimeout(_pendingTimer);
    sessionStorage.removeItem("booru_bm_walked"); // success -- clear walk guard
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
      const [postId, value] = entries[idx];

      // Extract the stored index page URL for the page-walk fallback
      let pageUrl = null;
      if (value && typeof value === "object") pageUrl = value.page || null;
      else if (typeof value === "string")     pageUrl = value;

      // Arm the pending jump -- checkPendingJump fires when runRestore finds it
      _pendingJumpId = postId;
      clearTimeout(_pendingTimer);
      _pendingTimer = setTimeout(() => {
        if (_pendingJumpId !== postId) return; // already found and scrolled to
        _pendingJumpId = null;
        // Guard: if we arrived here from a page-walk that already confirmed
        // this post is on this page, don't walk again -- avoids any loop.
        if (sessionStorage.getItem("booru_bm_walked")) {
          sessionStorage.removeItem("booru_bm_walked");
          showToast("Bookmark should be on this page", "info");
          return;
        }
        // Landed on the stored page but the post isn't here -- it drifted to
        // another index page. Walk pages to find where it lives now.
        findPostPageAndGo(postId, pageUrl);
      }, 2000);
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

    const [postId, value] = entries[_jumpIndex];

    // Normalise storage value -- it may be an object { page, post } (current
    // schema) or a bare URL string (legacy schema). Extract both URLs.
    let pageUrl = null, postUrl = null;
    if (value && typeof value === "object") {
      pageUrl = value.page || null;
      postUrl = value.post || null;
    } else if (typeof value === "string") {
      pageUrl = value; // legacy: only the index page URL was stored
    }

    // STEP 1 -- is the bookmarked thumbnail on the current page right now?
    // If so, just scroll to it. This is the common case while browsing.
    const result = findContainerByPostId(postId);
    if (result && !isDeleted(result.container)) {
      scrollToBookmark(result.container);
      return;
    }
    if (result && isDeleted(result.container)) {
      // The post is on this page but deleted -- show the nearest neighbour
      highlightNearest(result.container);
      return;
    }

    // STEP 2 -- not on this page. If the stored index page is a DIFFERENT page
    // than where we are, navigate there first; the thumbnail may simply be on
    // another page of the same listing we already know about.
    if (pageUrl && typeof pageUrl === "string" && !sameIndexPage(pageUrl)) {
      sessionStorage.setItem("booru_bm_autojump", "1");
      navigateTo(pageUrl);
      return;
    }

    // STEP 3 -- we're on the stored index page but the post isn't in the DOM.
    // If the page has already finished loading, the post genuinely isn't here
    // (it drifted to another page) -- start the page-walk immediately, no wait.
    // Only if the page is still loading do we briefly wait for it to settle,
    // and even then checkPendingJump fires the instant the post appears.
    if (document.readyState === "complete") {
      findPostPageAndGo(postId, pageUrl);
      return;
    }

    _pendingJumpId = postId;
    clearTimeout(_pendingTimer);
    _pendingTimer = setTimeout(() => {
      if (_pendingJumpId !== postId) return; // resolved by runRestore already
      _pendingJumpId = null;
      findPostPageAndGo(postId, pageUrl);
    }, 1000);
  }

  // ── Page-walk search ───────────────────────────────────────────────────────
  // Boorus reshuffle the index as new posts arrive, so a bookmarked post drifts
  // to later pages over time. To land the user on the INDEX PAGE where the
  // thumbnail now lives (not the post's standalone page), we fetch successive
  // index pages and scan each for the target post ID, then navigate there.

  // Build the index URL for a given page number, based on the stored page URL.
  // Handles both ?page=N query style and /list/N path style.
  function buildIndexPageUrl(baseUrl, pageNum) {
    try {
      const u = new URL(baseUrl, location.origin);
      // Query-param style: set/replace ?page=N
      if (u.searchParams.has("page") || /[?&]/.test(u.search) || !/\/\d+\/?$/.test(u.pathname)) {
        // If the path doesn't already encode the page number, use query param
        if (/\/(post\/list|posts?)\/?$/i.test(u.pathname) || u.searchParams.has("page")) {
          u.searchParams.set("page", String(pageNum));
          return u.toString();
        }
      }
      // Path style: replace trailing /N with /pageNum, or append /pageNum
      if (/\/\d+\/?$/.test(u.pathname)) {
        u.pathname = u.pathname.replace(/\/\d+\/?$/, "/" + pageNum);
      } else {
        u.pathname = u.pathname.replace(/\/?$/, "/" + pageNum);
      }
      return u.toString();
    } catch (_) {
      return baseUrl;
    }
  }

  // Fetch an index page and return true if the target post ID appears on it.
  async function pageContainsPost(pageUrl, postId) {
    try {
      const resp = await fetch(pageUrl, { credentials: "include" });
      if (!resp.ok) return false;
      const html = await resp.text();
      const doc  = new DOMParser().parseFromString(html, "text/html");
      for (const el of doc.querySelectorAll(
        "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb"
      )) {
        if (getPostId(el) === postId) return true;
      }
      // Bare-img boorus
      for (const img of doc.querySelectorAll("img")) {
        if (img.closest("article, [data-post-id], [data-id], span.thumb, li.thumb")) continue;
        if (getPostId(img) === postId) return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  // Walk index pages (up to a sane limit) to find the target post, then
  // navigate the user to the index page it's on. Searches outward from the
  // page it was bookmarked on, since drift is usually toward later pages.
  async function findPostPageAndGo(postId, bookmarkPageUrl) {
    if (!bookmarkPageUrl) {
      showToast("Bookmarked post not found on this page", "info");
      return;
    }

    showToast("Locating bookmark across pages...", "info");

    // Determine the page number the bookmark was originally on
    let startPage = 1;
    try {
      const u = new URL(bookmarkPageUrl, location.origin);
      const qp = u.searchParams.get("page");
      if (qp) startPage = parseInt(qp, 10) || 1;
      else {
        const m = u.pathname.match(/\/(\d+)\/?$/);
        if (m) startPage = parseInt(m[1], 10) || 1;
      }
    } catch (_) {}

    const MAX_PAGES = 50; // safety limit

    // Search order: start page, then forward (drift is usually forward),
    // interleaving a backward check in case the post moved earlier.
    const order = [];
    order.push(startPage);
    for (let d = 1; d < MAX_PAGES; d++) {
      if (startPage + d <= MAX_PAGES) order.push(startPage + d);
      if (startPage - d >= 1)        order.push(startPage - d);
    }

    for (const pageNum of order) {
      const candidateUrl = buildIndexPageUrl(bookmarkPageUrl, pageNum);
      const found = await pageContainsPost(candidateUrl, postId);
      if (found) {
        // Navigate the user to this index page; autojump will scroll to it.
        // The walked flag prevents a second page-walk if rendering is slow.
        sessionStorage.setItem("booru_bm_autojump", "1");
        sessionStorage.setItem("booru_bm_walked", "1");
        navigateTo(candidateUrl);
        return;
      }
    }

    showToast("Bookmarked post not found -- it may have been deleted", "warn");
  }

  // Navigate using the booru's SPA router if present, else a hard navigation.
  function navigateTo(url) {
    if (window.Turbo?.visit)           window.Turbo.visit(url);
    else if (window.Turbolinks?.visit) window.Turbolinks.visit(url);
    else                               location.href = url;
  }

  // True if the given index-page URL refers to the same page we're viewing,
  // accounting for both ?page=N query style and /list/N path style.
  function sameIndexPage(pageUrl) {
    try {
      const target  = new URL(pageUrl, location.origin);
      const current = new URL(location.href);
      if (target.origin !== current.origin) return false;

      const marker = (u) => {
        const qp = u.searchParams.get("page");
        if (qp !== null) return { value: qp, path: u.pathname };
        const m = u.pathname.match(/\/(\d+)\/?$/);
        if (m) return { value: m[1], path: u.pathname.slice(0, u.pathname.length - m[0].length) || "/" };
        return { value: "1", path: u.pathname };
      };
      const a = marker(target), b = marker(current);
      return a.path === b.path && a.value === b.value;
    } catch (_) {
      return false;
    }
  }

  // ── Initialise ────────────────────────────────────────────────────────────

  runRestore().then(() => {
    refreshJumpToast();
    maybeAutoJump();
  });

  // MutationObserver: re-apply bookmarks when new thumbnails appear.
  // When a bookmarked node is removed (booru replaces it), detect it
  // immediately and trigger a fast restore without waiting for debounce.
  new MutationObserver((mutations) => {
    if (_mutingObs) return;
    let urgentRestore = false;
    for (const m of mutations) {
      for (const node of m.removedNodes) {
        if (node.nodeType === 1 && (
          node.classList?.contains(BOOKMARK_CLASS) ||
          node.querySelector?.("." + BOOKMARK_CLASS)
        )) {
          urgentRestore = true;
          break;
        }
      }
      if (urgentRestore) break;
    }
    if (urgentRestore) {
      clearTimeout(_restoreTimer);
      // Wait one microtask tick so the replacement node (e.g. from
      // DeferredPostLoader's replaceWith) is in the DOM before we scan
      Promise.resolve().then(runRestore);
    } else {
      scheduleRestore();
    }
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener("turbo:load", () => {
    runRestore().then(() => { signalBooru(); refreshJumpToast(); maybeAutoJump(); });
  });
  document.addEventListener("turbolinks:load", () => {
    runRestore().then(() => { signalBooru(); refreshJumpToast(); maybeAutoJump(); });
  });

  setInterval(() => { signalBooru(); scheduleRestore(); refreshJumpToast(); }, 10_000);

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
      const postLink = getPostLink(container);
      loadBookmarks().then(stored => {
        // Store both the index page URL (for jumping back to the grid) and
        // the post's permalink (stable fallback when the post has moved pages).
        stored[id] = { page: getTruePageUrl(), post: postLink };
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
