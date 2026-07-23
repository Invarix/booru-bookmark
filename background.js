/* =============================================================================
 * background.js  -  Chromium MV3 service worker
 *
 * Right-click an image on a supported site → "Download with Socialnamer"
 * submenu. Picks a smart filename from the post (poster/handle/artist/tags,
 * symbols stripped) and saves via downloads.download({ saveAs:true }), which
 * shows an editable filename field pre-filled with that name.
 *
 * Format handling (the webp problem): the served URL can LIE about the format
 * (Bluesky serves webp under a "...@jpeg" URL via content negotiation), so we
 * fetch the bytes and sniff the magic number instead of trusting the extension.
 *   - Auto:  webp → PNG, everything else kept as-is.
 *   - Force PNG / Force JPEG: re-encode via OffscreenCanvas.
 *   - Keep original: saved untouched, with a corrected extension.
 * Conversion needs read access to the image CDNs (see host_permissions).
 * ========================================================================== */

"use strict";

const ext = globalThis.browser ?? globalThis.chrome;

const MENU = {
  parent: "sis_parent",
  keep: "sis_keep",
  jpg: "sis_jpg",
  png: "sis_png",
};

const SITE_PATTERNS = [
  "https://x.com/*",
  "https://twitter.com/*",
  "https://bsky.app/*",
  // Mastodon instances (one generic extractor covers them all)
  "https://pawoo.net/*",
  "https://*.pawoo.net/*",
  "https://baraag.net/*",
  "https://*.baraag.net/*",
  "https://www.pixiv.net/*",
  "https://e621.net/*",
  // Direct image URLs (opened in their own tab) - no post DOM here, but the
  // menu should still work; the background derives what it can from the URL.
  "https://cdn.bsky.app/*",
  "https://pbs.twimg.com/*",
  "https://i.pximg.net/*",
  "https://*.e621.net/*",
];

// ---- menu ------------------------------------------------------------------

async function buildMenu() {
  // Named sites always work from SITE_PATTERNS. User-added sites are appended
  // when present; any storage failure leaves the named behavior untouched.
  let patterns = SITE_PATTERNS;
  try {
    const { userSites = [] } = await ext.storage.local.get({ userSites: [] });
    if (userSites.length) {
      patterns = SITE_PATTERNS.concat(userSites.map((d) => `https://${d}/*`));
    }
  } catch (_) {
    /* storage unavailable - named sites still work */
  }
  ext.contextMenus.removeAll(() => {
    ext.contextMenus.create({
      id: MENU.parent,
      title: "Download with Socialnamer",
      contexts: ["image"],
      documentUrlPatterns: patterns,
    });
    const child = (id, title) =>
      ext.contextMenus.create({
        id,
        parentId: MENU.parent,
        title,
        contexts: ["image"],
        documentUrlPatterns: patterns,
      });
    child(MENU.keep, "Keep original format");
    child(MENU.jpg, "Force JPG");
    child(MENU.png, "Force PNG");
  });
}

// ---- user-added sites (optional, isolated from the named-site paths) --------
// Named sites inject via the static content_scripts manifest entry and are
// never touched here. This registers content.js only for domains the user
// explicitly added and granted host access to, and re-runs on startup so the
// registration persists. Wrapped so any failure degrades to "user sites don't
// work this session" without affecting the named sites.
async function syncUserSiteScripts() {
  if (!ext.scripting || !ext.scripting.registerContentScripts) return;
  try {
    try {
      await ext.scripting.unregisterContentScripts({ ids: ["sis-user-sites"] });
    } catch (_) {
      /* nothing registered yet */
    }
    const { userSites = [] } = await ext.storage.local.get({ userSites: [] });
    const granted = [];
    for (const d of userSites) {
      const pat = `https://${d}/*`;
      try {
        if (await ext.permissions.contains({ origins: [pat] })) granted.push(pat);
      } catch (_) {
        /* skip this one */
      }
    }
    if (granted.length) {
      await ext.scripting.registerContentScripts([
        {
          id: "sis-user-sites",
          matches: granted,
          js: ["content.js"],
          runAt: "document_idle",
          allFrames: true,
        },
      ]);
    }
  } catch (err) {
    console.error("[Socialnamer] user-site script sync failed:", err);
  }
}

// The options page updates storage/permissions, then pings the background to
// re-register scripts and rebuild the menu.
ext.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "SIS_SITES_CHANGED") {
    syncUserSiteScripts();
    buildMenu();
  }
  return false;
});

ext.runtime.onInstalled.addListener(buildMenu);
ext.runtime.onStartup && ext.runtime.onStartup.addListener(buildMenu);
ext.runtime.onInstalled.addListener(syncUserSiteScripts);
ext.runtime.onStartup && ext.runtime.onStartup.addListener(syncUserSiteScripts);

// pximg refuses requests without a pixiv Referer. Downloads set the header
// directly; the background's own sniff and convert fetches cannot, so a
// declarativeNetRequest session rule injects it for that host only.
function installPximgRefererRule() {
  if (!ext.declarativeNetRequest || !ext.declarativeNetRequest.updateSessionRules) return;
  ext.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {
            requestDomains: ["i.pximg.net"],
            resourceTypes: ["xmlhttprequest", "image", "other"],
          },
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.pixiv.net/" },
            ],
          },
        },
      ],
    })
    .catch(() => {});
}
ext.runtime.onInstalled.addListener(installPximgRefererRule);
ext.runtime.onStartup && ext.runtime.onStartup.addListener(installPximgRefererRule);

// ---- click -----------------------------------------------------------------

ext.contextMenus.onClicked.addListener(async (info, tab) => {
  if (![MENU.keep, MENU.jpg, MENU.png].includes(info.menuItemId)) return;
  let srcUrl = info.srcUrl;
  if (!srcUrl || !tab) return;

  // Smart filename base from the content script (no extension yet).
  let base = "image";
  let urlExt = "jpg";
  let gotSmart = false;
  let downloadCandidates = [];
  try {
    const resp = await ext.tabs.sendMessage(
      tab.id,
      { type: "SIS_EXTRACT", srcUrl },
      info.frameId != null ? { frameId: info.frameId } : undefined
    );
    if (resp && resp.ok) {
      base = resp.base || base;
      urlExt = resp.urlExt || urlExt;
      // Extractor may know a better rendition of the same file, e.g.
      // Mastodon's /original/ next to the /small/ thumb that was clicked.
      if (resp.downloadUrl) srcUrl = resp.downloadUrl;
      if (resp.downloadUrls && resp.downloadUrls.length) downloadCandidates = resp.downloadUrls;
      gotSmart = true;
    }
  } catch (_) {
    base = basenameFromUrl(srcUrl) || base;
    urlExt = extFromUrl(srcUrl) || urlExt;
  }

  // Direct media URLs (image opened in its own tab): the page has no post
  // DOM, but the tab the user came from usually still does. Ask the content
  // scripts in open supported-site tabs to locate this image by its
  // rendition-stable basename and extract from the post there.
  if (!gotSmart) {
    const found = await findInOpenTabs(srcUrl);
    if (found) {
      base = found.base || base;
      urlExt = found.urlExt || urlExt;
      if (found.downloadUrl) srcUrl = found.downloadUrl;
      gotSmart = true;
    }
  }

  // Direct pximg URLs: the artwork id in the path keys pixiv's public JSON
  // endpoint, which returns artist, title, and tags. Used only when nothing
  // else produced a name.
  if (!gotSmart) {
    const px = await resolvePixivArtwork(srcUrl);
    if (px) {
      base = px;
      gotSmart = true;
    }
  }

  // Direct cdn.bsky.app URLs (image opened in its own tab): no post DOM, but
  // the URL carries the author DID and blob CID. Find the post via the public
  // AppView API to recover author, text, tags, and alt; fall back to just the
  // author profile, then to the CID string.
  if (!gotSmart) {
    const ids = parseBskyCdnUrl(srcUrl);
    if (ids) {
      const post = (await bskyPostFromCid(ids.did, ids.cid)) || (await bskyProfile(ids.did));
      if (post) {
        const b = bgBskyBase(post);
        if (b) base = b;
      }
    }
  }

  // Fetch the bytes once so we can sniff the REAL format (and convert if
  // asked). Candidates from the extractor are better renditions of the same
  // file (e.g. pixiv originals with unknown extension); first success wins.
  // A response is only accepted if its bytes sniff as a real image - this
  // rejects HTML error pages some hosts return with a 200 status, which would
  // otherwise be saved as an .htm file.
  let blob = null;
  let served = urlExt;
  for (const cand of [...downloadCandidates, srcUrl]) {
    try {
      const r = await fetch(cand, { credentials: "include" });
      if (!r.ok) continue;
      const b = await r.blob();
      const s = await sniffFormat(b);
      if (!s) continue; // not an image (e.g. an HTML error page) - skip
      blob = b;
      served = s;
      srcUrl = cand;
      break;
    } catch (_) {
      /* try the next candidate; total failure falls back below */
    }
  }

  // Decide target format from the chosen menu item.
  let target;
  if (info.menuItemId === MENU.png) target = "png";
  else if (info.menuItemId === MENU.jpg) target = "jpg";
  else target = served; // keep original

  const canConvert =
    !!blob &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function";
  const wantConvert = (target === "png" || target === "jpg") && target !== served;

  try {
    if (canConvert && wantConvert) {
      await saveConverted(blob, target, `${base}.${target}`, srcUrl);
    } else if (blob) {
      // Save the exact image bytes we already fetched and verified. This
      // guarantees an image with the sniffed extension and never re-requests
      // a URL that might resolve to HTML (the cause of stray .htm saves).
      await saveBlob(blob, `${base}.${served}`, srcUrl);
    } else {
      // Nothing could be read/verified (e.g. the fetch was blocked). Fall
      // back to downloading the URL directly, forcing the Referer that the
      // pixiv image host requires.
      const opts = { url: srcUrl, filename: `${base}.${served}`, saveAs: true };
      if (/pximg\.net/.test(srcUrl)) {
        opts.headers = [{ name: "Referer", value: "https://www.pixiv.net/" }];
      }
      await ext.downloads.download(opts);
    }
  } catch (err) {
    console.error("[Socialnamer] save failed:", err);
    try {
      await ext.downloads.download({ url: srcUrl, saveAs: true });
    } catch (_) {}
  }
});

// ---- conversion ------------------------------------------------------------

// Save already-fetched image bytes via a blob URL (Firefox event page) or a
// data URL (Chrome service worker, which has no URL.createObjectURL). Falls
// back to a direct URL download only if handing over the bytes fails.
async function saveBlob(blob, filename, fallbackUrl) {
  try {
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      const blobUrl = URL.createObjectURL(blob);
      try {
        await ext.downloads.download({ url: blobUrl, filename, saveAs: true });
      } finally {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      }
    } else {
      const dataUrl = await blobToDataURL(blob);
      await ext.downloads.download({ url: dataUrl, filename, saveAs: true });
    }
  } catch (err) {
    console.error("[Socialnamer] blob save failed, using URL:", err);
    const opts = { url: fallbackUrl, filename, saveAs: true };
    if (/pximg\.net/.test(fallbackUrl)) {
      opts.headers = [{ name: "Referer", value: "https://www.pixiv.net/" }];
    }
    await ext.downloads.download(opts);
  }
}

async function saveConverted(blob, fmt, filename, srcFallbackUrl) {
  try {
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    if (fmt === "jpg") {
      // JPEG has no alpha; flatten transparency onto white instead of black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bmp, 0, 0);
    const mime = fmt === "png" ? "image/png" : "image/jpeg";
    const out = await canvas.convertToBlob(
      fmt === "png" ? { type: mime } : { type: mime, quality: 0.95 }
    );
    // Firefox's event-page background has URL.createObjectURL; blob URLs are
    // more robust than large base64 data URLs. Chrome's service worker lacks
    // it, so fall back to a data URL there.
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      const blobUrl = URL.createObjectURL(out);
      try {
        await ext.downloads.download({ url: blobUrl, filename, saveAs: true });
      } finally {
        // Revoke after a grace period so the download can start reading.
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      }
    } else {
      const dataUrl = await blobToDataURL(out);
      await ext.downloads.download({ url: dataUrl, filename, saveAs: true });
    }
  } catch (err) {
    console.error("[Socialnamer] convert failed, saving original:", err);
    await ext.downloads.download({ url: srcFallbackUrl, saveAs: true });
  }
}

// ---- helpers ---------------------------------------------------------------

// Ask content scripts in open supported-site tabs to locate an image by URL
// (rendition-tolerant basename matching happens on their side) and return the
// extracted naming info. Works without the "tabs" permission because
// tabs.query with url filters is granted by our existing host permissions.
async function findInOpenTabs(srcUrl) {
  const pageUrls = [
    "https://x.com/*",
    "https://twitter.com/*",
    "https://bsky.app/*",
    "https://pawoo.net/*",
    "https://baraag.net/*",
    "https://www.pixiv.net/*",
    "https://e621.net/*",
  ];
  let tabs = [];
  try {
    tabs = await ext.tabs.query({ url: pageUrls });
  } catch (_) {
    return null;
  }
  for (const t of tabs) {
    try {
      const resp = await ext.tabs.sendMessage(t.id, {
        type: "SIS_EXTRACT",
        srcUrl,
        byUrlOnly: true,
      });
      if (resp && resp.ok && resp.base) return resp;
    } catch (_) {
      /* tab without a live content script; try the next one */
    }
  }
  return null;
}

// -- pixiv public artwork endpoint (read-only) --
// From a direct pximg URL, recover artist, title, and tags via the artwork
// id in the path. The request carries no user data beyond browser cookies
// for pixiv itself, which the user's own page visits already send.
async function resolvePixivArtwork(srcUrl) {
  const m = String(srcUrl).match(/pximg\.net\/.*\/(\d+)_p(\d+)/);
  if (!m) return null;
  const [, artId, page] = m;
  try {
    const r = await fetch(`https://www.pixiv.net/ajax/illust/${artId}`, {
      credentials: "include",
    });
    if (!r.ok) return null;
    const j = await r.json();
    const b = j && j.body;
    if (!b) return null;
    // Artist, title, and the first line of the description only - matching the
    // on-page naming. The large tag list is intentionally left out.
    const descLine = bgFirstLine(b.description || b.illustComment || "");
    const parts = [b.userName, b.title || b.illustTitle, descLine]
      .map(bgToken)
      .filter(Boolean);
    if (!parts.length) return null;
    let out = parts.join("_").replace(/_+/g, "_").slice(0, 180);
    const count = Number(b.pageCount || 0);
    if (count > 1) out += String(Number(page) + 1).padStart(2, "0");
    return out;
  } catch (_) {
    return null;
  }
}

// Description first line (background copy of the content-script helper): honor
// line breaks, strip markup/entities, stop at the first link.
function bgFirstLine(html) {
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

// -- Bluesky public AppView API (unauthenticated, read-only) --
// For a direct cdn.bsky.app image URL there is no post DOM at all, but the
// URL carries the author DID and the image blob CID. The public API lets us
// find the post that embeds that exact blob and recover author, text, tags,
// and alt - the same data the content script reads on bsky.app itself.

const BSKY_API = "https://public.api.bsky.app/xrpc";

function parseBskyCdnUrl(srcUrl) {
  const m = String(srcUrl).match(
    /cdn\.bsky\.app\/img\/[^/]+\/plain\/(did:[^/]+)\/([^/@?#]+)/
  );
  return m ? { did: decodeURIComponent(m[1]), cid: m[2] } : null;
}

// Scan the author's recent media posts for the one embedding this blob CID.
async function bskyPostFromCid(did, cid) {
  try {
    const u =
      `${BSKY_API}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}` +
      `&limit=100&filter=posts_with_media`;
    const r = await fetch(u);
    if (!r.ok) return null;
    const j = await r.json();
    for (const it of j.feed || []) {
      const post = it && it.post;
      if (!post || !post.author || post.author.did !== did) continue; // skip reposts

      let hit = false;
      let alt = "";
      // Record-level blob refs: embed.images[].image.ref.$link === cid
      const imgsOf = (e) =>
        !e ? [] : Array.isArray(e.images) ? e.images : e.media ? imgsOf(e.media) : [];
      for (const im of imgsOf(post.record && post.record.embed)) {
        const link = im && im.image && im.image.ref && im.image.ref["$link"];
        if (link === cid) { hit = true; alt = im.alt || ""; break; }
      }
      // View-level fallback: hydrated embed URLs contain the cid.
      if (!hit) {
        for (const im of imgsOf(post.embed)) {
          if ((im.fullsize || "").includes(cid) || (im.thumb || "").includes(cid)) {
            hit = true; alt = im.alt || ""; break;
          }
        }
      }
      if (hit) {
        return {
          displayName: post.author.displayName || "",
          handle: post.author.handle || "",
          text: (post.record && post.record.text) || "",
          alt,
        };
      }
    }
  } catch (_) {}
  return null;
}

// Author profile (handle + display name) when the post itself can't be found.
async function bskyProfile(did) {
  try {
    const r = await fetch(
      `${BSKY_API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
    );
    if (!r.ok) return null;
    const j = await r.json();
    return { displayName: j.displayName || "", handle: j.handle || "", text: "", alt: "" };
  } catch (_) {
    return null;
  }
}

// -- filename assembly for the API path (mirrors the content-script policy) --

const BG_STOP = new Set([
  "a","an","the","of","in","on","at","with","and","or","to",
  "is","are","was","were","its","it","this","that","there",
]);

function bgToken(s) {
  return (s || "")
    .normalize("NFC")
    .replace(/[@#]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function bgWords(text, max) {
  if (!text) return [];
  return text
    .split(/\s+/)
    .filter((w) => !/^[@#]/.test(w) && !/^https?:\/\//i.test(w))
    .map(bgToken)
    .filter((w) => w.length > 1 && !BG_STOP.has(w.toLowerCase()))
    .slice(0, max);
}

function bgBskyBase(p) {
  const poster = bgToken(p.displayName);
  const handle = bgToken((p.handle || "").replace(/\.bsky\.social$/i, ""));
  const parts = [];
  if (poster) parts.push(poster);
  if (handle && handle.toLowerCase() !== poster.toLowerCase()) parts.push(handle);
  const seen = new Set(parts.map((x) => x.toLowerCase()));
  const text = p.text || "";
  // hashtags first, then caption keywords, then alt keywords - same order
  // and caps as the content script.
  const tags = [...text.matchAll(/#([\p{L}\p{N}_]{1,40})/gu)].map((m) => bgToken(m[1]));
  for (const w of [...tags, ...bgWords(text, 4), ...bgWords(p.alt, 4)]) {
    if (w && w.length > 1 && !seen.has(w.toLowerCase())) {
      parts.push(w);
      seen.add(w.toLowerCase());
    }
  }
  return parts.join("_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 180);
}

// Read the first bytes and identify the real format. Beats trusting the URL,
// which Bluesky mislabels (webp served under "...@jpeg").
async function sniffFormat(blob) {
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (b.length < 12) return null;
  // RIFF????WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  return null;
}

function extFromUrl(url) {
  try {
    const u = new URL(url);
    const q = (u.searchParams.get("format") || "").toLowerCase();
    if (q) return q === "jpeg" ? "jpg" : q;
    const at = u.pathname.split("@").pop().toLowerCase();
    if (["jpg", "jpeg", "png", "webp", "gif"].includes(at)) return at === "jpeg" ? "jpg" : at;
    const ex = u.pathname.split(".").pop().toLowerCase();
    if (["jpg", "jpeg", "png", "webp", "gif"].includes(ex)) return ex === "jpeg" ? "jpg" : ex;
  } catch (_) {}
  return "jpg";
}

function basenameFromUrl(url) {
  try {
    return (new URL(url).pathname.split("/").pop() || "")
      .split("@")[0]
      .replace(/\.(jpe?g|png|webp|gif)$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f@#]/g, "");
  } catch (_) {
    return "";
  }
}

// arrayBuffer → base64 data URL (service workers have no URL.createObjectURL).
async function blobToDataURL(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}
