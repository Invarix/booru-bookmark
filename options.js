"use strict";
const ext = globalThis.browser ?? globalThis.chrome;

const $domain = document.getElementById("domain");
const $add = document.getElementById("add");
const $list = document.getElementById("list");
const $msg = document.getElementById("msg");

function say(text, kind) {
  $msg.textContent = text || "";
  $msg.className = kind || "";
}

// Accept "example.net", "www.example.net", or a pasted URL; return a bare host
// or null if it isn't a plausible domain.
function normalizeDomain(raw) {
  let s = (raw || "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return null;
  return s;
}

// Domains already handled by the built-in named-site paths. Adding one of
// these would double-register the content script, so they're rejected.
const RESERVED = [
  "x.com", "twitter.com", "bsky.app", "pawoo.net", "baraag.net",
  "pixiv.net", "e621.net",
];

function isReserved(d) {
  return RESERVED.some((base) => d === base || d.endsWith("." + base));
}

async function getSites() {
  const { userSites = [] } = await ext.storage.local.get({ userSites: [] });
  return userSites;
}

function render(sites) {
  $list.innerHTML = "";
  if (!sites.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No added sites yet.";
    $list.appendChild(li);
    return;
  }
  for (const d of sites) {
    const li = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = d;
    const rm = document.createElement("button");
    rm.textContent = "Remove";
    rm.addEventListener("click", () => removeSite(d));
    li.append(code, rm);
    $list.appendChild(li);
  }
}

async function refresh() {
  render(await getSites());
}

async function addSite() {
  const d = normalizeDomain($domain.value);
  if (!d) {
    say("Enter a valid domain, e.g. example.net", "err");
    return;
  }
  if (isReserved(d)) {
    say("That site is already supported out of the box.", "ok");
    return;
  }
  const sites = await getSites();
  if (sites.includes(d)) {
    say("That site is already added.", "err");
    return;
  }
  const origins = [`https://${d}/*`];
  let granted = false;
  try {
    // Must be called from this user gesture; scoped to just this domain.
    granted = await ext.permissions.request({ origins });
  } catch (e) {
    say("Permission request failed: " + (e && e.message), "err");
    return;
  }
  if (!granted) {
    say("Access was not granted, so the site was not added.", "err");
    return;
  }
  await ext.storage.local.set({ userSites: [...sites, d] });
  ext.runtime.sendMessage({ type: "SIS_SITES_CHANGED" });
  $domain.value = "";
  say(`Added ${d}.`, "ok");
  refresh();
}

async function removeSite(d) {
  const sites = await getSites();
  await ext.storage.local.set({ userSites: sites.filter((x) => x !== d) });
  try {
    await ext.permissions.remove({ origins: [`https://${d}/*`] });
  } catch (_) {
    /* permission may already be gone; storage is the source of truth */
  }
  ext.runtime.sendMessage({ type: "SIS_SITES_CHANGED" });
  say(`Removed ${d}.`, "ok");
  refresh();
}

$add.addEventListener("click", addSite);
$domain.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSite();
});

refresh();
