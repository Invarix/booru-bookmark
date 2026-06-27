// Booru Bookmark - popup.js

const STORAGE_PFX = "booru_bm_";

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
  const data       = await chrome.storage.local.get(storageKey);
  const stored     = data[storageKey] || {};
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

  // Clear this site's bookmarks
  document.getElementById("btn-clear-page").addEventListener("click", async () => {
    await chrome.storage.local.remove(storageKey);
    chrome.tabs.sendMessage(tab.id, { type: "CLEAR_ALL" }).catch(() => {});
    bmCountEl.textContent = "0";
    emptyEl.style.display = "flex";
    btnJump.disabled = true;
  });

  // Clear ALL bookmarks across every booru site
  document.getElementById("btn-clear-all").addEventListener("click", async () => {
    const all  = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith(STORAGE_PFX));
    if (keys.length) await chrome.storage.local.remove(keys);
    chrome.tabs.sendMessage(tab.id, { type: "CLEAR_ALL" }).catch(() => {});
    bmCountEl.textContent = "0";
    emptyEl.style.display = "flex";
    btnJump.disabled = true;
  });
})();
