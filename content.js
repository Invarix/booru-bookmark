// Booru Bookmark -- content.js

(function () {
  "use strict";

  // Guard: if the extension context is invalidated (e.g. after an update),
  // chrome.runtime is undefined or disconnected. Bail out silently.
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

  // Post-link URL patterns shared by every booru running a given engine.
  // Matching on these covers all sites on that engine -- present and future --
  // without naming individual boorus. Five engine families cover the vast
  // majority of boorus in existence:
  //   Gelbooru family   index.php?page=post&s=view&id=N   (Gelbooru, Safebooru,
  //                                                         rule34.xxx, booru.org)
  //   Danbooru family   /posts/N                          (Danbooru, e621, ATF)
  //   Shimmie2          /post/view/N                      (paheal, Pixboard)
  //   Moebooru          /post/show/N                      (yande.re, konachan)
  //   Philomena         /images/N                         (derpibooru, furbooru)
  const POST_LINK_PATTERNS = [
    /[?&]s=view&(amp;)?id=\d+/i,   // Gelbooru-family (also matches s=view&amp;id=)
    /[?&]id=\d+/i,                  // Gelbooru-family loose (id param on a post link)
    /\/posts?\/\d+/i,               // Danbooru-family /posts/N (and /post/N)
    /\/post\/view\/\d+/i,           // Shimmie2
    /\/post\/show\/\d+/i,           // Moebooru
    /\/images\/\d+/i,               // Philomena
  ];

  // Returns true if an <a href> looks like a booru post permalink.
  function isPostLink(href) {
    if (!href) return false;
    // Gelbooru post links must also be on a post page (page=post), to avoid
    // matching unrelated ?id= links elsewhere on a site.
    if (/[?&]id=\d+/i.test(href) && !/[?&]s=view/i.test(href)) {
      return /page=post/i.test(href);
    }
    return POST_LINK_PATTERNS.some(re => re.test(href));
  }

  function looksLikeBooru() {
    // 1. Engine identity in meta tags (fast path for engines that set them)
    const appName = document.querySelector('meta[name="application-name"]')
                             ?.content?.toLowerCase() || "";
    if (appName && /danbooru|booru|shimmie|gelbooru|moebooru|szurubooru|philomena/.test(appName))
      return true;
    const generator = document.querySelector('meta[name="generator"]')
                               ?.content?.toLowerCase() || "";
    if (generator && /shimmie|danbooru|booru/.test(generator)) return true;

    // 2. Danbooru body class
    if (document.body?.classList?.contains("c-posts")) return true;

    // 3. Engine-specific markers
    if (document.querySelector(".shm-thumb, [data-post-id], #shm-tag-list")) return true;

    // 4. Universal: a cluster of thumbnail links matching a known post-link
    //    pattern. This is the catch-all that covers Gelbooru/booru.org sites,
    //    Moebooru, Philomena, and any engine whose thumbnails are <a><img>.
    //    Require at least 3 such links so a single stray link doesn't trigger.
    let postLinkCount = 0;
    for (const a of document.querySelectorAll("a[href] > img, a[href] img")) {
      if (isPostLink(a.closest("a[href]")?.getAttribute("href"))) {
        if (++postLinkCount >= 3) return true;
      }
    }

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

  // One-time migration: older versions stored the same post under different key
  // formats (did:N, pid:N, eid:N, or href:...id=N) depending on render timing,
  // which could leave a single post recorded as two separate bookmarks. Collapse
  // any legacy numeric-bearing key into the canonical "num:N" form and merge
  // duplicates, keeping the entry that has the most complete value.
  function migrateBookmarkKeys(stored) {
    let changed = false;
    const out = {};

    const numFromKey = (key) => {
      let m;
      if ((m = key.match(/^num:(\d+)$/)))                 return m[1];
      if ((m = key.match(/^(?:did|pid|eid):(\d+)$/)))     return m[1];
      if ((m = key.match(/[?&]id=(\d+)/)))                return m[1]; // href:...&id=N
      if ((m = key.match(/\/posts?\/(\d+)/)))             return m[1];
      if ((m = key.match(/\/post\/(?:view|show)\/(\d+)/))) return m[1];
      if ((m = key.match(/\/images\/(\d+)/)))             return m[1];
      return null;
    };

    const valueRichness = (v) => {
      if (v && typeof v === "object") return (v.page ? 1 : 0) + (v.post ? 1 : 0);
      if (typeof v === "string") return 0.5;
      return 0;
    };

    for (const [key, val] of Object.entries(stored)) {
      const num = numFromKey(key);
      const canonical = num ? "num:" + num : key;
      if (canonical !== key) changed = true;

      if (!(canonical in out)) {
        out[canonical] = val;
      } else {
        // Duplicate -- keep the richer value (one with page + post info)
        if (valueRichness(val) > valueRichness(out[canonical])) out[canonical] = val;
        changed = true;
      }
    }
    return { migrated: out, changed };
  }

  // ── Container & ID resolution ──────────────────────────────────────────────

  // A real thumbnail wrapper holds exactly one post image. A page-level
  // container (post list, content column) holds many. Rejecting any candidate
  // with more than one <img> prevents the border from landing on a huge
  // ancestor and wrapping the whole index.
  function isSinglePostWrapper(node) {
    if (!node || !node.querySelectorAll) return true; // an <img> itself has none
    return node.querySelectorAll("img").length <= 1;
  }

  // True only for elements that are genuine single-post thumbnail wrappers,
  // never page-level containers. Used by every code path that applies or
  // searches for a bookmark so the border can only ever land on a thumbnail.
  function isThumbWrapper(node) {
    if (!node) return false;
    const tag = node.tagName?.toLowerCase();
    const cls = node.classList;
    const ds  = node.dataset;
    const numericDataId =
      (ds?.postId && /^\d+$/.test(ds.postId)) ||
      (ds?.id     && /^\d+$/.test(ds.id));
    const matches =
      tag === "article"                          ||
      numericDataId                              ||
      (tag === "span" && cls?.contains("thumb")) ||
      (tag === "li"   && (cls?.contains("thumb") || cls?.contains("shm-thumb"))) ||
      cls?.contains("shm-thumb")                ||
      cls?.contains("post-preview")             ||
      cls?.contains("thumbnail-preview");
    return matches && isSinglePostWrapper(node);
  }

  function getBestContainer(startEl) {
    let node = startEl;
    for (let i = 0; i < 12; i++) {
      if (!node || node === document.body) break;
      if (node.hasAttribute(BM_ATTR)) return node;
      if (isThumbWrapper(node)) return node;
      node = node.parentElement;
    }
    // No recognised wrapper -- fall back to the <img> itself (bare-img boorus).
    const img = startEl.tagName?.toLowerCase() === "img"
      ? startEl : startEl.closest?.("img");
    return img || startEl.parentElement || startEl;
  }

  function getPostId(container) {
    // Pull a stable numeric post id out of a post-link href, covering all
    // engine families so the same post always maps to the same storage key.
    const idFromHref = (href) => {
      if (!href) return null;
      let m;
      if ((m = href.match(/[?&]id=(\d+)/i)))        return m[1]; // Gelbooru
      if ((m = href.match(/\/posts?\/(\d+)/i)))     return m[1]; // Danbooru
      if ((m = href.match(/\/post\/view\/(\d+)/i))) return m[1]; // Shimmie2
      if ((m = href.match(/\/post\/show\/(\d+)/i))) return m[1]; // Moebooru
      if ((m = href.match(/\/images\/(\d+)/i)))     return m[1]; // Philomena
      return null;
    };

    // Canonical key: the numeric post ID, normalised to "num:N" no matter which
    // source it came from. This is CRITICAL -- on some boorus the same post can
    // be identified via data-id, an element id, OR its link href depending on
    // render timing (e.g. deferred loaders that add data-id late). If those
    // produced different keys, one post could be stored as two bookmarks.
    // Collapsing every numeric source to "num:N" guarantees one post = one key.

    // 1. data-* numeric attributes
    const dataNum = container.dataset?.postId || container.dataset?.id;
    if (dataNum && /^\d+$/.test(dataNum)) return "num:" + dataNum;

    // 2. element id like "p12345" / "post_12345" / "12345"
    if (container.id) {
      const m = container.id.match(/^[a-z_]*?(\d+)$/i);
      if (m) return "num:" + m[1];
    }

    // 3. post-link href (covers bare <a><img> boorus and as a fallback)
    if (container.tagName?.toLowerCase() === "img") {
      const href = container.closest("a[href]")?.getAttribute("href");
      const n = idFromHref(href);
      if (n) return "num:" + n;
      const src = container.src || container.currentSrc;
      if (src && !src.startsWith("data:")) return "src:" + src;
      return null;
    }
    const innerHref = container.querySelector("a[href]")?.getAttribute("href");
    const n = idFromHref(innerHref);
    if (n) return "num:" + n;

    // 4. Non-numeric fallbacks (rare engines) -- keep stable per-post
    if (container.dataset?.postId) return "pid:" + container.dataset.postId;
    if (container.dataset?.id)     return "did:" + container.dataset.id;
    if (innerHref)                 return "href:" + innerHref;
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
      if (!isThumbWrapper(el)) continue; // skip page-level containers
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
      if (tag === "img") {
        // Only <img> containers need display/position overrides for the outline
        // to render. Tagging them separately keeps us from touching the layout
        // of the booru's own wrapper elements (span.thumb, article, li), which
        // would break the page's grid (e.g. collapse it to one column).
        container.classList.add("booru-bookmark-img");
      }
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
      container.classList.remove(BOOKMARK_CLASS, PULSE_CLASS, "booru-bookmark-img");
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
        // Only apply to genuine single-post thumbnail wrappers. Page-level
        // containers can carry a data-id and resolve (via their first inner
        // post link) to a bookmarked post's ID -- without this guard the border
        // would wrap the entire index.
        if (!isThumbWrapper(el)) continue;
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

  // Persistent red error toast shown above the nav button when a bookmarked
  // post can't be located (e.g. deleted from the site). Stays until clicked
  // or until the user navigates / triggers another successful jump.
  function getErrorToast() {
    let el = document.getElementById("booru-bookmark-error-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "booru-bookmark-error-toast";
      document.documentElement.appendChild(el);
      el.addEventListener("click", () => hideErrorToast());
    }
    if (el.parentElement !== document.documentElement)
      document.documentElement.appendChild(el);
    return el;
  }
  function showErrorToast(msg) {
    const el = getErrorToast();
    el.textContent = msg;
    el.classList.add("visible");
  }
  function hideErrorToast() {
    document.getElementById("booru-bookmark-error-toast")?.classList.remove("visible");
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
    hideErrorToast(); // a successful find clears any prior "deleted?" notice
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

    // STEP 2 -- not on this page. Search the index to find which page the post
    // lives on NOW, then navigate straight there. We no longer hop to the
    // stored page first (which caused a wasted reload when the post had drifted
    // away from it). The walk starts from whichever page is the better guess:
    // the page we're currently on, or the page the bookmark was placed on.
    let walkFromUrl = null;
    if (sameIndexPage(pageUrl)) {
      // We're already on the stored listing -- the page may still be rendering
      // (deferred thumbnails). Give it a brief chance before walking.
      if (document.readyState !== "complete") {
        _pendingJumpId = postId;
        clearTimeout(_pendingTimer);
        _pendingTimer = setTimeout(() => {
          if (_pendingJumpId !== postId) return;
          _pendingJumpId = null;
          findPostPageAndGo(postId, pageUrl);
        }, 1000);
        return;
      }
      walkFromUrl = pageUrl;
    } else {
      walkFromUrl = sameListing(pageUrl) ? location.href : pageUrl;
    }

    if (!walkFromUrl) {
      showToast("No saved location for this bookmark", "info");
      return;
    }

    findPostPageAndGo(postId, walkFromUrl);
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
        if (!isThumbWrapper(el)) continue; // skip page-level containers
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

    // Determine the page number to start searching from. Prefer the page the
    // user is currently on (if it's a valid index page of this listing), since
    // that's the best guess for proximity; otherwise use the bookmarked page.
    function pageNumOf(urlStr) {
      try {
        const u = new URL(urlStr, location.origin);
        const qp = u.searchParams.get("page");
        if (qp) return parseInt(qp, 10) || 1;
        const m = u.pathname.match(/\/(\d+)\/?$/);
        if (m) return parseInt(m[1], 10) || 1;
      } catch (_) {}
      return 1;
    }

    let startPage = pageNumOf(bookmarkPageUrl);

    const MAX_PAGES  = 200; // safety ceiling
    const BATCH_SIZE = 6;   // pages fetched concurrently per batch

    // Build the search order: start page, then expand outward, biased forward
    // since index drift pushes older posts toward higher page numbers.
    const order = [startPage];
    for (let d = 1; d < MAX_PAGES; d++) {
      if (startPage + d <= MAX_PAGES) order.push(startPage + d);
      if (startPage - d >= 1)         order.push(startPage - d);
    }

    // Search in concurrent batches: fetch BATCH_SIZE pages at once, check all,
    // navigate to the lowest-numbered page that contains the post. This turns
    // a 7-sequential-fetch wait into roughly one or two round-trips.
    for (let i = 0; i < order.length; i += BATCH_SIZE) {
      const batch = order.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(async (pageNum) => {
        const url = buildIndexPageUrl(bookmarkPageUrl, pageNum);
        const found = await pageContainsPost(url, postId);
        return { pageNum, url, found };
      }));

      // Among hits in this batch, pick the one closest to startPage
      const hits = results.filter(r => r.found);
      if (hits.length) {
        hits.sort((a, b) => Math.abs(a.pageNum - startPage) - Math.abs(b.pageNum - startPage));
        const target = hits[0];
        sessionStorage.setItem("booru_bm_autojump", "1");
        sessionStorage.setItem("booru_bm_walked", "1");
        navigateTo(target.url);
        return;
      }
    }

    // Search exhausted -- the post is on no index page, so it has been deleted
    // (or made private/removed). Navigate the user to the bookmark's last known
    // page so they land where they left off, then show a persistent red toast.
    sessionStorage.setItem("booru_bm_deleted_notice", "1");
    if (sameIndexPage(bookmarkPageUrl)) {
      // Already on the last known page -- just show the notice now.
      sessionStorage.removeItem("booru_bm_deleted_notice");
      showErrorToast("Bookmark Not found! Deleted?");
    } else {
      navigateTo(buildIndexPageUrl(bookmarkPageUrl, startPage));
    }
  }

  // Navigate using the booru's SPA router if present, else a hard navigation.
  function navigateTo(url) {
    if (window.Turbo?.visit)           window.Turbo.visit(url);
    else if (window.Turbolinks?.visit) window.Turbolinks.visit(url);
    else                               location.href = url;
  }

  // True if the given URL is the same listing/search as the current page,
  // ignoring only the page number. Used to decide whether the current page is a
  // safe origin to walk from (same tags, just a different page).
  function sameListing(pageUrl) {
    try {
      const target  = new URL(pageUrl, location.origin);
      const current = new URL(location.href);
      if (target.origin !== current.origin) return false;

      // Strip the page marker from both, then compare what remains.
      const strip = (u) => {
        const c = new URL(u.href);
        c.searchParams.delete("page");
        c.searchParams.delete("pid"); // Gelbooru-family uses pid offset
        // Path-based page number (/list/N)
        c.pathname = c.pathname.replace(/\/\d+\/?$/, "/");
        // Normalise param order for stable comparison
        c.searchParams.sort();
        return c.pathname + "?" + c.searchParams.toString();
      };
      return strip(target) === strip(current);
    } catch (_) {
      return false;
    }
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

  // If we just navigated to a bookmark's last known page because the post was
  // determined to be deleted, show the persistent red notice now.
  function maybeShowDeletedNotice() {
    if (sessionStorage.getItem("booru_bm_deleted_notice")) {
      sessionStorage.removeItem("booru_bm_deleted_notice");
      showErrorToast("Bookmark Not found! Deleted?");
    }
  }

  // Run the one-time key migration before anything reads bookmarks, so the
  // canonical num: keys are in place for restore, jump, and the toast count.
  (async () => {
    const stored = await loadBookmarks();
    const { migrated, changed } = migrateBookmarkKeys(stored);
    if (changed) await saveBookmarks(migrated);

    runRestore().then(() => {
      refreshJumpToast();
      maybeAutoJump();
      maybeShowDeletedNotice();
    });
  })();

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
