// Booru Bookmark -- background.js

const MENU_BOOKMARK   = "booru_bookmark_set";
const MENU_UNBOOKMARK = "booru_bookmark_clear";
const MENU_CLEAR_ALL  = "booru_bookmark_clear_all";
const BOORU_TABS_KEY  = "booru_active_tabs"; // persisted in chrome.storage.local

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    const base = {
      contexts: ["image", "link", "video"],
      visible:  false,
    };
    chrome.contextMenus.create({ ...base, id: MENU_BOOKMARK,   title: "📌 Bookmark Image" });
    chrome.contextMenus.create({ ...base, id: MENU_UNBOOKMARK, title: "✖ Remove Bookmark" });
    chrome.contextMenus.create({ ...base, id: "booru_sep",     type: "separator" });
    chrome.contextMenus.create({ ...base, id: MENU_CLEAR_ALL,  title: "🗑 Clear All Bookmarks on This Page" });
  });
}

function setMenusVisible(visible) {
  const upd = { visible };
  chrome.contextMenus.update(MENU_BOOKMARK,   upd).catch(() => {});
  chrome.contextMenus.update(MENU_UNBOOKMARK, upd).catch(() => {});
  chrome.contextMenus.update("booru_sep",     upd).catch(() => {});
  chrome.contextMenus.update(MENU_CLEAR_ALL,  upd).catch(() => {});
}

// Read the persisted booru tab set from storage.
async function getBooruTabs() {
  const d = await chrome.storage.local.get(BOORU_TABS_KEY);
  return new Set(d[BOORU_TABS_KEY] || []);
}

async function saveBooruTabs(set) {
  await chrome.storage.local.set({ [BOORU_TABS_KEY]: [...set] });
}

// Sync menu visibility to whether the currently active tab is a known booru tab.
async function syncMenusForActiveTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab) return;
  const booruTabs = await getBooruTabs();
  setMenusVisible(booruTabs.has(activeTab.id));
}

// Content script sends IS_BOORU when it confirms this is a booru page.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== "IS_BOORU" || !sender.tab?.id) return;
  const tabId = sender.tab.id;
  getBooruTabs().then(async booruTabs => {
    booruTabs.add(tabId);
    await saveBooruTabs(booruTabs);
    // Show menus only if this tab is currently active.
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab?.id === tabId) setMenusVisible(true);
  });
});

// On tab switch, update menu visibility from persisted state.
// This is the key fix: we read from storage, not from an in-memory Map,
// so it survives service worker sleep/wake cycles.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  getBooruTabs().then(booruTabs => setMenusVisible(booruTabs.has(tabId)));
});

// On navigation, remove the tab from the booru set and hide menus.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading") return;
  const booruTabs = await getBooruTabs();
  if (booruTabs.has(tabId)) {
    booruTabs.delete(tabId);
    await saveBooruTabs(booruTabs);
  }
  if (tab.active) setMenusVisible(false);
});

// Remove closed tabs from persisted set so it doesn't grow forever.
chrome.tabs.onRemoved.addListener(async tabId => {
  const booruTabs = await getBooruTabs();
  if (booruTabs.has(tabId)) {
    booruTabs.delete(tabId);
    await saveBooruTabs(booruTabs);
  }
});

// When the service worker wakes from sleep (e.g. after PC wake from suspend),
// re-sync menus for whatever tab is currently active.
// chrome.runtime.onStartup covers browser restart; the service worker waking
// mid-session is handled by syncMenusForActiveTab() being called on every event.
chrome.runtime.onStartup.addListener(syncMenusForActiveTab);

// Handle context menu item clicks.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  const actions = {
    [MENU_BOOKMARK]:   "BOOKMARK",
    [MENU_UNBOOKMARK]: "UNBOOKMARK",
    [MENU_CLEAR_ALL]:  "CLEAR_ALL",
  };
  const action = actions[info.menuItemId];
  if (!action) return;

  // Verify from persistent storage, not in-memory state.
  const booruTabs = await getBooruTabs();
  if (!booruTabs.has(tab.id)) return;

  let resolvedTarget = null;
  try {
    resolvedTarget = await chrome.tabs.sendMessage(tab.id, { type: "GET_TARGET" });
  } catch (_) { return; }

  if (!resolvedTarget && action !== "CLEAR_ALL") return;

  chrome.tabs.sendMessage(tab.id, {
    type:   action,
    postId: resolvedTarget?.postId || null,
    srcUrl: resolvedTarget?.srcUrl || info.srcUrl || info.linkUrl || null,
  }).catch(console.warn);
});
