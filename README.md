# Booru Bookmark

A Chromium (Manifest V3) browser extension that lets you bookmark image thumbnails on booru-style image boards with a bright red border, so you always know where you left off, even after a post has drifted to a different index page.

Right-click any thumbnail to bookmark it. The thumbnail gets a distinctive red border, your bookmarks persist across sessions, and a one-click "Navigate Bookmarks" button takes you back to a bookmarked image, automatically finding and scrolling to it even if new uploads have pushed it onto a later page.

If you find this extension useful, you can support its development on Ko-fi:

[![Support me on Ko-fi](https://img.shields.io/badge/Support%20me%20on-Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/invarix)

---

## Features

- **One-click bookmarking** via the right-click context menu on any thumbnail.
- **Persistent visual markers**: bookmarked thumbnails get a thick red border with a contrast halo so they stand out against any thumbnail color.
- **Cross-page navigation**: if a bookmarked post has moved to a different index page since you saved it, the extension locates the page it's on now and takes you there.
- **Automatic scroll-to-bookmark**: after navigating, the page scrolls to and pulses the bookmarked thumbnail, re-centering as the page finishes loading.
- **Deleted-post detection**: if a bookmarked post no longer exists anywhere in the index, you're returned to its last known page with a clear notice.
- **Works on many boorus, not a fixed list**: the extension detects booru sites at runtime by their page structure rather than relying on a hardcoded domain list.
- **Syncs across your devices, still private**: bookmarks are stored in the browser's own storage and, if you are signed into the browser, follow you to your other devices through the browser's built-in encrypted sync. Nothing is ever sent to the developer.

---

## Supported boorus

The extension identifies booru sites by detecting the underlying engine, so it works across the major booru software families and the many sites built on them:

| Engine family | Post URL pattern | Example sites |
| --- | --- | --- |
| Gelbooru family | `index.php?page=post&s=view&id=N` | Gelbooru, Safebooru, booru.org-hosted sites |
| Danbooru family | `/posts/N` | Danbooru, e621 |
| Shimmie2 | `/post/view/N` | r34 paheal, Pixboard |
| Moebooru | `/post/show/N` | yande.re, Konachan |
| Philomena | `/images/N` | Derpibooru, Furbooru |

On any page that isn't a booru, the content script detects this and exits immediately, doing nothing.

---

## Installation

### From source (developer mode)

1. Download or clone this repository.
2. Open `chrome://extensions` in your Chromium-based browser (Chrome, Edge, Brave, etc.).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `booru-bookmark` folder.
5. The extension icon appears in your toolbar.

> **Note:** When updating to a new version in developer mode, load the new folder fresh rather than relying on a page refresh. Browsers cache the old content script in already-open tabs, so close and reopen any booru tabs after updating.

---

## Usage

### Bookmarking an image

1. Right-click any thumbnail on a booru index page.
2. Choose **📌 Bookmark Image** from the context menu.
3. The thumbnail gains a red border, and a **Navigate Bookmarks** button appears in the bottom-right corner.

### Returning to a bookmark

- Click the **Navigate Bookmarks** button in the bottom-right corner, **or**
- Right-click any thumbnail and choose **🔍 Go to Bookmark**.

If the bookmark is on your current page, it scrolls straight to it. If it has moved to another page, the extension finds the correct page, navigates there, and scrolls to the thumbnail automatically. Repeated clicks cycle through all of your bookmarks for that site.

### Removing bookmarks

- Right-click a bookmarked thumbnail and choose **✖ Remove Bookmark**, **or**
- Right-click anywhere and choose **🗑 Clear All Bookmarks on This Page**, **or**
- Open the toolbar popup to clear the current site's bookmarks or all bookmarks across every site.

### The popup

Clicking the toolbar icon opens a popup showing the current site's name, your bookmark count for that site, a jump button, and buttons to clear bookmarks for the current site or everywhere.

---

## How it works

### Detection

Rather than maintaining a list of booru domains, the content script inspects each page for booru engine signatures: engine meta tags, characteristic CSS classes and DOM structures, and clusters of thumbnail links matching known post-URL patterns. If three or more thumbnail links match a known engine pattern (or an engine marker is present), the page is treated as a booru. Otherwise the script exits and does nothing.

### Storage

Bookmarks are stored with the browser's `chrome.storage.sync` API, keyed by site origin. When you are signed into your browser, this carries your bookmarks to your other devices automatically through the browser's own encrypted sync; when you are signed out, it behaves like ordinary local storage on that device. If a site's bookmarks ever exceed the browser's per-site sync limit, the extension falls back to local storage for that site so nothing is lost. Each bookmark records the post's canonical numeric ID and the index page it was on when bookmarked. Post IDs from every source (data attributes, element IDs, and post links) are normalized to a single canonical form, so the same post is never recorded twice.

### Finding a moved post

Boorus order their default index by post ID descending, so a post's page position is monotonic in its ID. As new posts are uploaded, older posts drift toward higher page numbers. When you navigate to a bookmark that isn't on the current page, the extension:

1. **Binary searches** the index by post ID. It fetches a probe page, reads the range of post IDs on it, and decides whether the target is on an earlier or later page, halving the search space each step. This finds a post hundreds of pages deep in roughly 15 to 20 page fetches instead of hundreds.
2. **Falls back to a linear sweep** if the binary search concludes the post isn't found. Because custom sort orders or unusual markup can occasionally violate the ID-ordering assumption, an exhaustive sweep verifies the result before any "deleted" conclusion, so a bookmarked post that still exists is never falsely reported as gone.
3. **Reports deletion** only after the sweep confirms the post is absent from the index, returning you to its last known page with a notice.

These page lookups are plain `fetch()` requests to other pages of the same booru you're already browsing; the extension reads their existing HTML to locate the post and runs no remote code.

---

## Permissions

The extension requests the narrowest set of permissions needed for its features:

| Permission | Why it's needed |
| --- | --- |
| `contextMenus` | Adds the bookmark / remove / go-to entries to the right-click menu. |
| `storage` | Saves your bookmarks so they persist across sessions and, when you are signed into your browser, sync to your other devices. The same permission covers both local and synced storage. |
| `host_permissions: <all_urls>` | Boorus exist on hundreds of independent, unpredictable domains. The extension can't enumerate them in advance, so it requests broad host access and detects boorus at runtime, exiting immediately on non-booru pages. Host access is used only to mark thumbnails and to fetch index pages of the same booru to locate a moved post. |

The extension does **not** use remote code. All JavaScript and CSS is bundled in the package; no code is loaded or executed from any external server.

---

## Privacy

Booru Bookmark collects nothing. Your bookmarks are stored in your browser and, if you enable browser sync, synchronized to your other devices through the browser's built-in encrypted sync. They are never sent to the developer, sold, or shared. The only network requests the extension makes are to pages of the booru you're already viewing, in order to find where a bookmarked post has moved, and those requests carry no information about you. See [`PRIVACY.md`](PRIVACY.md) for the full policy.

---

## Project structure

```
booru-bookmark/
├── manifest.json      Extension manifest (MV3)
├── background.js      Service worker: context menus, message routing, tab tracking
├── content.js         Core logic: detection, bookmarking, restore, navigation, search
├── content.css        Bookmark border, toasts, and navigation button styling
├── popup.html         Toolbar popup markup
├── popup.js           Popup logic: per-site count, jump, clear actions
└── icons/             Extension icons (16, 48, 128, 512 px)
```

---

## Development

The core logic lives in `content.js`. Detection signatures, the canonical post-ID normalizer, and the page-search algorithm are the areas most likely to need extension when adapting to a new or unusual booru engine. Site-specific DOM extraction is the most fragile layer; if a particular booru misbehaves, that's the first place to look.

After making changes, reload the unpacked extension and reopen any booru tabs so the new content script is injected (browsers cache the old one in open tabs).

---

## Compatibility

Works in any Chromium-based browser that supports Manifest V3, including Google Chrome, Microsoft Edge, Brave, Opera, and Vivaldi.

---

## License

See [`LICENSE`](LICENSE) for details.
