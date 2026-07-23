# Privacy Policy - Socialnamer

**Last updated:** July 22, 2026

Socialnamer renames images you save from social and gallery sites (X/Twitter,
Bluesky, Pixiv, supported Mastodon instances, and galleries you add) using
information visible in the post - artist/poster, handle, tags, and description -
and can convert the image format on the way down.

The short version: **Socialnamer collects no personal data and sends nothing
about you anywhere.** There are no accounts, no analytics, no ads, no trackers,
and no remote code. The only thing it stores is the list of extra sites you
choose to add, and that stays on your device. Everything else happens locally,
only at the moment you invoke the extension.

## What the extension does with data

When you right-click an image and choose **Download with Socialnamer**, the
extension:

1. **Reads the visible content of the page you're on** (the post's author,
   handle, caption text, tags, and image alt text) - in your browser, locally -
   solely to build the filename. It is placed into the save dialog's filename
   field and is not retained, logged, or transmitted by the extension.
2. **Fetches the image file itself** from the site's image host. This is the
   same download your browser performs when you save any image; the extension
   reads the file's first bytes to identify its true format and, if you chose a
   conversion option, re-encodes it locally before saving. The image is never
   sent anywhere other than to your own disk.
3. **Reads public post metadata from the site's own endpoints** to build the
   filename. On the page you're viewing this is the page itself; when you save
   from a direct image URL with no post on screen, the extension reads the
   platform's public, unauthenticated endpoint (Bluesky's public AppView API,
   or Pixiv's public artwork endpoint) keyed on the identifier already present
   in the image URL. These requests identify the artwork or author being saved,
   never you or your browsing. If a lookup fails, the extension falls back to
   the default filename.

That is the complete list of network activity, and all of it is directed at the
site the image came from.

## What it stores

The only thing Socialnamer stores is **the list of additional gallery sites you
add** on its options page. This list lives in your browser's local extension
storage on your device. It is your configuration, not personal data; it is never
transmitted anywhere, and removing a site removes it from the list. Socialnamer
keeps no history of pages visited, images saved, or filenames generated.

## What the extension does NOT do

- **No collection.** No personal information, browsing history, or usage data is
  collected or profiled.
- **No transmission.** Nothing you do is sent to the developer or any third
  party. The only network requests are to the site an image came from, to fetch
  that image and its public post details.
- **No analytics or telemetry.** No tracking, crash reporting, fingerprinting,
  or usage measurement of any kind.
- **No remote code.** All code ships inside the extension package. Nothing is
  downloaded or executed at runtime.
- **No sale or sharing of data.**
- **No background activity.** The extension does nothing until you invoke it
  from the right-click menu.

## Permissions, explained

| Permission | Why it's needed |
|---|---|
| `contextMenus` | Adds the **Download with Socialnamer** item to the right-click menu. |
| `downloads` | Opens the save dialog pre-filled with the generated filename. |
| `storage` | Remembers the gallery sites you add. Local to your device; never transmitted. |
| `scripting` | Runs the extension on the gallery sites you add, so filenames work there too. |
| `declarativeNetRequestWithHostAccess` | Sets the Referer header that a couple of image hosts require in order to serve an image; scoped to those hosts, modifies only that header, and reads no traffic. |
| Host access to the built-in sites and their image hosts | Reads the post (author, caption, tags, alt text) and fetches the image bytes to rename and, if asked, convert. |
| Optional host access (requested per site) | Requested only when you add a site on the options page, scoped to that one domain, and revoked when you remove it. |

The extension reads pages only on the built-in sites and on sites you explicitly
add, and only in service of a save you initiated.

## Children's privacy

Socialnamer does not collect information from anyone, including children.

## Changes to this policy

If a future version changes what data the extension touches, this document will
be updated and the change noted in the release notes.

## Contact

Questions about this policy or the extension:
- Ko-fi: https://ko-fi.com/invarix
- Or open an issue on the extension's repository.
