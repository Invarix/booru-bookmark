[![Support on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/invarix)

# Socialnamer (MV3)

Right-click an image on X/Twitter, Bluesky, Pixiv, a supported Mastodon
instance, or an online gallery -> **Download with Socialnamer**. It opens a
save dialog with an editable filename field, pre-filled from the post -
artist/poster, handle, tags, and description keywords - and can convert the
file out of webp on the way down. No more `HiJKlMNoP.jpg`.

You can also add your own gallery sites from the settings page (below).

## Filename

Parts are joined by underscores into a flat filename.

1. Poster/artist name, then handle, then any artist shout-out from the caption
   (`art by @x`, `src: @y`, @mentions), then hashtags.
2. Up to four meaningful keywords from the post text (stopwords, mentions, and
   links excluded) - a caption like "Character doodle #fanart" yields
   `fanart_Character_doodle`.
3. If the poster wrote an image description (alt text), up to four keywords
   from it are appended. Placeholder values like X's `alt="Image"` are ignored,
   and words already present aren't repeated. (This is the description written
   on the post - social sites strip EXIF metadata on upload, so there's nothing
   usable inside the image file itself.)
4. Multi-image posts get a position suffix in display order - the first of four
   saves as `...01.jpg`, the fourth as `...04.jpg`. Single-image posts have no
   suffix.
5. Nothing found -> falls back to the site's random string (e.g. the media id),
   so you never get a worse name than the default.

Character safety: accented and non-Latin letters are kept (`Māui`, `José`,
`日本語`). `@` and `#` are dropped, and anything illegal on Windows or Linux
(`\ / : * ? " < > |`, control chars, emoji, other symbols) becomes an
underscore, so the name is always safe to write to disk. Windows reserved
device names (`CON`, `PRN`, ...) are guarded.

Per-site notes: on Bluesky the `.bsky.social` suffix is trimmed and a handle
that merely repeats the display name is dropped. On Pixiv the filename is the
artist, the title, and the first line of the description (the long tag list is
omitted). Online galleries that expose a per-post metadata endpoint use the
descriptive tag categories (artist, copyright, character, species) and omit the
large alphabetical "general" bucket.

Saving from a direct media URL (an image opened in its own tab) still works: if
the tab you came from is open, the extension finds the post there by the file's
rendition-stable name. Without such a tab, Bluesky posts are recovered via the
public AppView API and Pixiv artworks via pixiv's public artwork endpoint;
other sites fall back to the file hash.

## Adding your own sites

X, Bluesky, Pixiv, and Mastodon work out of the box. To enable Socialnamer on
another gallery, open the extension's options page (Extensions -> Socialnamer
-> Details -> Extension options), type the site's domain, and approve the
access prompt your browser shows. On sites that expose a standard per-post
metadata endpoint the filename uses the descriptive tag categories; on others
it is cleaned from the image URL. Removing a site revokes that access again.
The list of sites you add is stored locally on your device and never leaves it.

## Format conversion (the webp fix)

The submenu gives three choices - picked **before** the save dialog, because an
extension can't add controls inside the OS Save As window:

| Item | Behavior |
|------|----------|
| **Keep original format** | saved byte-for-byte, with a corrected extension |
| **Force JPG** | re-encode to JPEG (transparency flattened onto white, q=0.95) |
| **Force PNG** | re-encode to PNG (lossless) |

Format is detected by **sniffing the file's magic bytes**, not the URL -
Bluesky serves webp under a `...@jpeg` URL via content negotiation, so the
extension would lie. Conversion uses `OffscreenCanvas` in the background.
Re-encoding a webp recovers the pixels, not the photographer's original file -
there's no original hiding behind the webp to get back to.

> Converted files are handed to the download as a blob URL where the background
> supports it, with a base64 data URL as the fallback (a service worker can't
> mint blob URLs). Normal social images are fine either way; if an unusually
> large PNG re-encode ever fails, use **Keep original**.

## Install

Chrome/Chromium: `chrome://extensions` -> **Developer mode** -> **Load
unpacked** -> pick this folder. Firefox: `about:debugging` -> **Load Temporary
Add-on** -> pick this folder's `manifest.json` (temporary installs clear on
restart; sign through AMO for a permanent one).

## Permissions

- `contextMenus`, `downloads`: the menu item and the save dialog.
- `storage`: remembers the gallery sites you add (local only).
- `scripting`: runs Socialnamer on the gallery sites you add.
- `declarativeNetRequestWithHostAccess`: sets the Referer header that a couple
  of image hosts require, scoped to those hosts.
- Host access to the built-in sites and their image hosts: read the post and
  fetch the image to rename and convert it.
- Optional, per-domain host access: requested only in the moment you add a site.

## Maintenance

Per-site extractors live at the top of `content.js`, matched by hostname; the
first match wins, and named sites are ordered ahead of the generic gallery and
fallback extractors. To add a built-in site, add an extractor and register its
domain in `matches` (manifest), `SITE_PATTERNS` (background.js), and
`host_permissions`. User-added sites are handled separately via the options
page and dynamic registration, isolated from the built-in paths.

## Files

```
manifest.json          MV3; permissions above
background.js          menu, format sniffing, conversion, save, user-site sync
content.js             per-site extractors (top of file) + filename assembly
options.html/.js       settings page for user-added sites
icon16/32/48/128.png   toolbar + store icons
PRIVACY.md             privacy policy
```

[![Support on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/invarix)
