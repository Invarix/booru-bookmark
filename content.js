// Booru Bookmark content.js

(function () {
  "use strict";

  // Guard: if the extension context is invalidated (e.g. after an update),
  // chrome.runtime is undefined or disconnected. Bail out silently.
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

  // Post-link URL patterns shared by every booru running a given engine.
  // Matching on these covers all sites on that engine, present and future
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
  // location.href is unreliable for storing the bookmark's page boorus
  // often update it asynchronously after the page loads (e.g. adding tags=,
  // changing page numbers, etc.). We read the canonical URL from the page
  // itself, which is always accurate.

  function getTruePageUrl() {
    // Prefer the live location.href when it's a real listing URL, it always
    // reflects the page you're actually on. Some engines (modern Danbooru) set
    // <link rel="canonical"> to the bare site root on the index, which would
    // lose the /posts listing path, so we don't trust canonical blindly.
    const here = (() => { try { return new URL(location.href); } catch { return null; } })();
    if (here && /\/(post\/list|posts?|index\.php)/i.test(here.pathname + here.search)) {
      return location.href;
    }

    // 1. <link rel="canonical"> only trust it if it carries a listing path.
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical?.href) {
      try {
        const cu = new URL(canonical.href);
        if (/\/(post\/list|posts?|index\.php)/i.test(cu.pathname + cu.search)) {
          return canonical.href;
        }
      } catch (_) {}
    }

    // 2. Paginator current page link (e621/Danbooru style)
    //    <span class="page current"> with adjacent <a> links
    //    or prev/next links let us reconstruct the current page URL
    const paginatorNav = document.querySelector('nav.pagination, #paginator, .pagination');
    if (paginatorNav) {
      // Try the current page span's surrounding context if there's a
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
  // wrappers below guard against this so the page never crashes, they just
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
        // Duplicate - keep the richer value (one with page + post info)
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
    // No recognised wrapper - fall back to the <img> itself (bare-img boorus).
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
    // source it came from. This is CRITICAL. On some boorus the same post can
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

    // 4. Non-numeric fallbacks (rare engines) keep stable per-post
    if (container.dataset?.postId) return "pid:" + container.dataset.postId;
    if (container.dataset?.id)     return "did:" + container.dataset.id;
    if (innerHref)                 return "href:" + innerHref;
    return null;
  }

  // Extract the post's own permalink from a container (e.g. /posts/12345).
  // This is the stable destination for the "open post page" fallback, unlike
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
        label.title       = "Bookmarked - right-click to remove";
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
        // post link) to a bookmarked post's ID without this guard the border
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
  // stored page URL instead - the bookmark is on a different page.

  function checkPendingJump(container, id) {
    if (!_pendingJumpId || id !== _pendingJumpId) return;
    _pendingJumpId = null;
    clearTimeout(_pendingTimer);
    sessionStorage.removeItem("booru_bm_walked"); // success - clear walk guard
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

      // Actively poll for the post in the DOM rather than passively waiting for
      // a MutationObserver tick. e621 and other deferred-loading boorus inject
      // thumbnails over time, so we re-check directly on a short interval until
      // the post appears (then scroll to it) or we exhaust the window (then walk
      // pages / report). This eliminates the race where the element rendered
      // just after a fixed timeout and required a manual second click.
      _pendingJumpId = postId;
      clearTimeout(_pendingTimer);

      let attempts = 0;
      const MAX_ATTEMPTS = 40;     // 40 * 200ms = up to 8s of polling
      const tick = () => {
        if (_pendingJumpId !== postId) return; // resolved elsewhere
        const result = findContainerByPostId(postId);
        if (result && !isDeleted(result.container)) {
          _pendingJumpId = null;
          sessionStorage.removeItem("booru_bm_walked");
          scrollToBookmark(result.container);
          return;
        }
        if (result && isDeleted(result.container)) {
          _pendingJumpId = null;
          sessionStorage.removeItem("booru_bm_walked");
          highlightNearest(result.container);
          return;
        }
        if (++attempts < MAX_ATTEMPTS) {
          _pendingTimer = setTimeout(tick, 200);
          return;
        }
        // Window exhausted, the post genuinely isn't on this page.
        _pendingJumpId = null;
        if (sessionStorage.getItem("booru_bm_walked")) {
          // We already walked here and confirmed the post should be present,
          // but it never rendered. Do one final restore-driven attempt.
          sessionStorage.removeItem("booru_bm_walked");
          runRestore().then(() => {
            const r = findContainerByPostId(postId);
            if (r && !isDeleted(r.container)) scrollToBookmark(r.container);
            else showToast("Bookmark should be on this page", "info");
          });
          return;
        }
        // Not where we expected, it drifted to another page. Walk to find it.
        findPostPageAndGo(postId, pageUrl);
      };
      tick();
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

    const doScroll = () => target.scrollIntoView({ behavior: "smooth", block: "center" });

    // Scroll immediately, then re-assert after layout settles. On lazy-loading
    // boorus, thumbnails above the target finish loading and expand AFTER the
    // first scroll, pushing the target off-centre - re-centering fixes that.
    doScroll();
    requestAnimationFrame(doScroll);          // after the next paint
    setTimeout(doScroll, 250);                // after early lazy-load shifts
    setTimeout(doScroll, 600);                // after later shifts settle

    // If the target's own thumbnail image is still loading, re-center once it's
    // done (its final height may differ from the placeholder).
    const img = target.tagName?.toLowerCase() === "img"
      ? target : target.querySelector("img");
    if (img && !img.complete) {
      img.addEventListener("load", () => doScroll(), { once: true });
    }

    // Pulse animation to draw the eye to the bookmark once it's in view.
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

    // Normalise storage value, it may be an object { page, post } (current
    // schema) or a bare URL string (legacy schema). Extract both URLs.
    let pageUrl = null, postUrl = null;
    if (value && typeof value === "object") {
      pageUrl = value.page || null;
      postUrl = value.post || null;
    } else if (typeof value === "string") {
      pageUrl = value; // legacy: only the index page URL was stored
    }

    // STEP 1 - is the bookmarked thumbnail on the current page right now?
    // If so, just scroll to it. This is the common case while browsing.
    const result = findContainerByPostId(postId);
    if (result && !isDeleted(result.container)) {
      scrollToBookmark(result.container);
      return;
    }
    if (result && isDeleted(result.container)) {
      // The post is on this page but deleted - show the nearest neighbour
      highlightNearest(result.container);
      return;
    }

    // STEP 2 - not on this page. Search the index to find which page the post
    // lives on NOW, then navigate straight there. We no longer hop to the
    // stored page first (which caused a wasted reload when the post had drifted
    // away from it). The walk starts from whichever page is the better guess:
    // the page we're currently on, or the page the bookmark was placed on.
    let walkFromUrl = null;
    if (sameIndexPage(pageUrl)) {
      // We're already on the stored listing - the page may still be rendering
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
      let u = new URL(baseUrl, location.origin);

      // If the base URL has no recognisable listing path (e.g. a bare origin
      // "https://site/" that a canonical link produced), borrow the listing
      // path + query from the page we're currently on, which IS a real listing.
      const hasListing = /\/(post\/list|posts?|index\.php)/i.test(u.pathname + u.search);
      if (!hasListing) {
        try {
          const cur = new URL(location.href);
          if (/\/(post\/list|posts?|index\.php)/i.test(cur.pathname + cur.search)) {
            u = cur;
          }
        } catch (_) {}
      }

      // Query-param pagination (Danbooru family /posts, Gelbooru index.php).
      // Use this whenever a page param already exists OR the path is a known
      // query-paginated listing root.
      if (u.searchParams.has("page") ||
          /\/(posts?|index\.php)\/?$/i.test(u.pathname) ||
          /[?&]/.test(u.search)) {
        u.searchParams.set("page", String(pageNum));
        return u.toString();
      }

      // Path-style pagination (Shimmie2 /post/list/N): replace or append /N.
      if (/\/\d+\/?$/.test(u.pathname)) {
        u.pathname = u.pathname.replace(/\/\d+\/?$/, "/" + pageNum);
      } else if (/\/post\/list\/?$/i.test(u.pathname) || /\/post\/list\//i.test(u.pathname)) {
        u.pathname = u.pathname.replace(/\/?$/, "/" + pageNum);
      } else {
        // Unknown shape - safest is query param, which most engines accept.
        u.searchParams.set("page", String(pageNum));
      }
      return u.toString();
    } catch (_) {
      return baseUrl;
    }
  }

  // Fetch an index page and return true if the target post ID appears on it.
  async function pageContainsPost(pageUrl, postId) {
    const info = await fetchPageInfo(pageUrl);
    return info.ids.includes(postId);
  }

  // Fetch an index page once and extract: the set of post-ID keys on it, plus
  // the numeric min/max of those IDs. The numeric range powers a binary search:
  // boorus order the default index by post ID DESCENDING, so a target ID higher
  // than a page's max means the post is on an EARLIER page, lower than its min
  // means a LATER page, and within range means it's on this page.
  // Returns { ids:[...], maxNum, minNum, count } - empty page => count 0.
  async function fetchPageInfo(pageUrl) {
    try {
      const resp = await fetch(pageUrl, { credentials: "include" });
      if (!resp.ok) return { ids: [], maxNum: null, minNum: null, count: 0 };
      const html = await resp.text();
      const doc  = new DOMParser().parseFromString(html, "text/html");

      const ids = [];
      const nums = [];
      const addId = (key) => {
        if (!key) return;
        ids.push(key);
        const m = key.match(/^num:(\d+)$/);
        if (m) nums.push(parseInt(m[1], 10));
      };

      for (const el of doc.querySelectorAll(
        "article, [data-post-id], [data-id], span.thumb, li.thumb, li.shm-thumb"
      )) {
        if (!isThumbWrapper(el)) continue;
        addId(getPostId(el));
      }
      for (const img of doc.querySelectorAll("img")) {
        if (img.closest("article, [data-post-id], [data-id], span.thumb, li.thumb")) continue;
        addId(getPostId(img));
      }

      return {
        ids,
        maxNum: nums.length ? Math.max(...nums) : null,
        minNum: nums.length ? Math.min(...nums) : null,
        count: ids.length,
      };
    } catch (_) {
      return { ids: [], maxNum: null, minNum: null, count: 0 };
    }
  }

  // Concurrent linear sweep over a page range [fromPage, toPage] inclusive,
  // navigating to the first page found to contain the post. Returns true if it
  // navigated, false if the post wasn't found in the swept range. Used as a
  // safety net after binary search (whose ID-monotonic assumption can be
  // violated by custom sort orders, lazy-loaded fetched markup, or ID gaps).
  async function linearSweep(postId, bookmarkPageUrl, fromPage, toPage) {
    const lo = Math.max(1, Math.min(fromPage, toPage));
    const hi = Math.max(fromPage, toPage);
    const BATCH = 6;
    for (let start = lo; start <= hi; start += BATCH) {
      const batch = [];
      for (let p = start; p < start + BATCH && p <= hi; p++) batch.push(p);

      const hit = await new Promise((resolve) => {
        let pending = batch.length;
        let found = null;
        for (const p of batch) {
          fetchPageInfo(buildIndexPageUrl(bookmarkPageUrl, p)).then((info) => {
            if (info.ids.includes(postId) && found === null) found = p;
            if (--pending === 0) resolve(found);
          }).catch(() => { if (--pending === 0) resolve(found); });
        }
      });

      if (hit !== null) {
        sessionStorage.setItem("booru_bm_autojump", "1");
        sessionStorage.setItem("booru_bm_walked", "1");
        navigateTo(buildIndexPageUrl(bookmarkPageUrl, hit));
        return true;
      }
    }
    return false;
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

    const MAX_PAGES = 5000; // generous ceiling; binary search makes this cheap

    // The target's numeric post ID drives a binary search. Boorus order the
    // index by post ID descending, so page position is monotonic in ID.
    const targetNum = (() => {
      const m = String(postId).match(/^num:(\d+)$/);
      return m ? parseInt(m[1], 10) : null;
    })();

    const goToPage = (pageNum) => {
      sessionStorage.setItem("booru_bm_autojump", "1");
      sessionStorage.setItem("booru_bm_walked", "1");
      navigateTo(buildIndexPageUrl(bookmarkPageUrl, pageNum));
    };

    const notFound = () => {
      sessionStorage.setItem("booru_bm_deleted_notice", "1");
      if (sameIndexPage(bookmarkPageUrl)) {
        sessionStorage.removeItem("booru_bm_deleted_notice");
        showErrorToast("Bookmark Not found! Deleted?");
      } else {
        navigateTo(buildIndexPageUrl(bookmarkPageUrl, startPage));
      }
    };

    // ---- Fast path: binary search by post ID (when we have a numeric ID) ----
    if (targetNum !== null) {
      // 1. Find an upper-bound page whose min ID is below the target (target is
      //    on or before it). Probe exponentially: startPage, *2, *4, ... This
      //    brackets the target in O(log pages) fetches without knowing the last
      //    page. Simultaneously catch the post if a probed page contains it.
      let lo = 1;                       // page known to be at/before target side
      let hi = null;                    // page known to be at/after target side
      let probe = Math.max(1, startPage);
      let step  = Math.max(1, startPage);

      for (let guard = 0; guard < 40 && probe <= MAX_PAGES; guard++) {
        const probeUrl = buildIndexPageUrl(bookmarkPageUrl, probe);
        const info = await fetchPageInfo(probeUrl);

        if (info.count === 0) {            // past the last page -> bound above
          hi = probe;
          break;
        }
        if (info.ids.includes(postId)) { goToPage(probe); return; }

        if (info.minNum === null) {        // page has no numeric IDs -> can't
          break;                           // binary search; fall back to linear
        }
        if (targetNum > info.maxNum) {     // target newer -> earlier page
          hi = probe;
          break;
        }
        // target older than this page's min -> later page; expand the bracket
        lo = probe;
        step *= 2;
        probe = lo + step;
      }

      // 2. Binary search between lo (target is at/after) and hi (target before).
      if (hi !== null) {
        while (lo + 1 < hi) {
          const mid  = Math.floor((lo + hi) / 2);
          const info = await fetchPageInfo(buildIndexPageUrl(bookmarkPageUrl, mid));

          if (info.count === 0) { hi = mid; continue; }
          if (info.ids.includes(postId)) { goToPage(mid); return; }
          if (info.minNum === null)      { break; } // give up to linear fallback

          if (targetNum > info.maxNum)      hi = mid; // target newer -> earlier
          else if (targetNum < info.minNum) lo = mid; // target older -> later
          else break; // in range but not found by exact id -> check lo & hi below
        }

        // The post should be on lo or hi (adjacent). Check both directly.
        for (const p of [lo, hi]) {
          const info = await fetchPageInfo(buildIndexPageUrl(bookmarkPageUrl, p));
          if (info.ids.includes(postId)) { goToPage(p); return; }
        }
        // Binary search concluded the post isn't on lo or hi. Its ID-monotonic
        // assumption can be violated (custom sort orders, lazy-loaded fetched
        // markup, large ID gaps from mass deletions), so before declaring the
        // post deleted, do a full linear sweep from page 1 to a generous bound.
        // This guarantees we never report a false deletion for a post that
        // actually exists within range.
        if (await linearSweep(postId, bookmarkPageUrl, 1, 300)) return;
        notFound();
        return;
      }
      // If we never bounded above, fall through to the linear scan below.
    }

    // ---- Fallback: concurrent linear scan (non-numeric IDs / odd engines) ----
    const onStartPage = sameIndexPage(buildIndexPageUrl(bookmarkPageUrl, startPage));
    const firstProbe  = onStartPage ? startPage + 1 : startPage;
    const LINEAR_MAX  = 300;
    const BATCH_SIZE  = 6;

    const order = [firstProbe];
    for (let d = 1; d < LINEAR_MAX; d++) {
      if (firstProbe + d <= LINEAR_MAX) order.push(firstProbe + d);
      if (firstProbe - d >= 1)          order.push(firstProbe - d);
    }

    let navigated = false;
    for (let i = 0; i < order.length && !navigated; i += BATCH_SIZE) {
      const batch = order.slice(i, i + BATCH_SIZE);
      await new Promise((resolveWave) => {
        let pending = batch.length;
        for (const pageNum of batch) {
          const url = buildIndexPageUrl(bookmarkPageUrl, pageNum);
          pageContainsPost(url, postId).then((found) => {
            if (found && !navigated) {
              navigated = true;
              goToPage(pageNum);
              resolveWave();
              return;
            }
            if (--pending === 0) resolveWave();
          }).catch(() => { if (--pending === 0) resolveWave(); });
        }
      });
    }
    if (navigated) return;

    notFound();
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
