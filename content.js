/* =============================================================================
 * extractors.js  -  content-script world
 *
 * One extractor per site family. Given the right-clicked <img>, returns the
 * pieces of a filename: poster name, @handle, artist shout-outs, hashtags, plus
 * a fallback (the site's random string) and the file extension to keep.
 *
 * The DOM selectors are the fragile part - X and Bluesky ship obfuscated,
 * shifting markup, so we lean on data-testid / href shapes and fail soft
 * (omit a field rather than throw). This file is where you patch when a site
 * reshuffles its layout. Add a site by inserting an extractor before GENERIC.
 * ========================================================================== */

(function () {
  "use strict";

  const MENTION_RE = /@([A-Za-z0-9_]{1,30})/g;

  // User-added gallery domains (from the options page). Cached here so the
  // gallery extractor's test() stays synchronous; refreshed on change. Empty
  // and inert unless the user has added sites, so named sites are unaffected.
  let galleryUserSites = [];
  try {
    const _api = globalThis.browser ?? globalThis.chrome;
    _api.storage.local.get({ userSites: [] }, (r) => {
      galleryUserSites = (r && r.userSites) || [];
    });
    _api.storage.onChanged.addListener((c, area) => {
      if (area === "local" && c.userSites) {
        galleryUserSites = c.userSites.newValue || [];
      }
    });
  } catch (_) {
    /* storage unavailable - user sites simply won't match */
  }
  const HASHTAG_RE = /#([\p{L}\p{N}_]{1,40})/gu;
  const CREDIT_HINT_RE =
    /\b(art(?:work)?\s*(?:by|:)|by|cr(?:edit)?s?\s*:?|source|src|via|drawn by|illust(?:ration)?\s*(?:by|:)|🎨|✒️|🖌️)\b/i;

  const uniq = (a) => [...new Set(a.filter(Boolean))];

  function matchesAll(re, text) {
    if (!text) return [];
    const out = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
  }

  // Artist-ish handles from caption text, credited ones first. No leading @.
  function findArtistHandles(text, posterHandle) {
    if (!text) return [];
    const poster = (posterHandle || "").replace(/^@/, "").toLowerCase();
    const mentions = matchesAll(MENTION_RE, text).filter(
      (h) => h.toLowerCase() !== poster
    );
    const credited = [];
    const re = new RegExp(
      CREDIT_HINT_RE.source + "[^@#]{0,20}@([A-Za-z0-9_]{1,30})",
      "giu"
    );
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[1] && m[1].toLowerCase() !== poster) credited.push(m[1]);
    }
    return uniq([...credited, ...mentions]);
  }

  function extFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      const q = (u.searchParams.get("format") || "").toLowerCase();
      if (q) return q === "jpeg" ? "jpg" : q;
      // bsky: …/<cid>@jpeg  → jpeg
      const at = u.pathname.split("@").pop().toLowerCase();
      if (["jpg", "jpeg", "png", "webp", "gif"].includes(at))
        return at === "jpeg" ? "jpg" : at;
      const ext = u.pathname.split(".").pop().toLowerCase();
      if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext))
        return ext === "jpeg" ? "jpg" : ext;
    } catch (_) {}
    return "jpg";
  }

  // Reduce an HTML description to a short, clean first line: honor the
  // author's line breaks, strip markup and entities, and stop at the first
  // link so trailing URLs, mentions, and hashtags don't leak into the name.
  function firstLine(html) {
    if (!html) return "";
    const text = String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ");
    const line = text.split("\n").map((s) => s.trim()).find(Boolean) || "";
    let out = line.split(/https?:\/\//)[0];
    out = out.replace(/[#\uFF03]\S+/g, "").replace(/@\S+/g, "");
    return out.trim().slice(0, 60);
  }

  function basenameFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      return (u.pathname.split("/").pop() || "")
        .split("@")[0]
        .replace(/\.(jpe?g|png|webp|gif)$/i, "");
    } catch (_) {
      return "";
    }
  }

  // Poster-written image description (alt text). Sites stuff placeholder
  // values on undescribed images; those must not leak into filenames.
  const ALT_PLACEHOLDERS = new Set([
    "image", "images", "photo", "picture", "media", "embedded image",
    "embedded video", "video", "gif", "alt text",
  ]);

  function readAlt(img) {
    const alt = (img.getAttribute("alt") || "").trim();
    if (!alt) return "";
    if (ALT_PLACEHOLDERS.has(alt.toLowerCase())) return "";
    if (/^https?:\/\//i.test(alt)) return ""; // some sites mirror the URL
    return alt;
  }

  // ---- X / TWITTER ----------------------------------------------------------
  const X_EXTRACTOR = {
    id: "x",
    test(loc) {
      return /(^|\.)x\.com$/.test(loc.hostname) || /(^|\.)twitter\.com$/.test(loc.hostname);
    },
    extract(img) {
      // URL identity: on /user/status/id pages - including the /photo/N
      // lightbox, where the image is NOT inside an <article> - the handle and
      // status id are in the path. Most reliable source, so read it first.
      const pathMatch = location.pathname.match(
        /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/
      );
      const urlHandle = pathMatch ? pathMatch[1] : "";
      const statusId = pathMatch ? pathMatch[2] : "";

      // Scope: the tweet's article. In the lightbox, closest() fails, so find
      // the side-panel article that links to this exact status id.
      let article = img.closest("article");
      if (!article && statusId) {
        const link = document.querySelector(
          `article a[href*="/status/${statusId}"]`
        );
        article = link ? link.closest("article") : null;
      }
      const scope = article || document;

      let poster = "";
      let handle = "";
      // Only trust User-Name when scoped to the tweet's own article - a
      // document-wide hit in the lightbox could belong to a different tweet.
      const userName = article
        ? article.querySelector('[data-testid="User-Name"]')
        : null;
      if (userName) {
        const handleEl = [...userName.querySelectorAll("span")].find((s) =>
          s.textContent.trim().startsWith("@")
        );
        handle = handleEl ? handleEl.textContent.trim() : "";
        poster = userName.textContent.split("@")[0].trim();
      }
      // URL beats a DOM guess; and it still works when no article was found.
      if (urlHandle && (!handle || !article)) handle = "@" + urlHandle;
      if (!handle) {
        const a = scope.querySelector('a[role="link"][href^="/"]');
        const seg = a && a.getAttribute("href").split("/").filter(Boolean)[0];
        if (seg && !["i", "home", "search", "explore"].includes(seg)) handle = "@" + seg;
      }

      const textEl = article
        ? article.querySelector('[data-testid="tweetText"]')
        : null;
      const caption = textEl ? textEl.textContent : "";

      const src = img.currentSrc || img.src || "";
      const idMatch = src.match(/\/media\/([A-Za-z0-9_-]+)/);
      const mediaId = idMatch ? idMatch[1] : "";

      // Position of this image within the post (1-based) and total count,
      // for numbering multi-image posts. DOM order = display order.
      let imageIndex = 0;
      let imageCount = 0;
      const mediaImgs = article
        ? [...article.querySelectorAll('img[src*="/media/"]')]
        : [];
      if (mediaImgs.length) {
        imageCount = mediaImgs.length;
        let i = mediaImgs.indexOf(img);
        // Lightbox image isn't inside the article - match by media id.
        if (i < 0 && mediaId)
          i = mediaImgs.findIndex((el) => (el.src || "").includes(mediaId));
        if (i >= 0) imageIndex = i + 1;
      }
      // Backup: the lightbox URL carries the position (/status/id/photo/N).
      const photoM = location.pathname.match(/\/photo\/(\d+)/);
      if (!imageIndex && photoM) imageIndex = parseInt(photoM[1], 10);
      // Count unknown but position > 1 proves this is a multi-image post.
      if (!imageCount && imageIndex > 1) imageCount = imageIndex;

      return {
        poster,
        handle,
        artists: findArtistHandles(caption, handle).map((h) => "@" + h),
        tags: uniq(matchesAll(HASHTAG_RE, caption)),
        caption,
        alt: readAlt(img),
        imageIndex,
        imageCount,
        fallbackBase: mediaId || basenameFromUrl(src),
        ext: extFromUrl(src),
      };
    },
  };

  // ---- BLUESKY --------------------------------------------------------------
  const BLUESKY_EXTRACTOR = {
    id: "bluesky",
    test(loc) {
      return /(^|\.)bsky\.app$/.test(loc.hostname);
    },
    extract(img) {
      const src = img.currentSrc || img.src || "";
      // CID is the segment after the DID. The @ext suffix is OPTIONAL - the
      // lightbox fullsize URL omits it (".../plain/<did>/<cid>", no "@jpeg").
      const cidMatch = src.match(/\/plain\/[^/]+\/([^/@?#]+)/);
      const cid = cidMatch ? cidMatch[1] : "";

      // URL identity: post pages (and the lightbox over them) keep the path
      // /profile/<handle>/post/<rkey>.
      const pm = location.pathname.match(/^\/profile\/([^/]+)\/post\//);
      const urlHandle = pm ? decodeURIComponent(pm[1]) : "";

      // Feed and thread items embed the author handle in their testid:
      //   data-testid="feedItem-by-<handle>" / "postThreadItem-by-<handle>"
      const ITEM_SEL =
        '[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"]';
      let item = img.closest(ITEM_SEL);

      // Lightbox opened FROM THE FEED: the expanded image is rendered in a
      // portal at the document root and the URL stays "/", so neither
      // closest() nor the URL knows the author. But the feed thumbnail of the
      // same image shares the blob CID (feed_thumbnail vs feed_fullsize, same
      // <did>/<cid>) - find that thumbnail and use ITS post container.
      if (!item && cid) {
        for (const other of document.images) {
          if (other !== img && other.src && other.src.includes(cid)) {
            item = other.closest(ITEM_SEL);
            if (item) break;
          }
        }
      }

      let rawHandle = "";
      if (item) {
        const m = (item.getAttribute("data-testid") || "").match(/-by-(.+)$/);
        if (m) rawHandle = m[1];
      }
      if (!rawHandle) rawHandle = urlHandle;

      // Scope for name/caption: the item, else the matching thread post that
      // is still in the DOM underneath the lightbox.
      let scope = item;
      if (!scope && rawHandle) {
        scope =
          document.querySelector(
            `[data-testid="postThreadItem-by-${CSS.escape(rawHandle)}"]`
          ) || null;
      }

      // Display name: a profile link with real text (not the avatar, not the
      // left-nav "Profile" button, not a bare @handle).
      let poster = "";
      const linkPool = scope
        ? scope.querySelectorAll('a[href^="/profile/"]')
        : rawHandle
          ? document.querySelectorAll(
              `a[href^="/profile/${CSS.escape(rawHandle)}"]`
            )
          : [];
      for (const a of linkPool) {
        const t = (a.textContent || "").trim();
        if (t && t !== "Profile" && !t.startsWith("@")) {
          poster = t;
          break;
        }
      }
      // Some layouts glue the handle onto the name text; strip it.
      poster = poster.replace(/@[\w.:-]+$/, "").trim();

      const handle = rawHandle
        ? "@" + rawHandle.replace(/\.bsky\.social$/i, "")
        : "";

      const textEl = scope
        ? scope.querySelector('[data-testid="postText"]')
        : null;
      const caption = textEl ? textEl.textContent : "";

      // Position within the post for multi-image numbering. The clicked img
      // may be the lightbox copy, so match by CID against the item's images.
      let imageIndex = 0;
      let imageCount = 0;
      const postImgs = item
        ? [...item.querySelectorAll('img[src*="/img/feed_"]')]
        : [];
      if (postImgs.length) {
        imageCount = postImgs.length;
        let i = postImgs.indexOf(img);
        if (i < 0 && cid)
          i = postImgs.findIndex((el) => (el.src || "").includes(cid));
        if (i >= 0) imageIndex = i + 1;
      }

      return {
        poster,
        handle,
        artists: findArtistHandles(caption, handle).map((h) => "@" + h),
        tags: uniq(matchesAll(HASHTAG_RE, caption)),
        caption,
        alt: readAlt(img),
        imageIndex,
        imageCount,
        fallbackBase: cid || basenameFromUrl(src),
        ext: extFromUrl(src),
      };
    },
  };

  // ---- MASTODON instances ----------------------------------------------------
  // Mastodon's web UI shares markup across instances, so one extractor covers
  // them all. To support another instance, add its domain here, to `matches`
  // in manifest.json, and to SITE_PATTERNS + host_permissions as needed.
  const MASTODON_INSTANCES = ["pawoo.net", "baraag.net"];

  const MASTODON_EXTRACTOR = {
    id: "mastodon",
    test(loc) {
      const h = loc.hostname;
      return MASTODON_INSTANCES.some((d) => h === d || h.endsWith("." + d));
    },
    extract(img) {
      const src = img.currentSrc || img.src || "";

      // URL identity: status pages are /@user/<id> or /@user@remote.tld/<id>.
      const pm = location.pathname.match(/^\/@([^/@]+)(?:@[^/]+)?\/\d+/);
      const urlHandle = pm ? decodeURIComponent(pm[1]) : "";

      // Container: the status the image belongs to. In the media lightbox the
      // img lives in a modal at document root, so fall back to matching the
      // media file's basename against gallery images still in the page.
      let item =
        img.closest(".detailed-status") || img.closest(".status") || null;
      const base = basenameFromUrl(src);
      if (!item && base) {
        for (const other of document.images) {
          if (other !== img && (other.src || "").includes(base)) {
            item =
              other.closest(".detailed-status") ||
              other.closest(".status") ||
              null;
            if (item) break;
          }
        }
      }

      // Author: display name and @handle from the status header.
      let poster = "";
      let handle = "";
      if (item) {
        const nameEl = item.querySelector(".display-name__html");
        if (nameEl) poster = (nameEl.textContent || "").trim();
        const accEl = item.querySelector(".display-name__account");
        if (accEl) {
          // "@user" locally or "@user@remote.tld" for federated authors.
          const acc = (accEl.textContent || "").trim().replace(/^@/, "");
          handle = "@" + acc.split("@")[0];
        }
      }
      if (!handle && urlHandle) handle = "@" + urlHandle;

      // Caption: status text. Hashtags render inside it, so HASHTAG_RE works.
      const textEl = item ? item.querySelector(".status__content") : null;
      const caption = textEl ? textEl.textContent : "";

      // Position within the post's media gallery for multi-image numbering.
      let imageIndex = 0;
      let imageCount = 0;
      const galleryImgs = item
        ? [...item.querySelectorAll(".media-gallery img")]
        : [];
      if (galleryImgs.length) {
        imageCount = galleryImgs.length;
        let i = galleryImgs.indexOf(img);
        if (i < 0 && base)
          i = galleryImgs.findIndex((el) => (el.src || "").includes(base));
        if (i >= 0) imageIndex = i + 1;
      }

      // Quality upgrade: gallery thumbs are the /small/ rendition and the
      // full file lives at /original/ on the same path. Hand the background
      // the better URL to download.
      const downloadUrl = /\/small\//.test(src)
        ? src.replace("/small/", "/original/")
        : "";

      return {
        poster,
        handle,
        artists: findArtistHandles(caption, handle).map((h) => "@" + h),
        tags: uniq(matchesAll(HASHTAG_RE, caption)),
        caption,
        alt: readAlt(img),
        imageIndex,
        imageCount,
        downloadUrl,
        fallbackBase: base,
        ext: extFromUrl(src),
      };
    },
  };

  // ---- PIXIV -----------------------------------------------------------------
  // Image URLs carry the artwork id and page index: <id>_p<N> with rendition
  // suffixes like _master1200 or _custom1200 on the non-original copies. The
  // original file lives under /img-original/ with an unknowable extension, so
  // the extractor emits candidate URLs and the background tries them in order.
  const PIXIV_EXTRACTOR = {
    id: "pixiv",
    test(loc) {
      const h = loc.hostname;
      return h === "www.pixiv.net" || h === "pixiv.net" || h.endsWith(".pixiv.net");
    },
    async extract(img) {
      const src = img.currentSrc || img.src || "";

      // Artwork id and zero-based page index from the media URL. This works
      // on both the artwork page and grid thumbnails, so it is the reliable
      // key regardless of which /users/ links happen to be on the page.
      const pm = src.match(
        /\/img\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/(\d+)_p(\d+)/
      );
      let artId = pm ? pm[1] : "";
      const page = pm ? parseInt(pm[2], 10) : 0;
      if (!artId) {
        artId =
          (location.pathname.match(/^\/(?:en\/)?artworks\/(\d+)/) || [])[1] ||
          "";
        if (!artId) {
          const a = img.closest && img.closest('a[href*="/artworks/"]');
          if (a)
            artId =
              (a.getAttribute("href").match(/\/artworks\/(\d+)/) || [])[1] ||
              "";
        }
      }

      // Author, title, and description come from the post's own JSON endpoint,
      // not the DOM. This fixes grabbing the viewer's own profile name on grid
      // pages and lets us take only the title and description (not every tag).
      let poster = "";
      let title = "";
      let descLine = "";
      let pageCount = 0;
      if (artId) {
        try {
          const r = await fetch(`${location.origin}/ajax/illust/${artId}`, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (r.ok) {
            const j = await r.json();
            const b = j && j.body;
            if (b) {
              poster = b.userName || "";
              title = b.title || b.illustTitle || "";
              pageCount = Number(b.pageCount || 0);
              descLine = firstLine(b.description || b.illustComment || "");
            }
          }
        } catch (_) {
          /* endpoint unavailable - falls back to the id-based name below */
        }
      }

      // Rendition candidates: the full-resolution original (png then jpg).
      let downloadUrls = [];
      if (/pximg\.net/.test(src) && !/\/img-original\//.test(src)) {
        const base = src
          .replace(/\/c\/[^/]+\//, "/")
          .replace(/\/(?:img-master|custom-thumb)\//, "/img-original/")
          .replace(/_(?:master|custom|square)1200/, "");
        downloadUrls = [
          base.replace(/\.(?:jpe?g|png)$/i, ".png"),
          base.replace(/\.(?:jpe?g|png)$/i, ".jpg"),
        ];
      }

      const imageIndex = pm ? page + 1 : 0;
      const imageCount = pageCount > 1 ? pageCount : page > 0 ? page + 1 : 0;

      return {
        poster, // real artist from the API
        handle: "",
        artists: [],
        // Title and first description line only. Kept as tag entries so each
        // stays intact (multi-word titles aren't truncated to a word budget),
        // and the large tag list is intentionally omitted.
        tags: [title, descLine].filter(Boolean),
        caption: "",
        alt: "",
        imageIndex,
        imageCount,
        downloadUrls,
        fallbackBase: artId ? `${artId}_p${page}` : basenameFromUrl(src),
        ext: extFromUrl(src),
      };
    },
  };

  // ---- GALLERIES (tag-categorized image boards) ------------------------------
  // These sites expose a per-post JSON endpoint (/posts/<id>.json) whose tags
  // are grouped by category. Filenames are built from the descriptive
  // categories (artist, copyright, character, species) in that order; the
  // "general" bucket is a large alphabetical dump and is omitted, as are meta
  // and lore tags. To support another such site add its domain here, to
  // `matches` (manifest), and to SITE_PATTERNS + host_permissions.
  const GALLERY_INSTANCES = ["e621.net"];

  const GALLERY_EXTRACTOR = {
    id: "gallery",
    test(loc) {
      const h = loc.hostname;
      if (GALLERY_INSTANCES.some((d) => h === d || h.endsWith("." + d)))
        return true;
      // User-added sites route through the gallery extractor too: it tries the
      // booru JSON endpoint and otherwise falls back to filename cleaning.
      return galleryUserSites.some((d) => h === d || h.endsWith("." + d));
    },
    async extract(img) {
      const src = img.currentSrc || img.src || "";
      let fallbackBase = basenameFromUrl(src);
      let ext = extFromUrl(src);

      // Post id from the page URL, or the clicked thumbnail's enclosing link.
      let postId = (location.pathname.match(/\/posts\/(\d+)/) || [])[1] || "";
      if (!postId) {
        const a =
          (img.closest && img.closest('a[href*="/posts/"]')) ||
          document.querySelector('a[href*="/posts/"]');
        if (a)
          postId =
            (a.getAttribute("href").match(/\/posts\/(\d+)/) || [])[1] || "";
      }

      let tags = [];
      let downloadUrl = "";
      if (postId) {
        try {
          const r = await fetch(`${location.origin}/posts/${postId}.json`, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (r.ok) {
            const j = await r.json();
            const post = j.post || j;
            const t = (post && post.tags) || {};
            const take = (arr, n) =>
              Array.isArray(arr) ? arr.slice(0, n) : [];
            // Descriptive categories only, in filename order.
            tags = [
              ...take(t.artist, 3),
              ...take(t.copyright, 2),
              ...take(t.character, 3),
              ...take(t.species, 3),
            ].filter((x) => x && x !== "conditional_dnp");
            if (post && post.file) {
              if (post.file.url) downloadUrl = post.file.url;
              if (post.file.ext) ext = post.file.ext;
              if (post.file.md5) fallbackBase = post.file.md5;
            }
          }
        } catch (_) {
          /* API blocked or offline - fall back to the file hash below */
        }
      }

      return {
        poster: "",
        handle: "",
        artists: [],
        tags, // ordered category tags become the filename
        caption: "",
        alt: "",
        imageIndex: 0,
        imageCount: 0,
        downloadUrl,
        fallbackBase,
        ext,
      };
    },
  };

  // ---- GENERIC (only reached if matched-site selectors above miss) ----------
  const GENERIC_EXTRACTOR = {
    id: "generic",
    test() {
      return true;
    },
    extract(img) {
      const src = img.currentSrc || img.src || "";
      const fig = img.closest("figure");
      const cap =
        (img.getAttribute("alt") || "").trim() ||
        (fig && fig.querySelector("figcaption")
          ? fig.querySelector("figcaption").textContent.trim()
          : "");
      return {
        poster: "",
        handle: "",
        artists: [],
        tags: uniq(matchesAll(HASHTAG_RE, cap)),
        caption: cap,
        alt: readAlt(img),
        fallbackBase: basenameFromUrl(src),
        ext: extFromUrl(src),
      };
    },
  };

  window.SIS_EXTRACTORS = [X_EXTRACTOR, BLUESKY_EXTRACTOR, MASTODON_EXTRACTOR, PIXIV_EXTRACTOR, GALLERY_EXTRACTOR, GENERIC_EXTRACTOR];
})();

/* =============================================================================
 * content.js  -  content-script world (loaded after extractors.js)
 *
 * Tracks the element under the most recent right-click (the contextMenus API
 * gives us the image URL but not the DOM node), then on request builds the
 * final filename: poster (@handle) - @artist #tags.ext, or the site's random
 * string if nothing useful was found.
 * ========================================================================== */

(function () {
  "use strict";

  const ext = globalThis.browser ?? globalThis.chrome;

  let lastTarget = null;
  document.addEventListener(
    "contextmenu",
    (e) => {
      lastTarget = e.target;
    },
    true // capture, so we still see it if the page stops propagation
  );

  const pickExtractor = () =>
    (window.SIS_EXTRACTORS || []).find((x) => x.test(location)) || null;

  // Rendition-tolerant filename key: strips the extension marker forms that
  // differ between copies of the same file (Bluesky's @ext, pixiv's
  // _master1200 family) so two renditions compare equal.
  function basename(u) {
    try {
      return new URL(u, location.href).pathname
        .split("/")
        .pop()
        .split("@")[0]
        .replace(/_(?:master|custom|square)1200/, "");
    } catch (_) {
      return "";
    }
  }

  function resolveImage(srcUrl, byUrlOnly) {
    // byUrlOnly is set for cross-tab recovery queries: this tab was not the
    // one right-clicked, so its lastTarget is stale and must be ignored.
    if (!byUrlOnly && lastTarget) {
      if (lastTarget.tagName === "IMG") return lastTarget;
      const inner = lastTarget.querySelector && lastTarget.querySelector("img");
      if (inner) return inner;
      const up = lastTarget.closest && lastTarget.closest("img");
      if (up) return up;
    }
    if (srcUrl) {
      const imgs = [...document.images];
      const exact = imgs.find(
        (i) => i.currentSrc === srcUrl || i.src === srcUrl
      );
      if (exact) return exact;
      // Rendition-tolerant match: Mastodon keeps the same hash filename
      // across small/original, and Bluesky keeps the CID across renditions,
      // so the basename links a direct media URL back to its feed thumbnail.
      const nb = basename(srcUrl);
      if (nb) {
        const byName = imgs.find(
          (i) => basename(i.currentSrc || i.src) === nb
        );
        if (byName) return byName;
      }
    }
    return null;
  }

  // ---- filename assembly ----------------------------------------------------

  // Per-token cleaner. Keeps Unicode letters/numbers so accents survive
  // (Māui stays Māui), drops @ and #, and turns EVERY other character  - 
  // including everything illegal on Windows or Linux (\ / : * ? " < > |, control
  // chars, etc.) - into a single underscore separator.
  function safeToken(s) {
    return (s || "")
      .normalize("NFC")
      .replace(/[@#]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  // Low-information words to skip when condensing alt text into keywords.
  const STOPWORDS = new Set([
    "a", "an", "the", "of", "in", "on", "at", "with", "and", "or", "to",
    "is", "are", "was", "were", "its", "it", "this", "that", "there",
  ]);
  const ALT_MAX_WORDS = 4;
  const CAPTION_MAX_WORDS = 4;

  // Condense free text into filename keywords: skip @mentions, #tags, and
  // links (captured separately), drop stopwords, cap the count.
  // "Character doodle #fanart" → ["Character", "doodle"], tags and stops removed.
  function textKeywords(text, max) {
    if (!text) return [];
    return text
      .split(/\s+/)
      .filter((w) => !/^[@#]/.test(w) && !/^https?:\/\//i.test(w))
      .map(safeToken)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()))
      .slice(0, max);
  }

  // Flat underscore format:
  //   poster_handle_artist_tag_captionwords_altwords  (accents kept)
  function buildBase(d) {
    const poster = safeToken(d.poster);
    const handle = safeToken(d.handle);

    const parts = [];
    if (poster) parts.push(poster);
    // Skip the handle when it just repeats the poster name (common on Bluesky).
    if (handle && handle.toLowerCase() !== poster.toLowerCase()) parts.push(handle);
    for (const a of d.artists || []) {
      const t = safeToken(a);
      if (t) parts.push(t);
    }
    for (const t of d.tags || []) {
      const k = safeToken(t);
      if (k) parts.push(k);
    }
    // Post-text keywords, then image-description (alt) keywords, deduped.
    const seen = new Set(parts.map((p) => p.toLowerCase()));
    for (const w of [
      ...textKeywords(d.caption, CAPTION_MAX_WORDS),
      ...textKeywords(d.alt, ALT_MAX_WORDS),
    ]) {
      if (!seen.has(w.toLowerCase())) {
        parts.push(w);
        seen.add(w.toLowerCase());
      }
    }
    return parts.join("_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  }

  // Windows reserved device names - a file named exactly these won't save.
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  // Composed name WITHOUT extension. The background script appends the right
  // extension after it decides the output format (it may convert webp→png).
  function baseName(d) {
    let base = buildBase(d);
    const smart = !!base;
    if (!base) base = safeToken(d.fallbackBase); // fall back to the random string
    base = (base || "image").slice(0, 180).replace(/^_+|_+$/g, "") || "image";
    // Multi-image posts get a position suffix (01, 02, …) so each save is
    // distinct. Single-image posts and CDN-string fallbacks stay unsuffixed  - 
    // fallback names are already unique per image.
    if (smart && d.imageCount > 1 && d.imageIndex > 0) {
      base += String(d.imageIndex).padStart(2, "0");
    }
    if (RESERVED.test(base)) base += "_";
    return base;
  }

  // ---- respond to the background script -------------------------------------

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "SIS_EXTRACT") return false;
    (async () => {
      try {
        const img = resolveImage(msg.srcUrl, !!msg.byUrlOnly);
        const extractor = pickExtractor();
        if (!img || !extractor) {
          sendResponse({ ok: false });
          return;
        }
        // extract may be async (some sources fetch a JSON metadata endpoint).
        const data = await extractor.extract(img);
        sendResponse({
          ok: true,
          base: baseName(data),
          urlExt: data.ext,
          downloadUrl: data.downloadUrl || "",
          downloadUrls: data.downloadUrls || [],
        });
      } catch (err) {
        sendResponse({ ok: false, reason: String(err && err.message) });
      }
    })();
    return true; // async response
  });
})();
