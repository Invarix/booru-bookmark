// Booru Bookmark - popup.js

const STORAGE_PFX = "booru_bm_";

// Read a single site's bookmarks, sync first (cross-device), then falling back
// to the legacy local area so pre-sync bookmarks still show a correct count.
async function readSite(storageKey) {
  try {
    const s = await chrome.storage.sync.get(storageKey);
    // A key PRESENT in sync is authoritative even when empty (tombstone from a
    // deliberate clear). Only fall back to the mirror when the key is absent.
    if (s && (storageKey in s)) return s[storageKey] || {};
  } catch (_) { /* fall through to mirror */ }
  try {
    const l = await chrome.storage.local.get(storageKey);
    return l[storageKey] || {};
  } catch (_) { return {}; }
}

// Clear sites by writing an EMPTY OBJECT (a tombstone) to sync and emptying the
// local mirror. The tombstone makes a deliberate clear distinguishable from a
// storage purge: reads treat a present-but-empty sync key as authoritative, so
// a stale mirror on another device can never resurrect cleared bookmarks,
// while a truly absent key still lets the mirror restore after a purge.
async function clearEverywhere(keys) {
  const arr = Array.isArray(keys) ? keys : [keys];
  if (!arr.length) return;
  const tombstones = {};
  arr.forEach(k => { tombstones[k] = {}; });
  try { await chrome.storage.sync.set(tombstones); }  catch (_) {}
  try { await chrome.storage.local.set(tombstones); } catch (_) {}
}

// Collect every booru_bm_ key present in either area.
async function allSiteKeys() {
  const keys = new Set();
  try {
    const s = await chrome.storage.sync.get(null);
    Object.keys(s).forEach(k => { if (k.startsWith(STORAGE_PFX)) keys.add(k); });
  } catch (_) {}
  try {
    const l = await chrome.storage.local.get(null);
    Object.keys(l).forEach(k => { if (k.startsWith(STORAGE_PFX)) keys.add(k); });
  } catch (_) {}
  return [...keys];
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const siteNameEl = document.getElementById("site-name");
  const bmCountEl  = document.getElementById("bm-count");
  const emptyEl    = document.getElementById("empty-state");
  const btnJump    = document.getElementById("btn-jump");

  if (!tab?.url) {
    siteNameEl.textContent = "No active tab";
    bmCountEl.textContent  = "0";
    btnJump.disabled = true;
    return;
  }

  let url;
  try { url = new URL(tab.url); } catch { return; }

  siteNameEl.textContent = url.hostname.replace(/^www\./, "");

  const storageKey = STORAGE_PFX + url.origin;
  const stored     = await readSite(storageKey);
  const count      = Object.keys(stored).length;

  bmCountEl.textContent = count;
  if (count === 0) {
    emptyEl.style.display = "flex";
    btnJump.disabled = true;
  }

  // Jump to bookmark - sends message to content script then closes popup
  // so the user can see the page scroll to the bookmarked thumbnail.
  btnJump.addEventListener("click", () => {
    chrome.tabs.sendMessage(tab.id, { type: "JUMP_TO_BOOKMARK" }).catch(() => {});
    window.close();
  });

  // Clear this site's bookmarks (both areas)
  document.getElementById("btn-clear-page").addEventListener("click", async () => {
    await clearEverywhere(storageKey);
    chrome.tabs.sendMessage(tab.id, { type: "CLEAR_ALL" }).catch(() => {});
    bmCountEl.textContent = "0";
    emptyEl.style.display = "flex";
    btnJump.disabled = true;
  });

  // Clear ALL bookmarks across every booru site (both areas)
  document.getElementById("btn-clear-all").addEventListener("click", async () => {
    const keys = await allSiteKeys();
    await clearEverywhere(keys);
    chrome.tabs.sendMessage(tab.id, { type: "CLEAR_ALL" }).catch(() => {});
    bmCountEl.textContent = "0";
    emptyEl.style.display = "flex";
    btnJump.disabled = true;
  });
})();
