// Booru Bookmark -- background.js

const MENU_BOOKMARK   = "booru_bookmark_set";
const MENU_UNBOOKMARK = "booru_bookmark_clear";
const MENU_JUMP       = "booru_bookmark_jump";
const MENU_CLEAR_ALL  = "booru_bookmark_clear_all";
const BOORU_TABS_KEY  = "booru_active_tabs";

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    const base = { contexts: ["image", "link", "video"], visible: false };
    chrome.contextMenus.create({ ...base, id: MENU_BOOKMARK,   title: "📌 Bookmark Image" });
    chrome.contextMenus.create({ ...base, id: MENU_UNBOOKMARK, title: "✖ Remove Bookmark" });
    chrome.contextMenus.create({ ...base, id: MENU_JUMP,       title: "🔍 Go to Bookmark" });
    chrome.contextMenus.create({ ...base, id: "booru_sep",     type: "separator" });
    chrome.contextMenus.create({ ...base, id: MENU_CLEAR_ALL,  title: "🗑 Clear All Bookmarks on This Page" });
  });
}

function setMenusVisible(visible) {
  const upd = { visible };
  [MENU_BOOKMARK, MENU_UNBOOKMARK, MENU_JUMP, "booru_sep", MENU_CLEAR_ALL]
    .forEach(id => chrome.contextMenus.update(id, upd).catch(() => {}));
}

async function getBooruTabs() {
  const d = await chrome.storage.local.get(BOORU_TABS_KEY);
  return new Set(d[BOORU_TABS_KEY] || []);
}
async function saveBooruTabs(set) {
  await chrome.storage.local.set({ [BOORU_TABS_KEY]: [...set] });
}

async function syncMenusForActiveTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab) return;
  const booruTabs = await getBooruTabs();
  setMenusVisible(booruTabs.has(activeTab.id));
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== "IS_BOORU" || !sender.tab?.id) return;
  const tabId = sender.tab.id;
  getBooruTabs().then(async booruTabs => {
    booruTabs.add(tabId);
    await saveBooruTabs(booruTabs);
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab?.id === tabId) setMenusVisible(true);
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  getBooruTabs().then(booruTabs => setMenusVisible(booruTabs.has(tabId)));
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading") return;
  const booruTabs = await getBooruTabs();
  if (booruTabs.has(tabId)) { booruTabs.delete(tabId); await saveBooruTabs(booruTabs); }
  if (tab.active) setMenusVisible(false);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const booruTabs = await getBooruTabs();
  if (booruTabs.has(tabId)) { booruTabs.delete(tabId); await saveBooruTabs(booruTabs); }
});

chrome.runtime.onStartup.addListener(syncMenusForActiveTab);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  const actions = {
    [MENU_BOOKMARK]:   "BOOKMARK",
    [MENU_UNBOOKMARK]: "UNBOOKMARK",
    [MENU_JUMP]:       "JUMP_TO_BOOKMARK",
    [MENU_CLEAR_ALL]:  "CLEAR_ALL",
  };
  const action = actions[info.menuItemId];
  if (!action) return;

  const booruTabs = await getBooruTabs();
  if (!booruTabs.has(tab.id)) return;

  // Jump and Clear don't need a resolved target
  if (action === "JUMP_TO_BOOKMARK" || action === "CLEAR_ALL") {
    chrome.tabs.sendMessage(tab.id, { type: action }).catch(console.warn);
    return;
  }

  let resolvedTarget = null;
  try {
    resolvedTarget = await chrome.tabs.sendMessage(tab.id, { type: "GET_TARGET" });
  } catch (_) { return; }

  if (!resolvedTarget) return;

  chrome.tabs.sendMessage(tab.id, {
    type:   action,
    postId: resolvedTarget.postId || null,
    srcUrl: resolvedTarget.srcUrl || info.srcUrl || info.linkUrl || null,
  }).catch(console.warn);
});
